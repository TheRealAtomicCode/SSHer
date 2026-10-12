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
- **Deploy new** — drop a `docker save` tarball (or pick a local/registry image) and the
  wizard writes `/opt/<name>/docker-compose.yml`, starts it, and optionally adds an nginx
  site for a domain (port bound to `127.0.0.1`) or a ufw rule. The review step shows every
  file and command before anything runs.
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
