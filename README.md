# Content Studio

A self-hosted studio that connects three things that usually live apart: whoever produces the content, the team that
reviews it, and the networks where it goes out. Producers upload videos, carousels, posts, stories and PDFs. The team
comments on the exact spot, approves each version for specific accounts and dates, and the app keeps the whole trail.

It does not generate content, it orchestrates it. The producer can be an AI agent or a person: to the app both are the
same kind of client (a producer token or a signed-in user). It serves one brand or several, and nothing in it is
specific to any client: names, time zones, languages and review rules are configuration, never code.

> **Status: the four phases of the plan are done, plus a fifth that the plan did not have.** Review, approval, calendar and assisted publishing work end to end (phase 1); the app can
> publish by itself to Instagram, Facebook Pages and YouTube (phase 2); a comment can become a new version without
> anyone's hands: signed webhooks, an agent runner with safeguards, and automatic checks (phase 3); and it now also
> publishes to TikTok, LinkedIn, X, Threads, Pinterest and Bluesky, reads the numbers each post earned, and gives prizes
> to people who comment a keyword (phase 4). Phase 5 makes it ready for a first real run and for a team: a command that checks
> a real setup, single sign-on and a second factor, Slack and push notifications, subtitles beside the video, big uploads that
> resume, and YouTube watch time. **Phases 2, 4 and 5 were built and tested against stand-ins for the networks, the identity
> provider, Slack and the push services that I wrote from their documentation: none of them was reachable, so a first run with
> real accounts is still to do for every one of them, and TikTok in particular may refuse an app like this. Phase 3 was proven in
> a browser with a scripted agent and with real Claude Code on a few simple requests.** See [docs/phase-1.md](docs/phase-1.md),
> [docs/phase-2.md](docs/phase-2.md), [docs/phase-3.md](docs/phase-3.md), [docs/phase-4.md](docs/phase-4.md) and
> [docs/phase-5.md](docs/phase-5.md) for exactly what is done, what is left out, and the decisions taken where the spec left room.

## What phase 1 does

- **Pieces, variants and versions.** One piece goes out in several shapes (9:16, 4:5, 1:1, 16:9, carousel, document).
  Each variant has numbered, immutable versions made of one or more files.
- **Review where it happens.** A viewer for video (frame by frame, comments on a moment or a span, marks on the
  timeline), images and carousels (a point or an area), and PDFs (a page and an area). Every comment on a video keeps the
  frame it points at. Versions can be compared side by side, with synchronised playback, or flipped.
- **Approval that means something.** An approval is tied to the sha256 fingerprint of the files of one version. Change a
  byte and it stops counting. Nobody can approve what they uploaded, nothing is approved with open comments, and a brand
  can require several approvers and a checklist.
- **Calendar.** Month, week and list views per brand and network, fixed weekly slots that show up as requests for
  content, blocked dates, drag to move, and a pause button that freezes everything scheduled.
- **Assisted publishing.** At the scheduled time the approvers are told, and the app has the files, text and first
  comment ready to copy. A person posts and records it here, with the link.
- **Roles per brand.** Admin, approver, reviewer, producer, reader. The same person can hold different roles in
  different brands, and nothing crosses from one workspace to another.
- **Audit log** that can only be added to, and **notifications** in the app and by email.

## What phase 2 adds

- **Connect accounts.** Sign in with Meta or Google from *Settings → Accounts*, choose which Pages, Instagram accounts
  and channels this brand publishes to, and reconnect or disconnect later. Tokens are sealed with AES-256-GCM.
- **Publish by itself.** A connected account is published to by a worker: it prepares the post shortly before the hour
  (converting the file only when the network would not take it as it is), publishes at the hour, then checks the post is
  really live. Facebook and YouTube hold the post themselves until the hour, so those go out even if the app is down.
- **Failures with a plan.** Revoked connection, rate limit, refused file, temporary error, unsupported content and a
  missed hour each have their own handling, and every attempt is on record. A failed post can be tried again or handed to
  a person.
- **Per-network editing.** The schedule dialog says whether the app or a person will publish, shows each network's limits
  next to the text, what the feed shows before "more", and what would block publishing. The review screen can draw what
  each network's own interface covers over the picture.
