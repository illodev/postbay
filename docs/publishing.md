# Publishing

Only an approved version can be scheduled, and only on the accounts it was approved for ([approval](review.md#approval)). From there a
post goes out one of two ways:

- **Automatically**, when the account is connected and the network can take this content: a worker prepares the post shortly before the
  hour, publishes it at the hour and checks it is really live.
- **By hand**, when the account is manual, the network cannot take this content through its API, or the person scheduling chooses *I
  will publish this one by hand*: at the hour, the approvers are told and Postbay has the files and text ready.

## Scheduling

Approvers and admins schedule from the piece page or the calendar. Times are given in the brand's time zone and stored in UTC with the
brand's IANA zone, so a post set for 19:00 stays at 19:00 across a clock change.

Scheduling is refused while the brand is paused, on a blocked day, for a time that has passed, or for a version whose stored files are no
longer the approved ones. A version can be scheduled even while a new version of the same variant is being uploaded: the variant's lock
makes sure only what is approved goes on the calendar.

### What the schedule dialog shows

The dialog asks the server how the post would go out (`POST /api/versions/:id/publications/validate`). If the account is connected and
the network can do this content, it says **Postbay will publish it**, and shows:

- the kind of post (Reel, photo, Story…);
- the network's limits next to the text (characters, hashtags, mentions) and what the feed shows before "more";
- the settings the network needs ([what the dialog asks for](networks.md#what-the-schedule-dialog-asks-for));
- anything that would stop it. An error blocks the button; a warning does not.

The person can always choose to publish that one by hand instead. A post can carry a first comment, which goes out after the post where
the network allows it. The title and the AI label that go out are the ones the version was [approved with](review.md#what-is-approved-with-the-files).

### Changing what is scheduled

An approver can move a post (drag it on the calendar, or *Move* on the piece page), edit its text, or cancel it. A brand can turn on
*Changing something already scheduled needs a second approver to confirm* (*Settings → General → Approval rules*): moving the date or
editing the text then waits, *Awaiting confirmation*, until a second approver confirms it.

**A new version puts what is scheduled on hold** instead of moving it to the new content. Once the new version is approved, an approver
brings each post back with *Reschedule* onto it. Carrying a date over silently would let something go out that nobody approved for that
date.

### Dependencies between posts

A post can depend on another (`dependsOn` on `POST /api/versions/:id/publications`). It is not prepared until the first one is out
(published by Postbay or marked published by a person), so a network is never holding it while the first is still in doubt. If the first
is cancelled, fails or is put on hold, or is still not out at the dependent's hour, the dependent is put on hold with the reason. Moving
either of them past the other is refused.

## Automatic publishing

### Prepare, publish, verify

1. **Prepare**, the brand's lead time before the hour (30 minutes by default, *Settings → General → Publishing*). The worker checks the
   approval again ([below](#checks-right-before-sending)), converts the file if the network would not take it as it is
   ([files](#files-what-fits-and-what-is-converted)), hands it to the network and gets back what the network needs to publish: an
   Instagram container, a Facebook post held by the Page, a YouTube video already uploaded. Facebook and YouTube hold the post themselves
   until the hour (native scheduling), so those go out even if Postbay is down at that moment.
2. **Publish** at the hour. Instagram has no native scheduling, which is why its container is made only shortly before.
3. **Verify.** The worker asks the network whether the post is really there and public, and records its link. When the answer is
   "processing" or "private", it asks again every minute unless the connector says when to look next (YouTube's
   [public-after-its-hour](networks.md#youtube-until-google-audits-the-project) wait is the longest). When the post is out, the
   *published* notification also says what did not go through with it, such as a first comment the network refused.

Every step is a row in the attempt log with what the network answered. The piece page has a *History* button for each post
(`GET /api/publications/:id/attempts`). The attempt log is append-only and never holds a token.

### Checks right before sending

The worker runs the connector's validator again before preparing, so a rule that changed since scheduling is caught before anything is
sent. It also recomputes the version's fingerprint from the stored files (the file records and each object's size and sha256 in storage)
and confirms the approval still counts for that account. If it does not, the post is put on hold and the approvers are told.

### Files: what fits and what is converted

Every file is read by its own first bytes, not by its name or the type it was declared with. ffprobe and ffmpeg are told which reader to
use and that they may only read that one file (`-f`, `-format_whitelist`, `-protocol_whitelist`): a playlist uploaded as `video/mp4` is
not opened as a playlist, and nothing inside a file can make them fetch an address. Only MP4/MOV, Matroska/WebM, JPEG, PNG, WebP and GIF
are read.

**A file that fits the network's profile goes out untouched.** A video fits when it is really an MP4 (an H.264 MOV is not), its index
(the moov atom) comes before the media (Instagram and Threads read the file as it downloads and refuse one with the index at the end), it
is H.264/AAC in yuv420p, and it is within the network's size, bitrate and frame-rate range (Instagram, Threads and TikTok 23–60 fps;
Facebook Reels 24–60). When only the container, the index or the sound is wrong, the picture is copied and the file rewritten as an MP4
with its index at the front, which is quick and loses nothing; otherwise it is encoded again. A picture fits when it is a plain JPEG: a
PNG named `.jpg`, or an MPO (two pictures in one file, as some phones save), is converted.

Converted copies are cached per file and profile. The profiles are in `apps/api/src/connectors/profiles.ts`; every figure there is the
networks' public guidance, so check it against their current documentation before relying on it.

Files handed to a network by address are served with a signed link that lasts `PUBLIC_MEDIA_TTL_SECONDS` (6 hours by default), from the
media domain, which must be reachable from the internet ([deploying](deploying.md#the-media-domain)).

## Failures and retries

| Kind | Examples | What Postbay does |
| --- | --- | --- |
| `auth` | Token revoked or expired, permission removed | Marks the account *needs reconnecting*, tells the admins once, and keeps the post waiting. It looks again every 10 minutes, and **at once when the account is connected again**. If the hour plus the tolerance passes first, the post fails and the team is told |
| `rate_limit` | Instagram's daily cap, app limits | Waits as long as the network says. If the window would reopen after the post's last acceptable time, it fails now instead of publishing late |
| `file_rejected` | Wrong codec, too long, bad parameter | Fails at once with the network's own reason: retrying the same file would only repeat it |
| `transient` / unknown | 5xx, "media not ready", dropped connection | Retries after 1, 2, 5, 10 and 20 minutes. The fifth failure in a row is final |
| `unsupported` | The network cannot publish this kind of content through its API | Hands the post to a person, and says why |
| `missed_window` | Postbay was down past the hour plus the tolerance | Does not publish late. Fails and tells the team |

**Late means late.** A post that would go out after its hour plus the brand's tolerance (15 minutes by default, *Settings → General →
Publishing*) is not sent: a Reel meant for a launch posted three hours late is worse than a message saying it did not go out.

A failed post can be **tried again** (the same approved version, at a new time if you like), **handed over** to a person (it then appears
under *Due now* on *Publish today*), or cancelled. *Publish today* lists failed and private posts under *Needs attention*.

Whatever a network holds for a post that is cancelled, put on hold, failed, or whose piece is discarded (a Facebook post or video held for
its hour, a YouTube upload, a Facebook video still processing) is taken down there by the worker, also while the post is still being
prepared.

### Not sending twice, not sending late

What a connector records while it publishes (an id, or that a call was about to be made, written down before the call) is kept on the
publication. **Before any repeated send** (a pass that finds a send already begun, a retry after an error, a failed post tried again) the
connector looks for the post without sending anything:

- Instagram and Threads ask the container, whose status says `PUBLISHED` once it has been, and then find the post among the account's
  latest by kind, caption and time;
- X looks among the account's posts since the attempt, by the media it carries;
- LinkedIn among the page's latest posts, by the file it uploaded;
- Pinterest on the board, by the title.

If the post is there, the send is finished from it (its link, its first comment) and never made again, even past the tolerance, because
that is the end of a send that began on time. If the network says it is not there, it is sent within the tolerance and **not at all past
it**: the post fails as missed, saying the network does not have it. Facebook and YouTube hold the post themselves, Bluesky's write is
idempotent and TikTok's upload is the post, so those rely on what was recorded; if nothing was recorded, the usual late rule applies and the
team is told the send was interrupted and to check the network.

### When the worker stops in the middle

A worker holds a publication through a lease of two minutes that it renews every 30 seconds while it works, however long a conversion or
an upload takes, and every write it makes is fenced by that lease: a worker that lost it cannot overwrite what the one that took over did.
A worker that dies lets go within two minutes, including across a restart, and the next one carries on from the saved progress (the
container id, the upload session, the held post). The queue only wakes workers up; what is true about a publication lives in its row
([architecture](architecture.md#the-queue-and-the-worker)).

## Publishing by hand

When a post is published by hand, at its hour the brand's approvers and admins are told (`publication.due`), and *Publish today* shows it
under *Due now* with the files, the text and the first comment ready to copy (`GET /api/publications/:id/pack`). The person posts it on the
network and records it in Postbay, with the link (`POST /api/publications/:id/mark-published`; only `http(s)` links are accepted, because
they are shown as links).

A post handed to a person (by a failure, or because its brand was paused or its date blocked past its hour) is announced as
`publication.handed_over`, with the reason, and shows under *Due now* once the brand is no longer paused.

## Pausing and blocked dates

**Pause** (*Settings → General → Danger zone*) is for a crisis: nothing is published, scheduled or moved until someone resumes the
brand, and what is scheduled keeps its dates. Approvers and admins can pause.

- While the brand is paused, nothing is prepared or published. A post a network already holds (Facebook, YouTube) is taken down from the
  network at once, because it would otherwise go out at its hour by itself.
- On resume, those posts are prepared again and go out at their hour (or within the tolerance, if it has just passed). One whose hour
  plus the tolerance passed during the pause is handed to a person, with the reason.

**Blocked dates** work the same way for one day: nothing is scheduled on it, blocking it wakes that day's prepared posts at once so what a
network holds comes down straight away, and unblocking it lets the posts it held back carry on at once.

## Weekly slots

A brand keeps a weekly plan of **slots** (*Settings → Weekly plan*): an account, a weekday and a time, with a label ("Tuesday's reel").
The calendar shows free slots as requests for content. A slot still empty a few days before its date can
[ask an agent for content](agents.md#empty-slots-asking-for-content).

## Scheduling after approval

Three ways for something approved to reach the calendar without a person picking the time. Each is **off unless asked for**, and each is
recorded: every publication says who put it there, `scheduled_by`: `person` (with `created_by`), `auto` (Postbay itself) or `agent`
(with the producer token, `created_by_token`). The calendar and the piece's publications carry `scheduled_by`, `scheduled_by_name` and
`slot_id` (the slot occurrence it fills, if any); the audit entry `publication.scheduled` says the same, and the screens mark posts
scheduled by Postbay or the agent.

All three go through the same function a person's scheduling uses (`scheduleVersion` in `services/publications.ts`): the brand is not
paused, the day is not blocked, the time has not passed, the version is approved for that account and its stored files are still the
approved ones, the order between posts holds, and the network would take it. An approver can keep a version out of all of it by
unticking *Schedule on approval* (`autoSchedule: false`).

### A piece made for a slot

A piece can be **made for a slot occurrence**: `slot: { id, at }` (the slot, and the instant the calendar gives for that week) on
`POST /api/brands/:id/pieces` or `PATCH /api/pieces/:id` (`null` unlinks it). `at` must be one of the slot's occurrences: its weekday, at
its time, in the brand's zone (`400 invalid_slot` otherwise). A free slot on the calendar offers *Create a piece for this slot*. A piece an
agent makes in a run started by `slot.needs_content` is linked to that slot by itself. `GET /api/pieces/:id` returns `slot` (`id`, `at`,
`label`, `active`, `removed`, `account`).

**When a version of it gets the approvals it needs, the same approval schedules it at the slot**, for the slot's account, as the approver
(`scheduled_by: person`), with the text and first comment the approver gave (`scheduleText`, `scheduleFirstComment`, both optional;
with several approvals, from the latest one that gave them). Unless:

| `code` | Why it is not scheduled |
| --- | --- |
| `unticked` | An approver sent `autoSchedule: false`. Any of the approvals that count saying no is enough |
| `awaiting_approvals` | The brand needs more approvals: the one that completes them schedules it |
| `account_not_approved` | The version was not approved for the slot's account |
| `time_passed`, `brand_paused`, `blocked_date` | The slot's time has passed, the brand is paused, or the day is blocked |
| `slot_taken`, `already_scheduled` | Something else is on that account at that time (or in that occurrence), or this version already is |
| `slot_removed`, `slot_inactive` | The slot was deleted or switched off |
| any scheduling code | What scheduling by hand would have refused (`validation_failed` with the network's issues, `fingerprint_mismatch`…) |

**The approval never fails because of this**: the version is approved all the same, and the answer of `POST /api/versions/:id/approvals`
says what happened in `slot_schedule`: `{ scheduled: true, publication: { id, status, scheduled_at, manual, scheduled_by }, … }`, or
`{ scheduled: false, code, reason }` with the reason in the reader's language.

**Before approving**, `GET /api/versions/:id` says what approving will do, in `slot_schedule` (null for a piece not made for a slot):
`slot` (`id`, `label`), `account` (`id`, `network`, `display_name`), `at`, `day` and `time` in the brand's zone, `timezone`, `ready`
(whether it would be scheduled, if approved for that account without unticking), `summary` (the sentence to show, in the reader's
language), or `code` and `reason` when it would not, and `publication_id` once it is there. `approvals[]` include `auto_schedule`,
`schedule_text` and `schedule_first_comment`.

The approval dialog shows *Schedule on approval*, ticked, with that sentence, the slot's account ticked among the accounts, and an optional
text and first comment. After approving it says what was scheduled (with a link to the calendar) or why not. The piece page shows its slot
(name, day and time, account), or that the slot was removed.

### Filling free slots

A brand setting, **off by default**: *Fill free slots with what is approved* in *Settings → General → Approval rules*
(`PATCH /api/brands/:id { rules: { auto_fill_slots: true } }`, admins). While it is on, the worker (every `FILL_SLOTS_SECONDS`, 300 by
default) puts **approved versions that were never scheduled** into the brand's **free weekly slots**, as Postbay (`scheduled_by: auto`), and
tells **whoever approved each one** (`publication.auto_scheduled`, with the account, day, time and slot).

Which versions:

- approved **since the setting was switched on** (`rules.auto_fill_since`, set by Postbay): switching it on never sends out everything
  approved months ago;
- **never scheduled at all**: a version whose post a person cancelled is not put back, and one already scheduled is left alone;
- whose variant has nothing else **waiting** (scheduled, or on hold for a newer version: a person reschedules those);
- that **no approver unticked**;
- oldest approval first.

Which slot (`domain/slotfit.ts` and `services/scheduling.ts`): the **earliest free occurrence in the next 14 days** that

- is on an **account the version was approved for**;
- whose **network takes the piece as it is**: never a story (a feed slot is not a story's place); the variant's format must suit the
  network (Instagram 9:16, 4:5, 1:1 and carousels; Facebook, Threads, X and Bluesky any picture format and carousels; LinkedIn also PDF
  documents; YouTube only videos, 16:9, 9:16 or 1:1); **never TikTok or Pinterest**, whose posts need a setting a person chooses each
  time (who can see it, the board);
- for a **piece made for a slot, is that slot** (next week's occurrence when its own has passed or is taken);
- is **free**: nothing on that account at that time, nothing already filling that occurrence, not on a blocked day, and starting after
  the brand's preparation lead from now.

**One per slot occurrence, ever**: a unique index on the occurrence, and a lock per brand while free slots are filled, so two sweeps at
once cannot fill one slot twice. **Never while the brand is paused, never on a blocked day.** If the network would refuse the post in the
earliest slot, the next one is tried (three at most), and the rest waits for the next sweep. The post goes out with the text and first
comment the approver gave when approving, or none. While the setting is on, the approval dialog of a piece not made for a slot offers
*Schedule in the next free slot*.

### The agent scheduling what is approved

A brand can also let its agent schedule approved versions, from inside an agent run: see [agents](agents.md#the-agent-scheduling-what-is-approved).

## Known limitations

- **Dependencies between posts are API-only**: the schedule dialog does not offer them.
- **A lost answer is found again only as well as each network lets Postbay look.** Instagram and Threads do not say which post a published
  container became, so it is matched among the account's latest posts by kind, caption and time: a caption edited on the network in
  between, or more than 25 posts since, makes it unfindable, and then nothing is sent again and the post fails, after a few looks, with a
  note to check the network. X, LinkedIn and Pinterest are searched within a minute of the attempt.
- **A post Postbay schedules by itself** has the text the approver gave when approving, or none: no caption is written for it.
- **Filling free slots** looks two weeks ahead and tries at most three slots per version per sweep.
- **Dragging on the calendar needs a mouse.** The list view and the *Move* dialog on the piece page do the same without one.
- **Converted videos are checked with ffprobe, not played back**, and YouTube's resumable upload has not yet been tried with very large
  files.
