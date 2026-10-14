# Deploying SSHer to the VPS

SSHer runs on the server as two containers:

| Container | What it is | Port on the server | Port inside | Built from |
| --- | --- | --- | --- | --- |
| `ssher-web` | The UI (nginx). Forwards `/api` to the API at **https://app.ssh.com.ly** | **7000** | 80 | `client/` → `ssher-web.tar` |
| `ssher-api` | The Node back end that does the SSH work. Served at **app.ssh.com.ly** | **7001** | 3001 | `server/` → `ssher-api.tar` |

You open **http://102.203.201.222:7000**.

The web container's nginx reaches the API through its public https domain,
`https://app.ssh.com.ly`, not through the server's ports. The browser only talks to
`ssher-web`, so it needs no CORS settings. To point it somewhere else, set
`API_UPSTREAM` on `ssher-web`, e.g. `http://host.docker.internal:7001` to go straight to
the API container on the same server.

You deploy and update both containers from the SSHer you run **on your own PC**
(`npm start` → http://localhost:5173), by dragging `.tar` files onto its Docker page.

---

## 0. One-time setup on your PC

1. Install the project once: `npm install` in the SSHer folder.
2. Start **Docker Desktop**. It must be running to build the images.

---

## 1. Build the image files

Run this every time you want to ship changes:

```powershell
cd C:\Users\MyPC\Desktop\Projects\SSHer
npm run docker:images
```

This builds both images and writes two files in the SSHer folder:

- `ssher-api.tar`: the back end
- `ssher-web.tar`: the front end

| You changed… | Files to drag in step 3 |
| --- | --- |
| Something in `client/` (screens, styles) | `ssher-web.tar` |
| Something in `server/` (API, Docker/SSH logic) | `ssher-api.tar` |
| Both, or not sure | Both. The back end goes first |

---

## 2. First-time deploy (do this once)

1. On your PC, run `npm start` and open http://localhost:5173.
2. Log in to `102.203.201.222`, then go to **Docker** in the sidebar.

### 2a. Back end: drag `ssher-api.tar` onto the Docker page

The upload runs, then the deploy wizard opens.

| Wizard step | Enter |
| --- | --- |
| 1. Image | Already filled in. **Next** |
| 2. Basics | Name **`ssher-api`**. Leave the rest. **Next** |
| 3. Network | Choose **Public port**. Container port **3001**, server port **7001**. Tick the ufw box. **Next** |
| 4. Environment | **+ Add** → key `SSHER_ACCESS_KEY`, value: a long random password. **Write it down.** **Next** |
| 5. Review | Check the file, then **Deploy** |

Then put the API on its domain:

1. In Cloudflare, add an **A** record `app` → `102.203.201.222`, **Proxied** (orange cloud).
   Cloudflare provides the https.
2. In SSHer go to **Nginx** → add a site: domain **`app.ssh.com.ly`**, target
   **`127.0.0.1:7001`**, max body size `0` (unlimited, for big uploads).
3. Check that https://app.ssh.com.ly/api/health returns `{"ok":true,"service":"ssher-api",...}`.
   Do this before deploying the front end. Its nginx looks up `app.ssh.com.ly` when it starts.

> Cloudflare's free plan rejects request bodies over **100 MB**. Uploads larger than that
> fail when they go through app.ssh.com.ly.

### 2b. Front end: drag `ssher-web.tar`

| Wizard step | Enter |
| --- | --- |
| 2. Basics | Name **`ssher-web`** |
| 3. Network | **Public port**. Container port **80**, server port **7000**. Tick the ufw box |
| 4. Environment | Nothing to add. `API_UPSTREAM` is already `https://app.ssh.com.ly`. (Only if you set it to `http://host.docker.internal:7001` instead: tick **"Needs a database or service running on the host?"**, or nginx won't start) |
| 5. Review | **Deploy** |

### 2c. Check it

Open **http://102.203.201.222:7000** and enter the access key. You should see the SSHer
login page.

To check each piece on its own, open these in the browser. None of them needs the access key:

| URL | Proves | Expected |
| --- | --- | --- |
| http://102.203.201.222:7001/api/health | The API container is up | `{"ok":true,"service":"ssher-api",...}` |
| https://app.ssh.com.ly/api/health | The API's domain works | Same as above |
| http://102.203.201.222:7000/healthz | The web container is up | `{"ok":true,"service":"ssher-web",...}` |
| http://102.203.201.222:7000/api/health | Web can reach the API | Same as the first one. A **502** means web is up but can't reach the API |

---

## 3. Updating after you change the code

1. Make your change and test it locally with `npm start` → http://localhost:5173.
2. Build the image files: `npm run docker:images`.
3. Open the **local** SSHer (http://localhost:5173), log in to the VPS, then go to **Docker**.
   Don't use the deployed one at :7000 for this: see the warning below.
4. Drag in the `.tar` you need (see the table in step 1).
5. SSHer recognises that the app is already running and shows **"New build loaded"**:
   - Click **Update ssher-api** (or **Update ssher-web**).
   - Confirm.

   The version that was running is saved as `:rollback` first. Then the container is
   recreated with the new build, which takes a few seconds of downtime.
6. If you're updating both, drag the second `.tar` in and repeat.
7. Reload http://102.203.201.222:7000 with **Ctrl+F5**, so the browser doesn't use the old cached UI.

> ⚠️ **Update SSHer from your local SSHer, never from the deployed one.**
> Updating `ssher-api` restarts the back end that the deployed UI is using. It cuts its own
> connection in the middle of the update and can leave the container stopped.
> The local copy at localhost:5173 doesn't have this problem.

You don't need the wizard again for updates. Your settings (ports, access key, env) live
in `/opt/ssher-api/docker-compose.yml` and `/opt/ssher-web/docker-compose.yml` on the
server, and an update keeps them.

---

## 4. Something broke? Roll back

Docker page → click the container (e.g. `ssher-api`) → **Overview** tab → **Roll back**.
This switches back to the build that was running before your last update.

Each update also keeps a dated copy, e.g. `ssher/api:rollback-20261012-0410`. You'll find
these on the **Images** tab, and you can delete old ones there.

---

## 5. Changing a setting (port, access key) without rebuilding

1. Docker page → click the container → **Config** tab.
2. Open `docker-compose.yml`, edit it (e.g. change `SSHER_ACCESS_KEY`), then **Save**.
3. Accept **"Apply the change now?"**.

---

## 6. Removing it

Docker page → on the `ssher-web` group, **Remove app**. Then the same on `ssher-api`.

This stops and deletes the containers and the image, removes the ufw rules the wizard
added, and deletes `/opt/ssher-web` and `/opt/ssher-api`. You can't undo it, but you can
always deploy again from step 2.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `npm run docker:images` fails with "failed to connect to the docker API" | Docker Desktop isn't running. Start it and wait until it says *Engine running* |
| :7000 doesn't load at all | `ssher-web` isn't running. Check its **Logs** tab. "host not found in upstream app.ssh.com.ly" means the API's DNS record isn't set up yet (2a). Fix it, then restart `ssher-web` |
| Page loads, but everything fails or says "Request failed (502)" | The API isn't reachable at https://app.ssh.com.ly. Open https://app.ssh.com.ly/api/health. If that fails, check the `ssher-api` container, the nginx site, and the Cloudflare record |
| Keeps asking for the access key | The key is wrong. Check `SSHER_ACCESS_KEY` in `/opt/ssher-api/docker-compose.yml` (Config tab) |
| After an update the UI looks unchanged | Hard-reload the page with Ctrl+F5 |
| Dropping the `.tar` opens the wizard instead of "New build loaded" | The image name changed, or the app was removed. Use the wizard (step 2) |

## Security notes

- `http://IP:7000` is **not encrypted**: SSH passwords and the access key cross the
  internet in plain text. The web container already reaches the API over https. To make
  the UI itself https, give `ssher-web` a Cloudflare-proxied domain too, the same way as
  the API in 2a (Nginx site → `127.0.0.1:7000`). Nothing in the images needs to change.
- Ports published by Docker get past ufw, so 7000 and 7001 are reachable from anywhere
  while the app is deployed. The access key is the only thing protecting them, so make it
  long.