- **YouTube before Google's audit.** Uploads are private until the project passes the audit; the app treats that as a
  state, tells the team, and lets an admin flip the account once it passes.

## What phase 3 adds

- **Signed webhooks.** *Settings → Webhooks*: subscribe an address to events (changes requested, approved, rejected, a
  comment, an empty slot, a post published or failed). Every delivery is signed (HMAC-SHA256, a secret per webhook, shown
  once), carries a unique id, and is retried with growing waits for up to 24 hours. Every attempt can be inspected and sent
  again.
- **The agent runner** ([apps/runner](apps/runner/README.md)): a separate program that turns a request for changes into a new
  version. It prepares a workspace with the comments, the frame each one points at, the last version and what each network
  accepts; runs your agent's command (Claude Code, for example) on a template you write per brand; checks the result (length,
  aspect ratio, loudness, weight, text under a network's interface); uploads it; and replies to every comment.
- **Safeguards the studio enforces**, so no runner can skip them: a round cap per piece (3 by default, then a person), budgets
  per piece and per month (the agent does not start until both are set), a longest run, one run per piece, comments marked
  *only people* that the agent cannot answer or resolve, and a token that can never approve or schedule.
- **A ledger.** Every run, its cost and what it did, in *Settings → Agent* and on the piece page, with the month's spending
  against its budget. Approvers and admins are told when a piece goes to a person.
- **Empty slots ask for content.** A slot still empty a few days before its date is announced, with the campaign's brief, so an
  agent can fill it.

## What phase 4 adds

- **Six more networks.** Threads, X, LinkedIn, Pinterest and TikTok connect through their sign-in pages; Bluesky with a handle and an
  app password. Each declares the settings it needs (who can see a TikTok post, alt text, a Pinterest link…) and the schedule dialog
  asks for them. A network that holds posts back until it approves the app (TikTok, Pinterest, YouTube) is shown as *Private*, in its
  own words, until an admin says it has.
- **Results.** Each post is read 1 hour, 1 day, 7 days and 28 days after it goes live (a story: 1, 6 and 22 hours). *Results* shows
  each network on its own and never adds networks together.
- **Prizes for commenting.** A post can carry a prize: whoever comments the keyword gets a file or a link by private message on
  Instagram and Facebook (a public page on the other networks). Switched on per brand, with a confirmation that the post says the reply
  is automatic, Meta's signed webhook, data kept for as short a time as you set, and erasing a person on request or when Meta says so.

## What phase 5 adds

- **A way to check a real setup.** `npm run check` looks at the server (addresses, keys, ffmpeg, the LinkedIn version) and at every
  connected account (is the token accepted, were all the permissions granted, can the numbers be read), and says what to fix. It
  can make one real test post per account, and write a transcript of everything it sent with the secrets removed, so a disagreement
  with a real network can be reported. The same read-only checks are buttons in *Settings → Accounts*.
- **Signing in safely.** Single sign-on with any OpenID Connect provider (Google Workspace, Microsoft Entra), for people who already
  exist; and an authenticator app with recovery codes, required of admins and approvers in production.
- **Slack and push.** A brand posts chosen events to a Slack channel once for the team; each person chooses what they get by email
  and by push in each browser they turned it on in.
- **Review polish.** Subtitle files are shown beside the video, the line being said is marked, and a comment can be written on a line.
  Files of 64 MB and more are sent in pieces that resume after a dropped connection or a closed tab. With one setting on, YouTube watch
  time appears in the results.

## Quick start

You need Node 22, PostgreSQL 16 and ffmpeg.

```sh
npm install
cp .env.example .env                      # the dev scripts read it; edit DATABASE_URL and SECRET
createdb estudio                          # and point DATABASE_URL at it
npm run bootstrap -- --workspace "Acme" --brand "Acme Spain" --timezone Europe/Madrid --admin you@example.com

npm run dev:api                           # http://localhost:3000, applies migrations on start
npm run dev:web                           # http://localhost:5173, proxies /api and /media to the API
```

