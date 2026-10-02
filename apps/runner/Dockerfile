# The agent runner, on any machine, with what an agent needs to revise a piece made with code: ffmpeg, Chromium and fonts for a
# headless renderer, git, Python, the Claude Code CLI, and a rendering engine installed next to it. The engine is only a default:
# drawn-by-code (https://github.com/illodev/drawn-by-code), set by ENGINE_REPO and ENGINE_REF; nothing in the runner depends on it.
#
#   docker build -f apps/runner/Dockerfile -t studio-runner .                 (from the repository's root)
#   docker build -f apps/runner/Dockerfile --build-arg ENGINE_REF=<tag or commit> -t studio-runner .
#
# Two identities: the runner runs as root inside the container, only so that it can hand each run to the agent's user (agent.runAs)
# and read back what the agent made; the compose file drops every capability but the six that takes. The agent runs as `agent`
# (uid AGENT_UID), which cannot read the runner's secrets, configuration or queue. See "Running the runner on any machine" in
# apps/runner/README.md.
ARG NODE_IMAGE=node:22-bookworm-slim

# ───────────────────────────── the runner, built ─────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci --workspace @estudio/runner --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/runner/tsconfig.json apps/runner/tsconfig.build.json apps/runner/
COPY apps/runner/src apps/runner/src
RUN npm run build --workspace @estudio/runner

# ───────────────────────────── the engine, fetched ─────────────────────────────
FROM ${NODE_IMAGE} AS engine
ARG ENGINE_REPO=https://github.com/illodev/drawn-by-code.git
# A branch, a tag or a commit.
ARG ENGINE_REF=main
# Leave out what the engine's repository carries only to show its work (finished renders, review sheets): about 200 MB.
ARG ENGINE_SLIM=true
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /engine
RUN git init --quiet . \
 && git remote add origin "$ENGINE_REPO" \
 && git fetch --quiet --depth 1 origin "$ENGINE_REF" \
 && git checkout --quiet FETCH_HEAD \
 && echo "$ENGINE_REPO $(git rev-parse HEAD)" > .engine-version \
 && rm -rf .git \
 && if [ "$ENGINE_SLIM" = "true" ]; then rm -rf sandbox/*/render sandbox/*/review; fi \
 && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; elif [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force

# ───────────────────────────── the image ─────────────────────────────
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=latest
ARG ENGINE_DIR=/opt/drawn-by-code
ARG AGENT_UID=2001
ARG AGENT_GID=2001

# ffmpeg and ffprobe (the runner's checks and the agent's renders), Chromium with fonts (a headless renderer), git and ssh (projects in
# git), Python (projects' own scripts). No bubblewrap: Docker's default seccomp profile does not let it make namespaces, and the
# container plus agent.runAs is what keeps the agent apart here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      git openssh-client ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# The agent's user. The base image's `node` user goes, so that AGENT_UID can be 1000 (to match the owner of a folder worked on in place).
RUN userdel --remove node 2>/dev/null || true; groupdel node 2>/dev/null || true; \
    groupadd --gid "$AGENT_GID" agent \
 && useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --create-home --home-dir /home/agent --shell /bin/bash agent

COPY --from=engine /engine ${ENGINE_DIR}
# The engine's skills are the agent's: Claude Code reads ~/.claude/skills. Each is linked, so a brand's own skills can sit beside them.
# git: the agent may look at its worktree (git status, diff, log), whose repository the runner owns.
RUN mkdir -p /home/agent/.claude/skills \
 && if [ -d "${ENGINE_DIR}/.claude/skills" ]; then for d in "${ENGINE_DIR}"/.claude/skills/*/; do ln -s "$d" "/home/agent/.claude/skills/$(basename "$d")"; done; fi \
 && git config --file /home/agent/.gitconfig safe.directory '*' \
 && chown -R agent:agent /home/agent

WORKDIR /opt/studio
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci --omit=dev --workspace @estudio/runner --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/runner/dist apps/runner/dist
COPY apps/runner/templates apps/runner/templates
COPY apps/runner/examples apps/runner/examples

ENV NODE_ENV=production \
    RUNNER_CONFIG=/etc/studio-runner/runner.config.json \
    CHROME_PATH=/usr/bin/chromium \
    DRAWN_BY_CODE_DIR=${ENGINE_DIR}
RUN mkdir -p /var/lib/studio-runner /etc/studio-runner /srv/projects && chmod 0700 /var/lib/studio-runner
VOLUME ["/var/lib/studio-runner"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/runner/dist/main.js"]
