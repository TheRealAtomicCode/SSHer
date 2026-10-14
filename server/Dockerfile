# SSHer API (Node + Express + ssh2).
#
# Build context is the REPO ROOT, because package.json and tsconfig.json live there:
#
#   docker build -f server/Dockerfile -t ssher/api:latest .
#
# Runs on port 3001 inside the container. Settings (all optional):
#   SSHER_ACCESS_KEY   shared secret the UI must present — SET THIS on any public server
#   PORT               listen port inside the container (default 3001)
#
# Base image: Alpine by default. `npm run docker:images -- --base debian` passes
# NODE_IMAGE=node:22-bookworm-slim instead (Debian 12).

ARG NODE_IMAGE=node:22-alpine

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the root postinstall installs client/ deps, which this image doesn't
# have. It also skips ssh2's optional native crypto, which falls back to pure JS.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY server ./server
RUN npx tsc -p tsconfig.json

# ------------------------------------------------------------------ runtime
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3001
USER node
CMD ["node", "dist/index.js"]
