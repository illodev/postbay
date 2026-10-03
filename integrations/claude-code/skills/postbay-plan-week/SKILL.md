---
name: postbay-plan-week
description: Plan the coming days in Postbay: find free slots, approved content that is not scheduled yet, and gaps, and propose a schedule. Use when the person asks to plan the week, fill the calendar or the free slots, or what to publish next.
---

# Planning the week

1. **The picture.** `calendar` for the coming 7 days (or the range the person says): what is scheduled, the free weekly slots per
   account, and blocked days.
2. **What is ready.** `list_pieces` with `state: "approved"`, and `get_piece` on each, to find approved versions with nothing
   scheduled, and the accounts each was approved for.
3. **What is close.** `pending_for_me`: versions still in review that could be ready in time.
4. **Propose**, as a short table: day and time (brand's zone), account, piece and version, and why it fits that slot (format, network,
   campaign). Point out slots nothing approved can fill, so someone can make content for them, and content that fits no slot.
5. **Schedule only what the person agrees to**, one by one, following the postbay-schedule skill (dry run first).
