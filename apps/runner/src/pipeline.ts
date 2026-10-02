import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { logPrefix, parseCost, planAgent, runAgent } from './agent.js';
import { Studio, StudioError, type Comment, type RunStart } from './api.js';
import { checkOutput, type CheckResult } from './checks.js';
import type { Brand, Config } from './config.js';
import type { Logger } from './log.js';
import type { Item, Queue } from './queue.js';
import { RESULT_FORMAT, render, type TemplateVariable } from './template.js';
import type { Secrets } from './secrets.js';
import { agentDir, collectFiles, describeComments, describeRequirements, dirsFor, ensureDirs, prepareChanges, readResult, type OutputFile, type Prepared } from './workspace.js';

export interface PipelineDeps {
  config: Config;
  studioFor: (brandKey: string) => Studio;
  /** Instruction text by "brand:event type". */
  templates: Map<string, string>;
  queue: Queue;
  log: Logger;
  now: () => number;
  /** Aborted when the runner shuts down. */
  signal?: AbortSignal;
}

export type Outcome = { done: true } | { retryAt: number; reason: string };

/** What the agent writes to result.json. */
const resultSchema = z.object({
  files: z.array(z.object({ path: z.string(), kind: z.enum(['video', 'image', 'pdf', 'subtitles', 'cover']), position: z.number().int().min(0).optional() })).optional(),
  notes: z.string().max(5000).default(''),
  comments: z.array(z.object({ id: z.string(), status: z.enum(['fixed', 'cannot_do', 'needs_human']), reply: z.string().max(5000).optional() })).default([]),
  cost: z.number().min(0).optional(),
  /** For a slot: the piece to create. */
  piece: z
    .object({
      title: z.string().trim().min(1).max(200),
      kind: z.enum(['video', 'carousel', 'post', 'story', 'pdf']),
      brief: z.string().max(5000).default(''),
      format: z.enum(['9:16', '4:5', '1:1', '16:9', 'carousel', 'document']),
      style: z.string().max(80).default(''),
      campaignId: z.string().uuid().optional(),
    })
    .optional(),
});
type Result = z.infer<typeof resultSchema>;

/**
 * True when the agent explicitly declined the work: it left nothing, and for every comment it was given it said that it
 * cannot do it or that a person has to. Anything short of that (a comment it claims to have fixed with no file to show for
 * it, or nothing said at all) is a failed run.
 */
function declinedEverything(result: Result, eligible: string[]): boolean {
  if (eligible.length === 0) return false;
  const said = new Map(result.comments.map((x) => [x.id, x.status]));
  return eligible.every((id) => said.has(id) && said.get(id) !== 'fixed');
}

/** What the agent produced, kept between stages so a restart carries on instead of starting over. */
interface Work {
  startedAt: number;
  deadline: number;
  cost: number;
  files: OutputFile[];
  notes: string;
  /** What the agent said about each comment it was given. */
  said: { id: string; status: 'fixed' | 'cannot_do' | 'needs_human'; reply?: string }[];
  /** The comments it was given, so each can be answered after they have been resolved. */
  eligible: string[];
  checks: { errors: number; warnings: number; summary: string[]; issues: string[] };
  attempts: number;
  piece?: Result['piece'];
  pieceId?: string;
  variantId?: string;
  brandId: string;
  brandName: string;
}

const MIN = 60_000;
const gone = (e: unknown) => e instanceof StudioError && (e.status === 404 || e.status === 403);
const transient = (e: unknown) => e instanceof StudioError && (e.status === 0 || e.status >= 500);

/**
 * Which of the runner's secrets turn up in what the agent left to be posted: its notes, replies and piece (all of result.json that
 * is used) and the files that would be uploaded.
 */
async function secretsIn(secrets: Secrets, result: Result | null, files: OutputFile[]): Promise<string[]> {
  const found = new Set(result ? secrets.foundIn(JSON.stringify(result)) : []);
  for (const f of files) for (const label of await secrets.foundInFile(f.path)) found.add(label);
  return [...found];
}

const LEAK_NOTE =
  "The agent's result held a secret of this runner (a studio token, a webhook secret or a value of the agent's environment), so nothing it wrote was posted. " +
  'Look at what it was asked (a comment may have told it to), keep the agent apart from the runner (agent.runAs or agent.sandbox) and replace that secret.';

