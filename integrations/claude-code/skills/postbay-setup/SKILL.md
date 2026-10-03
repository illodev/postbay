---
name: postbay-setup
description: Connect Claude Code to a Postbay installation, or fix a broken connection. Use when the person wants to start using Postbay from Claude, when Postbay's tools are missing or answer "unauthorized", or when they ask how to give an AI agent its own access to Postbay.
---

# Connecting to Postbay

Postbay is reached through its MCP server, `postbay`, at `$POSTBAY_URL/api/mcp`. Nobody copies keys: the person signs in to
Postbay in their browser and chooses which brands Claude may use.

1. **The address.** The plugin uses the `POSTBAY_URL` environment variable (for example `https://postbay.example.com`); without it,
   `http://localhost:5173`. If the person's Postbay lives elsewhere, ask them to set it before starting Claude Code
   (`export POSTBAY_URL=https://…`) and restart.
2. **Signing in.** Ask them to type `/mcp`, choose **postbay** and **Authenticate**. A browser opens on Postbay: they sign in and
   allow it. If `/mcp` does not list it, restart Claude Code.
3. **Check.** Call `list_brands`. It answers with the brands this connection may use and the person's role in each.

## An agent that makes versions needs its own account

What Claude uploads through Postbay is uploaded by the account it signed in as, and nobody approves their own upload. If Claude
will make new versions (see the postbay-address-review skill) and the person is also the one who approves, suggest an account for
the agent: an admin adds a member with the **producer** role (for example "Claude (agent)", with an email address someone reads),
and the agent's Claude Code signs in to Postbay as that member. Its versions then go through review like anyone's.

## When something fails

- `unauthorized`: the sign-in expired or was disconnected in Postbay. Run `/mcp` → postbay → Authenticate again.
- `member_deactivated`: an admin deactivated this person in that brand. Only an admin can bring them back.
- `brand_required` or `unknown_brand`: say the brand by name; `list_brands` lists the ones allowed.
- Approving is refused with `assistant_approval_off`: an admin has to allow it in Settings → Assistants (MCP).
