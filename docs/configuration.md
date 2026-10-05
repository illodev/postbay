# Configuration

The API reads its configuration from environment variables, checked when it starts: a missing or contradictory value stops it with a
message that says what to fix. In development, `npm run dev:api` and the CLI commands read `.env` at the root; start from
[`.env.example`](../.env.example). The Compose deployment reads [`deploy/.env`](../deploy/.env.example) ([deploying](deploying.md)).

An empty value (`KEY=` in an env file) counts as not set. Booleans take `true`, `false`, `1` or `0`.

## The server

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production refuses the development sign-in, requires email for sign-in links, turns the second factor on and keeps webhooks to public https addresses |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Where the API listens |
| `DATABASE_URL` | `postgres://estudio:estudio@localhost:5432/estudio` | PostgreSQL connection string. Migrations are applied on start |
| `APP_URL` | `http://localhost:5173` | Public address of the app: sign-in links, the OAuth redirect address, links in notifications |
| `MEDIA_URL` | `http://localhost:3000` | Public address of the media domain (a separate one in production) |
| `SECRET` | (required) | At least 32 characters. Signs local media addresses, and the authenticator secrets are sealed with a key made from it: **losing it makes every authenticator unusable** |
| `TOKEN_KEY` | not set | 32 bytes in base64 (`openssl rand -base64 32`). Seals network tokens, webhook secrets, Slack addresses and Bluesky app passwords. Required once any network's credentials are set, and for webhooks, Slack and Bluesky. **Keep a copy: losing it means connecting every account again and replacing every webhook secret and Slack address** |
| `WEB_DIST` | not set | Folder with the built web app, so the API serves it from the same origin |
| `MEDIA_ORIGINS` | empty | Extra origins the browser may load media from or upload to (space separated), besides `MEDIA_URL` and the bucket's address |