/** Limits how much of a message goes into a reply or a note. */
const clip = (s: string, n = 900) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

class Retry extends Error {
  constructor(public retryAt: number, reason: string) {
    super(reason);
  }
}

/**
 * Handles one event from where it was left: asks the studio to start a run (which is where the limits are enforced), does
 * the agent's work, uploads the new version, answers every comment, and tells the studio how it went. Each stage is written
 * to the item before the next begins.
 */
export async function handle(deps: PipelineDeps, item: Item): Promise<Outcome> {
  const brand = deps.config.brands[item.brand];
  if (!brand) {
    deps.log.error({ item: item.id, brand: item.brand }, 'event for a brand that is no longer configured');
    deps.queue.done(item);
    return { done: true };
  }
  const studio = deps.studioFor(item.brand);
  const ctx: Ctx = { deps, item, brand, studio, log: deps.log };
  try {
    if (item.stage === 'queued') {
      const go = await begin(ctx);
      if (go === 'drop') return finishItem(ctx);
    }
    if (item.stage === 'started') {
      const ended = await doWork(ctx);
      if (ended) return finishItem(ctx);
    }
    if (item.stage === 'agent_done') {
      const ended = await upload(ctx);
      if (ended) return finishItem(ctx);
    }
    if (item.stage === 'uploaded') await replyAndFinish(ctx);
    return finishItem(ctx);
  } catch (err) {
    if (err instanceof Retry) return { retryAt: err.retryAt, reason: err.message };
    throw err;
  }
}

interface Ctx {
  deps: PipelineDeps;
  item: Item;
  brand: Brand;
  studio: Studio;
  log: Logger;
}

const finishItem = (c: Ctx): Outcome => {
  c.deps.queue.done(c.item);
  return { done: true };
};

const isSlot = (item: Item) => item.type === 'slot.needs_content';
const data = (item: Item) => item.payload.data as any;

// ───────────────────────────── starting ─────────────────────────────

async function begin(c: Ctx): Promise<'go' | 'drop'> {
  const { item, studio, deps } = c;
  const scope = scopeOf(c);
  let brandId: string;
  let brandName: string;
  try {
    const me = await studio.tokenInfo();
    brandId = me.brand.id;
    brandName = me.brand.name;
    if (scope.pieceId) {
      // A request that a person (or another run) has already moved past is not worth an agent's time.
      const v = await studio.version(data(item).version.id);
      if (v.review_state !== 'changes_requested') {
        c.log.info({ item: item.id, state: v.review_state }, 'the version has moved on: nothing to do');
        return 'drop';
      }
    }
  } catch (err) {
    if (gone(err)) {
      c.log.warn({ item: item.id, err: String(err) }, 'the piece or version is gone');
      return 'drop';
    }
    if (transient(err)) throw new Retry(deps.now() + 30_000, String(err));
    throw err;
  }

  let run: RunStart;
  try {
    run = await studio.startRun(scope.pieceId ? { pieceId: scope.pieceId } : { brandId }, { trigger: item.type, eventId: item.id });
  } catch (err) {
    if (err instanceof StudioError) {
      if (err.code === 'piece_busy') {
        item.tries++;
        if (item.tries > 120) {
          c.log.warn({ item: item.id }, 'the piece stayed busy: giving up');
          return 'drop';
        }
        throw new Retry(deps.now() + (Number(err.details?.retryAfterSeconds) || 60) * 1000, 'the piece is busy with another run');
      }
      // The studio refused for a reason it has already told the people responsible about.
      if (['rounds_exhausted', 'piece_budget_reached', 'monthly_budget_reached', 'budget_not_set', 'already_handled', 'piece_discarded'].includes(err.code)) {
        c.log.warn({ item: item.id, code: err.code }, `not started: ${err.message}`);
        return 'drop';
      }
      if (transient(err)) throw new Retry(deps.now() + 30_000, String(err));
    }
    throw err;
  }
  item.runId = run.id;
  item.round = run.round;
  item.maxCost = run.limits.maxCost;
  item.maxMinutes = run.limits.maxMinutes;
  item.maxRounds = run.maxRounds;
  item.work = { brandId, brandName, startedAt: deps.now(), deadline: deps.now() + run.limits.maxMinutes * MIN, cost: 0, attempts: 0, eligible: [] } as Partial<Work>;
  item.stage = 'started';
  deps.queue.save(item);
  c.log.info({ item: item.id, run: run.id, round: run.round, limits: run.limits }, 'run started');
  return 'go';
}

