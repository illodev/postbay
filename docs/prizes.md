# Prizes for commenting

A post can carry a prize: whoever comments a keyword gets a file or a link. On Instagram and Facebook it arrives by private message; on
the other networks, a public page for the prize does the job.

## Switching prizes on

An admin switches prizes on per brand in *Settings → Prizes*. **That is what makes the next Meta sign-in ask for the permissions to
send messages** (and `pages_manage_metadata`); a brand that does not use prizes is never asked for them. Accounts connected before have
to be connected again (*Renew* in *Settings → Accounts*) to grant them, and the prize dialog says so when a post's account lacks them.
With Facebook Login for Business, those permissions come from `META_LOGIN_CONFIG_ID_PRIZES` ([Meta setup](networks.md#meta-facebook-and-instagram)).

## The prize library

A prize is one of three kinds:

- **A studio piece** (the recommended kind): whoever downloads it gets the main file of the piece's latest approved version at that
  moment ([below](#prizes-from-a-studio-piece)).
- **A file** kept in Postbay, uploaded straight to storage with its hash checked.
- **A link** somewhere else.

### Prizes from a studio piece

`POST /api/brands/:id/prizes { kind: 'piece', name, pieceId }`.

- **What it hands out is decided at the moment of download**: the **main file** (the PDF of a document, the video, or a carousel's first
  image or video; never a cover or subtitles) of the **latest approved version of the piece**, among all its variants. Approving a new
  version changes the prize for whoever downloads from then on, through the same links. A version that was approved keeps being handed
  out while a newer one is in review.
- **A piece with no approved version is refused** (`409 no_approved_version`), and so is a piece of another brand
  (`400 unknown_piece`). The same holds when the prize is put on a post.
- **When the approved version disappears** (the piece is discarded), the prize shows as having none (`usable: false`,
  `unavailable_reason`), the public page says it is not available, a download answers `409 no_approved_version` and counts nothing, and
  a private message waiting to go out waits instead of promising nothing: it goes out if a version is approved within Meta's seven
  days, and fails after.

In the library (`GET /api/brands/:id/prizes`), a piece prize carries `piece` (`id`, `title`) and `version` (`id`, `number`, `format`,
`approved_at`, `file_name`, `mime`): what it would hand out now. The screen shows its thumbnail and the version and file it hands out,
or *No approved version*. The public page (`GET /api/public/prizes/:token`) shows it as a file and says nothing about the piece.

Postbay keeps **when each version reached its approval** (append-only), because a version's state only says where it is now: a superseded
version may or may not have been approved.

## A rule per post

*Prize…* on a published or scheduled post sets its rule:

- the prize;
- a keyword (any case, accents ignored, whole word);
- the message, with `{{name}}`, `{{prize}}`, `{{link}}` (required) and `{{hours}}`. Every message ends with a note ("This is an
  automatic message." unless you change it), which cannot be removed;
- how long each person's link works;
- a **confirmation that the post's own text says the reply is automatic and what is done with people's data**. A rule does not run without
  it: it is a person's statement about the post's text, and cannot be inferred.

## How a comment becomes a prize

1. **A comment arrives.** Meta pushes it to `$APP_URL/api/meta/webhook` (signed with the app secret; the handshake uses
   `META_WEBHOOK_VERIFY_TOKEN`), or the worker finds it while reading the comments of posts with a running rule every
   `PRIZE_POLL_SECONDS`. Only top-level comments that contain the keyword and are not the account's own count.
2. **The private reply** is sent to the comment, within Meta's rules: one message per comment, within 7 days of it, and no more than 700 an
   hour per account (Meta's own cap is 750). The same person gets the same prize once, whichever post they commented on, even if two
   comments arrive at once (the database enforces it). If it cannot go yet it is retried with growing waits, never past the seven days.
3. **The link** is a page on Postbay, opened without signing in, that shows the prize's name and who it is from, and nothing about anyone
   else. A person's link works for the hours you chose and at most five downloads; a file is then handed over by a link that works five
   minutes. The page is not indexed by search engines.

Meta only pushes a Page's events once the app is **subscribed to that Page** (`POST /{page-id}/subscribed_apps`, which needs
`pages_manage_metadata`). Postbay subscribes when a Facebook Page (field `feed`) or an Instagram account (field `comments`, through its
Page) is connected with that permission, when prizes are switched on for the brand (every Meta account of the brand, at once), and again
when a rule that answers by message starts. It keeps the other account's fields when both share a Page, and takes its own away when the
account is disconnected. *Check* on the account says whether Meta pushes its comments, and the account list carries the subscription
(`details.events`: subscribed, fields, and why not).

## Networks that cannot message

Every network but Instagram and Facebook: the rule gives a **public page** for the prize instead, open until the date you choose. Pin a
comment that points to it.

## What is kept about people

For each person who commented the keyword: their id on the network, the name they show, and what happened. The worker deletes it once the
brand's retention period ends (30 days by default, at least 8, because Meta allows 7 days to reply), after which nothing about them
exists; the audit log keeps only a *count* of what was purged, never who. The screens show the name a person shows, never the network's
id.

- An admin can **erase a person** on request, by their name or id.
- Meta's **data-deletion callback** (`$APP_URL/api/meta/data-deletion`, signed) deletes everything held about a person who removes the app,
  and answers with a status page (`$APP_URL/data-deletion?code=…`), as Meta requires.

## Setting up Meta for prizes

In the Meta app, register:

- `$APP_URL/api/meta/webhook` as the webhook (objects *Instagram* and *Page*, comments), with the verify token you put in
  `META_WEBHOOK_VERIFY_TOKEN` (any long random string);
- `$APP_URL/api/meta/data-deletion` as the data-deletion callback, and `$APP_URL/data-deletion` as its instructions page.

*Settings → Prizes* shows these addresses. Postbay subscribes the app to each Page itself (above).

To try it: switch prizes on, connect Instagram again, add a link prize, give a test post a rule, and comment the keyword from another
account.

## Known limitations

- **Meta must review the app** before it pushes comments from, or lets private messages go to, accounts outside your team. Until then the
  worker reads the comments itself, and reading comments that way on Instagram is not clearly promised by Meta's documentation. Where Meta
  gives only a username for an Instagram commenter, it is used as both the person's id and name.
- The 7-day window and the one-message-per-comment rule are Meta's.
- **Prize permissions need a reconnect** for accounts connected before prizes were switched on.
- **The prize link is a bearer link**: anyone who gets it can use it until it expires or is used five times. A person who forwards it
  forwards the prize.
- **A piece prize hands out one file**: a carousel gives its first image or video, not all of them.
