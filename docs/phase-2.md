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
   network would not take it as it is (a cached ffmpeg copy; a file that already fits goes out untouched; see
   [Files](#files-what-fits-and-what-is-converted)), hands it to the
   network and gets back what the network needs to publish: an Instagram container, a Facebook post held by the Page, a
   YouTube video already uploaded. Facebook and YouTube hold the post themselves until the hour (native scheduling), so
   those go out even if this app is down at that moment.
5. **Publish** at the hour. Instagram has no native scheduling, which is why its container is made shortly before.
6. **Verify.** The worker asks the network whether the post is really there and public, and records the link.
   Verification repeats for a while when the answer is "processing" or "private". A scheduled YouTube video is made public
   by YouTube a little after its time, not at that second: an audited channel's video still private just after its hour is
   looked at every minute for 45 minutes before it is called private.

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

Uploading a new version while a post is still waiting puts it on hold, as before. If the network already holds anything of
the post (a Facebook post or video held for its hour, a YouTube upload, and also a Facebook video that is still processing,
before preparation has finished), the worker takes it down there; cancelling, discarding the piece and a failure do the same.

### Pausing, blocked dates and dependencies

- **While the brand is paused, nothing is prepared or published.** The worker holds each automatic post back where it is; a
  post the network already holds (Facebook, YouTube) is taken down from the network first, because it would otherwise go
  out at its hour by itself. Pausing wakes those at once. On resume they are prepared again, and go out at their hour (or
  within the tolerance, if it has just passed); one whose hour plus the tolerance passed during the pause is handed to a
  person, with the reason, and shows under *Due now* once the brand is no longer paused.
- **A date blocked after something was scheduled on it** is treated the same way: the worker's sweep notices the block, takes
  down what a network holds for that day, and looks again every few minutes, so unblocking it lets the posts carry on.
- **A post that depends on another** is not prepared until that one is out (published by the app or marked published by a
  person), so a network cannot be holding it while the first is still in doubt. If the first is cancelled, fails or is put on
  hold, or is still not out at the dependent's hour, the dependent is put on hold with the reason. Moving either of them
  past the other is refused.

### When the worker dies in the middle

A worker holds a publication through a short lease (two minutes) that it renews every 30 seconds while it works, however long
a conversion or an upload takes, and every write it makes names that lease: a worker that lost it (stalled for minutes, say)
cannot overwrite what the one that took over did. A worker that dies lets go within two minutes, including across a restart.

What a connector records while it publishes (an id, or that a call was about to be made) is kept on the publication. A pass
that finds a send already begun finishes it through the connector's own recovery (Instagram and Threads remember the published
id, X and LinkedIn recognise their own duplicate, Pinterest looks on the board, Bluesky's write is idempotent), even past the
tolerance, because that is the end of a send that began on time. If nothing was recorded, the usual late rule applies and the
team is told the send was interrupted and to check the network. Trying a failed post again keeps that record, so a post the
network already has is not made twice.

### Files: what fits and what is converted

Every file is read by its own first bytes, not by its name or the type it was declared with, and ffprobe and ffmpeg are told
which reader to use and that they may only read that file (`-f`, `-format_whitelist`, `-protocol_whitelist`): a playlist
uploaded as "video/mp4" is not opened as a playlist, and nothing inside a file can make them fetch an address. Only MP4/MOV,
Matroska/WebM, JPEG, PNG, WebP and GIF are read.

A video fits a network's profile when it is really an MP4 (an H.264 MOV is not, though ffprobe names both the same family),
its index (the moov atom) comes before the media (Instagram and Threads read the file as it downloads and refuse one with the
index at the end), it is H.264/AAC in yuv420p, within the size, bitrate and frame-rate range (Instagram, Threads and TikTok
23–60 fps; Facebook Reels 24–60). When only the container, the index or the sound is wrong, the picture is copied and the file
rewritten as an MP4 with its index at the front, which is quick and loses nothing; otherwise it is encoded again. A picture
fits when it is a plain JPEG: a PNG named .jpg, and an MPO (two pictures in one file, as some phones save), are converted.

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
   and the *Instagram* publishing product. **With Facebook Login for Business**, create a *configuration* (user access token,
   with the permissions below and the Pages and Instagram accounts as assets) and set its id as `META_LOGIN_CONFIG_ID`: the
   sign-in dialog is then given `config_id` instead of a list of permissions, which Login for Business ignores (and without
   which it may share no Pages at all). A brand with prizes needs the messaging permissions too: a second configuration that
   has them goes in `META_LOGIN_CONFIG_ID_PRIZES` (without it the first one is used for every brand). With plain Facebook
   Login, leave both unset and the permissions are asked for by name.
2. The Instagram account must be a *professional* account (Business or Creator) **linked to a Facebook Page**. The person
   who connects must have a role on that Page.
3. Permissions the app asks for: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement` (to post
   the first comment as the Page; a refusal is said in the post's history), `instagram_basic`,
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
- **A worker holds a publication through a lease** (two minutes, renewed while it works), and every state change is a
  compare-and-set fenced by that lease. If a worker dies, the lease runs out and another picks the publication up from the
  saved progress (see [When the worker dies in the middle](#when-the-worker-dies-in-the-middle)).
- **The approval is checked again right before anything is sent.** The worker recomputes the version's fingerprint from
  the stored files (the file records and the objects in storage) and confirms the approval still counts for that account, the
  same check scheduling makes. If it does not, the post is put on hold and the approvers are told. The title and the AI label
  sent with it are the ones the version was approved with (the label is also sent if it was added later), not whatever the
  piece says at the time. A post a network is already holding is covered by the hold
  that a new version triggers, which takes it down.
- **A file that fits the network's profile goes out untouched** (what "fits" means is in [Files](#files-what-fits-and-what-is-converted)). Only files that do not fit are converted, and the
  copy is cached per file and profile, and the files themselves cannot change after a version exists (database trigger).
- **Scheduling asks the same question the worker will ask later.** The schedule dialog and the scheduling endpoint run
  the connector's validator, and the worker runs it again before preparing, so a rule changing in between is caught
  before anything is sent.
- **Natively held posts are cancelled on the network too.** Cancelling, putting on hold (a new version arrived), discarding
  a piece, a failure, a pause or a blocked date sets the post to be taken down, and the worker deletes it there. This covers
  anything the network holds, not only a post whose preparation finished: a Facebook video is held for its hour from the
  moment it is created, while Facebook is still processing it.
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

## Corrections after the connector review (October 2026)

A review of the connectors against the networks' current reference pages (read on 2026-10-01 and 02, **still not against the live
services**) found these, now fixed, each with a test and the stand-ins changed to answer as the reference says:

- **Instagram.** `is_ai_generated` *is* in the IG User Media reference ("a self-disclosure of AI usage in the post. Not available for
  carousel children"): it is sent on a Reel, a feed photo and a carousel, never on a carousel's items. A container is asked about at
  most once a minute, as Meta recommends, for five looks, then every five minutes. A Story video runs 3 to 60 seconds (the minimum was
  1). A video in a carousel is held to a Reel's 3 s to 15 min, with a warning past 60 seconds, because the reference gives no length.
- **Files.** Containers, the index at the front, frame-rate minimums, MPO pictures and a restricted ffmpeg: see
  [Files](#files-what-fits-and-what-is-converted).
- **Facebook.** The first comment needs `pages_manage_engagement`, which was not asked for (it is now, and a refusal is in the
  post's history). Photos of a scheduled album are uploaded with `temporary=true`, as Meta requires for photos used in a scheduled post.
  A video's numbers come from its own insights (`total_video_views`, `total_video_impressions_unique`, `total_video_avg_time_watched`)
  and a Reel's from a Reel's (`fb_reels_total_plays`, `post_impressions_unique`, `post_video_avg_time_watched`,
  `post_video_social_actions`); the Video node has no `shares` field, which made every reading of a video fail. Facebook Login for
  Business signs in with `config_id` (`META_LOGIN_CONFIG_ID`, above). The webhooks need the app subscribed to each Page: see
  [phase 4](phase-4.md#prizes-for-commenting).
- **YouTube.** The description may not contain `<` or `>` (each is sent as ‹ or ›) and is limited to 5,000 **bytes**: scheduling refuses
  more, counted the way YouTube counts. "Made for kids" was always declared as *no* without asking anyone: the schedule dialog now asks
  (nothing chosen), starting from the channel's default when one is set (`PATCH /api/brands/:brandId/accounts/:accountId` with
  `{ "madeForKids": true | false | null }`; there is no screen for it yet), and a video nobody declared is sent without a declaration so
  YouTube applies the channel's own setting. A scheduled video still private just after its hour is given 45 minutes to go public.

## Known limits

- **No real network was contacted.** Endpoint paths, parameter names, response shapes, error codes, limits and the way
  the networks classify errors come from the documentation as I know it, and from the specification. The riskiest
  parts, in my order of doubt: the Facebook Reels three-phase upload, the exact error
  codes mapped to each failure class, the Graph API version (`META_GRAPH_VERSION`, v23.0 by default), and the numeric
  limits in `connectors/profiles.ts` and each connector's capabilities (marked for re-verification in the code).
- **A lost answer is only found again as well as each connector can.** Finishing an interrupted send relies on what the
  connector wrote down. If Instagram or Threads publish and the worker dies in the instant before the id is saved, the next
  pass cannot tell: within the tolerance it publishes again (a duplicate), past it the post fails with a note to check the
  network. X, LinkedIn and Pinterest look for their own post first and, finding none, post then (a little late, since a dead
  worker lets go within two minutes). A lookup-only call in the connector interface would close both gaps.
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
