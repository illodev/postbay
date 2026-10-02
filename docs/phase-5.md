# Phase 5: ready for a real network, signing in safely, notifications and review polish

The specification has four phases, and the fourth (the rest of the networks, results and prizes) was the last of them. This phase is
what remained between "it works against stand-ins" and "a team can depend on it". Its scope was chosen by the person who asked for it,
from four options, and **all four were chosen**:

1. **Real-network readiness**: a command (and screen buttons) that checks a real setup and says what to fix, plus a first-run
   checklist for each network.
2. **Single sign-on and a second factor**: OpenID Connect sign-in, and a mandatory authenticator app for admins and approvers.
3. **Slack and push notifications**: two more places a notification can go, with each person choosing what they want.
4. **Review polish**: subtitles beside the video, each line commentable; uploads of big files that can be resumed; YouTube watch time.

> **Read this first.** Everything here was proven against **stand-ins** (`apps/api/test/fakes`: an OpenID provider, Slack, a push
> service, an S3 bucket, and the networks of the earlier phases), which I wrote from each service's public documentation. **Nothing was
> run against a real Google Workspace or Microsoft Entra, a real Slack, a real push service (Google's, Mozilla's or Apple's), a real S3 or
> MinIO, or any real social network.** The one exception to "only stand-ins" is the cryptography of push messages: it is checked against
> the worked example in the standard itself (RFC 8291, appendix A), byte for byte.
>
> The readiness checker is the answer to that gap, not a cure for it: it is how the *first real run* finds out where this application and a
> real network disagree, and it records those disagreements in a form that can be sent back and fixed (see [the checker](#the-readiness-checker)).

## Scope against the specification

| | Status |
| --- | --- |
| A way to check a real setup before relying on it | Done: `npm run check`, and *Check* buttons in *Settings → Accounts*. Read-only by default; a real test post only on request, from the command line |
| First-run checklist for each network | Done: [below](#first-run-checklist-per-network) |
| A transcript of what was sent to a network when something does not match | Done: `--capture`, with tokens, secrets and signed query strings removed |
| Single sign-on | Done for any OpenID Connect provider (code flow with PKCE). Written for Google Workspace and Microsoft Entra, tested against a stand-in |
| A second factor for the people who can approve and publish | Done: authenticator app (TOTP) with one-time recovery codes, mandatory for admins and approvers in production |
| Slack | Done: one incoming webhook per brand, chosen kinds of notification, posted once for the team |
| Push messages to browsers | Done: Web Push with the studio's own signing key, encrypted for each browser, chosen per person |
| Subtitles shown beside the video, each line commentable | Done for WebVTT and SubRip files uploaded with a video |
| Uploading large files without losing them to a dropped connection | Done through the app, in pieces that resume (files of 64 MB and more) |
| YouTube watch time | Done through the YouTube Analytics API, **off unless the deployment turns it on** because it needs a sensitive Google permission |

## The readiness checker

```
npm run check -w @estudio/api -- --brand "Acme Spain"                     # the server, then every connected account
npm run check -w @estudio/api -- --brand "Acme Spain" --network threads   # one network
npm run check -w @estudio/api -- --brand "Acme Spain" --json              # for a script
npm run check -w @estudio/api -- --brand "Acme Spain" --capture ./transcripts
npm run check -w @estudio/api -- --brand "Acme Spain" --network bluesky --publish --yes
```

(`npm run check:networks` at the root does the same through the workspace.) In the container:
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm app node apps/api/dist/cli.js check --brand "Acme Spain"`.
It exits with a failure when something failed, so it can sit in a deploy script.

**About the server**, it checks: the token key, that `APP_URL` and `MEDIA_URL` are public and https (networks send people back to the
first and download files from the second), the storage driver, ffmpeg, email, which networks are switched on, how old `LINKEDIN_VERSION`
is, and the Meta webhook's verify token. Each line says what is wrong and what to do.

**About each connected account**, it only reads:

| Check | What it tells you |
| --- | --- |
| Connection | The account is connected and nothing has marked it for reconnecting |
| Stored token / token lifetime | The token opens with this server's `TOKEN_KEY`; when it ends; whether the app renews it by itself |
| Permissions | What the network granted against what the app needs (the messaging permissions only when the brand has prizes on; the YouTube Analytics one only when `GOOGLE_ANALYTICS` is on) |
| Network accepts the connection | A live, light question to the network, with how long it took |
| Reading a post's numbers | The same call the results use, on the account's latest public post, to compare with what the network shows |
| Reading a post's comments | The same call prizes use (only if the brand has prizes on) |

The same checks run from *Settings → Accounts* (*Check* on an account, *Check the server* above the list). The screen **never** publishes.

**A real test post** (`--publish --yes`, command line only) makes *one real post* on each account it checks: a generated picture or
video, sent through the real publishing code (`validate`, `prepare`, `publish`, `verify`). It says what each step answered. **The app
cannot delete it, and does not try:** it prints where the post is, and you delete it. Use a test account.

**The transcript** (`--capture DIR`) writes every call the check made to the networks and what came back, in one JSON file. Tokens,
secrets, `Authorization` headers and signed query strings are removed before anything is written. When a real network answers in a way the app
did not expect, that file is what lets the stand-in be corrected to match. Read it once before you send it anywhere.

### First-run checklist per network

Setting each network up is described in [phase 2](phase-2.md#setting-up-the-networks) (Meta, Google) and
[phase 4](phase-4.md#setting-up-the-networks) (the rest). This is the order to do things in, the same for all of them:

1. Set `APP_URL` and `MEDIA_URL` to the public https addresses, `TOKEN_KEY`, and the network's credentials. Restart.
2. `npm run check -- --brand "…"` with no account connected. Fix every ✖ and read every ⚠ in the *server* section first.
3. Register the redirect address the checker printed (`$APP_URL/api/oauth/callback`) with the network, and connect **one test account** in *Settings → Accounts*.
4. Run the checker again. Fix what it says about permissions and the token before going on.
5. `--publish --yes` for that network. Look at the post on the network. Delete it.
6. Wait for the 1-hour reading, or publish something real, and check *Results* and the checker's *numbers* line against what the network shows.
7. Only then connect the real accounts.

Things worth knowing per network, all from the earlier phases' documents and **unverified against the real services**:

| Network | Watch for |
| --- | --- |
| Facebook and Instagram | The app needs Meta's review before anyone but its own developers can connect. The Instagram account must be professional and linked to a Page. The webhook for prizes needs `META_WEBHOOK_VERIFY_TOKEN` |
| YouTube | Until Google audits the project every upload is private. A consent screen in *Testing* expires refresh tokens after about 7 days. Watch time needs `GOOGLE_ANALYTICS` and a verified project |
| Threads | One token, 60 days, renewed by the app |
| Bluesky | An app password, never the account's password |
| X | Posting is billed per post by X; a link in the text makes it dearer |
| LinkedIn | The API version is retired after about a year: the checker warns before it is |
| Pinterest | The account is a board; pins are visible to others only with Standard access |
| TikTok | Private until audited, and the audit may be refused for a tool that posts for a team |

## Signing in

### Single sign-on

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and **`OIDC_ALLOWED_DOMAINS`** (required: a provider that is open to anyone must
not be open to everyone) and restart; the login page gets a button (`OIDC_LABEL` names it). Register `$APP_URL/api/auth/sso/callback`
with the provider. Google Workspace's issuer is `https://accounts.google.com`; Microsoft Entra's is
`https://login.microsoftonline.com/<tenant>/v2.0`.

How it behaves, on purpose:

- **Only people who already exist can sign in.** Single sign-on proves who someone is; it never creates an account or a role. An admin adds the person first.
- The identity is linked by the provider's `(issuer, sub)`, not by email, so a changed or reassigned email address cannot take over someone's account. The first sign-in links it by a *verified* email in an allowed domain.
- Authorization code with PKCE (S256). The state is single-use (the server keeps only a hash of it, to know it was used) and tied to the browser that started it (login CSRF); the nonce and the verifier are derived from it with the server's secret, so nothing else about a sign-in is stored.
- ID tokens are checked: RS256 signature against the provider's published keys (rotated keys are fetched again), issuer, audience, expiry, nonce, and `email_verified`. Anything else, including `alg: none`, is refused. Google's `hd` claim is checked against the allowed domains.
- `OIDC_TRUST_EMAIL=true` accepts an email the provider does not say is verified. Microsoft Entra does not send the claim; set it only for a single-tenant issuer whose admin controls the addresses.
- `EMAIL_LINK_LOGIN=false` turns the emailed link off for everyone (the server refuses to start with no way left to sign in).

### The second factor

An **authenticator app** (any TOTP app: 30-second codes of 6 digits) is asked of **admins and approvers**: they are the people whose
account can send something to a public network. It is on by default in production (`SECOND_FACTOR_REQUIRED=false` turns it off) and off in
development unless set. Anyone else can turn it on in *Your account*.

- After signing in (by link or single sign-on) the session is **pending** until a code is given; nothing else works. A person without one is taken through setting it up, and is shown **ten recovery codes** once.
- A code works once: replaying a code that was just used is refused (the time step is claimed atomically). One step either side of now is accepted, for clocks that drift.
- Five wrong codes lock the person out for 15 minutes. Recovery codes are stored hashed and each works once.
- Removing the authenticator, or making new recovery codes, needs a current code. A role that needs a second factor cannot remove it.
- **A person who lost their phone and their recovery codes** is reset by an admin (*Settings → Members → Reset authenticator*) or from the command line: `npm run reset-2fa -w @estudio/api -- --email them@example.com`. Their sessions have to do the second step again.
- `OIDC_SECOND_FACTOR=idp` skips the app's second step for single sign-on, **trusting that you enforce one at the provider**. The app cannot see whether you do. The default (`app`) asks anyway.
- The secret is sealed with a key made from `SECRET`; losing `SECRET` makes every authenticator unusable and every person would have to be reset.

## Notifications

*Settings → Notifications* (brands' admins) sets Slack; *Your account* (everyone) sets each person's email and push.

**Slack.** Make an *Incoming Webhook* in Slack and paste its address. It is a secret (anyone who has it can post), so it is **sealed** (needs
`TOKEN_KEY`) and the screen shows only its last four characters. Only Slack's own host is accepted (`SLACK_HOOK_HOST`, only changed to point
tests at a stand-in), so this is not a way to make the server post anywhere. The admin chooses which kinds of notification go there; each
event is posted **once for the team**, not once per person. *Send a test* posts a message now. A post Slack refuses temporarily is tried
again with growing waits; if Slack says the address is gone for good (404, 403, 410), posting stops and the brand's admins are told once.

**Push.** Each person turns it on **per browser** in *Your account*. The studio makes its own signing key the first time one is needed
(sealed in the database), so nothing has to be set up. The message is encrypted for that one browser (RFC 8291) and signed (VAPID); the push
service only carries it. A browser the push service says is gone is forgotten. Push needs https (browsers refuse it otherwise; `localhost`
counts as secure) and a browser that supports it; *Your account* says when that is not the case.

**Who gets what.** Each person chooses, for each kind of notification, whether to receive it by email and whether by push; the usual ones
are on to begin with. A change takes effect for notifications made after it. Whatever is not wanted is still in the bell.

## Review polish

### Subtitles

A video can carry subtitle files (`.vtt`, `.srt`), uploaded with it as before. The review screen now shows them **beside the video**:
every line with its time, the line on screen highlighted as the video plays, a click on a line jumps to it, and **a comment can be written
on a line**. Such a comment stores the file's own times and words, and not what the sender sent: the server reads the line from the
stored file, so a forged line is not possible. The agent receives the line's words and time with the comment.

The parser is forgiving on purpose (files come from many tools): optional hours, comma or dot, short milliseconds, markup and entities
taken out, notes and styles skipped, bad blocks counted and reported rather than hiding the rest. A file over 2 MB, or over 20,000
lines, is not read as subtitles.

### Uploading big files

Files of **64 MB and more** are no longer sent in one request to the bucket. The browser sends them through the app in pieces of 8 MB,
each beginning where the last ended. If the connection drops, or the tab is closed, **choosing the same file again carries on from
where it stopped** (for 24 hours). The pieces wait on the server's disk (`STAGING_DIR`; a volume in the compose file); when all the bytes
are there the server checks the size and hash the producer declared and only then puts the file in storage, so storage never holds
anything unchecked. The version is then closed exactly as before, and closing checks storage once more.

Details that matter: a piece must begin exactly where the file ends and is refused with the right offset otherwise, so a piece sent twice
or a restarted server sort themselves out; pieces for the same upload are applied one at a time; a crash between the disk and the
database is repaired by trusting the database; files nobody will finish are removed. Smaller files still go straight to storage.

> There is no S3 multipart upload here. It would have been the "proper" way for the bucket, but its checksums are composite and do not match the
> plain sha256 that closing a version reads back, and it could not be checked here. The cost: big uploads pass through the app, so the app's
> disk and bandwidth carry them.

### YouTube watch time

With `GOOGLE_ANALYTICS=true` the connection also asks for YouTube's read-only Analytics permission, and the results show **watch time (minutes)**
and the **average view duration** of a video next to the counts. The counts stay the Data API's (Analytics is a few days behind). It is off by
default because Google treats this permission as sensitive: the OAuth project must be verified to use it for other people's channels.

A channel connected before it was switched on must be **connected again** to grant it; until then its readings say so. If Analytics
refuses, or answers in a shape the app does not know, the counts are kept and the missing watch time is explained. A busy or failing Analytics
API makes the reading wait and try again, like the Data API would.

## Decisions where the specification left room

- **Second factor by role, not for everyone.** The people who can approve and publish are the ones whose account is worth stealing. Others may opt in.
- **Single sign-on never creates people.** Roles are the studio's business; the provider only says who someone is.
- **The checker reads by default.** A command that posts for real must be asked twice (`--publish --yes`) and is not on the screen.
- **Push needs no setup**, and Slack needs only the address Slack gives, because both are meant for a small team that self-hosts.
- **Resumable uploads go through the app**, accepting its disk and bandwidth, so that what reaches storage has always been checked.
- **Watch time is opt-in**, so that deployments that cannot get Google's verification keep working unchanged.

## What was verified, and how

All of it with real PostgreSQL, real ffmpeg and stand-ins. For each piece of security-sensitive code (the OpenID verifier and sign-in
flow, TOTP and the second factor, Slack and push delivery, the service worker, resumable uploads, the subtitle parser and the comment
anchor rules, YouTube watch time) I also ran **mutation checks**: break the code in a plausible way (drop a check, flip a comparison, remove
a limit) and confirm a test fails. Survivors were either covered with a new test or shown to be equivalent (dead code, which was then removed).
The final regression also found a defect **in phase 2's publisher**: the lease that keeps two workers from publishing the same post was let go
as soon as publishing *began* (a `return somePromise` inside a `try`/`finally` runs the `finally` before the promise ends), not when it
finished. Two workers picking the same post up within the network call could both publish it. It showed up as a test that failed one run in six.
The lease is now held until the work is done (the same pattern in the webhook delivery was changed too, where it could not matter in practice),
and a new test keeps a slow network call in flight while two more workers try. Phases 2 to 4 were released with the defect.

The tests and the mutation checks found real defects along the way, among them: an empty `Upload-Offset` header read as 0, a service
worker that opened `/undefined` for a push without an address, a subtitle comment checked against the video's length before its line had
been looked up (so a forged time could pass or fail the wrong check), and an SQL statement that set the same column twice.

| | How |
| --- | --- |
| Push encryption | The standard's own worked example (RFC 8291 appendix A) reproduced exactly, and a separate decryptor written as a browser would read it |
| TOTP | The standard's test vectors (RFC 6238) |
| OpenID Connect | A stand-in provider that signs tokens with keys it rotates, and misbehaves on request (wrong audience, expired, replayed state, `alg: none`, another issuer…) |
| Resumable uploads | Interrupted, repeated, concurrent and out-of-order pieces; a lost staging file; a damaged one; expiry; ownership; the S3 `putFile` against a stand-in bucket that refuses a body that does not match its checksum |
| The browser | The phase 5 run (`e2e/phase5.sh`): single sign-on, the second factor and its recovery, Slack, push (with the browser's push API replaced by a recorder and the message decrypted), subtitle comments, and an upload interrupted and resumed. See [e2e/README.md](../e2e/README.md) |

## Known limits

- **Nothing was run against a real provider, Slack, push service, bucket or network.** See the top of this page. The first real run is when the stand-ins get corrected.
- **Push in a real browser** was not exercised: the browser's push API was replaced by a recorder, and delivery through a real push service (which Safari, Chrome and Firefox each do differently) was not. Safari on iPhone only receives push from a site added to the home screen.
- **Authenticator apps** were not tried; the codes were checked against the standard's vectors and a separate generator.
- **Single sign-on with Microsoft Entra** relies on `OIDC_TRUST_EMAIL` and on the tenant's own controls; consumer Microsoft accounts are not supported.
- **Slack**: incoming webhooks only. No buttons, no replies in a thread, no Slack-to-studio direction.
- **No S3 multipart upload** (above); big uploads need disk on the app server, and an upload in progress is lost if its volume is.
- **Subtitles** are shown for files uploaded with the video. Burned-in captions, and times beyond the video's end, are not read.
- **Watch time** is lifetime to date for the video, not per day, and lags a day or two behind.
- **A real test post** cannot be deleted by the app.

## Your first real run

1. Read [the checklist](#first-run-checklist-per-network) and do it for **one** network with a **test account**.
2. For single sign-on, create the client at your provider, set the `OIDC_*` values, add yourself as an admin first, and sign in from a private window. Keep one other way in (the emailed link) until it works.
3. Set up your authenticator, write the recovery codes down, and sign out and in again.
4. Paste a Slack webhook for a test channel and press *Send a test*. Turn push on in your browser and press *Send a test*.
5. Upload a video of more than 64 MB, switch the network off for a few seconds in the middle, and watch it carry on.
