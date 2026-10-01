# End-to-end tests

Two browser runs: [phase 1's flow](#phase-1-smoke-test) and [phase 2's publishing against fake networks](#phase-2-publishing-against-fake-networks).

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
