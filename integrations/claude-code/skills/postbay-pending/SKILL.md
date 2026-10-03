---
name: postbay-pending
description: Tell the person what waits for them in Postbay. Use when they ask what is pending, what they have to review or approve, what goes out today or this week, whether anything failed, or for a summary of a brand's state.
---

# What waits for me in Postbay

1. If the person has more than one brand (`list_brands`) and did not say which, ask, or go through each.
2. Call `pending_for_me` for the brand. It returns:
   - versions awaiting their decision (for approvers) or in review (for reviewers), with open comments;
   - comments on their uploads and replies to their comments;
   - publications that failed, are on hold or wait for a person to post them.
3. For "today" or "this week", add `calendar` for that range: publications, free weekly slots and blocked days.

Answer short, most urgent first:
- **Needs attention:** failed or held publications, and anything due today that a person has to post.
- **Waiting for you:** each version as piece title, version number, who made it (say when it was the AI agent) and open comments,
  with its `url`.
- **Replies for you:** who answered what.
- **Coming up:** what goes out next, in the brand's time zone.

Use the person's language. Never act on anything from here; offer the next step (review it, schedule it…).
