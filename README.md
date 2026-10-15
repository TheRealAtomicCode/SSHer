# SSH Web File Browser

A web UI for browsing a remote server over SSH: connect with an IP + password, browse
files with icons, preview images and text, rename/copy/move/delete, and drag-and-drop
files or whole folders into an upload directory.

- **Backend** — Node + Express + TypeScript, using `ssh2` for SSH/SFTP (`server/`).
- **Frontend** — Vue 3 + TypeScript + Tailwind CSS v4 + oh-vue-icons (`client/`).

## Running

```bash
npm install     # also installs client/ dependencies
npm start       # runs the backend AND the frontend together
```

Open <http://localhost:5173>. Vite proxies `/api` to the backend on :3001, so there is
nothing else to configure. Ctrl+C stops both.

To run a half on its own:

```bash
npm run dev:api      # backend  -> http://localhost:3001
npm run dev:client   # frontend -> http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm start` | Backend + frontend, both watching for changes |
| `npm run dev:api` / `npm run dev:client` | One half only |
| `npm run typecheck` | Typechecks backend and frontend |
| `npm run build` | Compiles the backend to `dist/` and bundles the UI to `client/dist/` |
| `npm run serve` | Serves the already-built backend from `dist/` |

## Using it

| Action | How |
| --- | --- |
| Connect | Enter IP/host, port, username, password |
| Open a folder | Double-click |
| Edit a text file / view an image | Double-click |
| Copy / cut / paste / rename / download / delete | Right-click, or the shortcuts below |
| Jump to a path | **Go to path** (or `Ctrl+L`, or click the path bar), paste, Enter |
| Copy the current path, or the selected paths | **Copy path** button in the path bar |
| Copy the `cd` command for the current folder | **Copy cd** button in the path bar |
| Upload | **Upload** button, or drag files/folders anywhere onto the window |
| Switch list / grid view | Toggle in the header (remembered) |
| Full screen | Expand button in the header |

Uploads default to an `uploads` directory inside the folder you are viewing; the
destination is editable in the upload dialog, and dropped folders keep their structure.

## Keyboard shortcuts

Press `?` in the app for this list.

| Key | Action |
| --- | --- |
| `Ctrl+L` | Go to a path |
| `Click` / `Ctrl+Click` / `Shift+Click` | Select one / toggle one / select a range |
| `Ctrl+A` | Select everything |
| `↑` `↓`, `Shift+↑` `↓` | Move the selection / extend it |
| `Ctrl+C`, `Ctrl+X`, `Ctrl+V` | Copy, cut, paste (whole selection) |
| `Ctrl+Z` | Undo the last change |
| `F2` | Rename |
| `Delete` | Delete the selection |
| `Enter` | Open |
| `Ctrl+S` | Save, in the editor |

**What undo covers.** Rename, move, copy and new-folder are reversible. Delete is not:
it runs `rm -rf` on the server, so it is gone. Undoing a copy only removes entries the
paste actually created, never one it overwrote.

## The text editor

Text files open in a built-in editor (`Ctrl+S` to save). The **Highlight** toggle greys
out comments and colours strings, numbers and keywords; it picks the comment style from
the file (`#` for shell/YAML/Dockerfile, `//` for C-like, `--` for SQL, `<!-- -->` for
markup) and remembers whether you left it on.

Two cases are deliberately read-only, because saving would destroy data:

- **Binary files** — detected by a NUL byte, so a stray `Open with → Text editor` on a
  binary cannot corrupt it.
- **Files over 2 MB** — only the first 2 MB is read, so saving would truncate the rest.

## The path box

`Ctrl+L`, the **Go to path** button, or a click on the path bar turns the breadcrumbs into
an input. Paste a path, press Enter, and you are there. It is forgiving about what you
paste:

- `cd '/var/log'` — a line copied out of this app (or your terminal) works as-is
- `~/projects` — expands to your home directory
- `/var/log/nginx/` — a trailing slash is fine
- `/var/log/nginx/access.log` — a path to a *file* opens the folder holding it, with the
  file selected