Set `AUTH_DEV_LOGIN=true` to sign in with just an email while developing; otherwise sign-in links are emailed (or
written to the server log when `SMTP_URL` is not set). Dev sign-in is ignored when `NODE_ENV=production`.

For a single-origin run, the way production works:

```sh
npm run build
WEB_DIST=apps/web/dist APP_URL=http://localhost:3000 MEDIA_URL=http://localhost:3000 node apps/api/dist/server.js
```

## How it is built

```
apps/api    Node 22, TypeScript, Fastify, PostgreSQL (plain SQL), zod
  src/domain      the rules, with no I/O: roles, fingerprint, review states, anchors, time zones
  src/services    one module per concern; every write is a transaction that also writes the audit log
  src/routes      thin HTTP layer
  src/storage     signed-URL storage: local disk for development, S3-compatible (MinIO, S3, R2) for real use
  src/connectors  one connector per network behind a common interface (Instagram, Facebook, YouTube), file profiles, validators
  src/worker.ts   the queue (pg-boss): wakes the publisher and delivers webhooks; all state lives in ordinary rows
  src/net.ts      the address policy for webhooks (checked after DNS resolution)
  src/migrations  SQL; the database itself refuses edits to versions, files, approvals and the audit log
apps/web    React, Vite, TanStack Query; plain CSS, light and dark, works on a phone
apps/runner Node, TypeScript: the agent runner. Listens to webhooks, runs the agent's command, checks and uploads
e2e         real-browser tests: phase 1's flow, phase 2's publishing against fake networks, phase 3's agent loop, phase 4's networks, results and prizes
deploy      Docker Compose with PostgreSQL, MinIO, Caddy (TLS), the app and a worker
```

Files never pass through the app: the producer asks for signed URLs and uploads straight to storage, then closes the
version with each file's sha256. The app re-reads what was stored and refuses anything that does not match what was
declared.

### The rules that hold everywhere

| Rule | Where it is enforced |
| --- | --- |
| A version cannot change after it is created | database trigger, plus no code path edits it |
| A version's files, approvals and the audit log are append-only | database triggers (also against `TRUNCATE`) |
| An approval counts only for the exact files it was given for | fingerprint recomputed from the stored files on every approve, schedule and publish |
| Nobody approves their own upload, whatever their role | `services/approvals.ts` |
| No approval with open comments, an incomplete checklist or no accounts | `services/approvals.ts` |
| A new version voids the previous approval and puts anything scheduled on hold | `services/versions.ts` |
| Only what is approved, for the accounts approved, can be scheduled | `services/publications.ts` |
| A producer token never approves, schedules or manages anything | role resolution in `auth/principal.ts` |
| Times are stored in UTC with the brand's IANA zone, so 19:00 stays 19:00 after a clock change | `domain/time.ts`, tested across both clock changes |
| The approval is re-checked from the stored files right before anything is sent to a network | `services/publisher.ts` |
| A post that would go out after its hour plus the tolerance is not sent late | `services/publisher.ts` |
| Network tokens are sealed, bound to their account, and never returned, logged or stored in the attempt history | `crypto.ts`, `connectors/http.ts` |
| An event is written in the same transaction as the change it describes | `services/events.ts` |
| A webhook never reaches cloud metadata or link-local addresses, and in production only public ones over https (unless allowed) | `net.ts` |
| The agent cannot start without both budgets, past its rounds, over a budget, or on a piece that already has a run | `services/agent.ts`, a unique index |
| An agent token cannot answer, resolve or claim to fix a comment marked for people only | `services/comments.ts`, `services/versions.ts` |

### Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | Everything an approver can, plus manage accounts, people, rules and API tokens | Approve what they uploaded |
| Approver | Everything a reviewer can, plus upload, approve or reject, schedule, move dates, pause the brand | Approve what they uploaded |
| Reviewer | View, comment, request changes, resolve comments | Approve or schedule |
| Producer | Create pieces, upload versions, reply to and resolve comments (a person or an API token) | Approve, schedule or touch accounts |
| Reader | View pieces, the calendar and results | Comment |

## API in brief

Everything is under `/api`, JSON in and out. Browsers use a session cookie (and must send `X-Requested-By`); agents and
scripts use `Authorization: Bearer <producer token>`.