## Storage and uploads

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | `local` (this machine's disk: development, or the Compose file on one machine) or `s3` (any S3-compatible bucket) |
| `STORAGE_LOCAL_DIR` | `.data/media` (`/var/lib/estudio/files` in the image) | Where the local driver keeps files |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | region `auto`, path style off | The bucket. With `STORAGE_DRIVER=s3`, the bucket and both keys are required |
| `S3_PUBLIC_ENDPOINT` | not set | The bucket's address as browsers and networks reach it, when it differs from the one the app uses inside its network |
| `STAGING_DIR` | `.data/staging` | Where big uploads wait while they arrive in pieces (a volume in the Compose file). Needs room for the biggest upload in progress |
| `STAGING_MAX_GB_PER_BRAND` | `20` | How much one brand may have waiting there in unfinished big uploads, in GB; past it a new big upload is refused |
| `PUBLIC_MEDIA_TTL_SECONDS` | `21600` (6 hours) | How long a file handed to a network by address stays downloadable (at least 300) |

## Email and signing in

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_URL`, `MAIL_FROM` | not set, `Postbay <no-reply@localhost>` | Email. Without `SMTP_URL`, messages go to the log in development; in production it is required while email-link sign-in is on, and without it no email text is logged |
| `AUTH_DEV_LOGIN` | `false` | Sign in with just an email, for development. Ignored when `NODE_ENV=production` |
| `EMAIL_LINK_LOGIN` | on, except with `OIDC_SECOND_FACTOR=idp` | Whether the emailed link signs people in. `false` when everyone signs in with single sign-on |
| `SECOND_FACTOR_REQUIRED` | on in production, off otherwise | Whether admins and approvers must give an authenticator code |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | not set | Single sign-on with any OpenID Connect provider; the three go together, and the issuer must be https in production. Redirect address to register: `$APP_URL/api/auth/sso/callback` |
| `OIDC_ALLOWED_DOMAINS` | (required with single sign-on) | The email domains that may use it, comma separated |
| `OIDC_LABEL` | `single sign-on` | What the sign-in button says ("Google Workspace", "Microsoft") |
| `OIDC_SECOND_FACTOR` | `app` | `app`: admins and approvers also give an authenticator code. `idp`: you say the provider enforces its own second step |
| `OIDC_TRUST_EMAIL` | `false` | Accept an email the provider does not say is verified. Only for a single-tenant Microsoft Entra issuer |

How each works is in [security](security.md#signing-in).

## Networks

Each network switches on when its credentials are set, and needs `TOKEN_KEY`. Without them, accounts on that network stay manual. Setting
up each developer app is in [networks](networks.md#setting-up-the-networks).

| Variable | Default | Meaning |
| --- | --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | not set | The Meta app: Facebook Pages and the Instagram accounts linked to them |
| `META_LOGIN_CONFIG_ID`, `META_LOGIN_CONFIG_ID_PRIZES` | not set | With Facebook Login for Business: the login configuration the sign-in dialog uses instead of a list of permissions, and the one for brands with prizes (without it, the first is used for every brand) |
| `META_GRAPH_VERSION` | `v23.0` | The Graph API version |
| `META_WEBHOOK_VERIFY_TOKEN` | not set | For [prizes](prizes.md): the token Meta sends back when you register `$APP_URL/api/meta/webhook`. Any long random string; needs the Meta app |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | not set | The Google project with the YouTube Data API v3 |
| `GOOGLE_ANALYTICS` | `false` | Also ask YouTube for its Analytics permission, so watch time can be read. Google treats it as sensitive: the project must be verified |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | not set | Threads |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | not set | TikTok |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | not set | LinkedIn |
| `LINKEDIN_VERSION` | `202604` | LinkedIn's API version (`YYYYMM`). Raise it when LinkedIn retires the version; the server check warns before |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | not set | X |
| `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET` | not set | Pinterest |
| `BLUESKY_PDS_URL`, `BLUESKY_VIDEO_URL` | `https://bsky.social`, `https://video.bsky.app` | Only for a self-hosted Bluesky server. Bluesky needs no app, only `TOKEN_KEY` |

## Webhooks and Slack

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS` | yes in development, no in production | Whether webhooks (and a Bluesky server typed in) may point at loopback and private addresses, such as a runner on the same network. Cloud metadata and link-local addresses are refused whatever this says |
| `SLACK_HOOK_HOST` | `hooks.slack.com` | The only host a Slack address may be on. Changed only to point tests at a stand-in |

Push needs no configuration: Postbay makes its own signing key the first time one is needed.

## Workers

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUN_WORKERS` | `true` | Run the queue inside the API process. `false` when a separate worker runs (`node apps/api/dist/worker-main.js`, or `npm run worker -w @estudio/api` in development) |
| `WORKER_SWEEP_SECONDS` | `15` | How often the worker looks for publications that need attention |
| `NOTIFY_SECONDS` | `30` | How often notifications are sent by email, Slack and push |
| `METRICS_SWEEP_SECONDS` | `120` | How often due readings are taken |
| `PRIZE_POLL_SECONDS` | `180` | How often the comments of posts with a running prize are read |
| `PRIZE_PURGE_SECONDS` | `3600` | How often the people whose retention period ended are deleted |
| `FILL_SLOTS_SECONDS` | `300` | How often approved versions are put into free slots, for the brands that ask for it |

## Network addresses

Each network's sign-in and API address can be changed, which is how the tests and the end-to-end runs point Postbay at stand-ins. Leave
them unset in a real deployment: `META_GRAPH_URL`, `META_OAUTH_URL`, `GOOGLE_OAUTH_URL`, `GOOGLE_TOKEN_URL`, `YOUTUBE_API_URL`,
`YOUTUBE_ANALYTICS_URL`, `THREADS_OAUTH_URL`, `THREADS_GRAPH_URL`, `TIKTOK_OAUTH_URL`, `TIKTOK_API_URL`, `LINKEDIN_OAUTH_URL`,
`LINKEDIN_TOKEN_URL`, `LINKEDIN_API_URL`, `X_OAUTH_URL`, `X_API_URL`, `PINTEREST_OAUTH_URL`, `PINTEREST_API_URL`.

## Elsewhere

| Variable | Read by | Meaning |
| --- | --- | --- |
| `APP_DOMAIN`, `MEDIA_DOMAIN`, `DB_PASSWORD` | `deploy/docker-compose.yml` | The public names of the app and the media domain, and the database password. `APP_URL`, `MEDIA_URL` and `DATABASE_URL` are made from them |
| `API_URL` | the web's Vite server | Where development requests to `/api`, `/media` and `/.well-known` go (`http://localhost:3000` by default) |
| `LANG` | `npm run check` | The report's language: English for `en_*`, Spanish otherwise |
| `TEST_DATABASE_ADMIN_URL` | the tests | A PostgreSQL the tests can create databases in ([development](development.md#tests)) |

The agent runner has its own configuration file: see its [README](../apps/runner/README.md#configuration).
