# Architecture

## The apps

```
apps/api    Node 22, TypeScript, Fastify, PostgreSQL (plain SQL), zod
  src/domain      the rules, with no I/O: roles, fingerprint, review states, anchors, time zones, which slot fits a version
  src/services    one module per concern; every write is a transaction that also writes the audit log
  src/routes      thin HTTP layer (and the MCP endpoint)
  src/auth        who is asking: sessions, tokens, single sign-on, the second factor
  src/mcp         the MCP server: OAuth for assistants, and the tools
  src/storage     signed-URL storage: local disk for development, S3-compatible (MinIO, S3, R2) for real use
  src/connectors  one connector per network behind a common interface (Instagram, Facebook, YouTube, TikTok, LinkedIn, X, Threads,
                  Pinterest, Bluesky), file profiles, validators
  src/media       what a file really is (by its first bytes), and ffmpeg/ffprobe run with a restricted set of readers
  src/i18n        what the API says to people, in Spanish and English
  src/worker.ts   the queue (pg-boss): wakes the publisher, delivers webhooks, takes readings; all state lives in ordinary rows
  src/net.ts      the address policy for webhooks and typed-in servers (checked after DNS resolution)
  src/migrations  SQL; the database itself refuses edits to versions, files, approvals and the audit log
apps/web    React, Vite, TanStack Query; plain CSS, light and dark, works on a phone; PDFs through PDF.js's legacy build, which
            carries the polyfills that browsers a little behind need
apps/runner Node, TypeScript: the agent runner. Listens to webhooks, runs the agent's command, checks and uploads
e2e         real-browser tests of the whole app
deploy      Docker Compose with PostgreSQL, MinIO, Caddy (TLS), the app and a worker; deploy/runner: the agent runner's own image
```

The API serves the built web app too (`WEB_DIST`), so in production one origin serves both; in development Vite serves the web and
proxies `/api`, `/media` and `/.well-known` to the API.

## The layers of the API

- **Domain** (`src/domain`) holds the rules that need no I/O, so they are tested on their own: what each role may do, the fingerprint,
  the review states, comment anchors, times in a brand's zone, and which slot fits a version.
