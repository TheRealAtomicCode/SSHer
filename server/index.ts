import { timingSafeEqual } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import posix from 'node:path/posix';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { registerArchive } from './archive.js';
import { registerDotnet } from './dotnet.js';
import { registerNginx } from './nginx.js';
import { execMaybeRootOrThrow, registerOps } from './ops.js';
import { registerPermissions } from './permissions.js';
import { registerPostgres } from './postgres.js';
import { registerProcesses } from './processes.js';
import { registerTerminal } from './terminal.js';
import { registerUsers } from './users.js';
import {
  connect,
  disconnect,
  execOrThrow,
  getSession,
  readdir,
  realpath,
  rename,
  shellQuote,
  stat,
  type SshSession,
} from './ssh.js';

const PORT = Number(process.env.PORT) || 3001;
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

// readdir() hands back raw POSIX mode bits rather than a Stats object, so the
// file type has to be masked out by hand.
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// Only types we are willing to hand the browser to render. Everything else is
// served as an opaque download, so a remote file can never be interpreted as
// markup on our origin.
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function contentType(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return INLINE_TYPES[ext] ?? 'application/octet-stream';
}

const app = express();
app.use(cors());
// The editor PUTs whole files back as JSON, so the default 100kb cap is too small.
app.use(express.json({ limit: '12mb' }));

// Optional shared secret for when the app is reachable from the internet (e.g. deployed
// in Docker on a public port). Unset, the app is open, which is fine on localhost only.
const ACCESS_KEY = process.env.SSHER_ACCESS_KEY ?? '';

function keyMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!ACCESS_KEY || req.path === '/health') return next();
  // Header for fetch/XHR; query param for <img>/<a> URLs, which cannot send headers.
  const given = (req.header('x-access-key') || (req.query.key as string | undefined) || '').trim();
  if (keyMatches(given)) return next();
  res.status(401).json({ error: 'Access key required', accessKey: true });
});

const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

/** Requests carry their session id in a header, or in a query param for <img>/<a> URLs. */
interface SessionRequest extends Request {
  session?: SshSession;
}

function requireSession(req: SessionRequest, res: Response, next: NextFunction): void {
  const id = (req.header('x-session-id') || req.query.sid) as string | undefined;
  const session = getSession(id);
  if (!session) {
    res.status(401).json({ error: 'Not connected. Please reconnect.' });
    return;
  }
  req.session = session;
  next();
}

/** Resolves a possibly-relative remote path against the session home directory. */
function remotePath(session: SshSession, raw: unknown): string {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : session.home;
  return posix.normalize(value.startsWith('/') ? value : posix.join(session.home, value));
}

const asyncRoute =
  (handler: (req: SessionRequest, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req as SessionRequest, res).catch(next);
  };

// Open to everyone (no access key, no session) so it can be checked from a browser.
// It reveals nothing beyond "the API is up" and whether a key is required.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ssher-api',
    accessKey: Boolean(ACCESS_KEY),
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

/** Behind the access-key check, so a 200 here means the key the client holds is right. */
app.get('/api/access', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/connect', async (req: Request, res: Response) => {
  const { host, port, username, password, privateKey, passphrase } = req.body ?? {};
  if (!host || !username) {
    res.status(400).json({ error: 'host and username are required' });
    return;
  }
  if (!password && !privateKey) {
    res.status(400).json({ error: 'a password or private key is required' });
    return;
  }
  try {
    const session = await connect({
      host: String(host),
      port: port ? Number(port) : 22,
      username: String(username),
      password: password ? String(password) : undefined,
      privateKey: privateKey ? String(privateKey) : undefined,
      passphrase: passphrase ? String(passphrase) : undefined,
    });
    res.json({
      sessionId: session.id,
      host: session.host,
      port: session.port,
      username: session.username,
      home: session.home,
    });
  } catch (err) {
    res.status(401).json({ error: (err as Error).message || 'Connection failed' });
  }
});

app.post('/api/disconnect', requireSession, (req: SessionRequest, res: Response) => {
  disconnect(req.session!.id);
  res.json({ ok: true });
});

app.get('/api/session', requireSession, (req: SessionRequest, res: Response) => {
  const session = req.session!;
  res.json({
    sessionId: session.id,
    host: session.host,
    port: session.port,
    username: session.username,
    home: session.home,
  });
});

