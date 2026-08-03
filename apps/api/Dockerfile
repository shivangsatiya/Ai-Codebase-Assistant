# Why node:20-bookworm-slim instead of node:20-alpine?
#
# This project has three native-compiled dependencies now (bcrypt,
# sharp and onnxruntime-node via @huggingface/transformers) - none
# existed on Day 1, when Alpine was a fine, smaller choice. Alpine uses
# musl libc; the prebuilt binaries these packages ship are built and
# tested against glibc. Alpine + native npm dependencies is one of the
# most common, well-documented sources of "works locally, breaks in
# Docker" failures in the Node ecosystem. Debian slim costs roughly
# 130MB more image size than Alpine - a real cost, but a small one
# against the reliability of the build actually working.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# build-essential (python3/make/g++) is only needed here, in the builder
# stage, as a fallback: most native deps ship a prebuilt binary matching
# this base image, but if any of them ever needs to compile from source
# (e.g. no prebuilt binary for a specific Node ABI version), node-gyp
# needs these tools present. They are NOT copied into the final runtime
# image - only the already-compiled output is.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Installed unscoped, at the workspace root - NOT `npm ci --workspace=apps/api`.
# That flag scopes which workspace's SCRIPTS run (correct later, for
# `npm run build --workspace=apps/api`), not which workspace's
# dependencies get installed. For a monorepo, the install step needs to
# run against the root lockfile to resolve the full dependency tree
# correctly, including hoisted shared dependencies.
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
RUN npm ci

COPY apps/api ./apps/api
RUN npm run build --workspace=apps/api

FROM node:20-bookworm-slim
WORKDIR /app

# git is required at RUNTIME (not build time) by simple-git, which
# shells out to the real git binary to clone a user-submitted
# repository. ca-certificates is needed for outbound HTTPS calls (GitHub
# API, Groq API, the one-time embedding model download) to verify TLS
# certificates correctly. libgomp1 is a defensive addition: onnxruntime
# (the runtime behind local embeddings) commonly links against GNU's
# OpenMP runtime for parallelized CPU inference - this couldn't be
# confirmed with a real build test in this environment, but the failure
# mode if it's needed and missing is bad (a clean startup, then a crash
# the first time someone actually imports a repository, not an obvious
# build-time error), and the library itself is small and harmless to
# include even if it turns out not to be strictly required.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Why copy the ENTIRE builder /app directory instead of cherry-picking
# apps/api/dist + apps/api/node_modules (the original approach)?
#
# This is an npm workspaces monorepo. `npm ci` run at the repo root
# HOISTS most shared dependencies (express, mongoose, nearly everything)
# up to the root-level /app/node_modules - it does NOT put them in
# apps/api/node_modules. The original version of this Dockerfile only
# copied apps/api/node_modules into the runtime image, which was missing
# almost every dependency and failed at startup with "Cannot find module
# 'express'" - a real bug, caught only once this was actually deployed,
# since Docker wasn't available to test this multi-stage build during
# local development. Copying the whole /app directory preserves the
# exact relative structure (root node_modules alongside apps/api/) that
# Node's own module resolution algorithm expects - it walks UP parent
# directories looking for node_modules, so running from
# /app/apps/api/dist/server.js correctly finds hoisted packages in
# /app/node_modules the same way it did during the build. The trade-off:
# this also includes devDependencies and TypeScript source in the
# runtime image, a real image-size cost worth optimizing later (a
# proper `npm ci --omit=dev` production-only install stage) - but
# correctness came first, verified by an actual deployment, before that
# optimization was worth the added complexity and risk of a second
# untested change.
COPY --from=builder /app /app

ENV NODE_ENV=production
EXPOSE 4000

# Deliberately /health/live, not /health/ready: this HEALTHCHECK is a
# LOCAL Docker/docker-compose concept (visible in `docker ps`, usable via
# compose's `depends_on: condition: service_healthy`), separate from
# Render's own healthCheckPath (see render.yaml, which DOES check
# /health/ready). A transient MongoDB blip shouldn't make Docker's own
# tooling consider this container "unhealthy" - that mirrors the same
# reasoning behind /health/live existing as a distinct endpoint at all
# (see app.ts). node is used to make the request (not curl/wget) since
# neither is installed in this minimal image, and node is already
# present as the runtime itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]