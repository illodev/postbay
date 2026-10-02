# After the phases: deactivating members, scheduling after approval, prizes from the studio

Three decisions the owner took after the five phases, built on top of them. Nothing here changes the rule the whole studio rests on:
**nothing goes out without a person's approval of that very version**. What follows can schedule by itself, but only a version that is
approved, for an account it was approved for, through every check a person's scheduling goes through.

> **Read this first.** Everything here was built and tested against the API and the runner (with the scripted stand-in for the agent).
> **The web app does not show any of it yet**: a redesign of `apps/web` is in progress, and the screens are listed at the end of each
> section as *what the web needs*.

## Deactivating a member

Besides removing someone from a brand, an admin can **deactivate** them, and **reactivate** them later.

| Method and path | What it does |
| --- | --- |
| `POST /api/brands/:brandId/members/:memberId/deactivate` | `200 { id, active: false, deactivated_at, tokensRevoked }` |
| `POST /api/brands/:brandId/members/:memberId/reactivate` | `200 { id, active: true, role, tokensStillRevoked }` |
| `GET /api/brands/:brandId/members` | Each member now carries `active`, `deactivated_at` and `deactivated_by` (the name, or email, of the admin who did it). Deactivated members come after the active ones |
| `GET /api/me` | `brands` lists only the brands where the person is active; `deactivated_in` lists the others (`id`, `name`, `workspace`, `deactivated_at`) |

**While deactivated**, the person:

- **cannot open the brand.** Every route of it answers `403` with the code `member_deactivated` and a message in the reader's language
  ("Te han desactivado en esta marca: no puedes abrirla hasta que un administrador te reactive"). Someone who never belonged still gets
  `404`, so a brand's existence is not revealed to strangers. To everything else (role checks, the second factor's "is this person an
  admin or approver anywhere", who may reset whose authenticator) they are not a member of that brand.
- **is told nothing about it.** No notification is made for them (bell, email, push), and what was already waiting to be emailed or pushed
  to them about that brand is dropped. The bell does not show that brand's older notifications either (they come back if reactivated).
  Slack is the brand's channel, not a person's, and is not affected.
- **loses the producer tokens they made for the brand**: revoked at once (in the audit log as `token.revoked` with reason
  `member_deactivated`), and a token whose maker is deactivated stops working even if its revocation were undone in the database.
  **Reactivating does not bring them back**: an admin makes new ones (`tokensStillRevoked` says how many of theirs are revoked).
- **keeps their history.** Their comments, uploads, approvals and the audit log keep their name. Approvals they gave **still count**: they
  were valid when given, and a version does not lose its approval because an approver was deactivated afterwards.

**Rules.** Only admins deactivate and reactivate (`brand.manage`). **Nobody deactivates themselves** (`403 cannot_deactivate_self`). **A
brand always keeps an active admin**: the last active admin cannot be deactivated (`409 last_admin`), and removing or demoting the last
active admin is refused even when deactivated admins exist. The brand's admins are locked before anything is decided, so two admins taking
each other out at the same moment happen one after the other, and the second is refused. Deactivating someone already deactivated, or
reactivating someone active, is `409` (`already_deactivated`, `not_deactivated`). Adding a deactivated member again by email is
`409 already_member` with `details.deactivated: true`: reactivate them instead. Both steps are audited (`member.deactivated`,
`member.reactivated`, with who, the role and how many tokens were revoked).

**What the web needs** (*Settings → People*): a *Deactivate* / *Reactivate* action per member (not on oneself, and explain `last_admin`);
deactivated members shown apart, greyed, with "Desactivado por {deactivated_by} el {deactivated_at}"; the number of tokens revoked after
deactivating, and on reactivating that the tokens stay revoked. For the person: a clear page when a brand answers `member_deactivated`, and
the brands of `deactivated_in` shown as unavailable in the brand switcher.

## Scheduling after approval

Three ways for something approved to reach the calendar without a person picking the time, each **off unless asked for** and each
recorded: every publication now says who put it there, `scheduled_by`: `person` (with `created_by`), `auto` (the studio, nobody) or
`agent` (with the producer token, `created_by_token`). The calendar and the piece's publications carry `scheduled_by`,
`scheduled_by_name` (the person's name or the token's) and `slot_id` (the slot occurrence it fills, if any). The audit entry
`publication.scheduled` says the same.

