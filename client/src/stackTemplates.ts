// Starting points for "New stack → from a template". Each keeps every setting in one
// `x-…-env` block, handed to the services with `environment: *anchor` — the layout the
// Stacks settings form reads best, and the one DeviseHR's docker-compose.prod.yml uses.
// Values the form should flag before a deploy say CHANGE_ME.

export interface StackTemplate {
  id: string;
  title: string;
  description: string;
  content: (name: string) => string;
}

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    id: 'web',
    title: 'One web app',
    description: 'A single container on 127.0.0.1, ready for an nginx site.',
    content: (name) => `name: ${name}

x-app-env: &app-env
  # Settings the app reads. Quote every value; write $$ for a literal $.
  APP_ENV: "production"
  SECRET_KEY: "CHANGE_ME"

services:
  app:
    image: ${name}:latest
    environment: *app-env
    ports:
      # 127.0.0.1 keeps it private: only nginx on this server can reach it.
      - "127.0.0.1:3000:8080"
    restart: always
`,
  },
  {
    id: 'api-host-db',
    title: 'API + host PostgreSQL + Redis + MinIO',
    description: 'The DeviseHR shape: Postgres on the server itself, Redis and MinIO in the stack.',
    content: (name) => `name: ${name}

x-app-env: &app-env
  # ---- database on the HOST (not in Docker): containers reach it as host.docker.internal.
  # PostgreSQL page > Logins > "Allow containers" opens it to Docker.
  DB_HOST_IN_DOCKER: "host.docker.internal"
  DB_PORT: "5432"
  DB_NAME: "${name.replace(/-/g, '_')}"
  DB_USER: "${name.replace(/-/g, '_')}_user"
  DB_PASSWORD: "CHANGE_ME"
  # ---- redis (the service below)
  REDIS_HOST_IN_DOCKER: "redis"
  REDIS_PORT: "6379"
  # ---- minio (the service below)
  MINIO_HOST_IN_DOCKER: "minio"
  MINIO_API_PORT: "9000"
  MINIO_ACCESS_KEY: "CHANGE_ME_minio_user"
  MINIO_SECRET_KEY: "CHANGE_ME_minio_password"
  # ---- app
  ASPNETCORE_ENVIRONMENT: "Production"
  JWT_SECRET: "CHANGE_ME"

services:
  api:
    image: ${name}-api:prod
    environment: *app-env
    ports:
      - "127.0.0.1:3001:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on: [redis, minio]
    restart: always

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data
    restart: always

  minio:
    # minio/minio is no longer published on Docker Hub; Chainguard maintains a build.
    image: cgr.dev/chainguard/minio:latest
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: "CHANGE_ME_minio_user"
      MINIO_ROOT_PASSWORD: "CHANGE_ME_minio_password"
    ports:
      - "127.0.0.1:9001:9001"
    volumes:
      - minio-data:/data
    restart: always

volumes:
  redis-data:
  minio-data:
`,
  },
  {
    id: 'front-back',
    title: 'Front end + back end',
    description: 'An nginx-served client and its API, each on its own loopback port.',
    content: (name) => `name: ${name}

x-api-env: &api-env
  CORS_ORIGINS: "https://app.example.com"
  SECRET_KEY: "CHANGE_ME"

services:
  api:
    image: ${name}-api:prod
    environment: *api-env
    ports:
      - "127.0.0.1:3001:8080"
    restart: always

  web:
    image: ${name}-web:prod
    ports:
      - "127.0.0.1:3000:80"
    depends_on: [api]
    restart: always
`,
  },
  {
    id: 'blank',
    title: 'Blank',
    description: 'Just the skeleton.',
    content: (name) => `name: ${name}

services:
  app:
    image: CHANGE_ME
    restart: always
`,
  },
];
