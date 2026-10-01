# Phase 1: what is built, what is not, and what was decided

This follows the delivery plan in the technical specification ("Estudio de contenidos: especificación técnica"):
phase 1 is *review*: pieces and versions, anchored comments, approval, calendar and assisted publishing. Its gate is
that a marketing team can review and approve here even while someone still posts by hand. It needs no approval from any
network, so it can be built and used while those paperwork steps run.

## Scope against the specification

| Specification | Status |
| --- | --- |
| Pieces with variants (format and style) and immutable numbered versions | Done |
| Roles per brand: admin, approver, reviewer, producer, reader; one person, different roles in different brands | Done |
| Approvals needed per brand (1 by default); moving an approved date needing another approval (off by default) | Done. Per-brand settings |
| Producer can be a person or an API token; the app treats both the same way | Done |
| Video viewer: frame by frame, comments on a moment or span, marks on the timeline, frame saved with each comment | Done |
| Images, carousels and PDF: a page behind another, comment anchored to a point or a rectangle | Done |
| Compare versions side by side or flipping, synchronised playback; earlier comments shown as "resolved in v4" or "still open" | Done |
| Approve for specific networks, with a per-brand checklist; no approval with open comments unless the approver closes them | Done |
| Approval tied to the sha256 fingerprint of the files; a new version voids it | Done. Rechecked from the stored files, not trusted |
| Calendar: month, week, list; fixed slots per account; drag to move; blocked dates; pause button; dependencies between publications | Done, except dependencies are API-only (`dependsOn`); the schedule dialog does not offer them yet |
| Times in UTC plus the brand's IANA zone | Done, tested across both clock changes |
| Assisted publishing: warn the person responsible with files and text ready; they mark it published | Done |
| Notifications when a version arrives, someone comments, something waits for approval, a post is due | Done in the app and by email. Not Slack or push |
| Append-only audit log | Done, enforced in the database |
| API for producers (create piece, variant, signed uploads, close version, open comments, reply, empty slots) | Done. No webhooks (phase 3) |
| Tokens: hashed, shown once, expiring, valid for one brand | Done |
| Signed upload URLs; files never pass through the app; private bucket; separate media domain | Done. Local driver tested; S3 driver written but see below |
| Subtitles shown beside the video and commented line by line | Not yet. Subtitle files can be uploaded and are part of the fingerprint |
| Safe-zone overlays, per-network previews, per-network text counters and limits | Done in phase 2 ([docs/phase-2.md](phase-2.md)), because they depend on what each connector declares |
| SSO (OIDC) and mandatory two-factor for admins and approvers | Not yet. Sign-in is a one-time emailed link |
| Slack and push notifications | Not yet |
| Connectors, queue, retries, token refresh | Done in phase 2 for Instagram, Facebook and YouTube ([docs/phase-2.md](phase-2.md)) |
| Metrics, prize delivery, agent runner, the other networks | Phases 3 and 4 |

## Decisions where the specification left room

- **Approvers can upload.** The specification lists "approve a version they uploaded themselves" as something an
  approver cannot do, which only makes sense if they can upload. Admins can too. The rule applies to everyone,
  whatever their role, and is checked in the approval itself.
- **A token-authored version has no person behind it**, so any approver can approve it. Tokens are created by admins,
  and the admin who created one is not blocked from approving what that agent makes (otherwise the usual setup, an admin
  who owns the agent and approves its work, would be impossible).
- **The fingerprint** is the sha256 of one line per file, `position<TAB>kind<TAB>sha256`, sorted by position and kind.
  A different cover, a reordered carousel or one changed byte gives a different fingerprint.
- **A new version puts scheduled publications on hold instead of moving them.** The approver brings them back with an
  explicit "reschedule" onto the newly approved version. Silently carrying a date over to new content would let
  something go out that nobody approved for that slot.
- **With more than one required approval**, the approved accounts are the ones every approver agreed on. If two
  approvers pick accounts with nothing in common, the second approval is refused until they align.
- **"Needs confirmation" covers text edits as well as date moves** when the brand turns it on. Otherwise the text could
  be changed after the approval without anyone seeing it.
- **Reject means changes requested**, with a mandatory reason. There is no separate dead state: the diagram in the
  specification goes back to a new version.
- **Comments on an older version stay visible.** Open ones carry over and block approval of the next versions until
  someone resolves them; ones a version fixes show as "resolved in vN". A producer or an agent can still reply to a
  thread on a superseded version, because that is exactly when the agent answers.
- **Only reviewers and above start threads.** Producers reply and resolve, as specified.
- **Background work runs in the API process** (a 30 second loop that announces due publications and sends email),
  guarded so two instances do not double-send. The specification's queue (pg-boss) arrived with the publisher in
  phase 2, where retries and idempotency keys matter: see [docs/phase-2.md](phase-2.md). The announcing and email loop
  described here still runs in the API process.
- **The frame behind a video comment is grabbed by ffmpeg when the comment is posted.** If ffmpeg is missing or fails,
  the comment is still saved, without the frame.
- **Responses carry security headers and a Content-Security-Policy** (own-origin scripts only; WebAssembly allowed for
  hashing files and the PDF engine). Only `http(s)` links can be recorded on a published post, because they are shown as
  links.
- **PDF.js legacy build.** The current build needs very recent browser features; the legacy build carries the
  polyfills.

## What was verified, and how

- 77 integration tests against a real PostgreSQL: the rules, permissions, isolation between brands, sign-in, the
  calendar across the spring and autumn clock changes, and the database guarantees, by trying to break them (editing a
  version, swapping a file hash, rewriting the audit log). Three core rules were also broken on purpose, one at a time, to
  confirm the tests notice; that found one rule (the fingerprint recheck when scheduling) that was not covered, and it now is.
- A real-browser run over the whole flow (`e2e/`): upload, comments with real frames, request changes, a second version,
  approval blocked and then granted, comparison, scheduling, drag on the calendar, pause, assisted publishing, a PDF,
  a carousel, role restrictions and a phone-sized screen. It runs with real ffmpeg and the production build of both halves.
  It caught several real bugs along the way (a file list read after it was cleared, a video that reloaded whenever the
  page refetched, a Content-Security-Policy that blocked WebAssembly).
- The compiled production build starts, applies migrations, serves the app, and refuses the development sign-in.

## Known limits

- **The S3 driver and the Docker Compose and Caddy files were not run here.** There was no Docker daemon or bucket in the
  environment. The Compose file validates and the S3 code follows the SDK's documented presign and checksum calls, but
  both need a first real run. The local driver, which behaves the same way from the app's point of view, is what the
  tests and the browser run used.
- **The browser test uses WebM**, because the headless Chromium it runs on has no H.264 decoder. The server accepts MP4 as
  well and ffprobe and ffmpeg handle it; playback in a normal browser was not part of this run.
- **Uploads are a single signed PUT** (up to 4 GiB). There is no resumable or multipart upload yet.
- **Dragging on the calendar needs a mouse.** The list view and the "Move" dialog on the piece page do the same job
  without it.
- **After rebuilding the web app, restart the API** when it serves the files itself: the static file list is read at start.
