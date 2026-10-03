# Postbay for Claude Code

A Claude Code plugin with Postbay's [MCP connection](../../docs/mcp.md) and a skill for each workflow.

```sh
claude plugin marketplace add illodev/postbay
claude plugin install postbay@postbay
export POSTBAY_URL=https://postbay.example.com   # your Postbay; http://localhost:5173 when unset
```

Then, in Claude Code, `/mcp` → **postbay** → **Authenticate**, and sign in to Postbay in the browser that opens.

| Skill | When Claude uses it |
| --- | --- |
| `postbay-setup` | Connecting, fixing a connection, giving an agent its own account |
| `postbay-pending` | "What is waiting for me?", "what goes out today?" |
| `postbay-review` | Reviewing a version and leaving comments on the exact moment, page or area |
| `postbay-address-review` | Working through the open comments of a version into the next one, and answering each comment |
| `postbay-upload` | Uploading files as a new piece or a new version |
| `postbay-schedule` | Scheduling, moving or cancelling posts of approved versions |
| `postbay-plan-week` | Proposing a schedule from free slots and approved content |
| `postbay-approve` | Approving or requesting changes, with the exact version confirmed (where the brand allows it) |

An agent that makes new versions should sign in to Postbay with an account of its own (a producer), so that what it uploads can be
approved by someone else: see [Your own agent on a review](../../docs/mcp.md#your-own-agent-on-a-review).
