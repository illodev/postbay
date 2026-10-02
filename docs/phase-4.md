# Phase 4: the rest of the networks, results and prizes

This follows the delivery plan in the technical specification ("Estudio de contenidos: especificación técnica"): phase 4 is
*the rest*: TikTok, LinkedIn, X, Threads, Pinterest and Bluesky, the numbers each post earned, and prizes for commenting.

> **Read this first.** Everything in this phase was proven against **stand-ins for the networks** (`apps/api/test/fakes`), which I wrote
> from each network's public documentation. **Nothing was run against a real Threads, Bluesky, X, LinkedIn, Pinterest, TikTok, Meta or
> Google.** Every request shape, every error code and every limit below is "as documented when this was written", not "as observed".
> Expect the first real run of each network to find something. The tests prove that *this application* does what it means to with the
> answers the stand-ins give; they cannot prove the real services still answer that way. Phase 2's limits (Meta, Google) are unchanged.
>
> **Two of these networks may not let you use this at all.** TikTok's own guidelines call tools that post to accounts managed by a
> team "not acceptable", so its audit may be refused; until it passes, every TikTok post is private. And Meta only pushes comments to,
> and only lets private messages go out from, an app it has reviewed. See [Known limits](#known-limits).

## Scope against the specification

| Specification | Status |
| --- | --- |
| Connectors for TikTok, LinkedIn, X, Threads, Pinterest, Bluesky | Done, against stand-ins. [One table below](#the-networks) says what each does |
| Each network's own rules and settings in the schedule dialog | Done: connectors declare option fields (TikTok's mandatory controls, alt text, Pinterest's title and link…) and the dialog draws them |
| Metrics 1 hour, 1 day, 7 days and 28 days after publishing; stories within 24 hours | Done. Stories are read at 1, 6 and 22 hours |
| A results screen | Done: *Results*, one section per network, **never a total across networks** |
| Prizes: keyword in a comment → private message with a link → download, link expiry, a week of grace, data kept as briefly as possible | Done for Instagram and Facebook (automatic); a public page for the rest. [See below](#prizes-for-commenting) |
| Deleting people's data on request, and when Meta says so | Done: erase a person, retention purge, Meta's data-deletion callback and status page |
| Reading comments of posts with a prize | Done by webhook (Meta pushes) with polling as the fallback |

## The networks

| | How it signs in | What it posts | Its token | Can it publish the same post twice? |
| --- | --- | --- | --- | --- |
| **Threads** | Sign-in page | Text with a picture, a video, or a carousel (a post is always a file: there are no text-only posts in this studio) | Lasts 60 days, renewed up to a week before it ends | No: a post is made in two calls, and the second is only made once |
| **Bluesky** | A handle and an **app password**, typed in *Settings → Accounts* (no sign-in page exists for apps) | Pictures (up to 4) or a video; the hashtag, link and mention in the text become links. The 300-character limit counts what a person sees as one character | The session lasts about two hours; renewed ten minutes ahead, and made again from the stored app password if its renewal fails | No: the post's record key is a TID made from the publication and its time and kept before the write, so a repeat overwrites itself |
| **X** | Sign-in page with PKCE | Pictures (up to 4) or a video, with alt text. A link in the text, or in the first comment, is a warning, because X charges 13 times more for any post with one, replies included (and it makes a link of a bare domain too) | Renewed five minutes before it ends | X has no key for this. A post whose answer was lost is found again among the account's own posts since the attempt, by the media it carries (X rewrites the text's links), before another is made |
| **LinkedIn** | Sign-in page; you choose the company page | A picture, several pictures, a video, or a document (PDF) | No renewal for most apps: the token is kept and the account warns a week before it ends | No key either; a repeat is refused by LinkedIn with the original's name, which is how it is found |
| **Pinterest** | Sign-in page; **the account is a board** | A pin (one picture), a carousel pin, or a video pin (the video streamed from storage, never held in memory); title, destination link and alt text | Renewed three days before it ends | No key; the board is searched before a second pin is made |
| **TikTok** | Sign-in page (it reads only what `user.info.basic` gives: open_id, display name, avatar) | A video or photos | Renewed an hour before it ends; a renewal token that changes is kept | The upload is made in `publish` and TikTok's processing is watched in `verify`. A photo post is not safe to repeat, and the app does not repeat it |

Until the network approves the app, **TikTok** (always), **Pinterest** and **YouTube** accept the post but only the account can see it.
The studio says so on the post, in each network's own words, marks the post *Private*, and an admin flips the account's approval flag
in *Settings → Accounts* once the network has approved the app; *Check again* then looks at the post again. A private post gets **no
readings**.

### What the dialog asks for

A connector declares the settings it needs; when an account is chosen, the schedule dialog asks the server for that account's settings
(`GET /api/brands/:brandId/accounts/:accountId/options`) and draws them, with only the ones that apply to the kind of post, and the API
checks them. Nothing hidden is saved. TikTok's are the strictest, because TikTok obliges an app that posts for people to ask TikTok, **while
the post is being written**, what this creator may do (`creator_info`), and to show:

- Who the post goes out as: *Posting to TikTok as* the creator's nickname (and @username).
- **Who can see this post**: only the choices TikTok returns for this creator, nothing chosen, and it cannot be scheduled until they choose.
  Until TikTok audits the app only *Only me* is offered, and TikTok also requires the TikTok account itself to be set to private.
- Comments, duets and stitches: all unticked, and shown switched off (not tickable) where the creator has switched them off in TikTok.
- *This post promotes a brand, product or service*: if ticked, say whether it is your own brand (labelled *Promotional content*), branded
  content (labelled *Paid partnership*; it cannot be private, so *Only me* cannot be picked with it), or both.
- TikTok's consent sentence, shown **word for word** and needing a tick: "By posting, you agree to TikTok's Music Usage Confirmation.",
  replaced by "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." for branded content.
- The longest video this creator may post, and that TikTok can take a few minutes to process the post before it shows on the profile.

What TikTok said is kept on the account, so scheduling is checked against it (the privacy chosen is on offer, nothing is allowed that the
creator switched off, the video is not too long), and publishing asks TikTok again just before sending: a privacy no longer offered stops
the post, and what the creator has switched off since goes out switched off. A YouTube channel's settings start from its made-for-kids
default, when one is set (see [phase 2](phase-2.md#corrections-after-the-connector-review-october-2026)).

### Settings of each network that the studio does not control

The studio cannot make a network publish something it refuses. Each connector turns what the network says into one of six kinds of
failure (no longer allowed to sign in, rate limit, file refused, transient, not supported, unknown) and the same engine as phase 2
handles it: a transient failure is retried five times with growing waits; one that needs a person hands the post over, never silently.
Only a token the network no longer takes asks for the account to be connected again. A 403 is read for what it says: X's refusal of the
app's set-up (a project, an access level) or of the content, LinkedIn's or Pinterest's missing permission, or a refusal from Bluesky's
video service, hands the post to a person with the network's words and leaves the account as it is.

## Results

When a post is verified **public**, the studio creates its readings, due 1 hour, 1 day, 7 days and 28 days after it was published (a story:
1, 6 and 22 hours, because its numbers disappear after a day). A worker takes each when it falls due, claiming it with a lease so two
workers never take one twice. A reading is **read**, **not available** (the network has nothing to give for this post), **failed** (it
gave up after five tries with growing waits), or **missed** (the window closed first). A network that is rate-limiting makes the reading
wait without counting as a failed try.

*Results* shows the last 90 days, or the dates you pick, filtered by network. Each network has its own section: totals of the latest reading
of each post, and a table with that reading, which ages have been read, and a *Readings* dialog with every age. **Networks are never added
together:** a "view" does not mean the same on each (X's impressions, Instagram's views, a video's plays), the screen says so, and the
API's totals are per network only. Average watch time is shown per post and is never summed.

Cost to know about: X charges for reads too (about 0.001 USD per post per reading), which is why readings are taken at four fixed ages
and not continuously. YouTube numbers come from the Data API's public statistics (views, likes, comments): there is no watch time.

## Prizes for commenting

An admin switches prizes on per brand in *Settings → Prizes*. **That is what makes the next Meta sign-in ask for the permissions to send
messages**; a brand that does not use prizes is never asked for them. Accounts connected before have to be connected again (*Renew*) to grant
them, and the prize dialog says so when a post's account lacks them.

1. **A library**: a *file* kept here (uploaded straight to storage, with its hash checked), or a *link* somewhere else. Since then also, and
   recommended, a *piece* of the studio, which hands out its latest approved version: see [after the phases](after-the-phases.md#prizes-from-a-piece-of-the-studio).
2. **A rule per post**: *Prize…* on a published or scheduled post. A prize, a keyword (any case, accents ignored, whole word), the message
   (`{{name}}`, `{{prize}}`, `{{link}}` which is required, `{{hours}}`), how long each person's link works, and a **confirmation that the post's
   own text says the reply is automatic and what is done with people's data**. A rule does not run without it. Every message is also given a
   note at the end ("This is an automatic message." unless you change it), which cannot be removed.
3. **A comment arrives**: Meta pushes it to `/api/meta/webhook` (signed with the app secret; the handshake uses `META_WEBHOOK_VERIFY_TOKEN`), or the
   worker finds it while reading the comments of posts with a running rule every few minutes. Only top-level comments that contain the keyword and are not the account's own count.
   Meta only pushes a Page's events once the app is **subscribed to that Page** (`POST /{page-id}/subscribed_apps`, which needs
   `pages_manage_metadata`, one of the permissions asked for with prizes on). The studio subscribes when a Facebook Page (field `feed`) or an
   Instagram account (field `comments`, through its Page) is connected with that permission, when prizes are switched on for the brand
   (every Meta account of the brand, at once), and again when a rule that answers by message starts; it keeps the other account's fields
   when both share a Page, and takes its own away when the account is disconnected. The account check (*Check* on the account) says
   whether Meta pushes its comments, and the account list carries the subscription (`details.events`: subscribed, fields, and why not).
4. **The private reply**: sent by the app to the comment, within Meta's rules: one message per comment, within 7 days of it, and no more than 700 an hour
   per account (Meta's own cap is 750). The same person gets the same prize once, whichever post they commented on, even if two comments arrive at once
   (the database enforces it). If it cannot go yet it is retried with growing waits, never past the seven days.
5. **The link**: a page on this studio, opened without signing in, that shows the prize's name and who it is from and nothing about anyone else. A person's link
   works for the hours you chose and at most five downloads; a file is then handed over by a link that works five minutes. Not indexed by search engines.
6. **Networks that cannot message** (everything but Instagram and Facebook): the rule gives a **public page** for the prize instead. You pin a comment that
   points to it. It is open until the date you choose.

**What is kept about people.** For each person who commented the keyword: their id on the network and the name they show, and what happened. It is
deleted by the worker once the brand's retention period ends (30 days by default, at least 8: Meta allows 7 days to reply), after which nothing about
them exists; the audit log keeps only a *count* of what was purged, never who. The screens show the name they show and never the network's id. An admin can
erase a person on request (by their name or id), and Meta's **data-deletion callback** (`/api/meta/data-deletion`, signed) deletes everything held about a person
who removes the app, and answers with a status page (`/data-deletion?code=…`) as Meta requires. Register `/data-deletion` as the instructions page too.

## Setting up the networks

`.env.example` lists every variable. Each network switches on when its credentials are set (and `TOKEN_KEY`, which seals the tokens, is set);
Bluesky needs only `TOKEN_KEY`. For each, the redirect address is `$APP_URL/api/oauth/callback`.

- **Threads**: a Meta developer app with the Threads use case; `THREADS_APP_ID`, `THREADS_APP_SECRET`. The studio asks for `threads_basic`, `threads_content_publish`, `threads_manage_insights` and `threads_manage_replies`.
- **TikTok**: a developer app with Login Kit and the Content Posting API; `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. For photo posts TikTok downloads
  the pictures itself, only from a **domain you verified in its portal**: the domain of the signed addresses the app hands out. With the local storage
  driver that is `MEDIA_URL`; with `STORAGE_DRIVER=s3` the addresses are signed for the bucket, so it is the host of `S3_PUBLIC_ENDPOINT` (or of
  `S3_ENDPOINT` when that is not set), not `MEDIA_URL`. The server check (*Settings → Server*, `npm run check:networks`) names the domain to verify.
  Until the audit passes, posts are private, and TikTok only takes them from a TikTok account that is itself set to private.
- **LinkedIn**: an app with the Community Management API product (the studio asks for `w_organization_social`, `r_organization_social` and `rw_organization_admin`), and an admin of the company page; `LINKEDIN_CLIENT_ID`,
  `LINKEDIN_CLIENT_SECRET`. The API is versioned by month and each version is retired after about a year: **raise `LINKEDIN_VERSION`** (`YYYYMM`) when
  a post's history says the version is retired. The studio says so in those words.
- **X**: an OAuth 2.0 app (scopes `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write`); `X_CLIENT_ID`, `X_CLIENT_SECRET`. Posting is billed per post by X.
- **Pinterest**: an app (Trial access shows pins only to you; ask for Standard); `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`.
- **Bluesky**: *Settings → Accounts → Connect Bluesky*, with the handle and an **app password** made in Bluesky (*Settings → Privacy and security → App passwords*), not
  the account password. A different server: `BLUESKY_PDS_URL`. A server a person types in the form instead is held to the webhooks' rules: only the
  https address of a server (http only to a private address where `WEBHOOK_ALLOW_PRIVATE_NETWORKS` allows it), checked when connecting, with no
  redirects followed. Videos go to `BLUESKY_VIDEO_URL` with two service tokens: one for the video service itself (the allowance), one for the server the
  account's repository is on (the upload), which is read from the account's DID document (bsky.social only fronts it).
- **Meta, for prizes**: register `$APP_URL/api/meta/webhook` (objects *Instagram* and *Page*, comments; the studio subscribes the app to each Page itself, above) with the verify token you put in `META_WEBHOOK_VERIFY_TOKEN`, and
  `$APP_URL/api/meta/data-deletion` and `$APP_URL/data-deletion` as the data-deletion callback and instructions. *Settings → Prizes* shows these addresses.
  Meta needs to review the app before it pushes comments from, or lets private messages go to, accounts outside your team. Until then the worker reads the comments itself.

## Decisions where the specification left room

- **A network's settings are declared by its connector**, not hard-coded in the screens, so a new network needs no screen work. The server checks them as well.
- **Text-only posts do not exist**: a version is always files (as since phase 1), so Threads, X and Bluesky posts always carry a picture or video.
- **One total per network, none across.** The results API does not even offer one.
- **Prizes ask for their permissions only when switched on.** The cost is a reconnect for brands that switch them on later.
- **A reply that is not automatic is not sent.** The notice confirmation is a person's statement about the post's text; it cannot be inferred and the rule will not run without it.
- **Retention is a floor of 8 days**, because Meta's window is 7 and keeping people for less than it takes to answer them would defeat the prize.
- **The same prize goes to the same person once** across posts, enforced in the database, so a race cannot give two.
- **Pinterest's account is a board**, because a pin needs one. Connecting two boards makes two accounts.
- **Bluesky's app password is kept sealed** (never shown again) so the session can be remade when its renewal token expires.

## What was verified, and how

- **507 API tests against a real PostgreSQL (249 before this phase, 258 new)** and the 51 runner tests, all passing. New for this phase:
  - *Each connector against its stand-in*, written from the network's documentation: sign-in and token exchange, what is sent for every kind of post,
    each way the stand-in can refuse (rate limits, rejected files, a revoked token, a retired API version), processing that takes several looks,
    and **a lost answer**: for X, LinkedIn and Pinterest the stand-in makes the post but swallows the reply, and the test checks the retry finds
    the first post instead of making a second; for Bluesky, that repeating the step writes the same single record.
  - *Connecting and renewing*: the eight providers, PKCE for X, the app-password sign-in for Bluesky (and the session made again when its renewal
    token has expired), every network's renewal window, and a token that cannot be renewed asking to be connected again.
  - *Results*: the rows made when a post goes live (stories included), reading only when due, leases (a reader that died is taken over), the
    five tries with growing waits, a rate limit that waits without using up a try, a story whose window closed, and totals per network only.
  - *Prizes*: keyword matching, the rule's checks, Meta's own rules in the stand-in (one reply per comment, seven days, the permission), the hourly cap,
    one prize per person across posts **including two comments racing**, retention, erasing a person, the signed webhook and data-deletion callback,
    and the public page's limits (expiry, five downloads, a file link that works for five minutes).
  - Rules were broken on purpose, one at a time, to confirm the tests notice, across the connectors, results and prizes. One mutant (dropping the code's
    check that a person already has a prize) survived at first because the database's unique index caught what the code did not; a test of two comments
    at once was added so the behaviour itself is pinned.
- **A real-browser run** (`e2e/phase4.sh`, 36 steps, with the real worker, ffmpeg, PostgreSQL and pg-boss, against the stand-ins): a connect button per
  network; five sign-in pages, a board picker, and Bluesky's form (a wrong app password refused, the right one never coming back to the page); tokens sealed
  in the database; the schedule dialog's per-network settings (TikTok's empty privacy choice, its unticked boxes, its consent text word for word, and the
  branded-content rules; alt text; Pinterest's title and link) and that **only the fields showing are saved**; Bluesky counting characters as seen (three
  family emoji are 3, not 21); one photo published by the worker to **eight networks**, with what each stand-in received checked (text, alt text, hashtag
  link, board and link, TikTok private); the private-until-approved note in each network's words; readings taken and *Results* showing one section per
  network with no total across them; prizes end to end (switching them on, a link and an uploaded file, the account that must be reconnected for the
  messaging permission, the rule's checks, a **signed** webhook and its handshake, an unsigned one refused, the private message within seconds with the
  automatic note, the same person getting it once, the public page and the **byte-identical download** from a visitor who is not signed in, a public link for
  a network that cannot message, erasing a person, Meta's data-deletion callback and its status page, the worker purging expired entries and the audit log
  holding only counts); and phone-sized screens with no sideways scroll.
- **Regression**: phases 1, 2 and 3's browser runs were run again after these changes.
- **Problems the work found, all fixed:**
  - Going live and creating the readings were two separate writes, the readings four separate statements. A reader, and a crash, could see or leave a public
    post with some or none of them. It is now one statement, and the worker also gives the rows to a recent public post that lacks them. (Found because an
    existing worker test failed once in a full run; a test of the recovery, and of the one statement, was added.)
  - The note under a private post was written in Google's words for every network. Each network now has its own.
  - A checkbox that another field hangs from (TikTok's *branded content* under *promotes a brand*) kept its dependents alive after it was hidden, so a hidden
    consent would still have been required and sent. Dependents are now hidden with it, and the browser run asserts it.
  - Expired prize entries were deleted by a timer that ran once an hour and could not be set; it is now `PRIZE_PURGE_SECONDS` (still hourly by default).
  - The first draft of the browser test had wrong expectations (TikTok accounts are shown as `@name`) and ambiguous selectors; fixed. They were test errors, not
    application errors.
- **Not verified**: anything against a real network (above); the Docker image (no daemon here); S3; browsers other than Chromium; the web app has no
  unit tests of its own: its behaviour is exercised only through the browser run. Phone screens were checked for sideways scroll and by eye in screenshots,
  not on a device.

## Corrections after the connector review (October 2026)

A review against the networks' current documentation (read 2026-10-01 and 02, **still no real network**) found these, fixed with a test
each and the stand-ins changed to behave as documented, since they had shared the code's misunderstandings:

- **TikTok could not be connected at all**: sign-in asked `/v2/user/info/` for `username`, which needs `user.info.profile`; TikTok refuses
  the whole call (`scope_not_authorized`). It asks only for what `user.info.basic` gives. The compose-time rules are above.
- **Bluesky video** used the wrong audiences for its service tokens (the server signed in to, for both), so the video service refused
  them, and that refusal marked the whole account for reconnection. Post record keys are TIDs, as Bluesky expects, instead of the
  publication's id. The *Server* field is held to the webhooks' address rules.
- **X** never found a post whose answer was lost (it compared the exact text, which X gives back rewritten), and advised moving a link to
  the first comment, which costs the same. Details in the table above.
- **LinkedIn**'s first comment lacked `object`, the post it is on. **Pinterest** read a whole video into memory to upload it.
- **A 403** from X, LinkedIn or Pinterest marked the account for reconnection whatever it meant (see above).
- **`check --capture`** wrote Bluesky's session tokens and most of each signed address into the transcript; secrets are now removed by their
  shape (any JWT, any key that names a credential, every query value of a signed address).
- The browser run (`e2e/phase4.sh`) was **not** run again after these changes. Its TikTok steps were brought up to date afterwards (the settings
  come from TikTok through the options endpoint, only "Only me" before the audit, one consent sentence at a time), still without running it:
  the web is being redesigned.

## Known limits

- **Nothing was run against any real network.** See the box at the top. The stand-ins encode what I read in each network's documentation: request shapes, limits, error
  codes, how a post's id comes back. Any of them may differ, or have changed.
- **TikTok may refuse the audit**, and says in its guidelines that tools posting for a team's accounts are "not acceptable". Without the audit every post is private and a person has to publish it
  in TikTok. A photo post start is not safe to repeat, so the app does not repeat it.
- **Meta comments need an app review**; the polling fallback is what this studio depends on until then, and polling comments on Instagram is itself something I could not confirm Meta's documentation promises. Where Meta gives only a username
  for a commenter on Instagram, it is used as both the person's id and name.
- **Private messages to people outside your team need Meta's review too** (the messaging permissions), and the 7-day window and one-message-per-comment rules are Meta's, not ours.
- **LinkedIn's version header needs a yearly bump.** The studio says so, but a person has to do it.
- **X costs money per post and per reading.**
- **YouTube's numbers are views, likes and comments only** (the Data API's statistics): watch time comes from the Analytics API, which needs a permission the studio does not ask for yet.
- **A story's numbers vanish after a day**; the 22-hour reading is the last chance and a network outage across it loses it (shown as *missed*).
- **Prize permissions need a reconnect** for accounts connected before prizes were switched on.
- **The prize link is a bearer link**: anyone who gets it can use it until it expires or is used five times. A person who forwards it forwards the prize.
- **Compose and the S3 driver remain unexercised for real**, as in the earlier phases.

## Your first real run

1. Set `TOKEN_KEY`, then one network's credentials at a time (above). Start with Bluesky (nothing to register) or Threads.
2. In *Settings → Accounts*, connect it, and publish one photo to it from *Schedule…*. Look at *History* on the post: every call the app made is there.
3. Look at *Results* after the 1-hour reading is due. Compare the numbers with what the network shows.
4. For prizes, switch them on, connect Instagram again, add a link prize, give a test post a rule, and comment the keyword from another account.
