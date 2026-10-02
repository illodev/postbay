# New content for an empty slot

**{{brand}}** has an empty calendar slot and nobody has produced anything for it yet: {{slot}}.

## What is running that day

{{campaigns}}

## What to make

Make one piece for this slot that fits the campaign above (or, if none is running, something the brand would plausibly publish).
Pick the kind and format that suit the slot's network. Keep it honest: do not invent facts, prices or claims.

## Where things are

Your working directory is this run's directory.

- `input/slot.json` has the slot, the account and the campaigns as data; `input/requirements.json` what each network accepts.
- `{{sources_dir}}` is yours, kept between runs.
- Write the files in `{{output_dir}}`.

## What the networks accept

{{requirements}}

## What approvers tick before they approve

{{checklist}}

## Limits

You have about {{max_minutes}} minutes and about {{max_cost}} {{currency}} for this run.

{{failures}}

In addition to what follows, `result.json` must say what the piece is:

```json
{ "piece": { "title": "…", "kind": "video", "format": "9:16", "brief": "What it is and why, in two sentences." } }
```

`kind` is one of video, carousel, post, story, pdf; `format` one of 9:16, 4:5, 1:1, 16:9, carousel, document.

{{result_format}}
