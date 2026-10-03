# Using Postbay from Claude (MCP)

Someone on the team can ask an AI assistant "what is pending for me to review?", "upload this version" or "schedule the approved reel
for Tuesday at 19:00", and the assistant does it in Postbay **as that person, with their role in each brand**, exactly as the web would
let them. Postbay is a remote [MCP](https://modelcontextprotocol.io) server (Streamable HTTP) at **`$APP_URL/api/mcp`**; the address is
also in *Settings → Assistants (MCP)* and in *Your account*, with a copy button.

**Nobody handles a key.** The assistant registers itself, sends the person to Postbay to sign in with their own account (the same sign-in
as the web: emailed link, single sign-on, the development sign-in, and the second factor where it applies), and the person says which
assistant it is and which of their brands it may use. Producer tokens are not used here: they are for the [agent runner](agents.md#the-agent-runner).

## Adding it

**Claude Code, with the plugin** (recommended): the connection plus a skill for each workflow (what is pending, reviewing, working
through comments, uploading, scheduling, planning the week, approving). See [integrations/claude-code](../integrations/claude-code/README.md):

```sh
claude plugin marketplace add illodev/postbay
claude plugin install postbay@postbay
export POSTBAY_URL=https://your-postbay.example     # then /mcp → postbay → Authenticate
```


- **claude.ai or Claude Desktop**: *Settings → Connectors → Add custom connector*, give it a name ("Postbay") and the address
  `https://your-postbay.example/api/mcp`. Leave the OAuth client id and secret empty: Claude registers itself. Click *Connect*, sign in
  to Postbay and allow it. These connect from Anthropic's servers, so the address has to be public and served over https.
- **Claude Code**: `claude mcp add --transport http postbay https://your-postbay.example/api/mcp`, then `/mcp` in a session and
  *Authenticate*: a browser opens on the same consent page. Claude Code connects from your own machine, so a local Postbay works too.

The consent page shows the assistant's name and, above all, **the host it will send the answer to** (the one thing a client cannot make
up; `claude.ai` for claude.ai and Claude Desktop, `localhost:…` for Claude Code, with a warning that any program on the computer could use
such an address). The person picks the brands; with one brand there is nothing to pick.

## The tools

Each takes the brand by name or id where it matters, and leaves it out when the person allowed only one. Every result carries `url`
links to the same thing in the web app, times in the brand's zone (`at_local`) and in UTC.

| Tool | What it does |
| --- | --- |
| `list_brands` | The brands this connection can use: the person's role, the zone, whether it is paused, the approval rules (how many approvals, the checklist), whether approving from an assistant is on, and the brand's variant styles |
| `list_pieces` | Pieces, newest first, filtered by state, campaign, made by the agent or not, and words in the title; each with its latest version and what is scheduled |
| `get_piece` | A piece with its variants, every version (number, state, fingerprint, open comments) and its publications |
| `get_version` | One version: files (each with a `download_url`, valid for an hour, and its sha256), fingerprint, who uploaded it, the decisions on it, the checklist, the accounts and what approving it would schedule ([scheduling after approval](publishing.md#scheduling-after-approval)) |
| `pending_for_me` | Versions waiting for the person's decision, open comments on their uploads and replies to their comments, and publications that failed, are on hold or wait for a confirmation |
| `list_comments` | The threads of a version (and those still open from earlier versions), each saying where it points in words: "from 0:03.5 to 0:05", "page 2, an area in the top-right…", a subtitle line; and exactly, in `anchor` (seconds; points, areas and drawings as fractions of the picture), with `frame_url`, the frame a video comment points at |
| `calendar` | Publications, free weekly slots and blocked days between two dates (the next 14 days by default) |
| `list_accounts`, `list_notifications` | The brand's social accounts; the person's latest notifications |
| `add_comment`, `reply_to_comment`, `resolve_comment` | Comment at a moment or span of a video, on a page or area of an image, carousel or PDF, or in general; reply, saying with `kind` what became of it (`fixed`, `cannot_do`, `needs_human`); resolve |
| `create_piece`, `add_variant` | A new piece (optionally with its first formats), or another format of one; a variant's style must be one of the brand's |
| `list_campaigns`, `create_campaign`, `update_piece` | The brand's campaigns; a new one (no two with the same name); change a piece's title, brief, campaign, target date or AI label |
| `add_variant_style`, `remove_variant_style` | Add a style to the brand's list (at a position) or take one off it; admins only, as in Settings → General. Variants that have a removed style keep it |
| `start_upload`, `finish_upload` | A new version in two steps, see below. `start_uploads` and `finish_uploads` do the same for up to 50 variants per call, each item answering on its own |
| `schedule_publication` | Schedule an **approved** version on an account it was approved for, at `YYYY-MM-DDTHH:mm` in the brand's time; `dry_run` says first how it would go out and what would stop it |
| `move_publication`, `cancel_publication` | Move or edit, or cancel, a scheduled publication |
| `approve_version`, `request_changes` | Decide on a version, only where the brand allows it (below) |

**Uploading.** Postbay cannot read the person's disk and does not fetch files from addresses it is given (that would let anyone make the
server request any address). It works as the web does: `start_upload` takes each file's name, type, exact size and sha256 and answers with
a signed URL per file; the assistant sends the bytes there with `PUT` (storage refuses any byte that differs from what was declared) and
calls `finish_upload`, which re-reads what was stored and closes the version. The limits are the web's: video, images, PDF, subtitles and
covers, up to 4 GB each. This needs an assistant that can read local files and make HTTP requests, such as Claude Code; claude.ai cannot
upload files this way.

## Your own agent on a review

Postbay's own [agent runner](agents.md) turns a request for changes into a new version by itself. An agent of your own (Claude
Code, for example) can do the same work through the MCP, on your terms:

1. **Read what was asked.** `list_comments` with `status: "open"`: each thread's text, where it points in words and exactly
   (`anchor`), and, for a moment of a video, `frame_url`: the frame the reviewer was looking at, as an image. Threads marked
   *people only* are left to people.
2. **Get the material.** `get_version` gives each file's `download_url` (an hour) and sha256, to edit the files themselves; or the
   agent works on the piece's own project, if it has one ([pieces made with code](agents.md)).
3. **Upload the next version.** `start_upload` and `finish_upload` on the same variant, with `notes` saying what changed and
   `resolves_comment_ids` listing only the threads the new version really fixes.
4. **Answer every thread.** `reply_to_comment` with `kind`: `fixed`, `cannot_do` (and why) or `needs_human`. The review screen shows it.

**Give the agent an account of its own.** Whatever an assistant uploads is uploaded by the person it signed in as, and nobody approves
their own upload. So an agent that makes versions should not use the approver's account: add it to the brand as a member with the
**producer** role (for example "Claude (agent)", with an email address you read), and connect the MCP signed in as that member. Its
versions then carry its name, go through review like anyone's, and you approve them.

It does not hear about new comments by itself: ask it ("work through the open comments on the roasters video"), or have it check
`pending_for_me` from time to time.

## Approving from an assistant

Off unless an admin turns on **"Permitir aprobar desde asistentes (MCP)"** in *Settings → Assistants (MCP)* for the brand. While it is
off, `approve_version` and `request_changes` refuse (`assistant_approval_off`) and say an admin can turn it on there. While it is on:

- they work only for people whose role already can (approving: an approver or admin; requesting changes: a reviewer and up), with every
  rule of the web: never one's own upload, never with open comments, the checklist confirmed item by item, the approval bound to the
  version's fingerprint;
- the assistant has to say back what is being decided on, in `confirm`: the piece (title or id), the version number and the fingerprint as
  the web shows it (its first 12 characters, or all of it). If it is not the very version, nothing happens (`confirmation_mismatch`, with
  what the version actually is, so the assistant can ask the person again).

Nothing changes about publishing: only what a person approved goes on the calendar, through the same checks as the web.

## What is kept, and what can be undone

- **Everything is the person's, via the assistant.** Every change goes through the same services as the web and is in the audit log as
  the person, with `via: { channel: "mcp", client_id, client_name }`. The activity on *For you* says "vía Claude" (or the assistant's
  name), and webhook payloads name it in the actor's `via`.
- **Disconnecting works at once, from either side.** The person disconnects an assistant in *Your account*; an admin disconnects someone's
  assistant from the brand in *Settings → Assistants (MCP)* (if it had other brands, it keeps those). Either way its tokens stop working
  on the next request. A member deactivated in a brand loses it through the assistant at once too, and gets it back if reactivated, as in
  the web.
- **Tokens.** Access tokens last 30 minutes; refresh tokens 30 days and are used once (each refresh gives a new one, and one used twice
  ends the whole connection). Codes last two minutes and work once. Client secrets, codes and tokens are stored only as their sha256. A
  token is valid only at `/api/mcp` and never for the rest of the API; the rest of the API never accepts it, nor a cookie at `/api/mcp`.
- **The OAuth details**, for whoever checks them: protected-resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource/api/mcp` (and at the root), authorization-server metadata (RFC 8414) at
  `/.well-known/oauth-authorization-server`, dynamic client registration (RFC 7591) at `/api/mcp/oauth/register`, the authorization code
  flow with PKCE (S256 only, required), exact redirect URIs (https, or http on localhost), `state` returned as given and `iss` added
  (RFC 9207), resource indicators (RFC 8707), refresh rotation and revocation (RFC 7009) at `/api/mcp/oauth/revoke`. The consent answer
  carries a nonce made for that person and that request. What a client calls is open to any origin without credentials (CORS), for
  browser-based clients; the web's own API, its cookies and its Content-Security-Policy are not opened to other origins. Registration, the token endpoint and the
  consent are rate limited per address, the MCP endpoint per connection.
- In development Vite also proxies `/.well-known` to the API, so `http://localhost:5173/api/mcp` works with Claude Code.