What any of them schedules goes through `scheduleVersion` (`services/publications.ts`), the same function a person's scheduling uses:
the brand is not paused, the day is not blocked, the time has not passed, the version is approved for that account and its stored files
are still the approved ones, the order between posts holds, and the network would take it. An approver can keep a version out of all of it.

### A piece made for a slot

A piece can be **made for a slot occurrence**: `slot: { id, at }` (the slot and the instant the calendar gives for that week) on
`POST /api/brands/:id/pieces` or `PATCH /api/pieces/:id` (`null` unlinks it). `at` must be one of the slot's occurrences: its weekday, at
its time, in the brand's zone (`400 invalid_slot` otherwise). **A piece an agent makes in a run started by `slot.needs_content` is linked
to that slot by itself** (the runner also names it), so the piece the agent made for "Tuesday's reel" knows it is for Tuesday.
`GET /api/pieces/:id` returns `slot` (`id`, `at`, `label`, `active`, `removed`, `account`).

**When a version of it gets the approvals it needs, the same approval schedules it at the slot**, for the slot's account, as the approver
(`scheduled_by: person`), with the text and first comment the approver gave (`scheduleText`, `scheduleFirstComment`, both optional). Unless:

| `code` | Why it is not scheduled |
| --- | --- |
| `unticked` | An approver sent `autoSchedule: false`. Any of the approvals that count saying no is enough |
| `awaiting_approvals` | The brand needs more approvals: it will be scheduled by the one that completes them |
| `account_not_approved` | The version was not approved for the slot's account |
| `time_passed`, `brand_paused`, `blocked_date` | The slot's time has passed, the brand is paused, or the day is blocked |
| `slot_taken`, `already_scheduled` | Something else is on that account at that time (or in that occurrence), or this version already is |
| `slot_removed`, `slot_inactive` | The slot was deleted or switched off |
| any scheduling code | What scheduling by hand would have refused (`validation_failed` with the network's issues, `fingerprint_mismatch`…) |

**The approval never fails because of this**: the version is approved all the same, and the answer of `POST /api/versions/:id/approvals`
says what happened in `slot_schedule`: `{ scheduled: true, publication: { id, status, scheduled_at, manual, scheduled_by }, … }`, or
`{ scheduled: false, code, reason }` with the reason in the reader's language.

**Before approving**, `GET /api/versions/:id` says what approving will do, in `slot_schedule` (null for a piece not made for a slot):
`slot` (`id`, `label`), `account` (`id`, `network`, `display_name`), `at`, `day` and `time` in the brand's zone, `timezone`, `ready`
(whether it would be scheduled, if approved for that account without unticking), `summary` (the sentence to show, in the reader's
language: "Se programará el martes 6 a las 19:00 en @cuenta (hueco «Reel de la semana»)"), or `code` and `reason` when it would not,
and `publication_id` once it is there. `approvals[]` now include `auto_schedule`, `schedule_text` and `schedule_first_comment`.

**What the web needs** (the approval dialog): when `slot_schedule` is present, a ticked box with `summary` ("Programar al aprobar"), the
slot's account preselected among the accounts to approve for, and optional text and first comment; when `ready` is false, the `reason`
instead of the box. After approving, show what `slot_schedule` in the answer says (scheduled, with a link to the post; or why not). On the
piece, the slot it was made for (and "hueco eliminado" when `removed`); in the piece form, a way to link a piece to an empty slot of the
calendar (a "Crear pieza para este hueco" from the calendar's empty slot).

### Filling free slots

A brand setting, **off by default**: `PATCH /api/brands/:id { rules: { auto_fill_slots: true } }` (admins). While it is on, the worker
(every `FILL_SLOTS_SECONDS`, 300 by default) puts **approved versions that were never scheduled** into the brand's **free weekly slots**,
as the studio (`scheduled_by: auto`), and tells **whoever approved each one** (a notification of the new kind `publication.auto_scheduled`,
with the account, day, time and slot, in their language; by email unless they turned it off, on push and on the brand's Slack for those
who choose it).

Which versions:

- approved **since the setting was switched on** (`rules.auto_fill_since`, set by the studio): switching it on never sends out everything
  approved months ago and never scheduled;
- **never scheduled at all**: a version whose post a person cancelled is not put back (they meant it), and one already scheduled is left;
- whose variant has nothing else **waiting** (scheduled or on hold for a newer version: a person reschedules those);
- that **no approver unticked** (`autoSchedule: false`);
- oldest approval first.

Which slot (**the matching rule**, `domain/slotfit.ts` and `services/scheduling.ts`): the **earliest free occurrence in the next 14 days**
that

- is on an **account the version was approved for**;
- whose **network takes the piece as it is**: never a story (a feed slot is not a story's place); the variant's format must suit the
  network (Instagram 9:16, 4:5, 1:1 and carousels; Facebook, Threads, X and Bluesky any picture format and carousels; LinkedIn also PDF
  documents; YouTube only videos, 16:9, 9:16 or 1:1); **never TikTok or Pinterest**, whose posts need a setting a person chooses each
  time (who can see it, the board) and would be refused without it;
- for a **piece made for a slot, is that slot** (next week's occurrence when its own has passed or is taken);
- is **free**: nothing on that account at that time, nothing already filling that occurrence; not on a blocked day; and starting after the
  brand's preparation lead (30 minutes by default) from now.

**One per slot occurrence, ever**: a unique index on the occurrence, and a lock per brand while the sweep decides, so two sweeps at once
(a web process and a worker) cannot fill one slot twice. **Never while the brand is paused, never on a blocked day.** If the network would
refuse the post in the earliest slot, the next one is tried (three at most), and the rest waits for the next sweep. It goes out with the
text and first comment the approver gave when approving (or none).

**What the web needs**: in *Settings → Rules*, a switch "Rellenar huecos libres con lo aprobado" (with `auto_fill_since` shown as "desde");
in the approval dialog of a piece not made for a slot, when the version's `auto_fill_slots` is true, the same box ("Programar en el próximo
hueco libre") and the optional text; in the calendar and the piece, a mark for posts with `scheduled_by: auto` ("programada por el estudio")
and `agent` ("programada por el agente", with `scheduled_by_name`); the new notification kind in the bell and the preferences (its label
comes from the API).

### The agent scheduling what is approved

A brand setting, **off by default**: `PATCH /api/brands/:id { agent: { can_schedule_approved: true } }` (admins). While it is on, a
producer token **inside an agent run on the piece that is still going** may `POST /api/versions/:id/publications` (and `…/validate`):

- only a version that is **approved**, only on **accounts the approval covers**, at any time a person could choose (not past, not a blocked
  day, not while paused, nothing the network would refuse);
- it is recorded as the agent's: `scheduled_by: agent`, the token in `created_by_token`, and the token as the actor in the audit log;
- it **never approves**, never schedules what is not approved, and **never cancels or moves anything**, a person's post or its own: those
  routes stay closed to tokens;
- with the setting off: `403 agent_cannot_schedule`; outside a run on that piece: `409 no_run`.

A run for this is started with trigger `version.approved` (`POST /api/pieces/:id/agent-runs`). **It is not a round of changes**: the round
cap does not stop it and it does not count towards it (the budgets do, it spends), and **no version can be uploaded inside it**, so it is
not a way round the cap. It ends with the new outcome `scheduled` (or `failed`, `needs_people`…).

The runner does this with an optional template for `version.approved`: see [the runner's README](../apps/runner/README.md#an-approved-version-scheduling-it).
The agent is shown the version, the accounts it was approved for and their calendar (free slots, what is there, blocked days), and writes
`schedule: [{ versionId, accountId, at, text, firstComment }]` in `result.json`; the runner asks the studio for each, and the run's detail
keeps what was scheduled and what was refused, with the studio's code.

**What the web needs**: in *Settings → Agent*, the switch "El agente puede programar lo aprobado", with a line saying it never approves,
cancels or moves anything; the run list showing `scheduled` runs (and their `detail.scheduled` / `detail.refused`).

## Prizes from a piece of the studio

A prize can now be **a piece of the studio**, besides a file uploaded for it and a link, and it is the recommended kind:
`POST /api/brands/:id/prizes { kind: 'piece', name, pieceId }`.

- **What it hands out is decided at the moment of download**: the **main file** (the PDF of a document, the video, or a carousel's first
  image or video; never a cover or subtitles) of the **latest approved version of the piece**, among all its variants. Approving a new
  version changes the prize for whoever downloads from then on, through the same links. A version that was approved keeps being handed out
  while a newer one is in review: the prize is not taken away by work in progress.
- **A piece with no approved version is refused** (`409 no_approved_version`, "Esa pieza no tiene ninguna versión aprobada: aprueba una
  antes de usarla como premio"), and so is a piece of another brand (`400 unknown_piece`). The same holds when the prize is put on a post.
- **When the approved version disappears** (the piece is discarded), the prize shows as having none (`usable: false`,
  `unavailable_reason`: "Sin versión aprobada" in the reader's language), the public page says it is not available (`available: false`,
  `unavailable_reason`), a download answers `409 no_approved_version` and counts nothing, and a private message waiting to go out waits
  instead of promising nothing (its reason says why; it goes out if a version is approved within Meta's seven days, and fails after).

In the library (`GET /api/brands/:id/prizes`), a piece prize carries `piece` (`id`, `title`) and `version` (`id`, `number`, `format`,
`approved_at`, `file_name`, `mime`): what it would hand out now. The public page (`GET /api/public/prizes/:token`) shows it as a file
(`kind: 'file'`, its `file_name`), and says nothing about the piece.

To know which version was approved last, the studio now keeps **when a version reached its approval** (`version_approved`, append-only,
filled from the audit log for versions approved before): a version's state only says where it is now, and a superseded one may or may not
have been approved.

**What the web needs** (*Settings → Prizes*): a third kind, first and preselected, "Pieza del estudio", with a piece picker (pieces with
an approved version); the list showing for each piece prize its piece and the version it hands out ("v3, aprobada el …"), or "Sin versión
aprobada" in a warning style; the public prize page showing `unavailable_reason` when `available` is false.

## What was verified, and how

All against a real PostgreSQL, through the HTTP API:

- `test/member-deactivation.test.ts`: refused with the code in both languages, `/api/me`, the member list, twice and back; only admins, never
  oneself, re-adding; two admins taking each other out at once (one refused) and the last active admin on removal and demotion; tokens
  revoked, still dead with their revocation undone in the database, and still revoked after reactivation; no notification made, nothing
  waiting emailed, the bell, and names kept on comments, approvals and the audit log.
- `test/scheduling-slots.test.ts`: the version's preview (in both languages) and the approval scheduling at the slot, by the approver, with
  their text; unticked, another account, time passed, paused, blocked, taken, waiting for a second approval, a slot removed; occurrences
  checked; a piece linked by itself in an agent's `slot.needs_content` run.
- `test/scheduling-fill.test.ts`: off by default and only what is approved since; the earliest free slot, as the studio, the approver told;
  the matching table, one per slot, oldest first, a slot piece to its own slot; blocked days, taken slots, paused brands, unticked and
  cancelled versions; two sweeps at once.
- `test/scheduling-agent.test.ts`: off, outside a run, a run on another piece; scheduled as the agent with the audit and the calendar
  saying so; refused for other accounts, past times, blocked days, a paused brand, unapproved versions; never approving, cancelling or
  moving; a scheduling run not counted as a round and refusing uploads.
- `test/prizes.test.ts` (*a prize made from a piece of the studio*): refused without an approved version or from another brand; the file
  handed out changing with the approval, and kept while a new version is in review; a discarded piece, in both languages, the public page,
  the download, a rule refused and a message that waits.
- The runner (`apps/runner/test/loop.test.ts`): the agent scheduling in a free slot of the approved account, what the studio refused next to
  what it scheduled, an agent that schedules nothing (`needs_people`) or only refused things (`failed`), a brand that does not allow it (no
  run), and a slot piece linked to its slot.

## Decisions where the request left room

- **Approvals of a deactivated approver keep counting.** They were valid when given; taking them away would silently unapprove posts.
- **A deactivated member's sessions are not ended**: they may belong to other brands. The brand is closed to them on every request.
- **Who schedules at a slot on approval is the approver** (`scheduled_by: person`): they saw what would happen and left it ticked.
- **Any approver's "no" wins** when several approvals are needed, and the text comes from the latest approval that gave one.
- **Filling free slots starts from when it is switched on**, and **never refills a cancelled version**: both so that switching it on never
  surprises anyone with old content.
- **TikTok and Pinterest are never filled by the studio**, because their posts need a setting chosen per post; a person schedules those.
- **The agent cannot move or cancel even its own posts.** Simpler to reason about, and a person can always do it.
- **A piece prize hands out the last approved version, even while a newer one is in review**, and nothing once the piece is discarded.

## Known limits

- The **web app has none of this yet** (see *what the web needs* above).
- A post the studio schedules by itself has the text the approver gave when approving, or none: there is no caption generated for it.
- A piece prize hands out one file: a carousel gives its first image or video, not all of them.
- Filling free slots looks two weeks ahead and tries at most three slots per version per sweep.
