---
name: postbay-upload
description: Upload files to Postbay, either as a new piece or as a new version of an existing one. Use when the person wants to upload, send or add a video, image, carousel, PDF or subtitles to Postbay, or create a new piece for the team to review.
---

# Uploading to Postbay

1. **New piece or new version?** For a new version, find the piece (`list_pieces`, `get_piece`) and the variant (the format:
   9:16, 4:5, 1:1, 16:9, carousel or document). For a new piece, `create_piece` with a title, its kind (video, carousel, post, story,
   pdf), the campaign if any, a short brief, and `formats` for its first variants. Say `ai_generated: true` when the content was
   made with AI: it goes out labelled as such.
2. **A style for the variant?** Only one of the brand's styles (`list_brands` → `variant_styles`). A new style is added to the brand
   first, with the person's say-so and only by an admin (`add_variant_style`).
3. **Each file's facts**, computed locally: exact size (`stat -c %s file`) and sha256 (`sha256sum file`), and its type (video/mp4,
   image/jpeg, image/png, application/pdf, text/vtt…). Accepted: video, images, PDF, subtitles and cover images; up to 4 GB each,
   30 files.
4. **Upload.** `start_upload` with the files; PUT each file to its URL with exactly the headers given, for example
   `curl --fail -X PUT --data-binary @file -H "content-type: video/mp4" "<url>"`. Then `finish_upload` with each `upload_id`, its
   `kind` (video, image, pdf, subtitles or cover), `position` for a carousel's order (from 0), and `notes` saying what this version is.
5. **Report** the version number and its `url`. It is now in review; it does not go anywhere until someone approves it.

Carousels: one version holds all the items, in order. A cover is optional and goes with the video it belongs to.
