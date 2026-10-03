---
name: postbay-upload
description: Upload files to Postbay, as new pieces or as new versions of existing ones, one file or a whole folder. Use when the person wants to upload, send or add videos, images, carousels, PDFs or subtitles to Postbay, load a batch or a campaign, or create new pieces for the team to review.
---

# Uploading to Postbay

Two scripts in this skill's `scripts/` folder do the local work:
- `describe.py <files or folders>` prints each file's name, type, exact size and sha256, which is what Postbay asks for.
- `put.py <uploads.json> <files.json>` sends every file to the signed URLs Postbay answered with.

## 1. Where it goes

- **New version of an existing piece:** find the piece (`list_pieces`, `get_piece`) and the variant, meaning the format: 9:16,
  4:5, 1:1, 16:9, carousel or document.
- **New pieces:** `create_piece` with a title, its kind (video, carousel, post, story, pdf), a short brief, and `formats` for its
  first variants. Say `ai_generated: true` when the content was made with AI: it goes out labelled as such.
- **Campaign:** see the brand's campaigns with `list_campaigns`. If the one the person means does not exist, ask, then
  `create_campaign`. A piece can be moved later with `update_piece` (`campaign`, or `"none"`).
- **Two variants of the same format** (the same piece in two looks): each needs a style from the brand's list
  (`list_brands` → `variant_styles`). Add a variant with `add_variant` and `style`. A missing style is added first with
  `add_variant_style`, only by an admin and only with the person's say-so.

## 2. Upload

1. Run `python3 scripts/describe.py <files or folders> > /tmp/files.json`. Rename files whose names repeat.
2. For each variant, call `start_uploads` once with every file going into it, up to 50 variants per call. Each item answers on its
   own; fix and repeat the ones with an error. For a single variant, `start_upload` is the same thing.
3. Save the tool's answer exactly as it came to `/tmp/uploads.json` and run `python3 scripts/put.py /tmp/uploads.json /tmp/files.json`.
   It sends each file with exactly the headers given, and exits non-zero if anything failed. URLs last an hour.
4. Call `finish_uploads` once with every variant: each `upload_id`, its `kind` (video, image, pdf, subtitles or cover), its
   `position` for a carousel's order (from 0), and `notes` saying what the version is. A cover goes with the video it belongs to.

## 3. Report

List each piece and version with its `url`, plus any item that failed and why. The new versions are in review; nothing goes out
until someone approves it. Whoever uploads a version cannot approve it: if the person will approve these themselves, tell them now
(see the postbay-setup skill on giving an agent its own account).
