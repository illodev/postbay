# Webhooks and the agent

Postbay does not make content; whoever produces it can be a person or an agent. Signed **webhooks** tell a producer what happened, and
the **agent runner** turns a request for changes into a new version without anyone passing it on: a reviewer asks for changes, and a
few minutes later there is a new version in review, with every comment answered. The studio enforces every limit that matters, so no
runner can skip them.

## Webhooks

An admin subscribes an address to events in *Settings → Webhooks*. Every delivery is signed with HMAC-SHA256 and a secret of its own,
shown once (it can be rotated), carries a unique event id, and is retried with growing waits for up to a day. Webhook secrets are
sealed with `TOKEN_KEY`, so webhooks need it; without it the screen says so. A brand can have 20 webhooks.

### Events

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
| `publication.published` | A post is live (published by Postbay, or recorded by a person) | `piece`, `version`, `publication` (`status`, `scheduled_at`, `published_at`, `url`, `manual`, `placement`, `account`) |
| `publication.failed` | A post could not be published | the same, plus `error` (`class`, `message`) |
| `ping` | The *Send a test* button; delivered to that webhook only | `message` |

`piece` is `id`, `title`, `kind`, `brief`, `target_date`, `ai_generated`, `campaign_id` and `source` (where the piece's project lives, or
`null`: see [pieces made with code](#pieces-made-with-code)). `version` is `id`, `number`, `fingerprint`, `review_state`, `created_at`,
`notes`, `variant` (`id`, `format`, `style`) and `author`. The actor of a change (`requested_by`, `rejected_by`…) carries `via` when it
acted through an [assistant](mcp.md).

An **anchor** is `{ "type": "time", "t": 2.5, "t_end": 4 }` for a moment or span of a video (with `track`, `cue` and `cue_text` for a
subtitle line), or `{ "type": "region", "page": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1 }` (fractions of the page) for a point or area.
Either can carry a `drawing`: the shapes a reviewer drew. `frame_url` is a signed link to the frame the comment points at, valid for an
hour **from each delivery attempt**, so a retry hours later still has a working one.

**An event is part of the change it describes**: it is written in the same transaction, with one delivery per subscribed webhook, so
there is never an event for a change that rolled back, nor a change whose event was lost. **Ordering is not guaranteed** between
different events (a retry of one can arrive after the next): be idempotent with `id`, and when order matters read the current state from
the API.

### Verifying a delivery

Headers: `x-studio-timestamp` (Unix seconds), `x-studio-signature` (`v1=` and a hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the
webhook's secret), `x-studio-event`, `x-studio-event-id`, `x-studio-delivery`, and `user-agent: Studio-Webhooks/1`. The signature is made
again on every attempt, so **reject timestamps more than five minutes old** and a captured delivery cannot be replayed.

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

### Delivery and retries

- Any `2xx` is delivery. Anything else, a timeout (10 seconds) or a refused connection is retried after 10 s, 30 s, 2 min, 10 min, 30
  min, 1 h, 2 h, 4 h, 6 h and 8 h: eleven attempts in about 21.7 hours, then given up and shown as such. A `Retry-After` is honoured (up
  to an hour).
- `410 Gone` disables the webhook: the receiver said it is not coming back. A redirect is not followed, and counts as a failure.
- When a webhook starts failing, approvers and admins get **one** notification per webhook per 24 hours, not one per event.
- *Settings → Webhooks → Deliveries* shows every delivery with its attempts (status, time, the receiver's answer, cut short) and **Send
  again**, which gives it a fresh set of attempts.
- Deliveries are rows, claimed with a lease, so they survive a restart; a sweeper picks up anything due. Events are kept for 30 days.
- Delivery is **at least once**, never exactly once.

### Where a webhook may point

A webhook is the server making an HTTP request to an address someone typed, so the address is checked **after DNS resolution** (a name
that resolves to a private address does not get through) and again on connection:

- Link-local addresses (cloud metadata at `169.254.169.254` included), unspecified, multicast and reserved addresses are **always**
  refused, and so are the metadata addresses clouds put elsewhere: AWS's `fd00:ec2::254`, Google's `fd20:ce::254`, Alibaba's
  `100.100.100.200`, Oracle's `192.0.0.192` (all of `192.0.0.0/24`) and Azure's platform endpoint `168.63.129.16`.
- Loopback and private ranges are allowed in development and **refused in production**, unless `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` (a
  runner on the same private network, for instance). Plain `http` to a public address is refused in production.
- An IPv6 address that carries an IPv4 one is judged by both, and the stricter answer wins: IPv4-mapped and -compatible addresses, NAT64
  (`64:ff9b::/96` and `64:ff9b:1::/48`), 6to4 (`2002::/16`) and Teredo (`2001:0::/32`).

A refusal is final: it is recorded on the delivery with the reason and is not retried.

## The agent runner

The runner ([`apps/runner`](../apps/runner/README.md)) is a separate program that listens to the webhooks and runs **your agent's
command** (Claude Code in non-interactive mode, a script, anything that reads instructions and writes files) on a template of
instructions you write per brand. It runs wherever the agent's command is installed, with its own queue on disk, or in
[its own Docker image](../apps/runner/README.md#running-the-runner-on-any-machine). One studio can serve several runners, and one runner
several brands. Its README covers setting it up, the configuration, the templates, the workspace and `result.json`.

The loop:

1. A reviewer or approver asks for changes (or rejects a version). In the same transaction, the studio writes a
   `version.changes_requested` event and one delivery per subscribed webhook.
2. A worker delivers it, signed, to the runner. The runner verifies it, queues it durably and answers `202`.
3. The runner asks the studio to **start a run**. The studio refuses, and tells the people responsible, if the piece has used its rounds
   or its budget, if the month's budget is spent, if the budgets are not set, or if another run holds the piece.
4. The runner lays out a workspace: the open comments with their anchors and drawings, the frame each one points at, the files of the
   last version, what each connected network accepts, the brief and the approval checklist. Then it runs the agent's command on the
   brand's template.
5. It reads `result.json` and **checks the files**: length, aspect ratio, loudness, true peak, silence, weight, and text under a network's
   interface. A file no connected network can publish fails the checks, and the agent gets one more attempt with what failed; a heavy or
   low-resolution file, loudness, or text under a network's interface becomes a warning in the version's notes, where reviewers see it.
6. It uploads the files as a new version, resolving only the comments the agent says it fixed, and **replies to every comment**.
7. The version is in review like any other. People review it, approve it, or ask again, and the round count goes up.

Nothing in steps 3 to 6 can approve, schedule or publish: the agent signs in with a producer token, and the studio never lets one do any
of that (except scheduling what people approved, where the brand allows it: [below](#the-agent-scheduling-what-is-approved)).

**Declining is an answer.** An agent that makes nothing but says, for each comment, that it cannot or that a person must, ends its run as
*needs a person*, in its own words, and the approvers are told. A run that crashed, or claimed a fix with nothing to show, is a failure.

## Safeguards

All of these are enforced by the studio. The runner reads them but cannot skip them: a different runner, a script with the token, or a bug
meets the same refusals. The limits are set per brand in *Settings → Agent*.

| Safeguard | How it works |
| --- | --- |
| **The agent cannot approve or manage anything** | Its token is a producer token, which never approves, manages, cancels or moves anything. Where the brand allows it, it schedules what people approved, from inside a run, and nothing else |
| **A token lives no longer than its maker's say** | A producer token works only while the admin who made it is an active admin of the brand. Removing them, demoting them or deactivating them revokes their tokens (in the audit log, with the reason). *Settings → API tokens* says who made each one: make the runner's token with an account that stays |
| **Round cap per piece** | 3 by default. A run counts as a round; refusals, runs closed before they did anything and runs that only schedule do not. After the cap the piece goes to a person: the studio refuses the next run, tells approvers and admins once per request, and the piece page says so |
| **Budget per piece and per month** | Both must be set or **the agent does not start**: a missing limit is not "unlimited". Spending is what the runner reports per run; the month is the calendar month **in the brand's time zone**. A run is given what is left of the piece's and the month's budget **after what the runs still going were given**, and that much is set aside for it until it finishes, so runs at the same time never share more than the budget. The runner passes it to the agent as a hard stop (`--max-budget-usd` for Claude Code). A run closed as a timeout still gets its real cost recorded if the runner reports it late |
| **Longest run** | 30 minutes by default. The runner stops the agent (SIGTERM, then SIGKILL to its whole process group) and answers every comment with "a person needs to look". The studio enforces it too: a heartbeat never moves the lease past the start plus the longest run plus five minutes to upload and reply, and the worker closes any run past its lease or that time as a timeout and tells approvers and admins (`agent.timed_out`) |
| **One run per piece** | A unique database constraint, plus a lease the runner renews every minute. A run that vanished is closed as a timeout after the lease, so a crash never locks a piece. **A producer token uploads a version only inside a run it started on that piece** (or, for a run started for an empty slot, on the piece it made during that run), so a script with the token cannot skip the round cap, the budgets or the lock |
| **Comments for people only** | A reviewer ticks *Only people* on a comment. The studio refuses an agent token replying to it, resolving it or claiming to have fixed it; the event and the workspace list it apart from what the agent acts on; and it still counts as open, so **a version with a note for people only cannot be approved until a person deals with it** |
| **Handing a piece back** | An approver can reset a piece's rounds and spending. The request that was waiting is sent to the agent again (reason `agent_reset`) |
| **Never silent** | Every comment the agent was given gets a reply, whatever happens: a crash, a timeout, a failed check, an empty result, a comment it forgot. The reply says a person needs to look |
| **The ledger** | Every run is a row: trigger, round, cost, outcome, version, notes, checks. *Settings → Agent* shows the month's spending against its budget and the recent runs; the piece page shows its own |

The cost of a run is the runner's word: the studio cannot measure what an agent spent. It records what the runner reports (for Claude
Code, the `total_cost_usd` it prints, not what the agent writes about itself) and enforces the budgets from those records.

## Pieces made with code

Some pieces are not edited as finished files: they are **made with code**, a project folder (a scene, its assets, voices, a mix script)
that a rendering tool turns into the video. A piece says where its project lives with `source` (on the piece page, or `source` when the
piece is created or edited through the API). The studio does not interpret it: the runner turns it into a working directory, changes the
project and renders it again, in a git worktree and branch of the piece's own, and the new version names the commit it came from. How to
configure it is in the runner's README, [pieces made from a project](../apps/runner/README.md#pieces-made-from-a-project).

## Empty slots asking for content

A [weekly slot](publishing.md#weekly-slots) still empty a set number of days before its date (`slot_alert_days`, 3 by default, 0 turns it
off) sends `slot.needs_content`, once per slot occurrence, with the campaigns running that day. A runner subscribed to it can start a run
for the slot (`POST /api/brands/:id/agent-runs`), make a piece and its first version, and that piece is linked to the slot by itself:
approving it [schedules it there](publishing.md#a-piece-made-for-a-slot).

## The agent scheduling what is approved

A brand setting, **off by default**: *The agent can schedule what is approved* in *Settings → Agent*
(`PATCH /api/brands/:id { agent: { can_schedule_approved: true } }`, admins). While it is on, a producer token **inside an agent run on
that piece that is still going** may `POST /api/versions/:id/publications` (and `…/validate`):

- only a version that is **approved**, only on **accounts the approval covers**, at any time a person could choose (not past, not a
  blocked day, not while paused, nothing the network would refuse);
- it is recorded as the agent's: `scheduled_by: agent`, the token in `created_by_token`, and the token as the actor in the audit log;
- it **never approves**, never schedules what is not approved, and **never cancels or moves anything**, a person's post or its own: those
  routes stay closed to tokens;
- with the setting off it answers `403 agent_cannot_schedule`; outside a run on that piece, `409 no_run`.

Such a run is started with trigger `version.approved` (`POST /api/pieces/:id/agent-runs`). **It is not a round of changes**: the round cap
does not stop it and it does not count towards it (the budgets do), and **no version can be uploaded inside it**. It ends with the outcome
`scheduled` (or `failed`, `needs_people`…). The runner does this with an optional template for `version.approved`: see
[an approved version](../apps/runner/README.md#an-approved-version-scheduling-it).

The endpoints the agent uses are listed in [the API](api.md#agents-and-webhooks).

## Trying the loop

1. Set `TOKEN_KEY` (webhooks need it) and start the studio. In *Settings → API tokens* make a producer token; in *Settings → Agent* set
   both budgets, small at first.
2. Copy `apps/runner/config.example.json`, edit the template to say how your brand speaks and what the agent must never invent, put the
   token and the secret in files only the runner's user can read (`tokenFile`, `webhookSecretFile`), check the sandbox, and start the
   runner (see its README). Read its warnings on start.
3. In *Settings → Webhooks* add the runner's address and use *Send a test*.
4. Upload a short video, and as a reviewer comment on a frame and request changes. The Agent card on the piece page shows the run as it
   happens.
5. Read what it did as a reviewer would: the new version's notes list the checks, and each comment has the agent's reply. Ask whether
   each reply says what really changed.
6. Mark one comment *Only people* and check the agent leaves it alone. Set rounds to 1 and ask twice, to see the hand-off.
7. Only then raise the budgets.

## Known limitations

- **Real agents have been tried only on simple edits** (brightening a clip, changing its colours). Expect to tune the template for your
  brand's real edits.
- **The agent executes commands.** `--allowedTools` is Claude Code's permission list, not a sandbox: `ffmpeg` can still be given any
  arguments. The comments an agent reads are text written by your reviewers, and *Only people* is a rule about who acts, **not a defence
  against instructions hidden in a comment**. So the runner keeps its secrets in files (never in its environment, which an agent of the
  same user can read through `/proc`), runs the agent in a sandbox (`agent.sandbox`: bubblewrap, a container) or as another user
  (`agent.runAs`), closes each brand's directory to everyone else, and refuses to post a result that holds any secret it knows. An agent
  that is neither sandboxed nor another user can still read everything the runner can, and the runner says so when it starts. See
  [keeping the agent apart](../apps/runner/README.md#keeping-the-agent-apart-from-the-runner).
- **One runner, one queue.** Several runners can work for one studio (the studio allows one run per piece), but each has its own queue on
  disk, and a webhook address points to one.
- **Cost is trusted.** A runner that under-reports its spending is believed; the in-agent budget flag and the run time limit are the
  other brakes.
- **The covered-zones check is a guess**, and the loudness, resolution and weight thresholds are defaults to tune per brand.
