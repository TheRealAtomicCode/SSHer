// System users, groups, and per-user sudo access. Everything here needs root
// (listing requires `passwd -S` on other accounts, writing touches /etc/group and
// /etc/sudoers.d) so, unlike the File Explorer, this always runs through ops.ts's
// sudo-wrapped run()/runOrThrow() rather than the sudo-mode toggle — same bucket as
// Docker/nginx/.NET/ufw, which are also always elevated.
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { asRoot, badRequestRoute, need, run, runOrThrow, str, writeRemote, type AsyncRoute, type SessionRequest } from './ops.js';
import { execWithInput, shellQuote, type SshSession } from './ssh.js';

// A service account's shell is usually nologin/false — this is the signal the
// client uses to collapse those into their own section rather than hiding them,
// since an app's own account (www-data and the like) is exactly this kind.
const NOLOGIN_SHELL = /\/(nologin|false)$/;
const USERNAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;

export interface SystemUser {
  name: string;
  uid: number;
  gid: number;
  comment: string;
  home: string;
  shell: string;
  groups: string[];
  canLogin: boolean;
  locked: boolean;
  hasPassword: boolean;
  sudoGroup: boolean;
  sudoFile: boolean;
}

export interface SystemGroup {
  name: string;
  gid: number;
  members: string[];
}

export async function listSystemUsers(session: SshSession): Promise<{ users: SystemUser[]; groups: SystemGroup[] }> {
  const script = `
echo '===PASSWD==='
cat /etc/passwd
echo '===GROUP==='
cat /etc/group
echo '===STATUS==='
while IFS=: read -r name _; do
  [ -z "$name" ] && continue
  st=$(passwd -S -- "$name" 2>/dev/null | awk '{print $2}')
  sf=no
  [ -f "/etc/sudoers.d/$name" ] && sf=yes
  echo "$name:\${st:-unknown}:$sf"
done < /etc/passwd
`;
  const out = await runOrThrow(session, script);
  const [passwdPart, afterPasswd] = out.split('===GROUP===');
  const [groupPart, statusPart] = afterPasswd.split('===STATUS===');

  const groups: SystemGroup[] = groupPart
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, , gidStr, members] = line.split(':');
      return { name, gid: Number(gidStr), members: members ? members.split(',').filter(Boolean) : [] };
    });
  const groupByGid = new Map(groups.map((g) => [g.gid, g]));
  const memberOf = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const m of g.members) {
      if (!memberOf.has(m)) memberOf.set(m, new Set());
      memberOf.get(m)!.add(g.name);
    }
  }

  const status = new Map<string, { state: string; sudoFile: boolean }>();
  for (const line of statusPart.trim().split('\n').filter(Boolean)) {
    const [name, state, sf] = line.split(':');
    status.set(name, { state, sudoFile: sf === 'yes' });
  }

  const users: SystemUser[] = passwdPart
    .replace('===PASSWD===', '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, , uidStr, gidStr, comment, home, shell] = line.split(':');
      const uid = Number(uidStr);
      const gid = Number(gidStr);
      const primary = groupByGid.get(gid)?.name;
      const supplementary = [...(memberOf.get(name) ?? [])];
      const allGroups = [...new Set([primary, ...supplementary].filter((g): g is string => Boolean(g)))];
      const st = status.get(name);
      return {
        name,
        uid,
        gid,
        comment,
        home,
        shell,
        groups: allGroups,
        canLogin: !NOLOGIN_SHELL.test(shell),
        locked: st?.state === 'L',
        hasPassword: st?.state === 'P',
        sudoGroup: allGroups.includes('sudo') || allGroups.includes('wheel'),
        sudoFile: st?.sudoFile ?? false,
      };
    });

  return { users, groups };
}

/** Writes a sudoers rule only after `visudo -c` accepts it — never touches the real
 *  file otherwise. The staging name starts with a dot: Debian's sudoers already
 *  reads `#includedir /etc/sudoers.d` and (by the same convention dpkg itself relies
 *  on for its own .dpkg-new/.dpkg-old temp files) skips any name containing a dot,
 *  so even a crash between writing and validating leaves nothing sudo would ever
 *  actually honor. */
