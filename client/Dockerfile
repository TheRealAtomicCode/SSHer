# SSHer web UI: the Vite build served by nginx, which also forwards /api to the API.
#
# Build context is client/:
#
#   docker build -t ssher/web:latest client
#
# Runs on port 80 inside the container. Settings:
#   API_UPSTREAM   where nginx sends /api (default https://app.ssh.com.ly, the API's
#                  public https domain). To reach the API container's published port
#                  on the same server instead, set http://host.docker.internal:7001 —
#                  that needs the host.docker.internal -> host-gateway mapping.
#
# Base images: Alpine by default. `npm run docker:images -- --base debian` passes
# NODE_IMAGE=node:22-bookworm-slim and NGINX_IMAGE=nginx:1.27 instead (Debian 12).

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# vite build directly: `npm run build` also typechecks, which needs nothing at runtime.
RUN npx vite build

# ------------------------------------------------------------------ runtime
FROM ${NGINX_IMAGE}
# The official image runs envsubst over /etc/nginx/templates/*.template at startup, and
# only substitutes variables that are defined — so nginx's own $host, $uri stay intact.
ENV API_UPSTREAM=https://app.ssh.com.ly
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