function scopeOf(c: Ctx): { pieceId?: string; key: string } {
  const d = data(c.item);
  return isSlot(c.item) ? { key: `_slots/${d.slot.id}-${d.slot.day}` } : { pieceId: d.piece.id, key: d.piece.id };
}

// ───────────────────────────── the agent's work ─────────────────────────────

/** Keeps the run's lease alive while the agent works, and stops the agent if the studio says the run is over. */
function keepAlive(c: Ctx, abort: AbortController): () => void {
  const timer = setInterval(() => {
    c.studio.heartbeat(c.item.runId!).catch((err) => {
      if (err instanceof StudioError && err.status === 409) {
        c.log.warn({ run: c.item.runId }, 'the studio closed this run: stopping the agent');
        abort.abort();
      }
    });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function doWork(c: Ctx): Promise<boolean> {
  const { item, deps, brand, studio } = c;
  const work = item.work as Work;
  const scope = scopeOf(c);
  const dirs = dirsFor(deps.config.workspaceRoot, item.brand, scope.key, item.runId!);
  const access = { runAs: brand.agent.runAs };
  item.runDir = dirs.run;

  const template = deps.templates.get(`${item.brand}:${item.type}`);
  if (!template) return conclude(c, 'failed', { notes: `No instruction template for ${item.type}` }, 'No instructions are configured for this kind of request.');

  let prepared: Prepared | null = null;
  const vars: Partial<Record<TemplateVariable, string>> = {};
  let requirements: Awaited<ReturnType<Studio['requirements']>>;
  const info = await studio.brandSettings(work.brandId);
  try {
    if (isSlot(item)) {
      await ensureDirs(dirs, access);
      requirements = await studio.requirements(work.brandId);
      const d = data(item);
      await writeFile(path.join(dirs.input, 'slot.json'), JSON.stringify(d, null, 2));
      await writeFile(path.join(dirs.input, 'requirements.json'), JSON.stringify(requirements, null, 2));
      Object.assign(vars, {
        slot: `${d.account.network} (${d.account.display_name}), ${d.slot.label || 'a slot'} on ${d.slot.day} at ${d.slot.at}`,
        slot_day: d.slot.day,
        campaigns: d.campaigns?.length ? d.campaigns.map((x: any) => `- ${x.name}${x.objective ? `: ${x.objective}` : ''}`).join('\n') : '_No campaign is running that day._',
        comments: '_None: this is new work._', people_only: '_None._', previous_files: '_None._', piece_title: '', piece_brief: '', piece_kind: '', format: '', style: '', version_number: '',
        reason: item.type, note: '', requested_by: '',
      });
    } else {
      prepared = await prepareChanges(studio, c.log, dirs, work.brandId, data(item).version.id, item.payload, access);
      requirements = prepared.requirements;
      work.eligible = prepared.eligible.map((x) => x.id);
      const d = data(item);
      const frames = prepared.frames;
      Object.assign(vars, {
        piece_title: prepared.version.piece.title, piece_brief: prepared.version.piece.brief || '_No brief._', piece_kind: prepared.version.piece.kind,
        format: prepared.version.variant.format, style: prepared.version.variant.style || '', version_number: String(prepared.version.number),
        reason: d.reason ?? 'changes_requested', note: d.note ?? '', requested_by: d.requested_by?.name ?? '',
        comments: describeComments(prepared.eligible, (x: Comment) => frames.get(x.id) ?? null),
        people_only: prepared.peopleOnly.length ? describeComments(prepared.peopleOnly, () => null) : '_None._',
        previous_files: prepared.previousFiles.map((f) => `- ${f}`).join('\n') || '_None._',
      });
      if (prepared.eligible.length === 0 && !d.note) {
        return conclude(c, 'needs_people', { notes: 'Every open comment is marked for people only, so there was nothing for the agent to do.' }, null);
      }
    }
  } catch (err) {
    if (gone(err)) return conclude(c, 'aborted', { notes: `The piece disappeared: ${err}` }, null);
    if (transient(err)) throw new Retry(deps.now() + 30_000, String(err));
    throw err;
  }
  Object.assign(vars, {
    brand: work.brandName,
    round: String(item.round ?? 1), max_rounds: String(item.maxRounds ?? ''), max_minutes: String(item.maxMinutes ?? ''), max_cost: item.maxCost == null ? '' : String(item.maxCost), currency: info.agent.currency,
    requirements: describeRequirements(requirements), checklist: requirements.approval_checklist.length ? requirements.approval_checklist.map((x) => `- ${x}`).join('\n') : '_No checklist._',
    result_format: RESULT_FORMAT, input_dir: 'input', output_dir: 'output', sources_dir: path.relative(dirs.run, dirs.sources), run_dir: '.', failures: '',
  });

  const abort = new AbortController();
  const stopBeat = keepAlive(c, abort);
  const onShutdown = () => abort.abort();
  deps.signal?.addEventListener('abort', onShutdown, { once: true });
  try {
    for (let attempt = work.attempts; attempt <= brand.checkRetries; attempt++) {
      work.attempts = attempt;
      const remaining = work.deadline - deps.now();
      if (remaining < 1_000) return conclude(c, 'timeout', { notes: 'The time allowed for the run ran out before the agent could start.' }, 'The agent ran out of time.');
      if (attempt > 0) {
        // Whatever the last attempt left must not be uploaded by mistake with the new one: it moves aside, for reference.
        await rename(dirs.output, path.join(dirs.run, `output-attempt-${attempt}`)).catch(() => {});
      }
      // Whatever an earlier run of this item made of the directories (a restart), they are laid out again as they should be.
      await ensureDirs(dirs, access);
      await agentDir(dirs.output, access);
      const instructions = render(template, vars);
      await writeFile(path.join(dirs.run, 'instructions.md'), instructions);
      let res;
      try {
        const plan = planAgent(brand.agent, dirs, {
          brand: item.brand, runId: item.runId!, pieceId: scopeOf(c).pieceId ?? '', maxMinutes: String(item.maxMinutes ?? ''),
          maxBudget: item.maxCost == null ? undefined : String(Math.max(0, item.maxCost - work.cost)),
        });
        res = await runAgent({
          ...plan,
          stdin: brand.agent.input === 'stdin' ? instructions : undefined,
          timeoutMs: remaining,
          killGraceMs: brand.agent.killGraceSeconds * 1000,
          logPrefix: logPrefix(dirs.run, attempt),
          signal: abort.signal,
        });
      } catch (err) {
        return conclude(c, 'failed', { notes: String(err) }, 'The agent could not be started.');
      }
      if (res.aborted) {
        if (deps.signal?.aborted) throw new Retry(deps.now() + 5_000, 'the runner is shutting down'); // resumes from this stage after a restart
        c.log.warn({ run: item.runId }, 'the run was closed by the studio');
        deps.queue.done(item);
        return true;
      }

      let result: Result | null = null;
      let problem: string | null = null;
      const read = await readResult(dirs.output);
      if ('problem' in read) problem = read.problem;
      else if ('text' in read) {
        try {
          result = resultSchema.parse(JSON.parse(read.text));
        } catch (err) {
          problem = `result.json could not be read: ${clip(String(err), 300)}`;
        }
      }
      work.cost += parseCost(brand.agent.cost, res.stdout, result);
      if (res.timedOut) return conclude(c, 'timeout', { notes: `The agent was stopped after ${Math.round(res.durationMs / 60000)} minutes.` }, 'The agent ran out of time on this.');

      const found = problem ? { files: [], problem } : await collectFiles(dirs.output, result?.files);
      // Before anything the agent wrote goes anywhere: none of this runner's secrets may be in it.
      const leaked = await secretsIn(deps.config.secrets, result, found.files);
      if (leaked.length) {
        c.log.error({ run: item.runId, brand: item.brand, secrets: leaked }, "the agent's result holds a secret of this runner: nothing of it is posted");
        return conclude(c, 'failed', { notes: LEAK_NOTE }, "The agent's result could not be used.");
      }
      if (!problem && found.files.length === 0 && result && (res.exitCode === 0 || res.exitCode === null) && declinedEverything(result, work.eligible)) {
        // It made nothing, and said so comment by comment: a person has to take it from here. That is an answer, not a failure.
        work.said = result.comments;
        work.notes = result.notes;
        await answerComments(c, true);
        return conclude(c, 'needs_people', { notes: result.notes || 'The agent made no new version and handed the comments back to a person.' }, null);
      }
      if (found.problem || found.files.length === 0) {
        const why = found.problem ?? 'The agent left no files.';
        if (res.exitCode !== 0 && res.exitCode !== null) return conclude(c, 'failed', { notes: `The agent exited with ${res.exitCode}. ${clip(res.stderr.trim().split('\n').slice(-5).join(' '), 400)}` }, 'The agent failed.');
        return conclude(c, 'failed', { notes: why }, `The agent did not produce a result: ${why}`);
      }
      if (isSlot(item) && !result?.piece) return conclude(c, 'failed', { notes: 'result.json has no "piece" (title, kind, format) for the new piece.' }, null);

      const checks = await checkOutput(found.files, requirements, brand.checks, deps.config);
      const issues = [...checks.errors, ...checks.warnings].map((i) => `${i.severity === 'error' ? 'Problem' : 'Warning'}: ${i.message}`);
      work.checks = { errors: checks.errors.length, warnings: checks.warnings.length, summary: checks.summary, issues };
      if (checks.errors.length) {
        const budgetLeft = item.maxCost == null || work.cost < item.maxCost;
        if (attempt < brand.checkRetries && budgetLeft && work.deadline - deps.now() > 60_000) {
          vars.failures = `## The last attempt did not pass the automatic checks\n\n${checks.errors.map((e) => `- ${e.message}`).join('\n')}\n\nFix these and write result.json again. The output directory is empty again; your last attempt is in \`output-attempt-${attempt + 1}/\` if you want to start from it.`;
          c.log.info({ run: item.runId, errors: checks.errors.length }, 'the output failed the checks: another attempt');
          continue;
        }
        return conclude(c, 'checks_failed', { notes: `The output did not pass the automatic checks: ${checks.errors.map((e) => e.message).join(' | ')}`, checks }, `The result did not pass the automatic checks: ${checks.errors[0]!.message}`);
      }

      work.files = found.files;
      work.notes = result?.notes ?? '';
      work.said = result?.comments ?? [];
      work.piece = result?.piece;
      item.stage = 'agent_done';
      deps.queue.save(item);
      return false;
    }
    return conclude(c, 'checks_failed', { notes: 'The output kept failing the automatic checks.' }, 'The result did not pass the automatic checks.');
  } finally {
    stopBeat();
    deps.signal?.removeEventListener('abort', onShutdown);
  }
}

// ───────────────────────────── uploading ─────────────────────────────

function versionNotes(c: Ctx, work: Work): string {
  const lines = [`Agent round ${c.item.round}${work.cost ? `, cost ${work.cost.toFixed(2)}` : ''}.`];
  if (work.notes) lines.push('', work.notes);
  if (work.checks.summary.length) lines.push('', `Automatic checks: ${work.checks.summary.join('; ')}.`);
  if (work.checks.issues.length) lines.push(...work.checks.issues.slice(0, 10).map((i) => `- ${i}`));
  return clip(lines.join('\n'), 4900);
}

async function upload(c: Ctx): Promise<boolean> {
  const { item, studio, deps } = c;
  const work = item.work as Work;
  const resolves = work.said.filter((s) => s.status === 'fixed' && work.eligible.includes(s.id)).map((s) => s.id);
  try {
    let variantId: string;
    if (isSlot(item)) {
      const spec = work.piece!;
      const d = data(item);
      work.pieceId ??= (await studio.createPiece(work.brandId, { title: spec.title, kind: spec.kind, brief: spec.brief, targetDate: d.slot.day, campaignId: spec.campaignId ?? d.campaigns?.[0]?.id ?? null, aiGenerated: true })).id;
      work.variantId ??= (await studio.addVariant(work.pieceId, { format: spec.format, style: spec.style })).id;
      deps.queue.save(item);
      variantId = work.variantId;
    } else {
      variantId = data(item).version.variant.id;
    }
    const v = await studio.uploadVersion(variantId, work.files, { notes: versionNotes(c, work), resolves });
    item.versionId = v.id;
    item.versionNumber = v.number;
    item.stage = 'uploaded';
    deps.queue.save(item);
    c.log.info({ run: item.runId, version: v.id, number: v.number }, 'new version uploaded');
    return false;
  } catch (err) {
    if (err instanceof StudioError) {
      if (transient(err)) throw new Retry(deps.now() + 30_000, String(err));
      const why = err.code === 'identical_version' ? 'The agent produced files identical to the previous version.' : `The studio refused the new version: ${err.message}`;
      return conclude(c, 'failed', { notes: why }, why);
    }
    throw err;
  }
}

// ───────────────────────────── answering ─────────────────────────────

/**
 * Answers every comment the agent was given, one by one, with what it said about it. A comment it did not mention is
 * answered too: nothing is left silent. `soft` is for stages that must not be repeated (the agent's own): a reply that
 * cannot be sent then is logged, instead of retrying the stage.
 */
async function answerComments(c: Ctx, soft = false): Promise<void> {
  const { item, studio, deps } = c;
  const work = item.work as Work;
  item.repliedIds ??= [];
  for (const id of work.eligible) {
    if (item.repliedIds.includes(id)) continue;
    const said = work.said.find((s) => s.id === id);
    const status = said?.status ?? 'needs_human';
    const body = said?.reply?.trim() || (status === 'fixed' ? `Done in v${item.versionNumber}.` : status === 'cannot_do' ? 'The agent could not do this.' : said ? 'This needs a person.' : 'The agent did not say what it did about this comment, so a person needs to check it.');
    try {
      await studio.reply(id, { body: clip(body, 4900), kind: status });
    } catch (err) {
      if (!soft && transient(err)) throw new Retry(deps.now() + 30_000, String(err));
      c.log.warn({ comment: id, err: String(err) }, 'could not reply to a comment');
    }
    item.repliedIds.push(id);
    deps.queue.save(item);
  }
  const unknown = work.said.filter((s) => !work.eligible.includes(s.id));
  if (unknown.length) c.log.warn({ run: item.runId, ids: unknown.map((u) => u.id) }, 'result.json names comments the agent was not given: ignored');
}

async function replyAndFinish(c: Ctx): Promise<void> {
  const { item, studio, deps } = c;
  const work = item.work as Work;
  await answerComments(c);
  try {
    await studio.finishRun(item.runId!, {
      outcome: 'uploaded',
      cost: work.cost,
      notes: clip(work.notes || `Uploaded v${item.versionNumber}.`, 900),
      versionId: item.versionId,
      detail: { checks: work.checks, files: work.files.map((f) => path.basename(f.path)), attempts: work.attempts + 1 },
    });
  } catch (err) {
    if (transient(err)) throw new Retry(deps.now() + 30_000, String(err));
    c.log.warn({ run: item.runId, err: String(err) }, 'could not close the run');
  }
}

/**
 * Ends the item without a new version. Every comment the agent was given is answered ("needs a person"): nothing is left
 * unanswered. Then the run is closed with how it went.
 */
async function conclude(
  c: Ctx,
  outcome: 'failed' | 'checks_failed' | 'timeout' | 'needs_people' | 'aborted',
  o: { notes: string; checks?: CheckResult },
  replyWith: string | null,
): Promise<boolean> {
  const { item, studio, deps } = c;
  const work = item.work as Work;
  if (replyWith) {
    for (const id of work.eligible ?? []) {
      try {
        await studio.reply(id, { body: clip(`${replyWith} A person needs to look at this comment.`, 4900), kind: 'needs_human' });
      } catch (err) {
        c.log.warn({ comment: id, err: String(err) }, 'could not reply to a comment');
      }
    }
  }
  try {
    await studio.finishRun(item.runId!, {
      outcome, cost: work.cost ?? 0, notes: clip(o.notes, 900),
      detail: o.checks ? { checks: { errors: o.checks.errors.length, warnings: o.checks.warnings.length, summary: o.checks.summary, issues: [...o.checks.errors, ...o.checks.warnings].map((i) => i.message) } } : {},
    });
  } catch (err) {
    c.log.warn({ run: item.runId, err: String(err) }, 'could not close the run');
  }
  c.log.warn({ run: item.runId, outcome, notes: o.notes }, 'run ended without a new version');
  return true;
}
