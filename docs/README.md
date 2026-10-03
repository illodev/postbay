# Postbay documentation

- [Review and approval](review.md): pieces, variants and their styles, versions, the viewer, comments and drawings, comparing, subtitles, approval and the fingerprint, the checklist.
- [Publishing](publishing.md): scheduling, automatic publishing, failures and retries, publishing by hand, pausing and blocked dates, weekly slots, scheduling after approval.
- [Networks](networks.md): connecting accounts, setting up each network's developer app, private posts, results, and checking a real setup with `npm run check`.
- [Webhooks and the agent](agents.md): events and their signatures, the agent runner and its safeguards and budgets, pieces made with code, empty slots, the agent scheduling what is approved.
- [Using Postbay from Claude (MCP)](mcp.md): connecting an assistant, its tools, approving from it, and what it can and cannot do.
- [Prizes for commenting](prizes.md): a keyword in a comment that earns a file or a link, and what is kept about the people who comment.
- [Notifications](notifications.md): the bell, email, Slack and push, who gets what, and in which language.
- [Security and access](security.md): signing in, roles, invitations, deactivating members, API tokens, the audit log, and the rules that hold everywhere.
- [Architecture](architecture.md): the apps and the layers of the API, how files flow, the queue and the worker, languages.
- [The API in brief](api.md): the main routes, grouped by what they are for.
- [Configuration](configuration.md): every environment variable.
- [Deploying](deploying.md): Docker Compose, the media domain, and the agent runner's image.
- [Development](development.md): local setup, tests and end-to-end tests.

The agent runner has its own [README](../apps/runner/README.md), and the end-to-end tests [theirs](../e2e/README.md).
