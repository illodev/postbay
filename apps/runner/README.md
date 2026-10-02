# The agent runner

A small program that turns "changes requested" into a new version without anyone passing it on. It listens to the studio's
signed webhooks and, for each request, runs **your agent's command** (Claude Code in non-interactive mode, a script, anything
that reads instructions and writes files), checks what came out, uploads it as a new version and answers every comment.

The studio decides what the agent may do; the runner only does the work. **Every limit that matters is enforced by the
studio, so no runner can skip it**: the agent signs in with a producer token, which can upload and reply but never approve,
schedule or manage anything.

```
studio ──signed webhook──▶ runner ──▶ asks the studio for permission to start (rounds, budgets, one run per piece)
                              │
                              ├─ prepares a workspace: comments, frames, the last version, what each network accepts
                              ├─ runs the agent's command on a template of instructions
                              ├─ checks the output (duration, size, loudness, covered zones, ...)
                              ├─ uploads it as a new version, resolving what was fixed
                              └─ replies to each comment, one by one ("needs a person" for what it could not do)
```

It needs Node 22, `ffmpeg` and `ffprobe` (for the checks), and whatever the agent's command needs. Run it wherever the agent
lives: it only makes outgoing calls to the studio and accepts webhooks from it. It is not part of the studio's Docker image.

## Setting it up

1. **A producer token.** In the studio, *Settings → API tokens*, make one for the agent (role: producer). It is shown once.
2. **A webhook.** *Settings → Webhooks → Add a webhook*: address `http://<runner>:8787/webhooks/<brand key>`, events
   `version.changes_requested` (and `slot.needs_content` if the agent should fill empty slots). The *brand key* is any short
   name you choose in the runner's configuration. The secret is shown once. Use *Send a test*: the runner answers 200 and the
   delivery shows as delivered.
3. **Limits.** *Settings → Agent*: rounds per piece, longest run, **budget per piece and per month** (the agent does not start
   until both budgets are set), and how many days ahead an empty slot is announced.
4. **Configure the runner.** Copy [`config.example.json`](config.example.json), put the token and secret in environment
   variables (`${NAME}` is replaced in any string), and check the paths.
5. **Start it.**

```sh
npm run build -w @estudio/runner
RUNNER_CONFIG=/etc/estudio/runner.config.json node apps/runner/dist/main.js
# development: npm run dev -w @estudio/runner -- /path/to/config.json
```

On start it checks that `ffmpeg` runs and that each token and address works, and says so in the log straight away. `GET /health`
answers `{ ok: true, queued: n }`. Logs are one JSON object per line.

A runner should be reachable by the studio, and only by it: in production webhooks go to public addresses over https unless
the studio sets `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` (see [docs/phase-3.md](../../docs/phase-3.md)). Put it behind a reverse
proxy with TLS, or on the same private network with that setting.

## Configuration

```jsonc
{
  "listen": { "host": "0.0.0.0", "port": 8787 },
  "workspaceRoot": "/var/lib/estudio-runner",       // everything it writes; the queue lives in .state inside it
  "maxConcurrentRuns": 1,                            // 1 to 8; one piece never has two runs at once whatever this says
  "brands": {
    "lumen": {                                        // the key in the webhook address
      "api": "https://studio.example.com",
      "token": "${STUDIO_TOKEN_LUMEN}",
      "webhookSecret": "${WEBHOOK_SECRET_LUMEN}",     // a list works too: both are accepted while a secret is rotated
      "templates": { "version.changes_requested": "templates/changes-requested.md", "slot.needs_content": "templates/slot-needs-content.md" },
      "agent": { /* see below */ },
      "checks": { /* see below */ },
      "checkRetries": 1                               // extra tries when the output fails the checks (each is another agent run)
    }
  }
}
```

An event type with no template is ignored (the runner still answers 200, so the studio does not retry it). Several brands can
share one runner; each has its own token, secret, templates, agent and checks.

### The agent

| Key | Meaning |
| --- | --- |
| `command` | The command as a list. A string may hold `{{placeholders}}`; `{ "if": "maxBudget", "args": [...] }` adds arguments only when that value exists |
| `input` | `stdin` (default): the instructions arrive on standard input. `file`: only as the file `{{instructionsFile}}` |
| `env` | Extra environment for the agent (`${NAME}` works). **The studio's token and the webhook secret are never passed** |
| `cost` | How a run's cost is read: `{ "from": "stdout-json", "path": "total_cost_usd" }` (the last JSON object on the agent's output), `{ "from": "result" }` (the `cost` in `result.json`), or `{ "fixed": 0.5 }` |
| `killGraceSeconds` | After the time allowed, SIGTERM; this many seconds later SIGKILL (to the whole process group) |

