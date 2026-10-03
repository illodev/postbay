# One image runs the API and serves the built web app. ffmpeg is there to measure uploads and grab the frame
# a comment points at. The agent runner (apps/runner) is not in this image: it runs where the agent's command is installed
# (see apps/runner/README.md). It is built here with the rest of the workspace, so its manifest is copied for `npm ci`.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci
COPY tsconfig.base.json ./
COPY apps ./apps
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN npm ci --omit=dev -w @estudio/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
ENV WEB_DIST=/app/apps/web/dist
# Where big uploads wait while they arrive in pieces (docs/architecture.md#big-uploads). The compose file keeps it on a volume so an upload survives a restart.
ENV STAGING_DIR=/var/lib/estudio/staging
RUN mkdir -p /var/lib/estudio/staging && chown node:node /var/lib/estudio/staging
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
