---
name: postbay-review
description: Review a version in Postbay and leave comments on it as the person, at the exact moment of a video or the exact page and area of an image, carousel or PDF. Use when the person wants to comment on, give feedback on, or review a piece or version, or to see the comments already on it.
---

# Reviewing a version

1. **Find it.** `list_pieces` (filter by state or search the title) or `pending_for_me`, then `get_piece` for its variants and
   versions. Review the latest version of the variant unless the person says otherwise.
2. **Look at it.** `get_version` gives each file with a `download_url` (valid for an hour). To look at a video, download it and
   extract frames with ffmpeg (`ffmpeg -ss <seconds> -i file.mp4 -frames:v 1 frame.jpg`); images and PDFs can be read directly.
   `list_comments` shows what others already said, so you do not repeat it.
3. **Comment.** One comment per thing to change, written for the person who will fix it, saying what and why. `add_comment`:
   - a moment of a video: `at_seconds` (and `until_seconds` for a span);
   - a page or carousel item: `page` (from 1), and for a spot `x`, `y`, `width`, `height` as fractions 0–1 from the top-left;
   - nothing of that for a general comment;
   - `people_only: true` when the AI agent must leave it to a person.
4. **Before posting**, show the person the comments you are about to leave and wait for their go-ahead: comments notify the team.
   Then post them and share the version's `url`.

Reviewing is not approving: to approve or request changes, see the postbay-approve skill.
