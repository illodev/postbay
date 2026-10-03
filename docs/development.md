# Development

## Local setup

You need Node 22, PostgreSQL 16 and ffmpeg (with ffprobe).

```sh
npm install
cp .env.example .env                      # the dev scripts read it; edit DATABASE_URL and SECRET
createdb estudio                          # and point DATABASE_URL at it
npm run bootstrap -- --workspace "Acme" --brand "Acme Spain" --timezone Europe/Madrid --admin you@example.com

npm run dev:api                           # http://localhost:3000, applies migrations on start
npm run dev:web                           # http://localhost:5173, proxies /api, /media and /.well-known to the API
```

Set `AUTH_DEV_LOGIN=true` to sign in with just an email while developing; otherwise sign-in links are emailed (or, outside production,
written to the server log when `SMTP_URL` is not set). The development sign-in is ignored when `NODE_ENV=production`.

`npm run dev:api` runs the web server and the queue in one process. To run the worker apart, set `RUN_WORKERS=false` and start
`npm run worker -w @estudio/api`. Every variable is in [configuration](configuration.md).

For a single-origin run, the way production works:

```sh
npm run build
WEB_DIST=apps/web/dist APP_URL=http://localhost:3000 MEDIA_URL=http://localhost:3000 node apps/api/dist/server.js
```

The agent runner runs with `npm run runner` (or `npm run dev -w @estudio/runner -- /path/to/config.json`); see its
[README](../apps/runner/README.md). The [architecture](architecture.md) says where things are.

### Other commands

| Command | What it does |
| --- | --- |
| `npm run bootstrap -- …` | Makes a workspace, a brand and its first admin |
| `npm run migrate -w @estudio/api` | Applies pending migrations (the API also does it on start) |
| `npm run check:networks -- --brand "…"` | Checks the server and the brand's connected accounts ([networks](networks.md#checking-a-real-setup)) |
| `npm run reset-2fa -w @estudio/api -- --email …` | Removes a person's authenticator ([security](security.md#the-second-factor)) |
| `npm run typecheck` | Type checks the API, the web and the runner |

Migrations are SQL files in `apps/api/src/migrations`, applied in order and tracked by file name: add a new file rather than editing one
that may have run somewhere. Texts for people go in `apps/api/src/i18n/messages` and `apps/web/src/i18n/messages`, in Spanish and English
side by side ([languages](architecture.md#languages)).

## Tests

```sh
npm test                 # the API's and the runner's tests
npm run typecheck
```

The tests run against a real PostgreSQL, and some against real ffmpeg and a real pg-boss worker. The API tests (and the runner's loop
test, which starts a real API) create a throwaway database per file, so they need a PostgreSQL they can create databases in: point
`TEST_DATABASE_ADMIN_URL` at it (default `postgres://postgres@localhost:5433/postgres`). The runner's tests also need ffmpeg.

```sh
cd apps/api && TEST_DATABASE_ADMIN_URL=postgres://… npx vitest run test/review.test.ts    # one file
npm test -w @estudio/runner                                                                # the runner's
```

They cover:

- **the rules** in [security](security.md#the-rules-that-hold-everywhere), and the database guarantees, by trying to break them (editing
  a version, swapping a file hash, rewriting the audit log); permissions and isolation between brands; sign-in, single sign-on against a
  stand-in provider that misbehaves on request, and the second factor against the standard's test vectors;
- **the calendar** across both clock changes, slots, scheduling after approval and filling free slots;
- **publishing**: each connector against a stand-in of its network (`apps/api/test/fakes`), including a post whose answer was lost, and
  the whole publishing state machine on a controlled clock: preparing early, waiting for the hour, retries, rate limits, waiting for a
  reconnect, hand-over, the late tolerance, cancellation and holds taking down what a network holds, a restart in the middle of a step,
  and two workers at once;
- **webhooks and the agent**: signed delivery with every retry wait, the address policy, the agent's limits, and the runner against a
  scripted agent (`apps/runner/test/fake-agent.mjs`);
- **results and prizes**, with Meta's own rules in the stand-in;
- **Slack and push** (the encryption against the standard's own worked example), subtitles, resumable uploads (interrupted, repeated,
  concurrent), and YouTube watch time;
- **every text for people in both languages**: the dictionary, the request's language, texts kept as codes, emails, Slack and push;
- **the MCP server**: OAuth for assistants, and the tools.

The web app has no unit tests of its own: its behaviour is covered by the end-to-end runs.

## End-to-end tests

Five runs drive the real app in a real browser (Chromium, through `playwright-core`), with real ffmpeg, a real PostgreSQL and, where it
matters, the real worker and runner:

| Run | What it drives |
| --- | --- |
| `npm run e2e` | The review flow: upload, comments with real frames, changes requested, a second version, approval, comparing, scheduling, dragging on the calendar, pausing, publishing by hand, a PDF, a carousel, roles and a phone-sized screen |
| `npm run e2e:publishing` | Connecting Facebook, Instagram and YouTube and publishing to them, against stand-in networks |
| `npm run e2e:agent-loop` | A comment becoming a new version through the runner, with a scripted agent or, with `AGENT=claude`, real Claude Code (which costs money) |
| `npm run e2e:networks` | The other six networks, their settings in the schedule dialog, results, and prizes from a comment to a download |
| `npm run e2e:accounts-and-notifications` | The second factor, single sign-on, Slack, push, subtitle comments, interrupted uploads and the readiness checks |

How to run each, and exactly what each covers and cannot prove, is in [e2e/README.md](../e2e/README.md). The test media is WebM, because
headless Chromium has no H.264 decoder.
