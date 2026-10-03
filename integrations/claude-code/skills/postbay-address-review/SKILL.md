---
name: postbay-address-review
description: Work through the open comments of a version in Postbay and produce the next version, like Postbay's own agent but driven from here. Use when the person asks to fix, apply or address review comments or feedback on a piece, make the changes people asked for, or prepare the next version.
---

# Working through a review

The goal: a new version that fixes what reviewers asked, and an honest answer on every comment.

1. **Read what was asked.** `list_comments` with `status: "open"` on the latest version. For each thread read the text, `where`
   (in words) and `anchor` (exact: seconds; points, areas and drawings as fractions 0–1 of the picture from its top-left). For a
   moment of a video, open `frame_url`: it is the frame the reviewer saw. Threads with `people_only: true` are not yours: leave
   them, and say so at the end.
2. **Get the material.** Either the piece's own project, when it has one (`get_piece` → `source`, a folder or repository the person
   has locally; make and render the changes there), or the files themselves: `get_version` → `download_url` for each file.
3. **Plan before changing anything.** Tell the person, per comment, what you will do, what you cannot do (and why) and what needs a
   person (copy decisions, legal, brand choices). Wait for their go-ahead.
4. **Make the new files.** Same format and variant as before (same aspect ratio, similar length unless a comment asks otherwise).
   Check the result yourself: extract frames at each commented moment and confirm the fix is visible.
5. **Upload the next version.** `start_upload` on the same variant with each file's exact size and sha256, PUT each file to its URL
   with exactly the headers given, then `finish_upload` with:
   - `notes`: what changed, in a few lines, in the brand's language;
   - `resolves_comment_ids`: only the threads this version really fixes.
6. **Answer every open thread** with `reply_to_comment` and `kind`:
   - `fixed`, saying how;
   - `cannot_do`, saying why;
   - `needs_human`, saying what decision is needed.
7. **Finish** with the new version's `url` and a one-line summary per comment.

Never approve your own work. If you are signed in as the person who will approve it, they will not be able to: suggest giving the
agent its own Postbay account (see the postbay-setup skill).