- **Services** (`src/services`) do the work, one module per concern. Every write is a database transaction that also writes the audit log
  and, where something happened that a webhook can subscribe to, the event and its deliveries. The rules in
  [security](security.md#the-rules-that-hold-everywhere) say which service enforces what.
- **Routes** (`src/routes`) parse the request with zod, call one service and return its answer. The same services serve the web, the
  producer API and the [MCP tools](mcp.md), so an assistant or an agent goes through exactly the checks a person does.
- **Connectors** (`src/connectors`) speak to the networks behind one interface: capabilities, validate, prepare, publish, verify, find (a
  lookup that sends nothing), health, and the readings. A network's own settings are declared by its connector, not hard-coded in the
  screens, and the server checks them.
- **The database** is the source of truth. Triggers refuse edits to versions, their files, approvals, the attempt log and the audit log;
  unique indexes keep one run per piece, one prize per person and one post per slot occurrence.

## How files flow

Files never pass through the app on their way in:

1. The producer (the web, the agent or an assistant) declares each file: name, type, exact size and sha256
   (`POST /api/variants/:id/uploads`).
2. The API answers with a signed address per file. The producer uploads straight to storage with `PUT`; storage refuses any byte that
   differs from what was declared.
3. The producer closes the version (`POST /api/variants/:id/versions`). The API re-reads what was stored and refuses anything that does
   not match what was declared, then fixes the version's fingerprint.

Media is read through short-lived signed addresses on a separate **media domain** (`MEDIA_URL`, or the bucket's public address with S3),
never through the app's own origin. In the Compose deployment the bucket is private and versioned. A file handed to a network is served the same way, with a link
that lasts `PUBLIC_MEDIA_TTL_SECONDS`.

Every file is read by its own first bytes, not by its name or declared type, and ffprobe and ffmpeg are told which reader to use and that
they may only read that file ([files](publishing.md#files-what-fits-and-what-is-converted)).

### Big uploads

Files of **64 MB and more** are sent through the app instead, in pieces of 8 MB, each beginning where the last ended
(`GET`/`PATCH /api/uploads/:id/resumable`, `POST /api/uploads/:id/resumable/finish`). If the connection drops, or the tab is closed,
**choosing the same file again carries on from where it stopped**, for 24 hours after the last piece and never more than three days after
the upload began.

- The pieces wait on the server's disk (`STAGING_DIR`; a volume in the Compose file). What one brand may have waiting there is capped
  (`STAGING_MAX_GB_PER_BRAND`, 20 GB by default, counting what unfinished uploads declared): past it a new big upload is refused until
  others finish or expire.
- A piece must begin exactly where the file ends, and is refused with the right offset otherwise, so a piece sent twice or a restarted
  server sort themselves out. Pieces for the same upload are applied one at a time. A crash between the disk and the database is repaired
  by trusting the database, and files nobody will finish are removed.
- When all the bytes are there, the server checks the size and hash the producer declared, and only then puts the file in storage, so
  storage never holds anything unchecked. The version is then closed as usual, and closing checks storage once more.

Big uploads use the app's disk and bandwidth, because S3 multipart checksums are composite and would not match the plain sha256 that
closing a version reads back.

## The queue and the worker

The worker runs the queue (pg-boss, in the same PostgreSQL, so there is nothing else to run). It prepares, publishes and verifies posts,
delivers webhooks, checks account health, takes readings, reads comments for prizes, fills free slots, closes agent runs past their time,
announces posts due by hand, and sends email, Slack and push.

- **The database is the source of truth, the queue only a doorbell.** pg-boss delivers "look at publication X"; the state machine,
  retries, leases and the attempt log live in ordinary rows, so they can be read, audited and repaired with SQL, and the queue can be
  dropped and rebuilt without losing anything. A lost, repeated or late wake-up is harmless, and a sweep every `WORKER_SWEEP_SECONDS` finds
  whatever is due.
- **More than one worker is fine.** Each publication, delivery and reading is claimed with a lease, renewed while the work goes on, and
  every write is fenced by it ([when the worker stops](publishing.md#when-the-worker-stops-in-the-middle)).
- **By default** the API process runs the worker too (`RUN_WORKERS=true`). **The Compose deployment** runs the web server with
  `RUN_WORKERS=false` and a separate `worker` process (`apps/api/dist/worker-main.js`), so a slow conversion never competes with a page
  load.
- The worker needs **ffmpeg** and enough disk for a conversion.

## Languages

Postbay speaks **Spanish** (the default) **and English**, and no other language.

- **What the API says while answering** (a check's result, a scheduling issue, an error) follows the request's `Accept-Language`: `en` and
  its variants for English, anything else for Spanish. The web sends its interface language.
- **What it keeps to be read later** (why a post is on hold or failed, the attempt history, why a prize was not sent, the studio's note on
  an agent run) is kept as a code next to the English, and read in each reader's language. A change to the English without a code drops
  the stale translation (a database trigger). A kept text without a code, such as a note written by the runner, is shown in English.
- **Emails, Slack and push** go in the person's own language if they chose one, otherwise in the brand's
  ([notifications](notifications.md#languages)).
- **What a network says** in its own words, and the agent's own notes, are passed on as they came.

The words are in [`apps/api/src/i18n/messages`](../apps/api/src/i18n/messages) and [`apps/web/src/i18n/messages`](../apps/web/src/i18n/messages),
both languages side by side; TypeScript checks that each language has the same keys.

## Time zones

Each brand has an IANA time zone. Times are stored in UTC with the brand's zone, so 19:00 stays 19:00 after a clock change; the calendar,
slots, blocked days, the agent's monthly budget and the MCP tools all work in the brand's zone.