| Method and path | What it does |
| --- | --- |
| `POST /brands/:id/pieces`, `POST /pieces/:id/variants` | Create a piece and add a variant |
| `POST /variants/:id/uploads` | Declare files with their sha256 and get signed upload URLs; with `resumable: true` for a big file, an upload to send in pieces instead |
| `GET`, `PATCH /uploads/:id/resumable`, `POST /uploads/:id/resumable/finish` | Ask how much of a big file has arrived, send the next piece (`Upload-Offset`, raw bytes), and have the whole checked and stored |
| `POST /variants/:id/versions` | Close a version: the uploaded files, notes and the comments it resolves |
| `GET /versions/:id/comments?status=open&carried=true` | Open comments with their anchor and frame |
| `POST /comments/:id/replies` | Reply: fixed, cannot do (and why), or needs a person |
| `GET /brands/:id/slots?status=empty&from=&to=` | Calendar slots that still ask for content |
| `POST /versions/:id/approvals`, `/request-changes` | Decide on a version |
| `POST /versions/:id/publications` | Schedule an approved version on an account |
| `GET /brands/:id/calendar`, `GET /brands/:id/publications/due` | What is planned (with how each post goes out) and what a person has to publish now |
| `POST /versions/:id/publications/validate` | How a post would go out, and what would block it, before scheduling |
| `POST /brands/:id/connections/:provider` and the pending-connection routes | Connect, choose accounts, reconnect (`meta`, `google`) |
| `POST /publications/:id/retry`, `/hand-over`, `/recheck`; `GET /publications/:id/attempts` | Act on a failed or private post; read every attempt |
| `GET /brands/:id/requirements` | What each connected network accepts, for an agent that has to make the file |
| `POST /pieces/:id/agent-runs`, `/agent-runs/:id/heartbeat`, `/agent-runs/:id/finish` | An agent asks to start, keeps its lease, and closes a run with its cost and outcome. The studio refuses past the limits |
| `GET /brands/:id/webhooks`, `POST` and the routes under `/webhooks/:id` | Manage webhooks, send a test, rotate the secret, read deliveries and send one again |
| `POST /comments/:id/people-only` | Mark a comment as for people only |

[docs/phase-3.md](docs/phase-3.md) has the event payloads and how to verify a signature.

## Configuration

See [`.env.example`](.env.example). The ones that matter:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `SECRET` | At least 32 characters; signs local media URLs |
| `APP_URL`, `MEDIA_URL` | Public address of the app, and of the media domain (a separate one in production) |
| `STORAGE_DRIVER` | `local` for development, `s3` for MinIO, S3 or R2 (`S3_*` variables, and `S3_PUBLIC_ENDPOINT` when browsers reach the bucket on a different address than the app does) |
| `SMTP_URL`, `MAIL_FROM` | Email; without it, messages go to the log |
| `WEB_DIST` | Folder with the built web app, so the API serves it |
| `TOKEN_KEY` | 32 bytes in base64 (`openssl rand -base64 32`). Seals network tokens and webhook secrets; required once Meta or Google is set, and for any webhook. **Keep a copy: losing it means connecting every account and replacing every webhook secret** |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | Whether webhooks may point at loopback and private addresses. Default: yes in development, no in production |
| `META_APP_ID`, `META_APP_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The developer apps ([setup in docs/phase-2.md](docs/phase-2.md#setting-up-the-networks)). Without them accounts stay manual |
| `META_LOGIN_CONFIG_ID` (and `META_LOGIN_CONFIG_ID_PRIZES`) | With Facebook Login for Business: the login configuration the sign-in dialog uses instead of a list of permissions (the second one for brands with prizes) ([docs/phase-2.md](docs/phase-2.md#meta-facebook-and-instagram)) |
| `THREADS_*`, `TIKTOK_*`, `LINKEDIN_*` (and `LINKEDIN_VERSION`), `X_*`, `PINTEREST_*` | The other networks' apps ([setup in docs/phase-4.md](docs/phase-4.md#setting-up-the-networks)). Each switches on with its credentials; Bluesky needs only `TOKEN_KEY` |
| `SECOND_FACTOR_REQUIRED`, `EMAIL_LINK_LOGIN` | Whether admins and approvers must give an authenticator code (default: yes in production), and whether the emailed link still signs people in ([docs/phase-5.md](docs/phase-5.md#signing-in)) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS` (and `OIDC_LABEL`, `OIDC_SECOND_FACTOR`, `OIDC_TRUST_EMAIL`) | Single sign-on. The allowed domains are required |
| `GOOGLE_ANALYTICS` | Also ask YouTube for its Analytics permission, so watch time can be read. Off by default: Google treats it as sensitive |
| `STAGING_DIR` | Where big uploads wait while they arrive in pieces (a volume in the compose file) |
| `NOTIFY_SECONDS` | How often notifications are sent by email, Slack and push (30 by default) |
| `META_WEBHOOK_VERIFY_TOKEN` | For prizes: the token Meta sends back when you register `$APP_URL/api/meta/webhook` |
| `METRICS_SWEEP_SECONDS`, `PRIZE_POLL_SECONDS`, `PRIZE_PURGE_SECONDS` | How often readings are taken, comments of posts with a prize are read, and expired people are deleted (120, 180 and 3600 seconds by default) |
| `RUN_WORKERS` | `true` (default) runs the queue inside the API process; `false` when a separate worker runs |

