# Review and approval

Producers upload versions of a piece, the team comments on the exact spot, and approvers approve one version for specific accounts. An
approval is tied to the fingerprint of that version's files: change a byte and it stops counting.

## Pieces, variants and versions

A **piece** is one thing to publish: a video, a carousel, a post, a story or a PDF. It has a title, a brief, optionally a campaign (a
name, an objective and dates) and a target date, and an AI label (*made with AI*). It can also say where its project lives, for pieces
[made with code](agents.md#pieces-made-with-code), and which [weekly slot](publishing.md#a-piece-made-for-a-slot) it is made for.

A piece goes out in several shapes, its **variants**: each has a format (`9:16`, `4:5`, `1:1`, `16:9`, `carousel` or `document`) and
optionally a style.

Each variant has numbered, **immutable versions**. A version is one or more files (video, images, a PDF, subtitles, a cover), notes, and
the comments it says it resolves. Nothing about a version changes after it is created: the database refuses it.

Producers, approvers and admins create pieces and upload versions. A producer can be a person or an API token: both are the same kind of
client. A token uploads a version only inside an [agent run](agents.md#safeguards) on that piece; the version then names the token and
the admin who made it, and so does the record of its approval.

### Variant styles

A brand keeps the list of styles its variants can have, in *Settings → General → Variant styles*, one per line: in order, each at most 40
characters, at most 30 of them, no two alike whatever their case (`rules.variant_styles`). The add-variant dialog picks the style from
that list (*No style* first); a variant whose style is not in the list keeps it, and the dialog shows it marked *not in the list*. A
brand without styles says so there, with a link to set them for those who manage the brand.

The agent is given the list too: `GET /api/brands/:id/requirements` carries `variant_styles`, the runner passes them to the agent as
`{{styles}}`, and a variant the agent makes gets the style as the brand spells it, or none if the agent invented one.

### Uploading a version

Files never pass through the app: the browser (or the agent) declares each file with its size and sha256, gets a signed address, and
uploads straight to storage; closing the version re-reads what was stored and refuses anything that does not match. Files of 64 MB and
more are sent in pieces through the app instead, and an interrupted upload carries on where it stopped when the same file is chosen
again. Each file can be up to 4 GB. The details are in [architecture](architecture.md#how-files-flow).

## The viewer

**Video**: play frame by frame or a second at a time, change the speed, go full screen, and comment on a moment or a span. Comments
show as marks on the timeline. Every comment on a video keeps the frame it points at: ffmpeg grabs it when the comment is posted (if
ffmpeg fails, the comment is saved without it). Keyboard shortcuts are listed in the viewer.

**Images, carousels and PDFs**: one page behind another, and a comment on a point or an area of a page.

**What each network covers**: the viewer can draw over the picture what each connected network's own interface covers (buttons,
captions, the profile line), so text is not put where a network hides it. These safe zones are approximate.

### Subtitles

A video can carry subtitle files (`.vtt` or `.srt`), uploaded with it. The viewer shows them **beside the video**: every line with its
time, the line on screen highlighted as the video plays, and a click on a line jumps there. **A comment can be written on a line.** Such
a comment stores the file's own times and words, read by the server from the stored file, not what the browser sent, so a line cannot be
forged. The agent receives the line's words and time with the comment.

The parser is forgiving, because files come from many tools: optional hours, a comma or a dot, short milliseconds, markup and entities
taken out, notes and styles skipped, and bad blocks counted and reported rather than hiding the rest. A file over 2 MB, or over 20,000
lines, is not read as subtitles.

## Comments

Reviewers, approvers and admins start threads; producers (and the agent) reply and resolve. A comment points at a moment or span of a
video, a subtitle line, a point or area of a page, or the version in general. Comments can be filtered (from the agent, by person, with a
drawing) and searched, resolved, and reopened.

**Comments across versions.** Comments on an older version stay visible. Open ones carry over and block the approval of later versions
until someone resolves them; the ones a version fixes show as *resolved in vN*. A producer or the agent can still reply to a thread on a
superseded version, because that is exactly when the agent answers.

**Comments for people only.** A reviewer can tick *Only people* on a comment (or toggle it later): the agent cannot reply to it, resolve
it or claim to have fixed it, and it still counts as open, so the version cannot be approved until a person deals with it
([safeguards](agents.md#safeguards)).

### Drawings

While writing a comment, a reviewer can **draw** on the frame or the page: a pen stroke, a rectangle or an arrow, in yellow, red, green,
blue or white. The drawing goes with the comment, in fractions of the frame so it fits any screen size, at most 30 shapes and 2,000
points (a sketch, not a picture). It is shown over the frame when the comment is opened, and the agent is told what was drawn and where.

## Comparing versions

Two versions can be compared **side by side**, by **flipping** between them, or with a **wipe** dragged across the picture. Videos play
in sync (*Play both*). Earlier comments show as *resolved in vN* or still open.

## Approval

Approvers and admins approve a version **for specific accounts**. Nothing is approved:

- by whoever uploaded it, whatever their role;
- while a comment on the variant is open (the approver resolves them first);
- without every item of the brand's checklist ticked;
- without at least one account, or for an account that needs connecting again;
- when its stored files no longer match its fingerprint.

A brand sets in *Settings → General → Approval rules* how many approvals a version needs (1 by default) and its checklist. With more than
one approval, the approved accounts are the ones every approver agreed on: if two approvers pick accounts with nothing in common, the
second approval is refused until they align.

A version made with a producer token has no person behind it, so any approver can approve it, including the admin who made the token. The
version and the approval record name both the token and its maker.

### The fingerprint

The fingerprint is the sha256 of one line per file, `position<TAB>kind<TAB>sha256`, sorted by position and kind: a different cover, a
reordered carousel or one changed byte gives a different fingerprint. An approval records the fingerprint it was given for, and it is
recomputed from the file records, with each stored object's size and sha256 read back from storage, on every approve, schedule and
publish.

### What is approved with the files

The approval records the piece's title and AI label as the approver saw them, and a publication takes both from it: renaming the piece
afterwards changes nothing already approved (an approver can still set the title of one publication). A producer can mark a piece as
made with AI at any time, and the label then goes out even on what is already scheduled; once a version is approved, only an approver
can take the label away.

### Requesting changes and rejecting

A reviewer or approver can request changes when there is something to change: at least one open comment, or a note, which becomes a
general comment. An approver can reject a version, with a mandatory reason; a rejection also
sends the version back as changes requested, so whoever produces (a person or the agent) starts the next one.

### A new version

A new version voids the previous approval and puts what was scheduled on hold. An approver brings it back onto the new version once it
is approved ([changing what is scheduled](publishing.md#changing-what-is-scheduled)).

## Discarding a piece

Discarding a piece cancels what it has scheduled, so once anything of it is approved or scheduled, only an approver can discard it.
Before that, a producer can discard their own drafts.

## Known limitations

- **Safe zones are approximate**: the areas drawn over the picture are an estimate of what each network covers, not a published
  specification. Use them as a guide.
- **Subtitles** are read only from files uploaded with the video. Burned-in captions, and times beyond the video's end, are not read.
