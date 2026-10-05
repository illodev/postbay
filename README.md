<p align="center">
  <img src="docs/brand/banner.jpg" alt="Postbay: review, approve and publish your social content, with your team and your AI agents" width="100%">
</p>

# Postbay

Postbay is a self-hosted studio for social content. Whoever makes it (a designer, an agency or an AI agent) uploads it;
your team reviews it on the exact frame and approves it for specific accounts; Postbay puts it on the calendar and
publishes it, or tells a person when it is their turn to post.

It does not generate content: it is where content gets checked, agreed and sent out. One brand or many, in Spanish or
English, on your own server.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/review.jpg" alt="Reviewing a video: comments on the timeline, the agent's new version, and what changed"></td>
    <td width="50%"><img src="docs/screenshots/pieces.jpg" alt="All the pieces of a brand, with their state, version and comments"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/calendar.jpg" alt="The calendar with scheduled posts and free weekly slots"></td>
    <td width="50%"><img src="docs/screenshots/home.jpg" alt="For you: what waits for your approval, and the team's activity"></td>
  </tr>
</table>

## What it does

**Review where it happens.** Comment on a moment or a span of a video, a point or an area of an image, a page of a PDF,
and draw on the frame. Compare two versions side by side or with a wipe. See what each network's own interface will cover
before it goes out.

**Approvals that mean something.** An approval is bound to the exact files of a version: change one byte and it no longer
counts. Nobody approves their own upload, open comments block an approval, and a brand can ask for several approvers and a
checklist.

**Plan and publish.** A calendar per brand with weekly slots, blocked dates and a pause button. Postbay publishes by itself to
Instagram, Facebook, YouTube, TikTok, LinkedIn, X, Threads, Pinterest and Bluesky, or gets the files, text and first comment
ready for a person to post. Afterwards it reads the numbers each post earned.

**Made for AI agents, safely.** Signed webhooks and an agent runner turn a request for changes into a new version, with a
limit of rounds and a budget per piece and per month. An agent can upload and reply; it never approves. It pairs with
[drawn-by-code](https://github.com/illodev/drawn-by-code), videos made with code by Claude: when a piece comes from a drawn-by-code
project, the agent edits the project, renders it again and uploads the result as the next version.

**Use it from Claude.** Postbay is an [MCP](https://modelcontextprotocol.io) server: ask Claude what is pending for you, leave a
comment, upload a version or schedule an approved post. Claude signs in as you, with your role; no keys to copy. The
[Claude Code plugin](integrations/claude-code/README.md) adds a skill for each workflow, including working through a review into the
next version with an agent of your own.

**Built for a team.** Roles per brand (admin, approver, reviewer, producer, reader), several brands per workspace, single
sign-on and a second factor, an audit log that can only grow, and notifications in the app, by email, on Slack and as push.

## Quick start

You need Node 22, PostgreSQL 16 and ffmpeg.

```sh
npm install
cp .env.example .env            # set DATABASE_URL and SECRET
createdb estudio                # the database DATABASE_URL points at
npm run bootstrap -- --workspace "Acme" --brand "Acme" --timezone Europe/Madrid --admin you@example.com

npm run dev:api                 # http://localhost:3000, applies migrations on start
npm run dev:web                 # http://localhost:5173
```

Set `AUTH_DEV_LOGIN=true` in `.env` to sign in with just your email while you try it out. Connecting real social accounts
needs each network's developer app: see [Networks](docs/networks.md).

## Running it for real

[`deploy/`](deploy) has a Docker Compose setup with PostgreSQL, the app, a worker and Caddy for TLS. The steps, the
media domain the networks download files from, and the agent runner's own image are in [Deploying](docs/deploying.md); every
setting is in [Configuration](docs/configuration.md).

## Documentation

| | |
| --- | --- |
| [Review and approval](docs/review.md) | Pieces, variants and versions, comments, drawings, comparing, approvals |
| [Publishing](docs/publishing.md) | The calendar, slots, automatic and assisted publishing, failures and retries |
| [Networks](docs/networks.md) | Connecting accounts and setting up each network's developer app |
| [Agents](docs/agents.md) | Webhooks, the agent runner and its safeguards |
| [Postbay from Claude (MCP)](docs/mcp.md) | Connecting Claude, the tools, approving from an assistant |
| [Prizes](docs/prizes.md) | Sending a file or a link to whoever comments a keyword |
| [Notifications](docs/notifications.md) | In the app, email, Slack and push |
| [Security](docs/security.md) | Sign-in, roles, the audit log and the rules that always hold |
| [Architecture](docs/architecture.md), [API](docs/api.md) | How it is built, and the HTTP API |
| [Configuration](docs/configuration.md), [Deploying](docs/deploying.md), [Development](docs/development.md) | Settings, production, tests |

## Status

Every connection to a social network is written against that network's documentation and tested against a local stand-in;
none has been run against real accounts yet. Some networks (TikTok, Pinterest, YouTube) keep posts private until they review
the app, and TikTok may not approve an app like this one.

## License

[MIT](LICENSE). Made by illodev, who also makes [drawn-by-code](https://github.com/illodev/drawn-by-code).
