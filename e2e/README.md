# End-to-end smoke test

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
