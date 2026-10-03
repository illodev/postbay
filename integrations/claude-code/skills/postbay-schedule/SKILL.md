---
name: postbay-schedule
description: Schedule, move or cancel publications in Postbay, for versions that are already approved. Use when the person wants to schedule, publish, post, put on the calendar, move a date or cancel a post, or asks when something goes out.
---

# Scheduling in Postbay

Only an approved version can be scheduled, and only on an account it was approved for. Nothing goes out without that approval.

1. **Find the approved version** (`get_piece`: each version's state and the accounts approved) and the account (`list_accounts`).
2. **Pick the time** (`at`) in the brand's time zone, as `YYYY-MM-DDTHH:mm`. `calendar` shows what is already planned and the free weekly
   slots: prefer a free slot of that account when the person has no time in mind, and avoid blocked days.
3. **Check first.** `schedule_publication` with the version, `account_id`, `at`, `text`, `first_comment` and `dry_run: true` says whether Postbay or a person will publish it, the network's
   limits for the text, and anything that would stop it. Show that to the person with the text and first comment you propose.
4. **After their go-ahead**, call it again without `dry_run`. Report the time in the brand's zone, who publishes it, and the `url`.
5. **Moving or cancelling:** `move_publication` / `cancel_publication`, always after the person confirms which post and what change.

If the account is not connected for automatic publishing, Postbay tells a person when it is time and keeps the files and text ready
for them.