async function writeSudoersDropIn(session: SshSession, file: string, content: string): Promise<void> {
  const tmp = `/etc/sudoers.d/.sshertmp-${randomUUID()}`;
  try {
    await writeRemote(session, tmp, content);
    await runOrThrow(session, `chmod 0440 ${shellQuote(tmp)}`);
    const check = await run(session, `visudo -c -f ${shellQuote(tmp)} 2>&1`);
    if (check.code !== 0) {
      throw new Error(`Invalid sudoers rule, nothing was changed:\n${(check.stdout + check.stderr).trim()}`);
    }
    await runOrThrow(session, `mv -f ${shellQuote(tmp)} ${shellQuote(file)}`);
  } finally {
    await run(session, `rm -f ${shellQuote(tmp)}`).catch(() => {});
  }
}

export function registerUsers(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/users',
    requireSession,
    route(async (req, res) => {
      res.json(await listSystemUsers(req.session!));
    }),
  );

  app.post(
    '/api/users',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const name = str(req.body?.name);
      need(USERNAME_RE.test(name), 'Username must be lowercase letters, digits, - or _, starting with a letter or underscore');

      const systemAccount = Boolean(req.body?.systemAccount);
      const createHome = req.body?.createHome !== false;
      const shell = str(req.body?.shell) || (systemAccount ? '/usr/sbin/nologin' : '/bin/bash');
      need(/^\/[\w./-]+$/.test(shell), 'Invalid shell path');
      const groups = (Array.isArray(req.body?.groups) ? req.body.groups : []).map(String).filter(Boolean);
      for (const g of groups) need(USERNAME_RE.test(g), `Invalid group: ${g}`);

      const args = ['useradd', createHome ? '-m' : '-M'];
      if (systemAccount) args.push('-r');
      args.push('-s', shellQuote(shell));
      if (groups.length) args.push('-G', shellQuote(groups.join(',')));
      args.push('--', shellQuote(name));
      await runOrThrow(session, args.join(' '));

      const password = str(req.body?.password);
      if (password) {
        need(!/[\r\n]/.test(password), 'Password cannot contain a line break');
        const result = await execWithInput(session, asRoot(session, 'chpasswd'), `${name}:${password}\n`);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not set the password');
      }

      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/users/:name/delete',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const name = str(req.params.name);
      need(USERNAME_RE.test(name), 'invalid username');
      need(name !== session.username, "You can't delete the account you're connected as.");
      need(name !== 'root', 'Refusing to delete root.');

      const removeHome = Boolean(req.body?.removeHome);
      const output = await runOrThrow(session, `userdel ${removeHome ? '-r ' : ''}-- ${shellQuote(name)} 2>&1`);
      res.json({ ok: true, output });
    }),
  );

  app.post(
    '/api/users/:name/sudo',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const name = str(req.params.name);
      need(USERNAME_RE.test(name), 'invalid username');
      need(
        name !== session.username || req.body?.confirmSelf === true,
        'That is the account you are connected as. Changing its sudo access could lock you out of fixing it over SSH — confirm you understand before proceeding.',
      );

      const file = `/etc/sudoers.d/${name}`;

      if (req.body?.removeAll) {
        await run(session, `gpasswd -d ${shellQuote(name)} sudo >/dev/null 2>&1; rm -f ${shellQuote(file)}; true`);
        res.json({ ok: true });
        return;
      }

      if (typeof req.body?.group === 'boolean') {
        const cmd = req.body.group
          ? `usermod -aG sudo ${shellQuote(name)}`
          : `gpasswd -d ${shellQuote(name)} sudo 2>&1 || true`;
        await runOrThrow(session, cmd);
      }

      if (typeof req.body?.rule === 'string' && req.body.rule.trim()) {
        await writeSudoersDropIn(session, file, `${req.body.rule.trim()}\n`);
      } else if (req.body?.passwordless === true) {
        await writeSudoersDropIn(session, file, `${name} ALL=(ALL) NOPASSWD:ALL\n`);
      } else if (req.body?.passwordless === false) {
        await runOrThrow(session, `rm -f ${shellQuote(file)}`);
      }

      res.json({ ok: true });
    }),
  );
}
