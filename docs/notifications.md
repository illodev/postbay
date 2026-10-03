# Notifications

Postbay tells people what needs them: a version that arrived, a comment, something waiting for approval, a post due by hand, a post that
failed. Every notification goes to the bell in the app; besides that, each person chooses what they get by email and by push, and a brand
can post chosen kinds to a Slack channel for the team.

A notification says which piece and account it is about, why (in the reader's language), and the post's address once it is out. Email,
Slack and push are sent every `NOTIFY_SECONDS` (30 by default), by the worker.

## In the app

The bell lists the person's notifications, newest first, and marks them read. *For you* gathers what waits for the person, what goes out
today, what needs a hand and what just happened.
Whatever a person turned off for email or push is still in the bell.

## Email

Every kind is emailed unless the person turns it off in *Your account*. Without `SMTP_URL`, emails go to the server log in development
(in production they are not logged at all, only by recipient and subject). Sign-in links are emails too: see [security](security.md#the-emailed-link).

## Slack

An admin pastes a Slack *Incoming Webhook* address in *Settings → Slack* and chooses which kinds of notification go there. Each event is
posted **once for the team**, not once per person.

- The address is a secret (anyone who has it can post), so it is **sealed** with `TOKEN_KEY` and the screen shows only its last four
  characters.
- Only Slack's own host is accepted (`SLACK_HOOK_HOST`, changed only to point tests at a stand-in), so this cannot make the server post
  anywhere else.
- *Send a test* posts a message now.
- A post Slack refuses temporarily is tried again with growing waits. If Slack says the address is gone for good (404, 403, 410), posting
  stops and the brand's admins are told once (`slack.failing`).

## Push

Each person turns push on **per browser** in *Your account*, and can send themselves a test. Postbay makes its own signing key the first
time one is needed (sealed in the database), so there is nothing to set up. Each message is encrypted for that one browser (RFC 8291) and
signed (VAPID); the push service only carries it. A browser the push service says is gone is forgotten.

Push needs https (browsers refuse it otherwise; `localhost` counts as secure) and a browser that supports it; *Your account* says when
that is not the case. Safari on iPhone only receives push from a site added to the home screen.

## Who gets what

Each person chooses, for each kind, whether to receive it by email and whether by push (`GET`/`PUT /api/notifications/preferences`); a
change applies to notifications made after it. An admin chooses the kinds that go to the brand's Slack. The defaults for push and Slack:

| Kind | When | Push | Slack |
| --- | --- | :---: | :---: |
| `version.uploaded` | A new version is in review | ✓ | ✓ |
| `comment.created` | Someone comments on a piece | ✓ | |
| `version.changes_requested` | Changes are requested on a version | ✓ | ✓ |
| `version.approved` | A version is approved | | ✓ |
| `publication.due` | A post published by hand is due (approvers and admins) | ✓ | ✓ |
| `publication.reapproval` | A change to something scheduled needs confirming | ✓ | ✓ |
| `publication.on_hold` | Scheduled posts are put on hold | | ✓ |
| `publication.published` | A post goes out | | ✓ |
| `publication.failed` | A post fails to publish | ✓ | ✓ |
| `publication.handed_over` | A post is handed to a person: the network cannot take it, or its brand was paused or its date blocked past its hour | ✓ | ✓ |
| `publication.private` | A post went out private, until the network approves the app | ✓ | ✓ |
| `publication.auto_scheduled` | Postbay put a version into a free slot (whoever approved it) | | ✓ |
| `account.reconnect` | An account has to be connected again (admins) | ✓ | ✓ |
| `account.expiring` | An account's connection is about to expire | | ✓ |
| `webhook.failing` | A webhook is failing (once per webhook per 24 hours) | | ✓ |
| `slack.failing` | Slack stopped taking messages (admins) | ✓ | |
| `agent.needs_person` | The agent handed a piece back to a person | ✓ | ✓ |
| `agent.failed` | An agent run failed | | ✓ |
| `agent.timed_out` | An agent run ran out of time | | ✓ |

Everything is emailed unless turned off. A member [deactivated](security.md#deactivating-a-member) in a brand is told nothing about it.

## Languages

Emails, Slack and push are written in Spanish or English:

- **email and push** in the person's own language if they chose one (`PUT /api/notifications/locale` with `es`, `en` or `null`, also
  `locale` in the preferences), otherwise in the brand's (its *Content language*, such as `es-ES` or `en-GB`; English only for `en…`);
- **Slack** always in the brand's language;
- **a sign-in link or an authenticator reset**, which belong to no brand, in English only when every brand the person belongs to
  publishes in English.

What a network says in its own words, and the agent's own notes, are passed on as they came. See [languages](architecture.md#languages).

## Known limitations

- **Not yet tried against the real Slack or a real push service.** Slack is tested against a stand-in; push encryption is checked against
  the standard's own worked example, byte for byte, but delivery through Google's, Mozilla's and Apple's push services, which each behave
  a little differently, has not yet been tried.
- **Slack: incoming webhooks only.** No buttons, no replies in a thread, nothing from Slack back to Postbay.