Placeholders in `command`: `instructionsFile`, `runDir`, `inputDir`, `outputDir`, `pieceDir`, `maxBudget` (what is left for this
piece), `maxMinutes`, `runId`, `pieceId`.

The agent runs in the run's directory, in its own process group, **without the runner's environment**: it gets `PATH`, `HOME`,
`USER`, `LANG`, `TERM`, `TMPDIR`, `TZ`, the proxy and certificate variables, `agent.env`, and `ESTUDIO_RUN_DIR`,
`ESTUDIO_INPUT_DIR`, `ESTUDIO_OUTPUT_DIR`, `ESTUDIO_SOURCES_DIR`.

### Checks

| Key | Default | Meaning |
| --- | --- | --- |
| `requireNetworks` | `[]` | Networks that must be able to publish the file. Empty: it must suit at least one of the brand's networks |
| `loudness` | `{ min: -23, max: -9 }` | Integrated loudness (LUFS) outside which there is a warning |
| `truePeakMax` | `-1` | True peak (dBTP) above which there is a warning |
| `minShortSide` | `720` | Shorter side in pixels below which there is a warning |
| `coveredZones` | `warn` | Looks for fine detail where a network's own interface covers the picture; `off` skips it |

An **error** (the file cannot be published anywhere: wrong length or aspect ratio, unreadable) fails the run's checks; the agent
gets the failures and another attempt up to `checkRetries`. A **warning** (heavy file, low resolution, loudness, covered zones, an
aspect ratio outside the recommended band) does not stop the upload: it goes into the new version's notes, where reviewers see it.
The covered-zones check is a heuristic, which is why it can only warn.

## Templates

A template is plain text (Markdown works well) with `{{name}}` placeholders. A name the runner does not know is an error when it
starts, not a blank at two in the morning. [`templates/changes-requested.md`](templates/changes-requested.md) and
[`templates/slot-needs-content.md`](templates/slot-needs-content.md) are complete examples: copy them and make them yours. Per
brand is the point: house style, what the agent may and may not invent, and how to talk to the reviewers live there.

| Placeholder | Is |
| --- | --- |
| `brand`, `piece_title`, `piece_brief`, `piece_kind`, `format`, `style` | What the piece is |
| `version_number`, `round`, `max_rounds`, `max_minutes`, `max_cost`, `currency` | Where this run stands and its limits |
| `reason`, `note`, `requested_by` | Why changes were requested (`changes_requested`, `rejected`, `agent_reset`), the note, who |
| `comments` | The comments to act on: where each points, who wrote it, its frame, earlier replies |
| `people_only` | The comments marked for people only, to be left alone |
| `previous_files`, `requirements`, `checklist` | The last version's files, what each network accepts, what approvers tick |
| `failures` | After a failed check: what failed |
| `result_format` | What to write in `result.json` (put it in every template) |
| `input_dir`, `output_dir`, `sources_dir`, `run_dir` | Where things are, relative to the run directory |
| `slot`, `slot_day`, `campaigns` | For an empty slot: which, when, and the campaign briefs |

## The workspace

```
<workspaceRoot>/<brand>/<piece id>/
  sources/                         kept between rounds of the piece: the agent's project files and scripts
  runs/<run id>/
    instructions.md                what the agent was told
    input/  comments.json  people-only.json  requirements.json  brief.md  event.json
            frames/<comment id>.jpg    the frame each comment points at
            previous/                  the files of the version being revised
    output/ ...                    what the agent leaves; result.json goes here
    agent-1.stdout.log  agent-1.stderr.log
    output-attempt-1/              the output of an attempt that failed its checks, moved aside
```

For an empty slot the directory is `_slots_<slot id>-<day>`: there is no piece yet.

## `result.json`: what the agent leaves

```json
{
  "notes": "What changed, for the reviewers.",
  "comments": [
    { "id": "<comment id>", "status": "fixed", "reply": "What was done." },
    { "id": "<comment id>", "status": "cannot_do", "reply": "Why not, specifically." },
    { "id": "<comment id>", "status": "needs_human", "reply": "What a person has to decide." }
  ],
  "files": [ { "path": "reel-v2.mp4", "kind": "video" } ],
  "cost": 0.12
}
```

- `files` is optional: without it, the runner takes what is in `output/`, telling videos, images, PDFs, subtitles (`.vtt`, `.srt`)
  and a `cover.*` apart by name. Every path must be a real file **inside** `output/`; a link leading out of it is refused.
