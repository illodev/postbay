# Phase 2: publishing to Instagram, Facebook and YouTube

This follows the delivery plan in the technical specification ("Estudio de contenidos: especificación técnica"): phase 2
is *publish*: connectors with a common interface, OAuth and token storage, a queue with retries, preparation shortly
before the hour, verification afterwards, per-network validation and previews, and an attempt log. It covers Instagram,
Facebook Pages and YouTube.

> **Read this first.** Everything in phase 2 was built and tested against **fake Meta and Google servers** that I wrote
> from how the APIs are documented to behave. The environment this was built in could not reach either company, so
> **no real call was ever made**. The app's own behaviour (ordering of calls, retries, error handling, state machine,
> screens) is proven. Whether Meta and Google still behave the way the fakes do is not. Treat the first run with real
> accounts as part of the build: see [Your first real run](#your-first-real-run).

## Scope against the specification

| Specification | Status |
| --- | --- |
| Connector interface: capabilities, validate, prepare, publish, verify, health | Done (`apps/api/src/connectors/types.ts`) |
| Instagram: Reels, feed photo, carousel, Story; containers made shortly before the hour; first comment; daily quota read from the API | Done against the fake |
| Facebook Pages: photo, album, video, Reel; native scheduling on the Page; first comment; take down on cancel | Done against the fake |
| YouTube: resumable upload with resume, `publishAt`, Shorts, made-for-kids and synthetic-media flags, thumbnail | Done against the fake. Private until Google audits the project, handled as a state, not a failure |
| OAuth (Meta, Google), pick which Pages, Instagram accounts and channels to connect, reconnect, disconnect | Done, in the Settings screen |
| Tokens encrypted at rest (AES-256-GCM), refreshed on demand, expiry and revocation detected | Done. See [Tokens](#tokens) |
| Queue with retries (pg-boss), prepare at T-30 min, publish at the hour, verify afterwards | Done. Lead time is a per-brand setting |
| Error classes: auth, rate limit, file rejected, transient, unsupported | Done. See [What happens when something fails](#what-happens-when-something-fails) |
| Late tolerance: publish late or tell the team | Done. 15 minutes by default, per brand |
| Per-network transcoding profiles | Done, with real ffmpeg. **Numbers need checking against each network's current documentation** |
| Validators and capabilities per network, checked at scheduling and again before publishing | Done |
| Per-network text editor with counters, truncated feed preview, safe-zone overlays | Done. Safe-zone percentages are approximate |
| Audit trail of every attempt | Done (`publication_attempt`, append-only, tokens removed) |
| TikTok, LinkedIn, X, Threads, Pinterest, Bluesky | Not in this phase |
| Webhooks and the agent runner | Phase 3 ([docs/phase-3.md](phase-3.md)) |
| Metrics, prize delivery | Phase 4 |

## How a post goes out

1. **Connect.** An admin opens *Settings → Accounts* and signs in with Meta or Google. The sign-in can find several
   things (a Facebook login yields Pages and the Instagram accounts linked to them), so the admin ticks which ones this
   brand publishes to. Tokens wait in the database, sealed, until then. Accounts from phase 1 can be connected in place:
   they keep their history.
2. **Approve.** Unchanged from phase 1. An account that needs reconnecting cannot be approved for.
3. **Schedule.** The schedule dialog asks the server how the post would go out. If the account is connected and the
   network can do this content, it says **the app will publish it**, and shows the kind of post (Reel, photo…), the
   network's limits next to the text (characters, hashtags, mentions), what the feed shows before "more", and anything
   that would stop it. An error blocks the button; a warning does not. The person can always choose "I will publish this
   one by hand".
4. **Prepare** (the brand's lead time before the hour, 30 minutes by default). The worker converts the file if the
   network would not take it as it is (a cached ffmpeg copy; a file that already fits goes out untouched), hands it to the
   network and gets back what the network needs to publish: an Instagram container, a Facebook post held by the Page, a
   YouTube video already uploaded. Facebook and YouTube hold the post themselves until the hour (native scheduling), so
   those go out even if this app is down at that moment.
5. **Publish** at the hour. Instagram has no native scheduling, which is why its container is made shortly before.
6. **Verify.** The worker asks the network whether the post is really there and public, and records the link.
   Verification repeats for a while when the answer is "processing" or "private".

Every step is a row in `publication_attempt` with what the network answered. The piece page has a *History* button.

## What happens when something fails

| Class | Examples | What the app does |
| --- | --- | --- |
| `auth` | Token revoked or expired, permission removed | Marks the account *needs reconnecting*, tells the admins once, and keeps the post waiting. It looks again every 10 minutes, and **immediately when the account is reconnected**. If it is still not reconnected when the hour plus the tolerance has passed, the post fails and the team is told |
| `rate_limit` | Instagram's daily cap, app limits | Waits as long as the network says. If the window would reopen after the post's last acceptable time, it fails now instead of publishing late |
| `file_rejected` | Wrong codec, too long, bad parameter | Fails at once with the network's own reason. Retrying the same file would only repeat it |
| `transient` / unknown | 5xx, "media not ready", dropped connection | Retries after 1, 2, 5, 10 and 20 minutes. The fifth failure in a row is final |
| `unsupported` | The network cannot publish this kind of content through its API | Hands the post over to a person, as in phase 1, and says why |
| `missed_window` | The app was down past the hour plus the tolerance | Does not publish late. Fails and tells the team |

A failed post can be **tried again** (same approved version, new time optional), **handed over** to a person (it then
appears under *Due now* on the Publish page), or cancelled. The Publish page lists failed and private posts under
*Needs attention*.

Uploading a new version while a post is still waiting puts it on hold, as before. If the post is already held by the
network (Facebook, YouTube), the worker takes it down there; cancelling does the same.

### YouTube until Google audits the project

Videos uploaded through the API by a project that has not passed Google's audit are forced to **private**, whatever is
asked. The app treats that as a state of its own: the post counts as published, shows a *Private* chip with an
explanation, and the approvers get a notification. Once the audit passes, an admin ticks *Google has audited this
project* on the account (Settings → Accounts) so new uploads ask for public, and *Check again* on an existing post looks
at it again. Until then someone has to flip each video to public in YouTube Studio.

## Tokens

- Stored with AES-256-GCM under `TOKEN_KEY`. The authenticated data binds each token to its own account row, so a
  sealed token copied onto another account does not open. The key is never stored in the database.
- **Lose the key and every account has to be connected again.** Keep a copy outside the server.
- Tokens never reach the browser (the API returns flags and dates, never secrets), the log, or the attempt history
  (responses are scrubbed before they are written).
- Meta page tokens are long-lived; the app checks them (and the permissions that were granted) about once a day and shows
  warnings in Settings: a missing permission, access that is about to expire. Google access tokens are refreshed when
  they are about to expire; if Google says the grant was revoked, the account asks to be reconnected.

## Setting up the networks

You need a developer app at each company. The steps below are from memory of their consoles and **may be out of date**;
use their current documentation for anything that disagrees. Register the redirect URI
`https://<your app domain>/api/oauth/callback` in both.

### Meta (Facebook and Instagram)

1. Create an app of type *Business* at developers.facebook.com and add *Facebook Login for Business* (or Facebook Login)
   and the *Instagram* publishing product.
2. The Instagram account must be a *professional* account (Business or Creator) **linked to a Facebook Page**. The person
   who connects must have a role on that Page.
3. Permissions the app asks for: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`, `instagram_manage_comments`, `business_management`.
4. While the app is in *development mode*, only people with a role on the app can connect, which is enough to publish to
   your own accounts and to test everything below. Going live for other people's accounts requires Meta's app review and
   business verification; the specification already lists this as paperwork to start early.
5. Set `META_APP_ID`, `META_APP_SECRET` (and `TOKEN_KEY`) and restart.

### Google (YouTube)

1. In Google Cloud, create a project, enable *YouTube Data API v3*, configure the OAuth consent screen and create an
   *OAuth client ID* of type *Web application* with the redirect URI above.
2. The app asks for `youtube.upload` and `youtube.force-ssl` and requests offline access, so it gets a refresh token.
3. **While the consent screen is in *Testing* status, Google expires refresh tokens after about 7 days**, and only listed
   test users can connect. Move it to *In production* (unverified is fine for your own use) so the connection lasts.
4. Uploads from an unaudited project are private (above). The audit is a form Google reviews; start it early.
5. The API has a daily quota, and an upload costs a large share of the default. Check the quota page in your project
   before planning how many videos a day you can send.
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and `TOKEN_KEY`) and restart.

## Running it

- **Development:** `npm run dev:api` runs the web server and the queue in one process. Set the variables above in `.env`.
- **Deployment:** the Compose file runs the web server with `RUN_WORKERS=false` and a separate `worker` service
  (`node apps/api/dist/worker-main.js`). The queue is pg-boss in the same PostgreSQL, so there is nothing else to run.
  More than one worker is fine: each publication is leased to one at a time.
- The queue only wakes workers up. What is true about a publication lives in its row, so a lost, repeated or late
  wake-up is harmless, and restarting everything mid-publish resumes where it stopped (the connector's progress is
  saved after each step: the container id, the upload session, the held post).
- The worker needs **ffmpeg** (the image has it) and enough disk for a transcode. Files handed to a network by URL are
  served from the media domain with a signed link that lasts `PUBLIC_MEDIA_TTL_SECONDS` (6 hours by default); the
  media domain must be reachable from the internet, because Meta downloads the file itself.

## Decisions where the specification left room

- **OAuth belongs to the provider, not the network.** One Meta sign-in covers Facebook Pages and the Instagram accounts
  behind them; one Google sign-in covers the channel. The connectors for each network sit on top of that.
- **The database is the source of truth, the queue only a doorbell.** pg-boss delivers "look at publication X"; the
  state machine, retries, leases and the attempt log live in ordinary rows, so they can be read, audited and repaired
  with SQL, and the queue can be dropped and rebuilt without losing anything.
- **A worker holds a publication through a lease** (45 minutes), and every state change is a compare-and-set. If a worker
  dies, the lease runs out and another picks the publication up from the saved progress.
- **The approval is checked again right before anything is sent.** The worker recomputes the version's fingerprint from
  the stored files and confirms the approval still counts for that account, the same check scheduling makes. If it does
  not, the post is put on hold and the approvers are told. A post a network is already holding is covered by the hold
  that a new version triggers, which takes it down.
- **A file that fits the network's profile goes out untouched.** Only files that do not fit are converted, and the
  copy is cached per file and profile, and the files themselves cannot change after a version exists (database trigger).
- **Scheduling asks the same question the worker will ask later.** The schedule dialog and the scheduling endpoint run
  the connector's validator, and the worker runs it again before preparing, so a rule changing in between is caught
  before anything is sent.
- **Natively held posts are cancelled on the network too.** Cancelling, putting on hold (a new version arrived) or
  discarding a piece sets the post to be taken down, and the worker deletes it there.
- **Reconnecting must be the same account.** A broken connection can only be repaired by signing in as the same Page,
  Instagram account or channel, so history and anything scheduled stay attached to it.
- **Late means late.** A post that would go out after its hour plus the tolerance is not published: a Reel meant for a
  campaign launch posted three hours late is worse than a message saying it did not go out.

## What was verified, and how

- **180 API tests** against a real PostgreSQL (phase 1's 77 plus 103 for phase 2): the connectors against the fake
  servers (every endpoint they call, parameters, pagination, resumable upload including a dropped connection),
  connecting and reconnecting, the whole state machine on a controlled clock (preparing early, waiting for the hour,
  retries with backoff, rate-limit waits, auth waits and recovery, hand-over, late tolerance, cancellation and version
  holds discarding natively held posts, restart in the middle of a step), real ffmpeg for conversions, and a real pg-boss
  worker. Several engine rules were broken on purpose, one at a time, to confirm the tests notice: leasing, the
  missed-window rule, discarding on cancel, discarding on version hold, counting attempts, the auth wait, and the
  approval recheck.
- **A real-browser run** (`e2e/phase2.mjs`) against the fake networks, with the real worker, real ffmpeg and real
  PostgreSQL: connect Facebook, Instagram and YouTube through the UI, choose from the picker, approve, schedule with
  counters and a blocked over-long caption, watch the worker transcode and publish, see YouTube come out private and then
  public after the audit flag, see a refused file fail and be handed over to a person, see Facebook hold a post natively
  and take it down on cancel, see Instagram ask to be reconnected, reconnect, and the waiting post carry on. It also checks
  that no token reaches the browser or sits unsealed in the database. Phase 1's browser run still passes.
- **Two gaps found while writing the browser run and this document**, both fixed with a test that fails without the
  change: when an account was reconnected, a post waiting on it still sat out its 10-minute timer (reconnecting now wakes
  it at once); and the worker did not re-check the approval before sending (it now does, below).

## Known limits

- **No real network was contacted.** Endpoint paths, parameter names, response shapes, error codes, limits and the way
  the networks classify errors come from the documentation as I know it, and from the specification. The riskiest
  parts, in my order of doubt: the Facebook Reels three-phase upload, Instagram's AI-label parameter, the exact error
  codes mapped to each failure class, the Graph API version (`META_GRAPH_VERSION`, v23.0 by default), and the numeric
  limits in `connectors/profiles.ts` and each connector's capabilities (marked for re-verification in the code).
- **Safe zones are approximate.** The percentages drawn over the picture are my estimate of what each network covers,
  not a published specification. Use them as a guide.
- **Nothing here has run against H.264 playback in a browser.** The converted files are checked with ffprobe, not played.
- **The S3 driver and the Compose file are still unexercised for real** (as in phase 1). The Compose file now validates
  with the worker service; neither was started.
- **TikTok, LinkedIn, X, Threads, Pinterest and Bluesky** are not built. The interface is the same, but each needs its own
  connector and its own paperwork.
- **YouTube chunked-upload size and speed** were exercised with small files only.
- **Instagram carousels with video** and **Facebook photo albums** are implemented and tested against the fake, but the
  browser run publishes a Reel, a Facebook video and a YouTube video only.

## Your first real run

Do this with accounts you own, before relying on it:

1. Set up the Meta app in development mode and a Google project in *Testing* (see above), set the variables, restart.
2. Connect a Facebook Page, its Instagram account and a YouTube channel. Look at *Settings → Accounts* for warnings.
3. Upload a short vertical video, approve it for the three accounts, and schedule each for 15 minutes from now (Facebook's
   native scheduling needs at least 10 minutes' lead).
4. Watch the piece page and *History*. When something fails, the network's own message is in the history; that message
   is what tells us which of the assumptions above was wrong.
5. Do the same with a feed photo and a carousel.
6. Cancel a Facebook post while it is held, and check it disappears from the Page's scheduled posts.