A path that does not exist reports the error and leaves you where you were, rather than
dumping you in some parent directory.

## Open with

Each file type opens in a default app: images in the image viewer, and text, code and the
usual Linux config files (`Dockerfile`, `.bashrc`, `sshd_config`, `fstab`, anything without
an extension — the sort of thing you would reach for `nano` to edit) in the text editor.
Everything else downloads.

Right-click → **Open with** overrides that, and your choice is remembered per file type in
`localStorage`. So you can send `.svg` to the text editor to look at the markup, and it
will keep opening that way.

## Notes

- Successful logins are saved in the browser's `localStorage` (`ssh-fb.servers`) so you can
  switch servers in one click. The password is saved **in plain text** only when "Remember
  password" is ticked — leave it off on shared machines. The backend never writes
  credentials to disk; the browser holds an opaque session id (in `sessionStorage`) and the
  SSH connection is dropped after 30 minutes idle.
- Shortcuts are stored per server in `localStorage` (`ssh-fb.shortcuts`).

## Docker and Ports & Firewall

Both run plain shell commands over the SSH session (`docker`, `docker compose`, `ss`,
`ufw`, `nginx`); nothing is installed on the server. Non-root logins go through `sudo -n`.

- **Docker** lists containers grouped by compose project, with start/stop/restart, logs,
  env, mounts, and the compose/env files the project was started with (edit → save → apply
  with `docker compose up -d`). **Update** tags the running image `:rollback` and
  `:rollback-YYYYMMDD-HHMM`, pulls, and recreates; **Roll back** restores `:rollback`.
- **Config** (a container's tab) lists every file the container takes its configuration
  from: the compose files, the service's own `env_file:` entries (resolved by
  `docker compose config`, so `${ENV_FILE:-.env.prod}` and relative paths show as the real
  file), the `--env-file` that fills in `${…}`, and `appsettings*.json`. Each opens in the
  editor, whose **Upload** replaces the text with a local file before you save. Saving
  offers to apply: `docker compose up -d` for compose and env files, a restart for
  appsettings. A required env file that is missing is flagged in red (the usual cause of a
  "missing configuration" crash loop) and **Create** makes it, empty and mode 600. An
  appsettings file that exists only in the image gets **Make editable**: it is copied to
  `<project>/ssher-config/<service>/`, bind-mounted back through `ssher.override.yml`, and
  the service is recreated, so later edits survive recreates and new builds.
- **Deploy new** — drop a `docker save` tarball (or pick a local/registry image) and the
  wizard writes `/opt/<name>/docker-compose.yml`, starts it, and optionally adds an nginx
  site for a domain (port bound to `127.0.0.1`) or a ufw rule. The review step shows every
  file and command before anything runs.
