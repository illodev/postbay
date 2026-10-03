# Security and access

Who can sign in and how, what each role can do, and the rules Postbay enforces whatever the screen or the client.

## Signing in

People sign in with an emailed link, with single sign-on, or both; admins and approvers also give a code from an authenticator app.
Sessions last 14 days. Assistants connected over [MCP](mcp.md) sign in the same way, as the person.

### The emailed link

- A link works once and for 15 minutes.
- Asking for a link answers `202` at once, the same way for everyone: the lookup, the link and the email happen after the answer, so
  neither its timing nor an error from the mail server says whether an account exists. A mail server that fails is logged.
- In production the server refuses to start with email-link sign-in on and no `SMTP_URL`: without a mail server the link would go to the
  log, and a link signs in whoever has it. Without SMTP, other emails are logged by recipient and subject only.
- The request log never holds the link: query values are redacted from every logged URL.
- `EMAIL_LINK_LOGIN=false` turns the emailed link off for everyone (the server refuses to start with no way left to sign in).

### Single sign-on

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and **`OIDC_ALLOWED_DOMAINS`** (required: a provider that is open to anyone must
not be open to everyone) and restart; the sign-in page gets a button (`OIDC_LABEL` names it). Register `$APP_URL/api/auth/sso/callback`
with the provider. Google Workspace's issuer is `https://accounts.google.com`; Microsoft Entra's is
`https://login.microsoftonline.com/<tenant>/v2.0`.

- **Only people who already exist can sign in.** Single sign-on proves who someone is; it never creates an account or a role. An admin
  adds the person first.
- The identity is linked by the provider's `(issuer, sub)`, not by email, so a changed or reassigned email address cannot take over
  someone's account. The first sign-in links it by a *verified* email in an allowed domain.
- Authorization code with PKCE (S256). The state is single-use (the server keeps only a hash of it) and tied to the browser that started
  it; the nonce and the verifier are derived from it with the server's secret, so nothing else about a sign-in is stored.
- ID tokens are checked: RS256 signature against the provider's published keys (rotated keys are fetched again), issuer, audience,
  expiry, nonce, and `email_verified`. Anything else, `alg: none` included, is refused. Google's `hd` claim is checked against the
  allowed domains.
- `OIDC_TRUST_EMAIL=true` accepts an email the provider does not say is verified. Microsoft Entra does not send the claim; set it only
  for a single-tenant issuer whose admin controls the addresses. Consumer Microsoft accounts are not supported.

To set it up: create the client at your provider, set the `OIDC_*` values, add yourself as an admin first, and sign in from a private
window. Keep the emailed link on as another way in until single sign-on works.

### The second factor

An **authenticator app** (any TOTP app: 30-second codes of 6 digits) is asked of **admins and approvers**, the people whose account can
send something to a public network. It is on by default in production (`SECOND_FACTOR_REQUIRED=false` turns it off) and off in development
unless set. Anyone else can turn it on in *Your account*.

- After signing in (by link or single sign-on) the session is **pending** until a code is given; nothing else works. A person without
  an authenticator is taken through setting one up, and is shown **ten recovery codes** once.
- A code works once: a code that was just used is refused (the time step is claimed atomically). One step either side of now is
  accepted, for clocks that drift.
- Five wrong codes lock the person out for 15 minutes. Recovery codes are stored hashed and each works once.
- Removing the authenticator, or making new recovery codes, needs a current code. A role that needs a second factor cannot remove it.
- The secret is sealed with a key made from `SECRET`: losing `SECRET` makes every authenticator unusable, and every person would have to
  be reset.

**A person who lost their phone and their recovery codes** is reset by an admin (*Settings → People → Reset authenticator*) or from the
command line: `npm run reset-2fa -w @estudio/api -- --email them@example.com`.

- The authenticator guards the whole account, not a place in one brand, so **only an admin of every brand the person belongs to** may
  reset it from the screen (`can_reset_second_factor` in the member list says whether you may). Anyone else is refused with
  `not_admin_of_all_brands`, without being told which other brands those are. Whoever runs the server can still do it from the command
  line. Nobody resets their own.
- A reset **ends every session of the person** and spends any sign-in link not used yet, so a new authenticator is set up only after a
  fresh sign-in: a stolen session or link cannot be used to put somebody else's phone on the account. The person is emailed about it, and
  it is in the audit log of each of their brands.