/** Every shell command run for this session so far — what runs behind any button
 *  here, regardless of which page it was clicked on. */
app.get('/api/command-log', requireSession, (req: SessionRequest, res: Response) => {
  res.json({ entries: req.session!.commandLog });
});

app.get(
  '/api/list',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const dir = await realpath(session, remotePath(session, req.query.path));

    // Check it really is a directory before reading it. Servers differ in how
    // they answer an opendir on a regular file — some just never reply — so
    // this is what keeps the request from hanging and gives a usable error.
    const info = await stat(session, dir);
    if (!info.isDirectory()) {
      res.status(400).json({
        error: 'Not a directory',
        isFile: true,
        parent: posix.dirname(dir),
        name: posix.basename(dir),
      });
      return;
    }

    const entries = await readdir(session, dir);

    const files = await Promise.all(
      entries.map(async (entry) => {
        const attrs = entry.attrs;
        let isDirectory = (attrs.mode & S_IFMT) === S_IFDIR;
        const isSymlink = (attrs.mode & S_IFMT) === S_IFLNK;

        // A symlink's own attrs describe the link, not the target — follow it so
        // linked directories still behave like directories in the browser.
        if (isSymlink) {
          try {
            const target = await stat(session, posix.join(dir, entry.filename));
            isDirectory = target.isDirectory();
          } catch {
            isDirectory = false;
          }
        }

        return {
          name: entry.filename,
          path: posix.join(dir, entry.filename),
          isDirectory,
          isSymlink,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
          mode: attrs.mode,
        };
      }),
    );

    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.json({ path: dir, parent: dir === '/' ? null : posix.dirname(dir), files });
  }),
);

app.post(
  '/api/rename',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const { path: target, newName, sudo } = req.body ?? {};
    if (!target || !newName) {
      res.status(400).json({ error: 'path and newName are required' });
      return;
    }
    if (String(newName).includes('/')) {
      res.status(400).json({ error: 'newName cannot contain "/"' });
      return;
    }
    const from = remotePath(session, target);
    const to = posix.join(posix.dirname(from), String(newName));
    // SFTP's own rename() cannot be run as root — sudo mode falls back to a
    // shell `mv`, which can.
    if (sudo) await execMaybeRootOrThrow(session, `mv -n -- ${shellQuote(from)} ${shellQuote(to)}`, true);
    else await rename(session, from, to);
    res.json({ ok: true, path: to });
  }),
);

app.post(
  '/api/mkdir',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const dir = remotePath(session, req.body?.path);
    await execMaybeRootOrThrow(session, `mkdir -p -- ${shellQuote(dir)}`, Boolean(req.body?.sudo));
    res.json({ ok: true, path: dir });
  }),
);

app.post(
  '/api/delete',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const paths: string[] = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (!paths.length) {
      res.status(400).json({ error: 'paths are required' });
      return;
    }
    const args = paths.map((p) => shellQuote(remotePath(session, p))).join(' ');
    // Undoing a mkdir asks for a non-recursive delete, so that it refuses to
    // remove a directory the user has since put something into.
    const recursive = req.body?.recursive !== false;
    await execMaybeRootOrThrow(session, recursive ? `rm -rf -- ${args}` : `rmdir -- ${args}`, Boolean(req.body?.sudo));
    res.json({ ok: true });
  }),
);

app.post(
  '/api/paste',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const { sources, dest, mode, sudo } = req.body ?? {};
    const list: string[] = Array.isArray(sources) ? sources : [];
    if (!list.length || !dest) {
      res.status(400).json({ error: 'sources and dest are required' });
      return;
    }
    const destDir = remotePath(session, dest);
    const args = list.map((p) => shellQuote(remotePath(session, p))).join(' ');
    const command = mode === 'cut' ? 'mv --' : 'cp -r --';
    await execMaybeRootOrThrow(session, `${command} ${args} ${shellQuote(destDir + '/')}`, Boolean(sudo));
    res.json({ ok: true });
  }),
);

