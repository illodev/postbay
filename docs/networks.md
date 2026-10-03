# Networks

Postbay publishes to Instagram, Facebook Pages, YouTube, Threads, TikTok, LinkedIn, X, Pinterest and Bluesky. Each network is
switched on by giving the server its developer app's credentials; an account on a network that is not switched on stays
**manual**: a person publishes to it by hand, with the files and text Postbay has ready ([publishing by hand](publishing.md#publishing-by-hand)).

## Connecting an account

An admin opens *Settings → Accounts* and connects:

- **Meta, Google, Threads, TikTok, LinkedIn, X and Pinterest** through the network's own sign-in page. One sign-in can find several
  things (a Facebook login yields Pages and the Instagram accounts linked to them; a LinkedIn login, the company pages the person
  administers; a Pinterest login, the boards), so the admin ticks which ones this brand publishes to. Until then the tokens wait in the
  database, sealed.
- **Bluesky** with a handle and an **app password**, typed in *Settings → Accounts*, because Bluesky has no sign-in page for apps.

A manual account can be connected in place and keeps its history. An account that needs connecting again shows *Renew*: it has to be
**the same** Page, Instagram account, channel, board or profile, so its history and anything scheduled stay attached to it. Disconnecting
an account forgets its token and leaves it manual; it is refused while the account has automatic posts waiting.

One sign-in belongs to a provider, not to a network: a Meta sign-in covers the Facebook Pages and the Instagram accounts behind them, a
Google sign-in covers the YouTube channel. The connector for each network sits on top of that.

## Setting up the networks

Each network needs a developer app at its company, and the server needs that app's credentials (see [configuration](configuration.md#networks)).
`TOKEN_KEY` must be set too: it seals every token the server keeps. Register this redirect address with every network that has a
sign-in page:

```
$APP_URL/api/oauth/callback
```

The steps below follow each company's console as documented; consoles change, so use their current documentation for anything that
disagrees. `npm run check` ([checking a real setup](#checking-a-real-setup)) says what is still missing.

### Meta: Facebook and Instagram

1. Create an app of type *Business* at developers.facebook.com and add *Facebook Login for Business* (or Facebook Login) and the
   *Instagram* publishing product.
   - **With Facebook Login for Business**, create a *configuration* (user access token, with the permissions below and the Pages and
     Instagram accounts as assets) and set its id as `META_LOGIN_CONFIG_ID`. The sign-in dialog is then given `config_id` instead of a
     list of permissions, which Login for Business ignores (and without which it may share no Pages at all). A brand with prizes needs the
     messaging permissions too: put a second configuration that has them in `META_LOGIN_CONFIG_ID_PRIZES` (without it, the first one is
     used for every brand).
   - **With plain Facebook Login**, leave both unset and the permissions are asked for by name.
2. The Instagram account must be a *professional* account (Business or Creator) **linked to a Facebook Page**, and the person who
   connects must have a role on that Page.
3. The permissions Postbay asks for: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement` (to
   post the first comment as the Page; a refusal is noted in the post's history), `instagram_basic`, `instagram_content_publish`,
   `instagram_manage_comments` and `business_management`. A brand with [prizes](prizes.md) also gets the messaging permissions and
   `pages_manage_metadata`.
4. While the app is in *development mode*, only people with a role on the app can connect. That is enough to publish to your own
   accounts. Connecting other people's accounts needs Meta's app review and business verification: start them early.
5. Set `META_APP_ID`, `META_APP_SECRET` (and `TOKEN_KEY`) and restart.

`META_GRAPH_VERSION` sets the Graph API version (`v23.0` by default).

### Google: YouTube

1. In Google Cloud, create a project, enable *YouTube Data API v3*, configure the OAuth consent screen and create an *OAuth client ID*
   of type *Web application* with the redirect address above.
2. Postbay asks for `youtube.upload` and `youtube.force-ssl`, with offline access so it gets a refresh token. With
   `GOOGLE_ANALYTICS=true` it also asks for YouTube's read-only Analytics permission ([watch time](#youtube-watch-time)).
3. **While the consent screen is in *Testing*, Google expires refresh tokens after about 7 days**, and only listed test users can
   connect. Move it to *In production* (unverified is fine for your own channels) so the connection lasts.
4. Until Google audits the project, every upload is private ([below](#youtube-until-google-audits-the-project)). The audit is a form
   Google reviews: start it early.
5. The API has a daily quota, and one upload costs a large share of the default. Check the quota page of your project before planning
   how many videos a day you send.
6. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and `TOKEN_KEY`) and restart.

### Threads

A Meta developer app with the *Threads API* use case; `THREADS_APP_ID`, `THREADS_APP_SECRET`. Postbay asks for `threads_basic`,
`threads_content_publish`, `threads_manage_insights` and `threads_manage_replies`.

### TikTok

A developer app with Login Kit and the Content Posting API; `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. Sign-in reads only what
`user.info.basic` gives (open id, display name, avatar).

- **Photo posts**: TikTok downloads the pictures itself, and only from a **domain you verified in its portal**: the domain of the
  signed addresses Postbay hands out. With the local storage driver that is `MEDIA_URL`; with `STORAGE_DRIVER=s3` the addresses are
  signed for the bucket, so it is the host of `S3_PUBLIC_ENDPOINT` (or of `S3_ENDPOINT` when that is not set). The server check names
  the domain to verify.
- **Until TikTok audits the app, every post is private**, and TikTok only takes them from a TikTok account that is itself set to
  private. TikTok's own guidelines call tools that post to accounts managed by a team "not acceptable", so **the audit may be refused
  for an app like this: check before relying on it.** Without the audit, a person has to make each post public in TikTok.

### LinkedIn

An app with the Community Management API product, and an admin of the company page; `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.
Postbay asks for `w_organization_social`, `r_organization_social` and `rw_organization_admin`.

LinkedIn's API is versioned by month (`LINKEDIN_VERSION`, `YYYYMM`) and each version is retired after about a year. **Raise
`LINKEDIN_VERSION`** when a post's history says the version is retired; the server check warns before that happens.

### X

An OAuth 2.0 app with the scopes `tweet.read`, `tweet.write`, `users.read`, `offline.access` and `media.write`; `X_CLIENT_ID`,
`X_CLIENT_SECRET`. Sign-in uses PKCE. X bills every post, and every read of a post's numbers.

### Pinterest

An app; `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`. With *Trial* access, pins are shown only to you: ask Pinterest for *Standard*.

### Bluesky

No developer app: Bluesky is switched on as soon as `TOKEN_KEY` is set. In *Settings → Accounts → Connect Bluesky*, give the handle and
an **app password** made in Bluesky (*Settings → Privacy and security → App passwords*), never the account password. The app password is
kept sealed and never shown again, so the session can be made again when its renewal token expires.

- A different server: `BLUESKY_PDS_URL`. A server a person types in the form instead is held to the [webhooks' address rules](agents.md#where-a-webhook-may-point):
  only the https address of a server (http only to a private address where `WEBHOOK_ALLOW_PRIVATE_NETWORKS` allows it), checked when
  connecting, with no redirects followed.
- Videos go to `BLUESKY_VIDEO_URL` with two service tokens: one for the video service itself (the allowance), one for the server the
  account's repository is on (the upload), read from the account's DID document.

## What each network does

| | How it signs in | What it posts | Its token | Can a post go out twice? |
| --- | --- | --- | --- | --- |
| **Instagram** | Meta sign-in | Reels, feed photos, carousels and Stories; the first comment | Long-lived Page token, checked about once a day | No: the container is made shortly before the hour and published once; a lost answer is looked up on the container |
| **Facebook Pages** | Meta sign-in | Photos, albums, videos and Reels; the first comment as the Page | Long-lived Page token, checked about once a day | No: Facebook holds the post until its hour (native scheduling) |
| **YouTube** | Google sign-in | Videos and Shorts, with made-for-kids and synthetic-media flags and a thumbnail | Refreshed when it is about to expire | No: the upload is resumable and YouTube publishes it at `publishAt` |
| **Threads** | Sign-in page | A picture, a video or a carousel, with text | Lasts 60 days, renewed up to a week before it ends | No: a post is made in two calls, and the second is made once |
| **Bluesky** | Handle and app password | Pictures (up to 4) or a video; hashtags, links and mentions in the text become links. The 300-character limit counts what a person sees as one character | The session lasts about two hours; renewed ten minutes ahead, and made again from the app password if renewing fails | No: the record key is made from the publication and its time and kept before the write, so a repeat overwrites itself |
| **X** | Sign-in page with PKCE | Pictures (up to 4) or a video, with alt text | Renewed five minutes before it ends | X has no key for this: a post whose answer was lost is looked for among the account's posts since the attempt, by the media it carries, before another is made |
| **LinkedIn** | Sign-in page; you choose the company page | A picture, several pictures, a video, or a document (PDF) | Most apps get no renewal: the token is kept and the account warns a week before it ends | LinkedIn refuses a repeat with the original's name, which is how it is found |
| **Pinterest** | Sign-in page; **the account is a board** | A pin (one picture), a carousel pin or a video pin (the video streamed from storage, never held in memory); title, destination link and alt text | Renewed three days before it ends | The board is searched before a second pin is made |
| **TikTok** | Sign-in page | A video or photos | Renewed an hour before it ends | The upload is the post, and TikTok's processing is watched afterwards. A photo post is not safe to repeat, so it is never repeated |

Every post is files: a version is always made of files, so Threads, X and Bluesky posts always carry a picture or a video. Connecting
two Pinterest boards makes two accounts.

Details that decide whether a post is accepted:

- **Instagram**: the AI label is sent as `is_ai_generated` on a Reel, a feed photo and a carousel (never on a carousel's items). A Story
  video runs 3 to 60 seconds. A video in a carousel is held to a Reel's 3 seconds to 15 minutes, with a warning past 60 seconds. A
  container is asked about at most once a minute, as Meta recommends, for five looks, then every five minutes.
- **Facebook**: native scheduling takes a post 10 minutes to 29 days ahead; with less lead time left, the post is made and published at
  once. Photos of a scheduled album are uploaded as temporary, as Meta requires.
- **YouTube**: the description may not contain `<` or `>` (each is sent as ‹ or ›) and is limited to 5,000 **bytes**, counted the way
  YouTube counts; scheduling refuses more. A video with the AI label is declared as containing synthetic media.

**On X, a link costs more.** A link in the text, or in the first comment, is shown as a warning, because X charges about 13 times more for any
post with one, replies included (and X makes a link of a bare domain too).

## Private until the network approves the app

Until the network approves the app, **TikTok** (always), **Pinterest** and **YouTube** take the post but only the account can see it.
Postbay treats that as a state, not a failure: the post counts as published, shows a *Private* chip with the reason in that network's
own words, and the approvers are told. Once the network has approved the app, an admin ticks it on the account in *Settings → Accounts*,
so new posts ask to be public, and *Check again* on an existing post looks at it again. A private post gets **no readings**.

### YouTube until Google audits the project

Videos uploaded through the API by a project that has not passed Google's audit are forced to **private**, whatever is asked. Once the
audit passes, an admin ticks *Google has audited this project* on the account. Until then, someone has to make each video public in
YouTube Studio.

YouTube makes a scheduled video public a little after its time, not at that second: an audited channel's video still private just after
its hour is looked at again after 1, 2, 5 and 10 minutes and then every 15, for 45 minutes, before it is called private.

## What the schedule dialog asks for

Each connector declares the settings it needs. When an account is chosen, the schedule dialog asks the server for that account's
settings (`GET /api/brands/:brandId/accounts/:accountId/options`) and shows only the ones that apply to the kind of post; the API checks
them, and nothing hidden is saved. Among them: alt text, Pinterest's title and destination link, YouTube's *made for kids* (nothing chosen
to begin with, or the channel's default when an admin set one in *Settings → Accounts*; a video nobody declared is sent without a
declaration, so YouTube applies the channel's own setting).

TikTok's are the strictest, because TikTok obliges an app that posts for people to ask TikTok, **while the post is being written**, what
this creator may do, and to show:

- Who the post goes out as: *Posting to TikTok as* the creator's nickname (and @username).
- **Who can see this post**: only the choices TikTok returns for this creator, nothing chosen, and it cannot be scheduled until one is.
  Until TikTok audits the app only *Only me* is offered.
- Comments, duets and stitches: all unticked, and shown switched off (not tickable) where the creator has switched them off in TikTok.
- *This post promotes a brand, product or service*: if ticked, whether it is your own brand (labelled *Promotional content*), branded
  content (labelled *Paid partnership*; it cannot be private, so *Only me* cannot be picked with it), or both.
- TikTok's consent sentence, **word for word**, needing a tick: "By posting, you agree to TikTok's Music Usage Confirmation.", or "By
  posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." for branded content.
- The longest video this creator may post, and that TikTok can take a few minutes to process the post before it shows on the profile.

What TikTok said is kept on the account, so scheduling is checked against it (the privacy chosen is on offer, nothing is allowed that the
creator switched off, the video is not too long), and publishing asks TikTok again just before sending: a privacy no longer offered stops
the post, and what the creator has switched off since goes out switched off.

How the dialog shows each network's limits, counters and feed preview is in [publishing](publishing.md#what-the-schedule-dialog-shows).

## Tokens

- Stored with AES-256-GCM under `TOKEN_KEY`. The authenticated data binds each token to its own account row, so a sealed token copied
  onto another account does not open. The key is never stored in the database.
- **Lose `TOKEN_KEY` and every account has to be connected again** (and every webhook secret and Slack address replaced). Keep a copy
  outside the server.
- Tokens never reach the browser (the API returns flags and dates, never secrets), the log, or the attempt history (responses are scrubbed
  before they are written).
- Meta Page tokens are long-lived: Postbay checks them, and the permissions that were granted, about once a day, and *Settings → Accounts*
  warns about a missing permission or access that is about to expire. Google tokens are refreshed when they are about to expire; if Google
  says the grant was revoked, the account asks to be connected again.
- Only a token the network no longer takes marks an account for connecting again. A 403 is read for what it says: X refusing the app's
  set-up (a project, an access level) or the content, LinkedIn's or Pinterest's missing permission, or a refusal from Bluesky's video
  service hands the post to a person with the network's words and leaves the account as it is.

## Results

When a post is verified **public**, Postbay plans its readings: 1 hour, 1 day, 7 days and 28 days after it was published (a story: 1, 6
and 22 hours, because a story's numbers disappear after a day). A worker takes each when it falls due, claiming it with a lease so two
workers never take one twice. A reading is **read**, **not available** (the network has nothing to give for this post), **failed** (it gave
up after five tries with growing waits) or **missed** (the window closed first). A network that is rate-limiting makes the reading wait
without counting it as a failed try.

*Results* shows the last 90 days, or the dates you pick, filtered by network. Each network has its own section: totals of the latest
reading of each post, and a table with that reading, which ages have been read, and a *Readings* dialog with every age. **Networks are
never added together**: a "view" does not mean the same on each (X's impressions, Instagram's views, a video's plays), the screen says
so, and the API gives totals per network only. Average watch time is shown per post and never summed.

X charges for reads too (about 0.001 USD per post per reading), which is why readings are taken at four fixed ages and not continuously.

### YouTube watch time

YouTube's counts (views, likes, comments) come from the Data API's public statistics. With `GOOGLE_ANALYTICS=true` the connection also
asks for YouTube's read-only Analytics permission, and the results show **watch time (minutes)** and the **average view duration** of a
video next to the counts (the counts stay the Data API's, because Analytics is a few days behind).

It is off by default because Google treats this permission as sensitive: the OAuth project must be verified to use it for other people's
channels. A channel connected before it was switched on must be connected again to grant it; until then its readings say so. If Analytics
refuses, or answers in a shape Postbay does not know, the counts are kept and the missing watch time is explained. A busy or failing
Analytics API makes the reading wait and try again.

## Checking a real setup

`npm run check` looks at the server and at every connected account of a brand, and says what to fix. It only reads, unless you ask it
for a real test post.

```sh
npm run check -w @estudio/api -- --brand "Acme Spain"                     # the server, then every connected account
npm run check -w @estudio/api -- --brand "Acme Spain" --network threads   # one network
npm run check -w @estudio/api -- --brand "Acme Spain" --json              # for a script
npm run check -w @estudio/api -- --brand "Acme Spain" --capture ./transcripts
npm run check -w @estudio/api -- --brand "Acme Spain" --network bluesky --publish --yes
```

`npm run check:networks` at the root does the same. In the container:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm app node apps/api/dist/cli.js check --brand "Acme Spain"
```

It exits with a failure when something failed, so it can sit in a deploy script.

**About the server**, it checks: `TOKEN_KEY`; that `APP_URL` and `MEDIA_URL` are public and https (networks send people back to the
first and download files from the second); the storage driver; ffmpeg; email; which networks are switched on; how old `LINKEDIN_VERSION`
is; the Meta webhook's verify token; and, for TikTok photo posts, the domain to verify. Each line says what is wrong and what to do.

**About each connected account**, it only reads:

| Check | What it tells you |
| --- | --- |
| Connection | The account is connected and nothing has marked it for connecting again |
| Stored token / token lifetime | The token opens with this server's `TOKEN_KEY`; when it ends; whether Postbay renews it by itself |
| Permissions | What the network granted against what Postbay needs (the messaging permissions only when the brand has prizes on; the YouTube Analytics one only when `GOOGLE_ANALYTICS` is on) |
| Network accepts the connection | A light question to the network, with how long it took |
| Reading a post's numbers | The same call the results use, on the account's latest public post, to compare with what the network shows |
| Reading a post's comments | The same call prizes use (only when the brand has prizes on); for Instagram and Facebook, whether Meta pushes the account's comments |

The same checks run from *Settings → Accounts*: *Check* on an account, and a check of the server above the list. The screen **never**
publishes.

### A real test post

`--publish --yes` (command line only) makes **one real post** on each account it checks: a generated picture or video, sent through the
real publishing code (validate, prepare, publish, verify). It says what each step answered. **Postbay cannot delete it, and does not try**:
it prints where the post is, and you delete it. Use a test account.

### The transcript

`--capture DIR` writes every call the check made to the networks, and what came back, in one JSON file. Secrets are removed by their
shape before anything is written: tokens, `Authorization` headers, any JWT, any key that names a credential, and every query value of a
signed address. When a network answers in a way Postbay does not expect, that file is what lets the difference be reported and fixed. Read
it once before you send it anywhere.

### Bringing a network into use

The same order for every network:

1. Set `APP_URL` and `MEDIA_URL` to the public https addresses, `TOKEN_KEY`, and the network's credentials. Restart.
2. Run `npm run check -- --brand "…"` with no account connected. Fix every ✖ and read every ⚠ in the *server* section first.
3. Register `$APP_URL/api/oauth/callback` with the network, and connect **one test account** in *Settings → Accounts*.
4. Run the check again. Fix what it says about permissions and the token before going on.
5. `--publish --yes` for that network. Look at the post on the network, and delete it.
6. Wait for the 1-hour reading, or publish something real, and compare *Results* and the check's *numbers* line with what the network
   shows.
7. Only then connect the real accounts.

What to watch for on each:

| Network | Watch for |
| --- | --- |
| Facebook and Instagram | The app needs Meta's review before anyone but its own developers can connect. The Instagram account must be professional and linked to a Page. Facebook's native scheduling needs at least 10 minutes' lead: cancel a held post once and check it disappears from the Page's scheduled posts. Prizes need `META_WEBHOOK_VERIFY_TOKEN` |
| YouTube | Until Google audits the project every upload is private. A consent screen in *Testing* expires refresh tokens after about 7 days. Watch time needs `GOOGLE_ANALYTICS` and a verified project |
| Threads | One token, 60 days, renewed by Postbay |
| Bluesky | An app password, never the account's password |
| X | Every post is billed by X; a link in the text makes it dearer |
| LinkedIn | The API version is retired after about a year: the check warns before it is |
| Pinterest | The account is a board; pins are visible to others only with Standard access |
| TikTok | Private until audited, and the audit may be refused for a tool that posts for a team |

## Known limitations

- **Not yet tried against the real networks.** Each connector is written from the network's public documentation and tested against a
  stand-in that answers as that documentation says (`apps/api/test/fakes`). Request shapes, limits, error codes and how a post's id comes
  back may differ from what the real service does today. Expect the first real run of each network to find something; the
  [transcript](#the-transcript) is how to report it. The parts most likely to differ: Facebook's three-step Reels upload, the error codes
  mapped to each [kind of failure](publishing.md#failures-and-retries), the Graph API version, and the numeric limits of each network.
- **TikTok may refuse the audit** for a tool that posts for a team. Without it every post is private.
- **Meta comments and private messages need an app review.** Until Meta has reviewed the app, it pushes no comments and lets no private
  message go to accounts outside your team; prizes then depend on reading comments every few minutes, which Meta's documentation does
  not clearly promise for Instagram.
- **LinkedIn's version needs raising about once a year**, by a person.
- **X costs money** per post and per reading.
- **A story's numbers vanish after a day**: the 22-hour reading is the last chance, and an outage across it loses it (shown as *missed*).
- **YouTube watch time** is lifetime to date for the video, not per day, and lags a day or two.
- **A real test post** cannot be deleted by Postbay.