## Tests

```sh
npm test                 # 717 API tests and 53 runner tests, against a real PostgreSQL (and, for some, real ffmpeg and a real pg-boss worker)
npm run typecheck
```

The API tests create a throwaway database per file, so they need a PostgreSQL they can create databases in. Point
`TEST_DATABASE_ADMIN_URL` at it (default `postgres://postgres@localhost:5433/postgres`). They cover the rules above, the
database guarantees (by trying to break them), permissions, isolation between brands, sign-in, and the calendar across
clock changes, for phase 2 the connectors against fake Meta and Google servers and the whole publishing state machine on a
controlled clock, for phase 3 signed delivery with every retry wait, the agent's limits, and the runner against a scripted
agent (the runner's tests also need ffmpeg), for phase 4 every connector against its stand-in (including a post whose answer was lost),
the readings, and prizes with Meta's own rules, and for phase 5 the checker, single sign-on against a stand-in provider that misbehaves on request,
the second factor (against the standards' test vectors), Slack and push (the encryption against the standard's own worked example),
subtitles, resumable uploads (interrupted, repeated, concurrent) and YouTube watch time.

The end-to-end tests drive the real app in a real browser, with real ffmpeg: phase 1's whole flow, phase 2's connecting and
publishing against fake networks, phase 3's comment-to-new-version loop (with a scripted agent, or real Claude Code, which
costs money), phase 4's eight networks, results and prize flow, and phase 5's second factor, single sign-on, Slack, push, subtitles, interrupted
uploads and readiness checks. See [e2e/README.md](e2e/README.md).

## Deploying

[`deploy/`](deploy) has a Docker Compose file with PostgreSQL, MinIO (private, versioned bucket), the app, a worker and
Caddy for automatic TLS on the app and the media domain. The web server runs with `RUN_WORKERS=false`; the worker is the
same image running `worker-main`. It has not been run in the environment this was built in (no Docker daemon there); the
Compose file validates, and the application it starts is the one the end-to-end tests exercise. The media domain has to
be reachable from the internet, because Meta downloads the files it publishes from it. With `STORAGE_DRIVER=s3` the addresses handed to
the networks are the bucket's (`S3_PUBLIC_ENDPOINT`, or `S3_ENDPOINT`), so that is the domain to verify with TikTok for photo posts.

## Not yet

Anything run against a real network, identity provider, Slack or push service (see the box at the top), and the things each phase's
document lists as left out: S3 multipart upload, Slack buttons and replies, watch time per day, and more. Details and reasons in
[docs/phase-1.md](docs/phase-1.md), [docs/phase-2.md](docs/phase-2.md), [docs/phase-3.md](docs/phase-3.md),
[docs/phase-4.md](docs/phase-4.md) and [docs/phase-5.md](docs/phase-5.md), which also list what could not be verified.
