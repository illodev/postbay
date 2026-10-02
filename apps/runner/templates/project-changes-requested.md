# Revise "{{piece_title}}" in its project

You are revising a piece of content for **{{brand}}**. Reviewers asked for changes to version {{version_number}}. This piece is
**made from a project**: a folder of code and material (scenes, copy, assets, voices, a mix, a render script) that a tool renders into
the video. You change the project, render it again, and leave the new file for the runner to upload. Make the changes the reviewers
asked for and nothing else.

## The piece

- Kind: {{piece_kind}}, format {{format}} {{style}}
- Version being revised: v{{version_number}} (round {{round}} of {{max_rounds}})
- Project: `{{source}}`, in `{{project_dir}}`

Brief:

{{piece_brief}}

## What the reviewers asked

{{note}}

### Comments for you

Each comment says where it points. Where there is a frame, look at it: it is what the reviewer was looking at when they wrote the
comment, so it shows what they meant better than their words do. A time is seconds into the video: find the part of the project that
draws that moment. Comments marked "still open" were raised on an earlier version and were not fixed.

{{comments}}

### For people only: leave these alone

These comments are not for you. Do not act on them, do not answer them, and do not undo anything a person asked for in them.

{{people_only}}

## How to work

1. **Read the project's own instructions before anything else**: its `CLAUDE.md`, `README.md`, brief and review notes, in
   `{{project_dir}}` and in the folders above it up to the repository's root. They say how the piece is built, how it is rendered, and what
   must not change. Where they disagree with what you would do by habit, they win. Tools installed next to you (a rendering engine, for
   instance) are named in your environment: the project's instructions say which variable.
2. **Make each change in the project's sources**, the way the person who built it would: the scene code, the copy, an asset, the timing,
   the mix. Never patch the rendered video (no drawing over frames, no cutting or re-timing the final file): the next round starts from the
   sources, and a patch would be lost.
3. Keep each change to what its comment asks. Do not restyle, rename, reorganise or "improve" anything else.
4. **Render again with the project's own render command**, as its instructions give it (with its audio, if it has a mix). Before the full
   render, check the moments the comments point at (render stills at those times if the tool can) and look at them.
5. **Leave the finished file in `{{output_dir}}`**: render straight into it if the command takes an output path, or copy the render there
   with `ffmpeg -i <the render> -c copy {{output_dir}}/<name>.mp4`. Only finished files go there: no frames, no drafts.
6. **Do not commit, branch, push or reset.** When the project is in git, it is on the piece's own branch, and the runner commits
   everything you changed in it when you finish and names that commit in the new version. Anything you leave in the project is kept for
   the next round, so do not leave scratch files in it: put them in `{{sources_dir}}`.

If the render fails, or you run out of time, do not leave a half-made file in `{{output_dir}}`: say what happened in the notes and answer
the comments you could not finish with `needs_human`. Something only a person can provide (a missing asset, a legal call, a choice the
brief does not settle) is `needs_human` too, saying exactly what is needed.

## Where things are

Your working directory is this run's directory.

- `{{project_dir}}`: the project. Your changes go here.
- `input/frames/` has the frames the comments point at, `input/comments.json` the same comments as data, and `input/brief.md` the brief.
- `input/previous/` has the files of the version being revised, for reference only:

{{previous_files}}

- `{{sources_dir}}` is yours for scratch work, kept between rounds of this piece.
- Write the new files in `{{output_dir}}`.

## What the networks accept

{{requirements}}

Automatic checks run on what you leave in `{{output_dir}}`: duration, aspect ratio, resolution, loudness, size per network, and a guess about
text under the areas each network covers. If a check fails you will get one more attempt, with what failed: fix it in the project and
render again.

## What approvers tick before they approve

{{checklist}}

## Limits

You have about {{max_minutes}} minutes and about {{max_cost}} {{currency}} for this run, rendering included: a full render can take a while,
so check single frames first. Do not invent facts, prices, dates or claims that are not in the brief, the project or the comments: if
something is missing, say so in the reply to that comment (`needs_human`).

{{failures}}

{{result_format}}
