# The API in brief

Everything is under `/api`, JSON in and out. Browsers use a session cookie and must send `X-Requested-By`; agents and scripts use
`Authorization: Bearer <producer token>` ([API tokens](security.md#api-tokens)). Assistants use the [MCP endpoint](mcp.md) at `/api/mcp`
with their own OAuth tokens, which work nowhere else.

Texts for people come in the language of `Accept-Language` (Spanish by default). An error is
`{ "error": { "code": "…", "message": "…", "details": … } }`: `code` is stable, `message` is for people.

The tables below are the routes that matter most; `apps/api/src/routes/index.ts` has them all.

## Pieces, versions and review

| Method and path | What it does |
| --- | --- |
| `GET`, `POST /brands/:id/pieces` | List pieces (`state`, `q`); create one (optionally with `source`, where its project lives, and `slot`: `{ id, at }`, the slot occurrence it is made for) |
| `GET`, `PATCH /pieces/:id`; `POST /pieces/:id/discard` | A piece with its variants, versions and publications; edit it; discard it |
| `POST /pieces/:id/variants` | Add a variant (a format and a style from the brand's list) |
| `POST /variants/:id/uploads` | Declare files with their size and sha256 and get signed upload addresses; with `resumable: true` for a big file, an upload to send in pieces instead |
| `GET`, `PATCH /uploads/:id/resumable`, `POST /uploads/:id/resumable/finish` | Ask how much of a big file has arrived, send the next piece (`Upload-Offset`, raw bytes), and have the whole checked and stored |
| `POST /variants/:id/versions` | Close a version: the uploaded files, notes and the comments it resolves. With a producer token, only inside a run it started on the piece |
| `GET /versions/:id` | A version, with `slot_schedule` (what approving it will schedule at its slot, or why not) and `auto_fill_slots` |
| `GET /versions/:id/comments?status=open&carried=true`, `POST /versions/:id/comments` | Comments with their anchor, drawing and frame; start a thread |
| `POST /comments/:id/replies`, `/resolve`, `/reopen` | Reply (fixed, cannot do and why, or needs a person), resolve, reopen |
| `POST /comments/:id/people-only` | Mark or unmark a comment as for people only (people only, not tokens) |
| `GET /versions/:versionId/subtitles` | The subtitle lines of a version's video |
| `POST /versions/:id/approvals`, `/request-changes` | Decide on a version. An approval may say `autoSchedule: false` and give `scheduleText`, `scheduleFirstComment`; its answer says what was scheduled (`slot_schedule`) |

## Publishing and the calendar

| Method and path | What it does |
| --- | --- |
| `POST /versions/:id/publications/validate` | How a post would go out, and what would block it, before scheduling |
| `POST /versions/:id/publications` | Schedule an approved version on an account (a person; or a producer token inside an agent run, where the brand allows it) |
| `PATCH /publications/:id`; `POST /publications/:id/cancel`, `/confirm`, `/reschedule` | Move or edit, cancel, confirm a change that needs a second approver, bring a held post back onto a new version |
| `POST /publications/:id/retry`, `/hand-over`, `/recheck`; `GET /publications/:id/attempts` | Act on a failed or private post; read every attempt |
| `GET /publications/:id/pack`, `POST /publications/:id/mark-published` | What a person needs to publish by hand; record that it is out, with its link |
| `GET /brands/:id/calendar`, `GET /brands/:id/publications/due` | What is planned (with how each post goes out and who scheduled it) and what a person has to publish now |
| `GET`, `POST /brands/:id/slots`; `DELETE …/slots/:slotId` | The weekly slots; `?status=empty&from=&to=` for those that still ask for content |
| `GET`, `POST /brands/:id/blocked-dates`; `DELETE …/blocked-dates/:day` | Blocked days |
| `POST /brands/:id/pause` | Pause or resume the brand |
| `GET /brands/:id/metrics`, `GET /publications/:id/metrics` | Results per network (never a total across networks); a post's readings |

## Accounts and networks

| Method and path | What it does |
| --- | --- |
| `GET /brands/:id/integrations` | Which networks this server can connect, and what each accepts |
| `POST /brands/:id/connections/:provider` and the pending-connection routes | Connect, choose accounts, reconnect (`meta`, `google`, `threads`, `tiktok`, `linkedin`, `x`, `pinterest`); `…/:provider/credentials` for Bluesky |
| `GET /brands/:id/accounts`; `PATCH`, `DELETE …/accounts/:accountId`; `POST …/disconnect` | The brand's accounts; set the network's approval flag or YouTube's made-for-kids default (`{ "madeForKids": true \| false \| null }`); disconnect |
| `GET /brands/:id/accounts/:accountId/options` | The settings the schedule dialog asks for on that account |
| `POST /brands/:id/accounts/:accountId/check`, `GET /brands/:id/server-check` | The read-only [checks](networks.md#checking-a-real-setup) |

## Agents and webhooks

| Method and path | What it does |
| --- | --- |
| `GET /token` | Whose token this is and which brand it belongs to |
| `GET /brands/:id/requirements` | Per connected network and placement: what it accepts (types, durations, aspect ratios, safe zones), caption limits, the approval checklist, the brand's variant styles |
| `GET /brands/:id/agent`, `PATCH /brands/:id` (`agent`) | The brand's agent limits and the month's spending. Admins change them |
| `POST /pieces/:id/agent-runs`, `POST /brands/:id/agent-runs` | Ask to start a run (on a piece, or for an empty slot). `201` with the round and limits, or `409` with why not (`rounds_exhausted`, `piece_budget_reached`, `monthly_budget_reached`, `budget_not_set`, `piece_busy`, `already_handled`) |
| `POST /agent-runs/:id/heartbeat`, `POST /agent-runs/:id/finish` | Keep the lease (`409` once the run is over); close the run with its outcome, cost, notes and the version it made |
| `GET /pieces/:id/agent`, `POST /pieces/:id/agent/reset` | A piece's rounds, spending and runs; hand it back to the agent |
| `GET`, `POST /brands/:id/webhooks`; `PATCH`, `DELETE /webhooks/:id`; `POST /webhooks/:id/rotate-secret`, `/test` | Manage webhooks, rotate a secret, send a test |
| `GET /webhooks/:id/deliveries`, `GET /webhook-deliveries/:id`, `POST /webhook-deliveries/:id/redeliver` | Read deliveries and their attempts; send one again |

The events and how to verify a delivery are in [webhooks and the agent](agents.md#webhooks).

## Brands, people and notifications

| Method and path | What it does |
| --- | --- |
| `GET /me`, `GET /brands/:id/overview` | Who is signed in, their brands and invitations; what waits for them in a brand |
| `PATCH /brands/:id` | Settings and rules, among them `rules.variant_styles` (in order, at most 30, each up to 40 characters, no two alike), `rules.auto_fill_slots` and `agent.can_schedule_approved` |
| `GET`, `POST /brands/:id/members`; `PATCH`, `DELETE …/members/:memberId` | People and their roles |
| `POST /brands/:id/members/:memberId/deactivate`, `/reactivate`, `/reset-2fa` | Deactivate a member or let them back in (their revoked tokens stay revoked); reset their authenticator |
| `GET /invitations`, `POST /invitations/:id/accept`, `/decline`; `GET`, `DELETE /brands/:id/invitations…` | Invitations for someone from another workspace |
| `GET`, `POST /brands/:id/tokens`; `DELETE …/tokens/:tokenId` | Producer tokens |
| `GET /brands/:id/audit` | The audit log (approvers and admins) |
| `GET /notifications`, `POST /notifications/read` | The bell |
| `GET`, `PUT /notifications/preferences`; `PUT /notifications/locale` | What a person is told by email and push, and the language it is written in (`es`, `en`, or `null` for the brand's) |
| `GET`, `PUT`, `DELETE /brands/:id/slack`; `POST /brands/:id/slack/test` | The brand's Slack address and kinds |
| `GET /push/key`, `POST /push/subscriptions`, `/unsubscribe`, `/test` | Push to this browser |
| `GET`, `POST /brands/:id/prizes`; `POST /brands/:id/prizes/erase`; `GET`, `PUT /publications/:id/prize` | The prize library (a `piece`, a `file` or a `link`), erasing a person, a post's prize rule |
