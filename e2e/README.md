# End-to-end tests

Four browser runs: [phase 1's flow](#phase-1-smoke-test), [phase 2's publishing against fake networks](#phase-2-publishing-against-fake-networks), [phase 3's agent loop](#phase-3-the-agent-loop) and [phase 4's other networks, results and prizes](#phase-4-the-other-networks-results-and-prizes).

## Phase 1 smoke test

Drives the real app in a real browser over the whole phase 1 flow, with real ffmpeg and a real PostgreSQL, and fails on
any page error or console error (which includes Content-Security-Policy violations). It takes about half a minute.

It needs Node 22, PostgreSQL, ffmpeg, Python 3, curl and a Chromium. `playwright-core` is a dev dependency; point
`CHROMIUM` at a browser if yours is not at `/opt/pw-browsers/chromium`.

```sh
npm install && npm run build

# 1. A clean database, and the API serving the built web app with the development sign-in on
createdb estudio_e2e
export DATABASE_URL=postgres://localhost/estudio_e2e SECRET=$(openssl rand -hex 32) NODE_ENV=development
export APP_URL=http://localhost:3000 MEDIA_URL=http://localhost:3000 AUTH_DEV_LOGIN=true
export WEB_DIST=$PWD/apps/web/dist STORAGE_LOCAL_DIR=$(mktemp -d)
npm run bootstrap -- --workspace Demo --brand "Lumen Coffee" --timezone Europe/Madrid --admin admin@example.com
npm run dev:api &                      # wait until http://localhost:3000/api/health answers

# 2. Demo members, accounts, checklist and slots, and the files the test uploads
e2e/seed.sh
npm run e2e:assets

# 3. Run it. Screenshots land in e2e/shots
npm run e2e
```

Run it against an empty database each time: it expects the brand to have no pieces. `psql` must be able to reach
`DATABASE_URL`, because one step makes a scheduled post due by editing its time.

The media is WebM because the headless Chromium used to develop this has no H.264 decoder.

## Phase 2: publishing against fake networks

Connects accounts through the real UI, schedules posts, and lets the real worker prepare, publish and verify them, with real
ffmpeg, a real PostgreSQL and a real pg-boss queue. Meta and Google are replaced by the fake servers the API tests use
(`apps/api/test/fakes`), started by `e2e/fakes.mts`, which also stands in for the sign-in pages (it approves every sign-in
at once) and offers a small control surface: `GET /__state` to see what each network received, and `POST /__control` to
reset them, make the next calls fail the way Meta would, or flip YouTube's audit flag.

**What it can and cannot tell you.** It proves the app's own behaviour from the browser down to the database. It cannot prove
that the real Meta and Google behave like the fakes: nothing in it reaches a real network.

One command, from a built checkout:

```sh
npm install && npm run build && npm run e2e:assets          # once
TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5433/postgres npm run e2e:phase2
```

`e2e/phase2.sh` creates a clean database (`estudio_e2e_phase2`), starts the fakes, bootstraps a brand, starts the API with
its worker pointed at the fakes (port 3100; fakes on 4020), runs `e2e/phase2.mjs` and stops everything. Screenshots land in
`e2e/shots-phase2` (override with `SHOTS`). It takes about three minutes, most of it the worker doing real work: converting a
WebM to H.264, uploading, and waiting out the fake networks' "still processing" answers.

It covers: connecting Facebook, Instagram and YouTube (the picker, sealed tokens); the review screen's safe-zone overlay; the
schedule dialog (plan, counters, a blocked over-long caption, the feed preview, opting out to publish by hand); Instagram and
YouTube published by the worker with their history; YouTube private until the audit flag flips; a refused Facebook file that
fails and is handed over to a person and recorded on the Publish page; Facebook holding a post natively and taking it down on
cancel; Instagram's token rejected, the account asking to be reconnected, and the waiting post resuming after the reconnect;
the calendar and Publish page; and a phone-sized screen.

Run it against an empty database each time (the script makes one). To drive it by hand, run `node --import tsx e2e/fakes.mts`,
export the variables it prints before starting the API, and run `node e2e/phase2.mjs` with `BASE_URL`, `FAKES_URL` and
`DATABASE_URL` set.

## Phase 3: the agent loop

Drives a comment all the way to a new version, in a real browser, with the real API and worker, the real runner (started by the test
from what an admin makes in *Settings*), real ffmpeg and a real PostgreSQL. The agent is, by default, **a scripted stand-in**
(`apps/runner/test/fake-agent.mjs`), so the run is fast and the same every time; with `AGENT=claude` it is **real Claude Code**.

```sh
npm install && npm run build && npm run e2e:assets          # once
TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5433/postgres npm run e2e:phase3
```

`e2e/phase3.sh` creates a clean database (`estudio_e2e_phase3`), bootstraps a brand, starts the API with its worker (port 3200),
runs `e2e/phase3.mjs`, and stops everything. The runner listens on 8788 (`RUNNER_PORT`). Screenshots land in `e2e/shots-phase3`
(override with `SHOTS`); a failed step also saves what every open page looked like (`fail-NN-<user>.png`). The scripted run takes
about a minute.

It covers: budgets that must be set before the agent starts; a producer token and a webhook made in the screens, each secret shown
once and never again; the runner connecting with them; *Send a test* arriving; a reviewer commenting on a frame and adding a note for
people only; version 2 appearing with nobody's hands, marked as the agent's, with cost, checks and a reply on every comment; the
comment resolved in v2 while the note for people only is untouched; the round cap sending the piece to a person and the bell telling
the approver; the hand-back and version 3; approval blocked until the note for people only is dealt with; the webhook's deliveries
and attempts; and a phone-sized screen.

### With real Claude Code

```sh
AGENT=claude npm run e2e:phase3
```

**This costs money**: about 0.07 USD per run of the agent in a normal pass (the brand's budget per piece is set to 2 USD in this mode,
and Claude Code is given what is left of it as a hard stop). It needs the `claude` command, signed in the way your environment signs
it in. The test passes the runner only `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` if they
are set (the agent never gets the runner's whole environment), and in this mode the requests are ones a real agent can always do
(brighten, change the colours), so the run does not depend on what a model decides about text it cannot edit. A model is not
deterministic: a pass shows the loop works with a real agent, not that every edit will be good.

## Phase 4: the other networks, results and prizes

Connects Threads, X, LinkedIn, Pinterest, TikTok and Bluesky (and Meta again, with prizes on) through the real screens, schedules
one photo to eight networks, lets the real worker publish it, takes the readings, and runs a prize from a comment to a download.
The networks are the stand-ins in `apps/api/test/fakes`, started by `e2e/fakes.mts` (which now also fakes each network's sign-in page
and offers `meta.scopes`, `meta.comment`, `tiktok.domain` and `tiktok.audited` on its control surface).

```sh
npm install && npm run build && npm run e2e:assets          # once
TEST_DATABASE_ADMIN_URL=postgres://postgres@localhost:5433/postgres npm run e2e:phase4
```

`e2e/phase4.sh` creates a clean database (`estudio_e2e_phase4`), starts the fakes (port 4040), bootstraps a brand, starts the API with its
worker (port 3300, with the readings and comment polling every few seconds), runs `e2e/phase4.mjs` and stops everything. Screenshots land in
`e2e/shots-phase4` (override with `SHOTS`).

**What it can and cannot tell you.** It proves the app's own behaviour from the browser down to the database. It cannot prove that the
real networks answer the way the stand-ins do: they were written from each network's documentation, and nothing in this run reaches a real one.

It covers: a connect button per network; sign-in pages for five of them, a board picker for Pinterest, and a handle and app-password form for
Bluesky (a wrong password refused, the right one never coming back to the page); tokens sealed in the database; the approval flag for TikTok and
Pinterest; the settings each network asks for in the schedule dialog (TikTok's empty privacy choice, unticked permissions, its consent text word for
word and the branded-content rules; alt text; Pinterest's title and link) and only the fields showing being saved; Bluesky's limit counting characters
as a person sees them; the worker publishing to all eight and what each fake received; TikTok kept private until audited; the readings and the results
page, one section per network and never a total across them; prizes (switching them on, a link and a file, the reconnect needed for the permission to
message, the rule and its checks, Meta's signed webhook and its handshake, a private reply within seconds, once per person, the public page and the
download of the exact file, a public link for a network that cannot message, erasing a person, Meta's data-deletion callback and its status page, the
retention purge); and phone-sized screens.