**With single sign-on**, `OIDC_SECOND_FACTOR=idp` skips Postbay's second step for people who sign in that way, **trusting that you enforce
one at the provider**: Postbay cannot see whether you do. The default (`app`) asks anyway. With `idp`, the **emailed link is off by
default**, because a link signs in without the provider and would be a way round its second step. Set `EMAIL_LINK_LOGIN=true` to keep it
as a way in for when the provider is down: a session begun with a link then owes Postbay's own second step whatever the person's role, and
cannot set an authenticator up (people set one up after signing in with single sign-on, under *Your account*, and only then can use a
link).

### Development sign-in

`AUTH_DEV_LOGIN=true` signs in with just an email, for development. It is ignored when `NODE_ENV=production`.

## Roles

Each person has a role per brand, and the same person can hold different roles in different brands. Nothing crosses from one workspace to
another.

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | Everything an approver can, plus manage accounts, people (add, deactivate, reactivate, remove), rules and API tokens. Someone from another workspace is invited and joins only on accepting | Approve what they uploaded; reset the authenticator of someone who also belongs to a brand they do not manage; deactivate themselves, or the brand's last active admin |
| Approver | Everything a reviewer can, plus create pieces, upload, approve or reject, schedule, move dates, pause the brand, and read the audit log | Approve what they uploaded |
| Reviewer | View, comment, request changes, resolve comments | Approve or schedule |
| Producer | Create pieces, upload versions, reply to and resolve comments (a person or an API token; a token uploads inside an agent run, and, where the brand allows it, schedules an approved version inside one) | Start threads, approve, touch accounts, or schedule otherwise; cancel or move a post; discard a piece once something of it is approved or scheduled; take the AI label away after approval |
| Reader | View pieces, the calendar and results | Comment |
| Any role, deactivated | Nothing in that brand: it is as if they were not a member, except that they are told why | Open the brand, or be notified about it |

## Adding people

- A new person, or one already in **the same workspace**, is added straight away (`201`).
- A person who already belongs to **another workspace** is **invited** instead (`202`, `invited: true`): they are emailed, see it in
  `GET /api/me` (`invitations`) and `GET /api/invitations`, and become a member only when they accept, signed in as themselves
  (`POST /api/invitations/:id/accept` or `/decline`). Until then the brand's admins have no say over their account, so an admin cannot
  make someone from another workspace a member of their brand without asking. An invitation lasts 14 days; admins see the waiting ones
  (`GET /api/brands/:id/invitations`) and can cancel them (`DELETE …/invitations/:id`).

## Deactivating a member

