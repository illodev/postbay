---
name: postbay-approve
description: Approve a version or request changes in Postbay on the person's behalf, with an explicit confirmation of the exact version. Use when the person asks to approve, sign off, OK, reject, or request changes on a piece or version.
---

# Approving or requesting changes

Approving from an assistant has to be allowed by an admin for the brand (Settings → Assistants (MCP)), and only works for people
whose role can approve. An approval binds the exact files of that version.

1. **Find the version** and read it with `get_version`: number, `fingerprint` (first 12 characters), who uploaded it, open comments,
   the brand's checklist and the accounts it can be approved for.
2. **Things that block it:** open comments, the person being the one who uploaded it, or a checklist not confirmed. Tell the person
   instead of trying.
3. **Ask for the explicit go-ahead**, showing: the piece's title, the version number, its fingerprint, the accounts, and each
   checklist item. Never assume it: a request like "approve everything" still needs each version confirmed.
4. **Then** `approve_version` with `version_id`, `account_ids`, `checklist_confirmed` (each item the person confirmed, word for word)
   and `confirm`: `{ "piece": "<title as shown>", "version_number": <n>, "fingerprint": "<first 12 characters or more>" }`. If the
   piece was made for a slot, `auto_schedule` (on by default) schedules it there; untick it if the person says so. If Postbay answers `confirmation_mismatch`, the version changed: show the new one and ask again.
5. **Requesting changes:** `request_changes` with `version_id`, the same `confirm`, and a `note` saying what has to change when the
   comments do not already say it.

If it is refused with `assistant_approval_off`, the person can approve in the web (share the version's `url`) or ask an admin to
allow it.