app.get(
  '/api/download',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const target = remotePath(session, req.query.path);
    const info = await stat(session, target);
    if (info.isDirectory()) {
      res.status(400).json({ error: 'Cannot download a directory' });
      return;
    }

    const name = posix.basename(target);
    const disposition = req.query.inline ? 'inline' : 'attachment';
    res.setHeader('Content-Length', String(info.size));
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    );

    // An SVG has to be typed image/svg+xml or the browser will not render it in
    // an <img>. That same type would let a hostile SVG from the remote host run
    // script on our origin if it were opened as a top-level document, so the
    // response is sandboxed into a null origin and sniffing is turned off.
    res.setHeader('Content-Type', contentType(name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    const stream = session.sftp.createReadStream(target);
    stream.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
    });
    stream.pipe(res);
  }),
);

app.get(
  '/api/text',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const target = remotePath(session, req.query.path);
    const info = await stat(session, target);
    if (info.isDirectory()) {
      res.status(400).json({ error: 'Cannot read a directory as text' });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = session.sftp.createReadStream(target, { start: 0, end: TEXT_PREVIEW_LIMIT });
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.on('close', resolve);
    });

    const buffer = Buffer.concat(chunks);
    res.json({
      path: target,
      content: buffer.toString('utf8'),
      truncated: info.size > size,
      size: info.size,
      // A NUL byte means this is not text; the editor refuses to save it back.
      binary: buffer.includes(0),
    });
  }),
);

app.post(
  '/api/save',
  requireSession,
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const target = remotePath(session, req.body?.path);
    const content = req.body?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      // Opening with 'w' truncates but keeps the existing file's permissions.
      const write = session.sftp.createWriteStream(target);
      write.on('error', reject);
      write.on('close', () => resolve());
      write.end(Buffer.from(content, 'utf8'));
    });

    const info = await stat(session, target);
    res.json({ ok: true, path: target, size: info.size });
  }),
);

app.post(
  '/api/upload',
  requireSession,
  upload.array('files'),
  asyncRoute(async (req, res) => {
    const session = req.session!;
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) {
      res.status(400).json({ error: 'no files uploaded' });
      return;
    }

    // Folder drops send one relative path per file (same order as `files`) so the
    // directory structure can be recreated on the remote side.
    let relPaths: string[] = [];
    try {
      const raw = req.body?.relPaths;
      if (raw) relPaths = JSON.parse(String(raw));
    } catch {
      relPaths = [];
    }

    const destDir = remotePath(session, req.body?.dest);
    const uploaded: string[] = [];

    try {
      await execOrThrow(session, `mkdir -p -- ${shellQuote(destDir)}`);

      const dirs = new Set<string>();
      files.forEach((file, index) => {
        const rel = relPaths[index] || file.originalname;
        const dir = posix.dirname(posix.join(destDir, rel));
        if (dir !== destDir) dirs.add(dir);
      });
      if (dirs.size) {
        const args = [...dirs].map(shellQuote).join(' ');
        await execOrThrow(session, `mkdir -p -- ${args}`);
      }

      for (const [index, file] of files.entries()) {
        const rel = relPaths[index] || file.originalname;
        const target = posix.join(destDir, rel);
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(file.path);
          const write = session.sftp.createWriteStream(target);
          read.on('error', reject);
          write.on('error', reject);
          write.on('close', resolve);
          read.pipe(write);
        });
        uploaded.push(target);
      }
    } finally {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    }

    res.json({ ok: true, dest: destDir, uploaded });
  }),
);

registerOps(app, requireSession as express.RequestHandler, asyncRoute, upload);
registerArchive(app, requireSession as express.RequestHandler, asyncRoute);
registerNginx(app, requireSession as express.RequestHandler, asyncRoute, upload);
registerDotnet(app, requireSession as express.RequestHandler, asyncRoute, upload);
registerUsers(app, requireSession as express.RequestHandler, asyncRoute);
registerPostgres(app, requireSession as express.RequestHandler, asyncRoute);
registerPermissions(app, requireSession as express.RequestHandler, asyncRoute);
registerProcesses(app, requireSession as express.RequestHandler, asyncRoute);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api]', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: err.message || 'Internal error' });
});

const server = app.listen(PORT, () => {
  console.log(`SSH web API listening on http://localhost:${PORT}`);
});

registerTerminal(server, (key) => !ACCESS_KEY || keyMatches(key));