Besides removing someone from a brand, an admin can **deactivate** them (*Deactivate* in the member's menu in *Settings → People*), and
**reactivate** them later.

| Method and path | What it does |
| --- | --- |
| `POST /api/brands/:brandId/members/:memberId/deactivate` | `200 { id, active: false, deactivated_at, tokensRevoked }` |
| `POST /api/brands/:brandId/members/:memberId/reactivate` | `200 { id, active: true, role, tokensStillRevoked }` |
| `GET /api/brands/:brandId/members` | Each member carries `active`, `deactivated_at` and `deactivated_by` (the name, or email, of the admin who did it). Deactivated members come after the active ones |
| `GET /api/me` | `brands` lists only the brands where the person is active; `deactivated_in` lists the others (`id`, `name`, `workspace`, `deactivated_at`) |

While deactivated, the person:

- **cannot open the brand.** Every route of it answers `403` with the code `member_deactivated` and a message in the reader's language.
  Someone who never belonged still gets `404`, so a brand's existence is not revealed to strangers. To everything else (role checks, the
  second factor's "is this person an admin or approver anywhere", who may reset whose authenticator) they are not a member of that brand.
  Their sessions are not ended, because they may belong to other brands; the brand is closed to them on every request.
- **is told nothing about it.** No notification is made for them (bell, email, push), what was waiting to be emailed or pushed to them
  about that brand is dropped, and the bell hides that brand's older notifications (they come back if reactivated). Slack is the brand's
  channel, not a person's, and is not affected.
- **loses the producer tokens they made for the brand**: revoked at once (in the audit log as `token.revoked` with reason
  `member_deactivated`), and a token whose maker is deactivated stops working even if its revocation were undone in the database.
  **Reactivating does not bring them back**: an admin makes new ones (`tokensStillRevoked` says how many of theirs are revoked).
- **keeps their history.** Their comments, uploads, approvals and the audit log keep their name. Approvals they gave **still count**: they
  were valid when given, and a version does not lose its approval because an approver was deactivated afterwards.

Only admins deactivate and reactivate. **Nobody deactivates themselves** (`403 cannot_deactivate_self`). **A brand always keeps an active
admin**: the last active admin cannot be deactivated (`409 last_admin`), and removing or demoting the last active admin is refused even
when deactivated admins exist. The brand's admins are locked before anything is decided, so two admins taking each other out at the same
moment happen one after the other, and the second is refused. Deactivating someone already deactivated, or reactivating someone active, is
`409` (`already_deactivated`, `not_deactivated`). Adding a deactivated member again by email is `409 already_member` with
`details.deactivated: true`: reactivate them instead. Both steps are audited (`member.deactivated`, `member.reactivated`, with who, the
role and how many tokens were revoked).

In the web, the member list shows deactivated members apart, with who deactivated them and when, *Reactivate* and *Remove*. A person
deactivated in the brand they had open is told so, the brands they were deactivated in are listed apart in the brand switcher, and a
person deactivated everywhere sees a page saying where.

## API tokens

Producer tokens (*Settings → API tokens*, admins) let an agent or a script act as a producer of one brand. A token is shown once, stored
only as its hash, valid for one brand, and expires (90 days by default, at most a year). It works only while the admin who made it is an
active admin of the brand: removing, demoting or deactivating them revokes it. *Settings → API tokens* says who made each one and when it
was last used. What a token may do is in the [roles](#roles) and the [agent's safeguards](agents.md#safeguards).

## The audit log

Every write is a transaction that also writes the audit log: who (a person, a token, or a person through an assistant, with `via`), what,
and the before and after. The log can only be added to; the database refuses edits, deletions and `TRUNCATE`. Approvers and admins read
it in *Settings → Audit log* (`GET /api/brands/:id/audit`).

## The rules that hold everywhere

| Rule | Where it is enforced |
| --- | --- |
| A version cannot change after it is created | database trigger, plus no code path edits it |
| A version's files, approvals, the record of when it reached its approval, the attempt log and the audit log are append-only | database triggers (also against `TRUNCATE`) |
| An approval counts only for the exact files it was given for | fingerprint recomputed from the file records, and each stored object's size and sha256 read back from storage, on every approve, schedule and publish (`services/versions.ts`) |
| What goes out with the files (the title, the AI label) is what was approved; a producer can add the AI label but never take it away once a version is approved | the approval records both, the publication takes them from it (`services/approvals.ts`, `services/publications.ts`, `services/pieces.ts`) |
| Nobody approves their own upload, whatever their role. What a producer token uploads is the token's, not its maker's: the version and the approval's record name both | `services/approvals.ts` |
| No approval with open comments, an incomplete checklist or no accounts | `services/approvals.ts` |
| A new version voids the previous approval and puts anything scheduled on hold | `services/versions.ts` |
| Only what is approved, for the accounts approved, can be scheduled, even while a new version is being closed | `services/publications.ts` (the variant's lock) |
| Once a version is approved or anything is scheduled, only an approver can discard the piece | `services/pieces.ts` |
| A producer token never approves or manages anything, and never cancels or moves a post. It schedules only where the brand lets the agent schedule what is approved, from inside an agent run on that piece | role resolution in `auth/principal.ts`, `services/publications.ts` |
| Whatever schedules without a person at that moment (the approval of a piece made for a slot, filling free slots, the agent) schedules only a version that is approved, for an account it was approved for, through every check a person's scheduling goes through; each post says who scheduled it (`scheduled_by`: person, auto or agent) | `services/scheduling.ts`, `services/publications.ts` |
| An approver can keep a version out of all of that (`autoSchedule: false`), and Postbay never fills a slot with something approved before it was asked to, or that a person cancelled | `services/approvals.ts`, `services/scheduling.ts` |
| A slot occurrence is filled once | a unique index, and a lock per brand while free slots are filled |
| A producer token stops working when the admin who made it leaves the brand, stops being its admin or is deactivated in it | `services/auth.ts`, `services/brand.ts` |
| A member deactivated in a brand cannot open it, is notified of nothing in it, and keeps their name on everything they did; nobody deactivates themselves, and a brand always keeps an active admin (also on removal and demotion) | `auth/principal.ts`, `services/brand.ts`, `services/notify.ts` |
| Times are stored in UTC with the brand's IANA zone, so 19:00 stays 19:00 after a clock change | `domain/time.ts`, tested across both clock changes |
| The approval is re-checked from the stored files right before anything is sent to a network | `services/publisher.ts` |
| A post that would go out after its hour plus the tolerance is not sent late. Before any repeated send the network is asked, without sending anything, whether it already has the post: if it does the send is finished from it, never made again; if it does not, past the tolerance nothing is sent | `services/publisher.ts`, each connector's `find` |
| While a brand is paused or a date is blocked nothing is prepared or published; what a network holds is taken down, and prepared again afterwards (or handed to a person if its hour passed). Pausing, blocking and unblocking wake the posts concerned at once | `services/publisher.ts`, `services/brand.ts`, the worker's sweep |
| A post that depends on another is not prepared before that one is out, and is held if it will not go out | `services/publisher.ts`, `services/publications.ts` |
| Whatever a network holds for a post that is cancelled, held or failed is taken down, also while it is still being prepared | `services/publisher.ts`, `services/publications.ts`, `services/versions.ts` |
| One worker at a time per post: its lease is renewed while it works and every write it makes is fenced by it | `services/publisher.ts` |
| Network tokens are sealed, bound to their account, and never returned, logged or stored in the attempt history | `crypto.ts`, `connectors/http.ts` |
| An event is written in the same transaction as the change it describes | `services/events.ts`, and the publisher's own steps |
| The request log never holds a secret from a URL: query values (sign-in links, OAuth and sign-on codes and states, signed media) and prize links are redacted | `app.ts` |
| A webhook never reaches cloud metadata or link-local addresses, and in production only public ones over https (unless allowed) | `net.ts` |
| The agent cannot start without both budgets, past its rounds, over a budget (counting what runs in progress were given), or on a piece that already has a run. A run that only schedules what is approved (`version.approved`) is not a round | `services/agent.ts`, a unique index |
| A producer token uploads a version only inside a run it started on that piece (never one that only schedules), and no run outlives its longest time | `services/versions.ts`, `services/agent.ts` |
| A prize made from a piece hands out only the latest approved version of it, and nothing once the piece is discarded | `services/prizes.ts` |
| A brand's unfinished big uploads are capped (`STAGING_MAX_GB_PER_BRAND`), and dropped three days after they began | `services/resumable.ts`, `services/versions.ts` |
| A text kept to be read later is kept as a code beside its English; a change to the English without a code drops the stale translation | `src/i18n`, a database trigger (migration 012) |
| An agent token cannot answer, resolve or claim to fix a comment marked for people only | `services/comments.ts`, `services/versions.ts` |
| An assistant (MCP) acts as the person who connected it, with their role, only in the brands they chose, and approves or requests changes only where the brand allows it and after saying back the version's number and fingerprint; every change is audited as that person, via it | `auth/principal.ts`, `mcp/tools.ts`, `services/audit.ts` |

## Other protections

- **Headers.** Responses carry security headers and a Content-Security-Policy: scripts only from Postbay's own origin, and WebAssembly
  allowed for hashing files and for the PDF viewer.
- **Secrets at rest.** Network tokens, webhook secrets, Slack addresses and Bluesky app passwords are sealed with `TOKEN_KEY`
  (AES-256-GCM); authenticator secrets with a key made from `SECRET`. Sign-in links, sessions, API tokens, recovery codes and MCP tokens
  are stored only as hashes.
- **Media.** The bucket is private; files are reached through short-lived signed addresses, served from a separate media domain.
- **Files.** Uploaded files are read by their own first bytes, and ffmpeg may only read the one file it is given
  ([files](publishing.md#files-what-fits-and-what-is-converted)).

## Known limitations

- **Single sign-on has not yet been tried against a real Google Workspace or Microsoft Entra.** It is tested against a stand-in provider
  that signs tokens with keys it rotates and misbehaves on request (wrong audience, expired, replayed state, `alg: none`, another issuer).
- **Authenticator apps** are checked against the standard's test vectors (RFC 6238) and an independent code generator, not yet against a
  phone app.
