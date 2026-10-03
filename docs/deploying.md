# Deploying

[`deploy/`](../deploy) has a Docker Compose file that runs everything on one machine:

| Service | What it is |
| --- | --- |
| `db` | PostgreSQL 16 |
| `minio`, `minio-init` | MinIO, S3-compatible storage, with a private, versioned bucket made once |
| `app` | The web server: the API, serving the built web app, with `RUN_WORKERS=false` |
| `worker` | The same image running `worker-main`: the queue, publishing with ffmpeg, retries, webhooks, readings, notifications. Safe to run more than once |
| `caddy` | Automatic TLS for the app's domain and the media domain |

## Starting it

```sh
cp deploy/.env.example deploy/.env      # then edit it
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm app \
  node apps/api/dist/cli.js bootstrap --workspace "Acme" --brand "Acme Spain" --timezone Europe/Madrid --admin you@example.com
```

`deploy/.env` names the two public domains (`APP_DOMAIN`, `MEDIA_DOMAIN`), both pointing at this machine, and holds the secrets:
`SECRET` and `DB_PASSWORD` (`openssl rand -hex 32`), the MinIO keys, `SMTP_URL`, `TOKEN_KEY` (`openssl rand -base64 32`), and the
credentials of each network you use. Every variable is described in [configuration](configuration.md).

- **Email is required** while sign-in by emailed link is on (the default): the app refuses to start without `SMTP_URL` rather than put
  sign-in links in its log.
- **The second factor** is asked of admins and approvers by default in production; have an authenticator app at hand for the first
  sign-in ([security](security.md#the-second-factor)).
- **Keep a copy of `TOKEN_KEY` and `SECRET` outside the server.** Losing `TOKEN_KEY` means connecting every account again and replacing
  every webhook secret and Slack address; losing `SECRET` makes every authenticator unusable.

The migrations are applied when the app starts. Big uploads wait in the `staging` volume while they arrive in pieces, so an upload in
progress survives a restart.

## The media domain

The media domain only serves signed addresses from the bucket: browsers upload and download there, never through the app's origin. Caddy
proxies it to MinIO, and MinIO allows the app's origin for CORS.

**It has to be reachable from the internet**, because several networks download the files they publish from it (Meta among them) instead
of receiving them. With `STORAGE_DRIVER=s3` the addresses handed out are the bucket's (`S3_PUBLIC_ENDPOINT`, or `S3_ENDPOINT`), so that is
the domain to verify with TikTok for photo posts; in the Compose file, `S3_PUBLIC_ENDPOINT` is `https://$MEDIA_DOMAIN`.

## Checking the deployment

Once it is up, check the server and each network before relying on them:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm app node apps/api/dist/cli.js check --brand "Acme Spain"
```

What it checks, and the order to bring each network into use, are in [networks](networks.md#checking-a-real-setup).

## Running it without Docker

You need Node 22, PostgreSQL 16 and ffmpeg (with ffprobe). Build once, and run the API with `WEB_DIST` pointing at the built web app and
the rest of the [configuration](configuration.md) in its environment:

```sh
npm ci && npm run build
NODE_ENV=production WEB_DIST=apps/web/dist node apps/api/dist/server.js
```

The API runs the queue too, unless `RUN_WORKERS=false`; then run `node apps/api/dist/worker-main.js` as a second process with the same
environment (as many as you like). The API reads the list of the web app's files when it starts: after rebuilding the web app, restart
the API.

## The agent runner

The runner is not part of the studio's image: it runs where the agent's command is installed. [`deploy/runner`](../deploy/runner/docker-compose.yml)
builds an image of its own with the runner, Claude Code, Chromium, ffmpeg, git and a rendering engine, so a machine needs nothing but
Docker. Building it, its secrets and configuration, and checking it are in the runner's README,
[running the runner on any machine](../apps/runner/README.md#running-the-runner-on-any-machine).

The runner must be reachable by the studio, and only by it. In production, webhooks go only to public addresses over https unless the
studio sets `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`: put the runner behind a reverse proxy with TLS, or on the same private network with that
setting ([where a webhook may point](agents.md#where-a-webhook-may-point)).

## Known limitations

- **Not yet tried end to end with a real bucket.** The S3 driver follows the SDK's documented presign and checksum calls and is tested
  against a stand-in bucket, and the Compose file validates; the application it starts is the one the end-to-end tests drive. A first
  deployment should upload a file, review it and publish it by hand before anything else.
- **No S3 multipart upload.** Big uploads go through the app ([big uploads](architecture.md#big-uploads)), so the app's disk and bandwidth
  carry them, and an upload in progress is lost if its volume is.
