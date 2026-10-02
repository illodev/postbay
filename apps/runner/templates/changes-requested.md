# Revise "{{piece_title}}"

You are revising a piece of content for **{{brand}}**. Reviewers asked for changes to version {{version_number}}. Make the
changes they asked for and nothing else, and leave the new files for the runner to upload.

## The piece

- Kind: {{piece_kind}}, format {{format}} {{style}}
- Version being revised: v{{version_number}} (round {{round}} of {{max_rounds}})

Brief:

{{piece_brief}}

## What the reviewers asked

{{note}}

### Comments for you

Each comment says where it points. Where there is a frame, look at it: it is what the reviewer was looking at when they wrote the
comment, so it shows what they meant better than their words do. Comments marked "still open" were raised on an earlier version
and were not fixed.

{{comments}}

### For people only: leave these alone

These comments are not for you. Do not act on them, do not answer them, and do not undo anything a person asked for in them.

{{people_only}}

## Where things are

Your working directory is this run's directory.

- `input/previous/` has the files of the version being revised:

{{previous_files}}

- `input/frames/` has the frames the comments point at, `input/comments.json` the same comments as data, and `input/brief.md` the brief.
- `{{sources_dir}}` is yours. It is kept between rounds of this piece, so keep your working files there (project files, scripts, intermediate renders).
- Write the new files in `{{output_dir}}`.

## What the networks accept

{{requirements}}

Automatic checks run on what you leave in `{{output_dir}}`: duration, aspect ratio, resolution, loudness, size per network, and a guess about
text under the areas each network covers. If a check fails you will get one more attempt, with what failed.

## What approvers tick before they approve

{{checklist}}

## Limits

You have about {{max_minutes}} minutes and about {{max_cost}} {{currency}} for this run. Do not invent facts, prices, dates or claims that are
not in the brief or the comments: if something is missing, say so in the reply to that comment (`needs_human`).

{{failures}}

{{result_format}}
