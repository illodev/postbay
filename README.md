# Content Studio

A self-hosted studio that connects three things that usually live apart: whoever produces the content, the team that
reviews it, and the networks where it goes out. Producers upload videos, carousels, posts, stories and PDFs. The team
comments on the exact spot, approves each version for specific accounts and dates, and the app keeps the whole trail.

It does not generate content, it orchestrates it. The producer can be an AI agent or a person: to the app both are the
same kind of client (a producer token or a signed-in user). It serves one brand or several, and nothing in it is
specific to any client: names, time zones, languages and review rules are configuration, never code.

> **Status: phase 1 of 4.** Review, approval, calendar and assisted publishing work end to end. Publishing straight to
> the networks' APIs, the agent loop and the extra connectors are the next phases. See [docs/phase-1.md](docs/phase-1.md)
> for exactly what is done, what is deliberately left out, and the decisions taken where the spec left room.

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
  src/migrations  SQL; the database itself refuses edits to versions, files, approvals and the audit log
apps/web    React, Vite, TanStack Query; plain CSS, light and dark, works on a phone
e2e         a real-browser smoke test over the whole flow
deploy      Docker Compose with PostgreSQL, MinIO, Caddy (TLS) and the app
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
| `POST /variants/:id/uploads` | Declare files with their sha256 and get signed upload URLs |
| `POST /variants/:id/versions` | Close a version: the uploaded files, notes and the comments it resolves |
| `GET /versions/:id/comments?status=open&carried=true` | Open comments with their anchor and frame |
| `POST /comments/:id/replies` | Reply: fixed, cannot do (and why), or needs a person |
| `GET /brands/:id/slots?status=empty&from=&to=` | Calendar slots that still ask for content |
| `POST /versions/:id/approvals`, `/request-changes` | Decide on a version |
| `POST /versions/:id/publications` | Schedule an approved version on an account |
| `GET /brands/:id/calendar`, `GET /brands/:id/publications/due` | What is planned and what is due now |

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

## Tests

```sh
npm test                 # 77 tests against a real PostgreSQL
npm run typecheck
```

The API tests create a throwaway database per file, so they need a PostgreSQL they can create databases in. Point
`TEST_DATABASE_ADMIN_URL` at it (default `postgres://postgres@localhost:5433/postgres`). They cover the rules above, the
database guarantees (by trying to break them), permissions, isolation between brands, sign-in, and the calendar across
clock changes.

The end-to-end test drives the real app in a real browser, with real ffmpeg: see [e2e/README.md](e2e/README.md).

## Deploying

[`deploy/`](deploy) has a Docker Compose file with PostgreSQL, MinIO (private, versioned bucket), the app and Caddy for
automatic TLS on the app and the media domain. It has not been run in the environment this phase was built in (no Docker
daemon there); the Compose file validates, and the application it starts is the one the end-to-end test exercises.

## Not in phase 1

Connecting accounts through each network's API and publishing automatically, the agent loop (webhooks, agent runner),
the remaining connectors, metrics, and automatic prize delivery. Also not yet: SSO and two-factor sign-in, push and Slack
notifications, safe-zone overlays and per-network previews and text counters (they depend on what each connector
declares), and subtitle display. Details and reasons in [docs/phase-1.md](docs/phase-1.md).