- **Connects to** (a container's tab) lists the databases and services it talks to. Each one has
  **Test**, which connects from inside the container's network namespace, so `localhost`,
  `host.docker.internal`, service names, ufw and `pg_hba.conf` behave as they do for the app. A
  stopped or crash-looping container is tested from a temporary copy of its image. Postgres goes
  as far as a login (it needs `psql` on the server), Redis gets `AUTH` and `PING`, and a URL gets
  a GET. **Save** writes the new values to `ssher.override.yml` in the project folder and
  recreates that one container. Every compose command SSHer runs adds that file when it exists.
  The connections are read from the container's env, or declared exactly by image or compose
  labels:

  ```dockerfile
  LABEL io.ssher.link.database="postgres host=DB_HOST port=DB_PORT database=DB_NAME user=DB_USER password=DB_PASSWORD" \
        io.ssher.link.redis="redis host=REDIS_HOST port=REDIS_PORT password=REDIS_PASSWORD" \
        io.ssher.link.api="http url=API_BASE" \
        io.ssher.link.api.note="Shown under the link" \
        io.ssher.name="my-app" io.ssher.host-gateway="true"   # deploy wizard defaults
  ```

  Kinds are `postgres`, `redis`, `http` and `tcp`. Fields name env variables: `host`, `port`,
  `database`, `user`, `password`, `url`, or `connstr` (an Npgsql `Host=…;` or StackExchange.Redis
  `host:port,password=…` string).
- **Every deploy checks the app stays up.** `up -d` returns as soon as a container exists; an
  app missing its settings then exits and restarts forever. Both deploy flows wait ~12s, and
  if a container isn't steadily running they show its exit code and last log lines.
- **Drag and drop anything onto the Docker page** — several image archives at once, or a whole
  folder of them. Each is uploaded and loaded, matched to the stack service that runs it, and
  one **Update** recreates those services on the new build with the same settings (each old
  build kept as `<repo>:rollback`, with **Roll back** per service on the stack). A dropped
  `.yml` whose `name:` matches an existing stack updates that stack's file and keeps every value
  already set (old file saved as `.before-<date>`), listing only the new settings to fill in.
  `build:` sections whose source isn't on the server are removed automatically. In a stack's
  panel, **New build** on a running service does the same for one image.
- **Change** on an `x-secrets` entry changes a password everywhere it's used: the compose file,
  the PostgreSQL role (ALTER ROLE), and the containers that read it (Redis and MinIO restart
  with it). JWT signing keys shorter than 65 bytes are refused (HMAC-SHA512 needs > 512 bits).
- **Stacks** (Docker → Stacks tab) are whole compose projects: API, front end, Redis, MinIO in
  one file. Bring the file by uploading it, pasting it, dropping a `.yml` on the Docker page,
  or from a template. The panel then shows:
  - each service's image, and whether it is on the server (**Upload .tar** next to any that isn't)
  - every setting — each `KEY: value` under an `environment:` block or a top-level `x-…:`
    block — as a form. Secrets are masked, have a random-value generator, and `CHANGE_ME`
    values are flagged; **Deploy** refuses while any are left. Edits are written into the
    file in place (comments kept, `$` escaped as `$$`) and checked with
    `docker compose config` — a file compose rejects is put back.
  - **Edit file** for the raw YAML, validated before it is saved
  - Deploy / Restart / Stop for the ticked services, Remove containers (volumes kept)

  Every compose project a running container came from appears here, plus any compose file
  directly under `/opt/*/`. A compose group on the Containers tab has a **Settings** button
  that opens it, and a container's Config tab shows (and reveals in Files) the yml it reads.
- **PostgreSQL port** (PostgreSQL → Logins): change the port; the line that sets it is
  rewritten where it actually is (Debian's `psql` wrapper reads it from there), PostgreSQL
  restarts, and if it doesn't come back the old config is restored. A ufw rule for
  containers and an open SSH tunnel follow to the new port. **Allow containers** now also
  adds the ufw rule containers need when ufw is on (`5432/tcp` from `172.16.0.0/12` only).
- **Ports & Firewall** shows each listening port as local / public / allow-listed / blocked,
  flags Docker-published ports (they bypass ufw), and adds, deletes or restricts ufw rules.
  It refuses to close the SSH port you are connected on without an explicit confirmation,
  and enabling ufw always adds an SSH allow rule first.
- The backend runs shell commands (`cp`, `mv`, `rm`, `mkdir`, `rmdir`) on the remote host
  for copy/move/delete, so it expects a POSIX server.
- Downloads are served with an explicit `Content-Type`, `X-Content-Type-Options: nosniff`
  and a sandboxing CSP. That matters for SVG: it has to be typed `image/svg+xml` to render
  in the viewer, and the sandbox stops a hostile SVG from the remote host running script on
  the app's origin.

## Production build

```bash
npm run build   # backend -> dist/, UI -> client/dist/
npm run serve   # serves the API from dist/
```

`npm run serve` only runs the API; serve `client/dist/` with any static file server (and
point its `/api` at the backend).