- Only `fixed` comments are resolved by the new version. The rest stay open, with the agent's reply on them.
- **A comment the agent does not mention is still answered**: "the agent did not say what it did about this comment, so a person
  needs to check it". Nothing is left silent.
- For a slot, `piece` (`title`, `kind`, `brief`, `format`, `style`) says what to create.
- **Declining is an answer.** If the agent makes no file and says, for every comment, `cannot_do` or `needs_human`, the run ends as
  *needs a person*: its replies go on the comments as written, no retry is wasted, and approvers and admins are told. Saying
  `fixed` with nothing to show for it, or saying nothing about a comment, is a failed run instead.

## What the runner does with each event

1. Verifies the signature (HMAC-SHA256, five-minute window), drops duplicates by event id, answers `202`, and puts the event in a
   **durable queue** (files in `.state`): a restart picks up each item at the stage it reached.
2. **Asks the studio to start** a run. The studio refuses, and tells the people responsible, when the round cap, the piece's budget,
   the month's budget or a missing budget stops it; when another run holds the piece; or when the event was already handled.
   A refusal is final; "piece busy" is retried.
3. Drops the event if the version has already moved on (a person got there first).
4. Prepares the workspace and runs the agent, with the time left as its limit and a heartbeat to the studio every minute.
5. Reads `result.json`, checks the files, retries the agent if they fail the checks, uploads the version and replies to each comment.
6. Closes the run with its outcome and cost.

| Outcome | When |
| --- | --- |
| `uploaded` | A new version exists |
| `needs_people` | Nothing for the agent to do (everything is for people only), or it declined every comment |
| `failed` | The agent crashed, left nothing usable, claimed a fix with no file, or the studio refused the version (for example identical files) |
| `checks_failed` | The output kept failing the automatic checks |
| `timeout` | The time allowed ran out (`SIGTERM`, then `SIGKILL`) |
| `aborted` | The piece disappeared, or the studio closed the run |

On every outcome that makes no version, **each comment gets a reply** saying a person needs to look. Failed, timed-out and
check-failed runs also notify approvers and admins.

## Claude Code as the agent

```json
"agent": {
  "command": [
    "claude", "-p", "--output-format", "json",
    { "if": "maxBudget", "args": ["--max-budget-usd", "{{maxBudget}}"] },
    "--add-dir", "{{pieceDir}}",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep", "Bash(ffmpeg:*)", "Bash(ffprobe:*)", "Bash(ls:*)", "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)"
  ],
  "input": "stdin",
  "env": { "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}" },
  "cost": { "from": "stdout-json", "path": "total_cost_usd" }
}
```

- `--max-budget-usd` gets what is left for the piece, so the studio's per-piece budget is also a hard stop inside the agent.
- `--add-dir {{pieceDir}}` lets the agent use the piece's `sources/` folder, which sits outside its working directory. Without it
  Claude Code refuses shell commands that touch that folder.
- The agent runs without the runner's environment. If your Claude Code signs in through the environment, pass **by name** only
  what it needs (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`). Do not pass `CLAUDE_*` wholesale: some of
  those variables tie a child process to the session that launched it.
- The cost the studio records is the one Claude Code reports (`total_cost_usd`), not the one the agent writes in `result.json`.

## Running it as a service

```ini
# /etc/systemd/system/estudio-runner.service
[Unit]
Description=Studio agent runner
After=network-online.target

[Service]
User=estudio
WorkingDirectory=/opt/estudio
EnvironmentFile=/etc/estudio/runner.env          # STUDIO_TOKEN_LUMEN=..., WEBHOOK_SECRET_LUMEN=..., ANTHROPIC_API_KEY=...
Environment=RUNNER_CONFIG=/etc/estudio/runner.config.json
ExecStart=/usr/bin/node apps/runner/dist/main.js
Restart=on-failure
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

On SIGTERM the runner stops taking events and tells a running agent to stop; the item stays in the queue and carries on from its
stage after the restart.

## Tests

```sh
npm test -w @estudio/runner
```

The tests use a real PostgreSQL, a real API, real ffmpeg and a **scripted stand-in for the agent** (`test/fake-agent.mjs`, driven by
`FAKE_AGENT_MODE`): they prove everything around the agent, not what a model does with the instructions. `e2e/phase3.sh`
drives the same loop in a browser, and with `AGENT=claude` runs it with Claude Code as the agent (see [e2e/README.md](../../e2e/README.md)).
