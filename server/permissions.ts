// File ownership/mode and POSIX ACLs for the File Explorer's "Permissions…" dialog.
// Same privilege model as the rest of File Explorer: unprivileged by default, the
// sudo-mode toggle opts a request into running as root (execMaybeRoot/
// execMaybeRootOrThrow from ops.ts) — changing another user's files, or files you
// don't own, generally needs it.
import type { Express, Response } from 'express';
import { badRequestRoute, execMaybeRoot, execMaybeRootOrThrow, need, RE, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { shellQuote } from './ssh.js';

const USERNAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

interface AclEntry {
  tag: string;
  name?: string;
  perms: string;
  default: boolean;
}

function parseAcl(output: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const isDefault = line.startsWith('default:');
    const rest = isDefault ? line.slice('default:'.length) : line;
    const parts = rest.split(':');
    if (parts.length < 2) continue;
    entries.push({ tag: parts[0], name: parts[1] || undefined, perms: parts[parts.length - 1], default: isDefault });
  }
  return entries;
}

function truthy(value: unknown): boolean {
  return value === true || value === '1' || value === 'true';
}

function validPaths(raw: unknown): string[] {
  const paths = (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
  need(paths.length > 0, 'No files selected');
  for (const p of paths) need(RE.absPath.test(p), `Invalid path: ${p}`);
  return paths;
}

export function registerPermissions(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/files/permissions',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const path = str(req.query.path);
      need(RE.absPath.test(path), 'invalid path');
      const sudo = truthy(req.query.sudo);

      const [info, aclSupport] = await Promise.all([
        execMaybeRoot(session, `stat -c '%U:%G:%a' -- ${shellQuote(path)}`, sudo),
        execMaybeRoot(session, 'command -v getfacl >/dev/null 2>&1 && echo yes || true', false),
      ]);
      need(info.code === 0, info.stderr.trim() || 'Could not read that path');
      const [owner, group, mode] = info.stdout.trim().split(':');

      let acl: AclEntry[] = [];
      const hasAcl = aclSupport.stdout.trim() === 'yes';
      if (hasAcl) {
        const out = await execMaybeRoot(session, `getfacl -p --omit-header -- ${shellQuote(path)} 2>/dev/null`, sudo);
        if (out.code === 0) acl = parseAcl(out.stdout);
      }
      res.json({ owner, group, mode, hasAcl, acl });
    }),
  );

  app.post(
    '/api/files/permissions',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const paths = validPaths(req.body?.paths);
      const sudo = truthy(req.body?.sudo);
      const recursive = truthy(req.body?.recursive) ? '-R' : '';
      const args = paths.map(shellQuote).join(' ');

      const owner = str(req.body?.owner);
      const group = str(req.body?.group);
      if (owner || group) {
        need(!owner || USERNAME_RE.test(owner), 'invalid owner');
        need(!group || USERNAME_RE.test(group), 'invalid group');
        const spec = owner && group ? `${owner}:${group}` : owner || `:${group}`;
        await execMaybeRootOrThrow(session, `chown ${recursive} -- ${shellQuote(spec)} ${args}`, sudo);
      }

      if (req.body?.mode !== undefined && req.body?.mode !== '') {
        const mode = String(req.body.mode);
        need(/^[0-7]{3,4}$/.test(mode), 'invalid mode — use octal like 644 or 0755');
        await execMaybeRootOrThrow(session, `chmod ${recursive} -- ${mode} ${args}`, sudo);
      }

      res.json({ ok: true });
    }),
  );

  /** `setfacl`: grants (or revokes) one user's access to a path without touching
   *  the existing owner — the direct answer to "give this app's service account
   *  read/write here" without a `chown`/`chmod 777` workaround. */
  app.post(
    '/api/files/acl',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const paths = validPaths(req.body?.paths);
      const user = str(req.body?.user);
      need(USERNAME_RE.test(user), 'invalid user');
      const sudo = truthy(req.body?.sudo);
      const recursive = truthy(req.body?.recursive) ? '-R' : '';
      const args = paths.map(shellQuote).join(' ');

      if (req.body?.remove) {
        await execMaybeRootOrThrow(session, `setfacl ${recursive} -x ${shellQuote(`u:${user}`)} -- ${args}`, sudo);
        res.json({ ok: true });
        return;
      }

      const perms = str(req.body?.perms).replace(/[^rwx]/g, '') || 'r';
      const spec = shellQuote(`u:${user}:${perms}`);
      const commands = [`setfacl ${recursive} -m ${spec} -- ${args}`];
      if (req.body?.alsoDefault) commands.push(`setfacl ${recursive} -d -m ${spec} -- ${args}`);
      await execMaybeRootOrThrow(session, commands.join(' && '), sudo);
      res.json({ ok: true });
    }),
  );
}
