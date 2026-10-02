# Phase 3: the agent loop

This follows the delivery plan in the technical specification ("Estudio de contenidos: especificación técnica"): phase 3 is
*agent*: the producer API, signed webhooks, a runner with safeguards, and the commented frame. Its gate is "a comment becomes a
new version without anyone's hands": a reviewer asks for changes, and a few minutes later there is a new version in review, with
every comment answered.

> **Read this first.** The loop was proven end to end in a real browser with **a scripted stand-in for the agent**, and then with
> **real Claude Code** as the agent (`AGENT=claude e2e/phase3.sh`): a real model brightened a video and changed its colours,
> declined, in its own words, a request it could not honestly do, and left the note marked "only people" alone. That is a handful
> of runs, enough to show the loop works with a real agent and to find real problems (below), not a measure of how good an agent
> is at your brand's edits. **Nothing was run against real Meta or Google**: phase 2's limits are unchanged, and nothing in phase 3
> depends on them (the loop ends at a new version in review).

## Scope against the specification

| Specification | Status |
| --- | --- |
| Producer API: create piece and variant, signed uploads, close a version, open comments, reply, empty slots | Phase 1, plus `GET /api/token`, `GET /brands/:id/requirements` and the run endpoints below |
| Webhooks signed with HMAC-SHA256, a secret per subscription | Done. Secrets are sealed with `TOKEN_KEY`, shown once, rotatable |
| Unique event id; retried with growing waits for 24 hours | Done: 11 attempts over about 21.7 hours, then given up and shown as such. Redelivery by hand |
| Events: `version.changes_requested`, `version.approved`, `version.rejected`, `comment.created`, `slot.needs_content`, `publication.published`, `publication.failed` | Done. See [the events](#the-events) |
| `slot.needs_content`: an empty slot N days before its date, with the campaign brief | Done. N is per brand (3 by default, 0 turns it off); once per slot occurrence |
| A separate runner process that listens to the webhooks, one agent run per event | Done: [`apps/runner`](../apps/runner/README.md) |
| A per-brand instruction template and a command (Claude Code non-interactive, for example) | Done. Templates with checked placeholders; the command is a configurable list. A Claude Code example is in the runner README |
| Per request for changes: check the piece and month budget, take the piece lock, prepare the workspace with sources, launch the agent with template, comments, anchors and frames | Done. Budget and lock are the studio's, so no runner can skip them |
| Automatic checks: duration, resolution, loudness, covered zones, weight per network | Done with real ffmpeg. Covered zones is a heuristic and only ever warns |
| Upload the version and reply to each comment one by one, "needs a person" for what is unresolved, never silent | Done, including when the agent crashes, times out or says nothing about a comment |
| Safeguards: round cap per piece (3 by default, then a person), budgets per piece and per month, longest run, comments for people only, the agent never approves or schedules | Done. See [the safeguards](#the-safeguards) |
| Commented frame | Every video comment keeps its frame (phase 1). The event carries a signed URL to it, and the runner puts it in the agent's workspace next to the comment's text and anchor |
| Real Claude Code run | Done, a few runs. See [what was verified](#what-was-verified-and-how) |
| Metrics, prize delivery, the remaining networks | Phase 4 and beyond |

## The loop

1. A reviewer or approver asks for changes (or rejects a version). In the same transaction as that decision the studio writes a
   `version.changes_requested` event and one delivery per webhook subscribed to it.
2. A worker delivers it, signed, to the runner. The runner verifies it, queues it durably and answers `202`.
3. The runner asks the studio to **start a run**. The studio refuses, and tells the people responsible, if the piece has used
   its rounds or its budget, if the month's budget is spent, if budgets are not set, or if another run holds the piece.
4. The runner lays out a workspace: the open comments with their anchors, the frame each one points at, the files of the last
   version, what each connected network accepts, the brief and the approval checklist; then runs the agent's command on the
   brand's template.
5. It reads `result.json`, **checks the files**, and if they fail, gives the agent one more attempt with what failed.
6. It uploads the files as a new version, resolving only the comments the agent says it fixed, and **replies to every comment**.
7. The version is in review like any other. People review it, approve it, or ask again, and the round count goes up.

Nothing in 3 to 6 can approve, schedule or publish: the agent signs in with a producer token, which the studio never lets do any
of that (phase 1's rule, unchanged).

## The events

Every delivery is a `POST` of JSON:

```json
{
  "id": "0b7e6f5c-…",                       // unique per event: the same on every retry, so use it to ignore repeats
  "type": "version.changes_requested",
  "created_at": "2026-10-02T06:40:20.123Z",
  "brand": { "id": "…", "name": "Lumen Coffee" },
  "data": { … }
}
```

| Type | When | `data` |
| --- | --- | --- |
| `version.changes_requested` | Changes were requested, a version was rejected, or a person handed a piece back to the agent | `reason` (`changes_requested`, `rejected`, `agent_reset`), `note`, `requested_by`, `piece`, `version`, `comments` (every open thread of the variant, including those carried from earlier versions, with `anchor`, `frame_url`, `people_only`, `replies`), `people_only_open` |
| `version.approved` | A version got the approvals it needs | `piece`, `version`, `accounts`, `approvals` |
| `version.rejected` | A version was rejected | `piece`, `version`, `note`, `rejected_by`. A rejection also sends `version.changes_requested` with reason `rejected` |
| `comment.created` | A comment, a reply, or the note of a request for changes | `piece`, `version`, `comment` (`parent_id` is set for a reply) |
| `slot.needs_content` | A calendar slot is still empty `slot_alert_days` before its date | `slot` (`id`, `label`, `at`, `day`), `account`, `days_ahead`, `campaigns` (name and objective of those running that day) |
| `publication.published` | A post is live (by the app, or recorded by a person) | `piece`, `version`, `publication` (`status`, `scheduled_at`, `published_at`, `url`, `manual`, `placement`, `account`) |
| `publication.failed` | A post could not be published | the same, plus `error` (`class`, `message`) |
| `ping` | The *Send a test* button; always delivered to that webhook only | `message` |

`piece` is `id`, `title`, `kind`, `brief`, `target_date`, `ai_generated`, `campaign_id`. `version` is `id`, `number`, `fingerprint`,
`review_state`, `created_at`, `notes`, `variant` (`id`, `format`, `style`) and `author`. An **anchor** is
`{ "type": "time", "t": 2.5, "t_end": 4 }` for a moment or span of a video, or `{ "type": "region", "page": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1 }`
(fractions of the page) for a point or area. `frame_url` is a signed link to the frame, valid for an hour **from each delivery
attempt**, so a retry hours later still has a working one.

**Ordering is not guaranteed** between different events (a retry of one can arrive after the next). Each carries `id` and
`created_at`: be idempotent, and when order matters read the current state from the API.

### Verifying a delivery

Headers: `x-studio-timestamp` (Unix seconds), `x-studio-signature` (`v1=` and a hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the
webhook's secret), `x-studio-event`, `x-studio-event-id`, `x-studio-delivery`, `user-agent: Studio-Webhooks/1`. The signature is
made again on every attempt, so **reject timestamps more than five minutes old** and a captured delivery cannot be replayed.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {            // rawBody: the bytes as received, before any JSON parsing
  const ts = headers['x-studio-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const given = Buffer.from((headers['x-studio-signature'] ?? '').replace(/^v1=/, ''), 'hex');
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

```python
import hmac, hashlib, time

def verify(secret: str, headers: dict, raw_body: bytes) -> bool:
    ts = headers["x-studio-timestamp"]
    if abs(time.time() - int(ts)) > 300:
        return False
    expected = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v1=" + expected, headers.get("x-studio-signature", ""))
```

### What the studio does when delivery goes wrong

- Any `2xx` is delivery. Anything else, a timeout (10 seconds) or a refused connection is retried after 10 s, 30 s, 2 min, 10 min, 30 min,
  1 h, 2 h, 4 h, 6 h and 8 h: eleven attempts in about 21.7 hours, inside the 24 hours the specification asks for. A `Retry-After`
  is honoured (up to an hour).
- `410 Gone` disables the webhook: the receiver said it is not coming back. A redirect is not followed (and is a failure).
- When a webhook starts failing, approvers and admins get **one** notification per webhook per 24 hours, not one per event.
- *Settings → Webhooks → Deliveries* shows every delivery with its attempts (status, time, the receiver's answer, cut short) and
  **Send again**, which gives it a fresh set of attempts.
- Events are kept for 30 days, then purged. Deliveries survive a restart: they are rows, claimed with a lease, and a sweeper
  picks up anything due.
- A brand can have 20 webhooks. Webhooks need `TOKEN_KEY` (their secrets are sealed with it); without it the screen says so.

### Where a webhook may point

A webhook is the studio making an HTTP request to an address someone typed, so the address is checked **after DNS resolution** (so
a name that resolves to a private address does not get through) and again on connection:

- Link-local (cloud metadata at `169.254.169.254` included), unspecified, multicast and reserved addresses are **always** refused,
  and so are the metadata addresses clouds put elsewhere: AWS's `fd00:ec2::254`, Google's `fd20:ce::254`, Alibaba's `100.100.100.200`,
  Oracle's `192.0.0.192` (all of `192.0.0.0/24`) and Azure's platform endpoint `168.63.129.16`. A private-network setting does not change that.
- Loopback and private ranges are allowed in development and **refused in production**, unless `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`
  (a runner on the same private network, for instance). Plain `http` to a public address is refused in production.
- An IPv6 address that carries an IPv4 one is judged by both, and the stricter answer wins: IPv4-mapped and -compatible addresses,
  NAT64 (`64:ff9b::/96` and `64:ff9b:1::/48`), 6to4 (`2002::/16`) and Teredo (`2001:0::/32`, server and client).

A refusal is final: it is recorded on the delivery with the reason and is not retried.

## The safeguards

All of these are enforced by the studio. The runner reads them but cannot skip them: a different runner, a script with the token,
or a bug would meet the same refusals.

| Safeguard | How it works |
| --- | --- |
| **The agent cannot approve, schedule or manage anything** | Its token is a producer token, and phase 1's role rules (tested) never let one approve, schedule or manage |
| **A token lives no longer than its maker's say** | A producer token works only while the admin who made it is still an admin of the brand. Removing them, or making them anything less than admin, revokes their tokens (in the audit log, with the reason); a change made any other way is caught when the token is next used. *Settings → API tokens* says who made each one. Make the runner's token with an account that stays |
| **Round cap per piece** | 3 by default (*Settings → Agent*). A run counts as a round; refusals and runs closed before they did anything do not. After the cap the piece goes to a person: the studio refuses the next run, notifies approvers and admins once per request, and the piece page says so |
| **Budget per piece and per month** | Both must be set or **the agent does not start** (a missing limit is not "unlimited"). Spending is what the runner reports per run; the month is the calendar month **in the brand's time zone**. A run is given what is left of the piece and of the month **after what the runs still going were given**, and that much is set aside for it until it finishes, so runs at the same time never share more than the budget. The runner passes that to the agent as a hard stop (`--max-budget-usd` for Claude Code). A run the studio closed as a timeout still gets its real cost recorded if the runner reports it late |
| **Longest run** | 30 minutes by default, per brand. The runner stops the agent (SIGTERM, then SIGKILL to its whole process group) and answers every comment with "a person needs to look". The studio enforces it too: a heartbeat never moves the lease past the start plus the longest run plus five minutes to upload and reply, and the worker closes any run past its lease or that time as a timeout and tells approvers and admins (notification kind `agent.timed_out`, of its own: it used to be `agent.failed`) |
| **One run per piece** | A unique database constraint, plus a lease the runner renews every minute. A run that vanished is closed as a timeout after the lease, so a crash never locks a piece. **A producer token uploads a version only inside a run it started on that piece** (or, for a run started for an empty slot, on the piece it made during that run, which no other run can start on until it finishes), so a script with the token cannot skip the round cap, the budgets or the lock |
| **Comments for people only** | A reviewer ticks *Only people* on a comment (or toggles it later). The studio refuses an agent token replying to it, resolving it or claiming to have fixed it; the event and the workspace list it apart from what the agent acts on; and it still counts as open, so **a version with a note for people only cannot be approved until a person deals with it** |
| **Handing a piece back** | An approver can reset a piece's rounds and spending. The request that was waiting is sent to the agent again (reason `agent_reset`) |
| **Never silent** | Every comment the agent was given gets a reply, whatever happens: a crash, a timeout, a failed check, an empty result, a comment it forgot. The reply says a person needs to look |
| **The ledger** | Every run is a row: trigger, round, cost, outcome, version, notes, checks. *Settings → Agent* shows the month's spending against its budget and the recent runs; the piece page shows its own |

## The producer API, as the agent uses it

Everything is under `/api` with `Authorization: Bearer <producer token>`. Phase 1's routes (pieces, variants, signed uploads, closing
a version with `resolves`, comments, replies, slots) are unchanged. Added in this phase:

| Method and path | What it does |
| --- | --- |
| `GET /token` | Whose token this is and which brand it belongs to (the runner checks it on start) |
| `GET /brands/:id/agent`, `PATCH /brands/:id` (`agent`) | The brand's limits and the month's spending. Admins change them |
| `GET /brands/:id/requirements` | Per connected network and placement: what it accepts (types, durations, aspect ratios, safe zones), caption limits, the approval checklist |
| `POST /pieces/:id/agent-runs`, `POST /brands/:id/agent-runs` | Ask to start a run (on a piece, or for an empty slot). `201` with the round and limits, or `409` with why not (`rounds_exhausted`, `piece_budget_reached`, `monthly_budget_reached`, `budget_not_set`, `piece_busy`, `already_handled`). Versions a token uploads outside a run it started are refused (`409 no_run`) |
| `POST /agent-runs/:id/heartbeat`, `POST /agent-runs/:id/finish` | Keep the lease (`409` once the run is over, including past its longest time); close the run with an outcome, cost, notes and the version it made. Finishing a run the studio already closed as a timeout records its cost and leaves it a timeout |
| `GET /pieces/:id/agent`, `POST /pieces/:id/agent/reset` | A piece's rounds, spending and runs; hand it back |
| `POST /comments/:id/people-only` | Mark or unmark a comment (people only, not tokens) |
| Webhook routes: `/brands/:id/webhooks`, `/webhooks/:id` (`PATCH`, `DELETE`), `/rotate-secret`, `/test`, `/deliveries`, `/webhook-deliveries/:id` and `/redeliver` | Manage webhooks and read their deliveries |

## Decisions where the specification left room

- **The event is part of the change.** An event is written in the same transaction as what it describes, with one delivery per
  subscribed webhook. There is never an event for a change that rolled back, nor a change whose event was lost in a crash.
- **A rejection also sends the version back.** `version.rejected` is followed by `version.changes_requested` with reason `rejected`,
  because that is what starts whoever produces. A receiver that cares only about rejections subscribes to the first.
- **Frames are links minted at delivery.** The event stores the frame's key, not a link, so the link in a retry is always fresh.
- **Budgets default to "not set", and not set means stopped.** The specification asks for budgets; the safe reading of a missing one
  is that nothing should spend.
- **Cost is the runner's word.** The studio cannot measure what an agent cost. It records what the runner reports (for Claude Code,
  the `total_cost_usd` it prints, not what the agent writes about itself) and enforces the budgets from those records.
- **Declining is an answer.** An agent that makes nothing but says, for each comment, that it cannot or that a person must, ends its run
  as *needs a person*, in its own words, with approvers notified. That is different from a run that crashed or claimed a fix with nothing
  to show, which is a failure. (A real run showed this was needed: see below.)
- **Warnings do not block, errors do.** A file no connected network can publish (wrong length or aspect) fails the checks; a heavy or
  low-resolution file, loudness, or text under a network's interface becomes a warning in the version's notes, where reviewers see it.
- **Safe zones stay approximate** (phase 2), so *covered zones* is a heuristic that looks for fine detail where a network's interface
  sits. It can only warn.
- **The runner is not in the studio's image.** It runs where the agent's command is installed, with its own queue on disk. One studio
  can serve several runners and one runner several brands.

## What was verified, and how

- **249 API tests against a real PostgreSQL (180 before this phase, 69 new).** New for this phase: the outbox and its transaction guarantee, signing and the
  rotation window, every retry wait and the 24-hour end, `Retry-After`, `410`, redirects, the address policy (including a name that
  resolves to a private address), redelivery, leases and a sweeper restart, each event at every place it is emitted, people-only
  enforcement for tokens, the agent ledger (round cap, both budgets, the month in the brand's time zone, lease expiry, reset, blocked
  starts notifying once), and slot alerts. Rules were broken on purpose, one at a time, to confirm the tests notice: the
  delivery wait schedule and lease, the people-only and event-emission rules, the safeguards (the piece lock, round cap, both
  budgets, token ownership, reset and the month boundary), output-path containment, resuming after a restart, and the
  declined/failed distinction. Two mutants survived at first (path containment and resuming at the first stage); the tests were
  strengthened until they were caught.
- **51 runner tests**, with a real API, real PostgreSQL and real ffmpeg, and a **scripted agent**: signature and replay
  handling, the durable queue and resuming at every stage after a restart, workspace contents, `result.json` handling, output paths
  that try to leave the output directory (including through links), the checks against generated media (length, aspect, loudness,
  true peak, silence, covered zones), retries after a failed check, timeouts, a crashing agent, an agent that forgets a comment,
  an agent that declines, the environment the agent does and does not get, and slot requests.
- **A real-browser run** (`e2e/phase3.sh`): an admin makes the token and webhook in *Settings* and the runner starts from them; *Send a
  test* arrives; a producer uploads; a reviewer comments on a frame, adds a note for people only, and requests changes; version 2
  appears with nobody's hands, marked as made by the agent, with its cost, checks and replies; the comment shows as resolved in v2
  with the agent's reply, and the note for people only is untouched; with one round allowed, the next request is refused and the
  piece says it needs a person; the bell tells the approver, who hands it back and gets version 3; approval is blocked until the
  note for people only is dealt with; the webhook's deliveries and attempts are visible; the new screens fit a phone.
- **The same run with real Claude Code** (`AGENT=claude e2e/phase3.sh`, a 2 USD budget per piece): it passed twice after fixes. The agent
  brightened the video (mean luma 126 to 153, about 21%, for a request of "about 25% brighter", which the agent described as a x1.25
  gain), then changed the saturation, replying to each comment and leaving the note for people only alone. About 0.07 USD per
  run, and the studio recorded the cost Claude Code reported.
- **Problems the real runs and the browser run found, all fixed:**
  - A real agent that was asked to enlarge text it had no way to edit declined honestly, and the runner recorded the run as *failed*
    and replied with a generic "no result" instead of the agent's explanation. Declining is now an answer (above), tested, including
    the cases that must still fail.
  - Claude Code could not run shell commands on the piece's `sources/` folder, which sits outside its working directory. The runner's
    Claude Code example now passes `--add-dir {{pieceDir}}`.
  - A hand-back did not re-trigger the agent: the request that was waiting stayed waiting. It is now sent again.
  - Passing every `CLAUDE_*` variable to the agent (which the first e2e did) would have tied it to the session that launched it. The
    environment the agent gets is an allow-list, and the example passes only sign-in variables, by name.
  - The browser test itself had races (checking a page before its data arrived, and matching a textarea's own text), and the screens
    had a settings tab strip that squashed its labels on a phone; both are fixed.

## Known limits

- **Real Claude Code was run a handful of times**, on a small clip, with simple requests (brighten, change colours). It shows the
  loop works with a real agent; it says nothing about how well an agent handles your brand's real edits. Expect to tune the template.
- **Nothing was run against real Meta or Google** (see phase 2). Phase 3's loop does not need them, but publication events for real
  posts have only been seen with the fakes.
- **The agent executes commands.** `--allowedTools` is Claude Code's permission list, not a sandbox: `ffmpeg` can still be given any
  arguments. The comments an agent reads are text written by your reviewers; "only people" is a rule about who acts, **not a defence
  against instructions hidden in a comment**. So the runner keeps its secrets in files (never in its environment, which an agent of the
  same user reads through `/proc`), runs the agent in a sandbox (`agent.sandbox`: bubblewrap, a container) or as another user
  (`agent.runAs`), closes each brand's directory to everyone else, and refuses to post an agent's result that holds any secret it knows.
  An agent that is neither sandboxed nor another user can still read everything the runner can, and the runner says so when it starts.
  See [Keeping the agent apart](../apps/runner/README.md#keeping-the-agent-apart-from-the-runner).
- **The runner is one process with a queue in files.** Several runners can work for one studio (the studio allows one run per piece),
  but each has its own queue, and a webhook address points to one.
- **Cost is trusted.** A runner that under-reports its spending would be believed; the in-agent budget flag and the run time limit are
  the other brakes.
- **The covered-zones check is a guess**, and the loudness, resolution and weight thresholds are defaults to tune per brand.
- **Webhook delivery is at least once**, never exactly once, and unordered between events.
- **Compose and the S3 driver remain unexercised for real** (as in phases 1 and 2). The Dockerfile now copies the runner's manifest for
  the workspace install, and the dependency install was checked with `npm ci --dry-run` for that layout, but the image was not built.
- **One flaky test was seen once** in about ten full runs (`publisher.test.ts`, "refuses to publish twice when two workers pick it up at
  once", right after the database cold-started) and not again in twenty isolated runs. It was not reproduced, and is not explained.

## Your first real run

1. Set `TOKEN_KEY` (webhooks need it) and start the studio. In *Settings → API tokens* make a producer token; in *Settings → Agent*
   set both budgets, small at first.
2. Copy `apps/runner/config.example.json`, edit the template to say how your brand speaks and what the agent must never invent, put the
   token and the secret in files only the runner's user can read (`tokenFile`, `webhookSecretFile`), check the sandbox, and start the
   runner (see its README). Read its warnings on start.
3. In *Settings → Webhooks* add the runner's address and use *Send a test*.
4. Upload a short video, and as a reviewer comment on a frame and request changes. Watch the piece page: the Agent card shows the run
   as it happens.
5. Read what it did like a reviewer would: the new version's notes list the checks, and each comment has the agent's reply. Open a
   comment's reply and ask whether it says what really changed.
6. Mark one comment *Only people* and check the agent leaves it alone. Set rounds to 1 and ask twice, to see the hand-off.
7. Only then raise the budgets.
