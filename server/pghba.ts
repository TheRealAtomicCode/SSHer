// pg_hba.conf — who may log in to PostgreSQL, from where, and how — plus the list
// of PostgreSQL servers on the box, because "password authentication failed" is as
// often a client reaching the wrong server (a second cluster on 5433, a container
// on 5432) as it is a missing rule.
//
// Rules are read back through pg_hba_file_rules, which is PostgreSQL's own parse of
// the file on disk: it gives line numbers and flags lines it would reject. Every
// write is checked the same way BEFORE the reload — a file PostgreSQL can't parse is
// put back from the copy taken just before, so a typo here can never lock anyone out.
import type { Express, Response } from 'express';
import { badRequestRoute, need, port, run, runOrThrow, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { retargetPgTunnel } from './pgtunnel.js';
import { execAsPostgres, runPgJson, runPgSql } from './postgres.js';
import { exec, execWithInput, shellQuote, sudoPrefix, type SshSession } from './ssh.js';

const TYPES = ['host', 'hostssl', 'hostnossl', 'local'] as const;
const METHODS = ['scram-sha-256', 'md5', 'peer', 'trust', 'reject'] as const;
/** A database or user field: `all`, a keyword, or comma-separated names (a `+group` too). */
const NAME_LIST_RE = /^\+?[A-Za-z_][A-Za-z0-9_]*(,\+?[A-Za-z_][A-Za-z0-9_]*)*$/;
/** IPv4/IPv6 with an optional /prefix, or the words pg_hba accepts. */
const ADDRESS_RE = /^(all|samehost|samenet|[0-9.]+(\/\d{1,2})?|[0-9A-Fa-f:]+(\/\d{1,3})?)$/;

interface HbaRule {
  file_name: string | null;
  line_number: number | null;
  type: string | null;
  database: string[] | null;
  user_name: string[] | null;
  address: string | null;
  netmask: string | null;
  auth_method: string | null;
  error: string | null;
}

async function hbaFile(session: SshSession): Promise<string> {
  return (await runPgSql(session, 'SHOW hba_file;')).trim();
}

async function readHba(session: SshSession, path: string): Promise<string> {
  const result = await execAsPostgres(session, `cat ${shellQuote(path)}`);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
  return result.stdout;
}

/** Written as postgres, who owns the file — the mode and owner stay as they were. */
async function writeHba(session: SshSession, path: string, content: string): Promise<void> {
  const prefix = session.username === 'postgres' ? '' : `${sudoPrefix(session, '-u postgres')} `;
  const result = await execWithInput(session, `${prefix}tee ${shellQuote(path)} >/dev/null`, content);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `could not write ${path}`);
}

async function rules(session: SshSession): Promise<HbaRule[]> {
  return runPgJson<HbaRule[]>(
    session,
    `SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.line_number), '[]'::json) FROM (
       SELECT file_name, line_number, type, database, user_name, address, netmask, auth_method, error FROM pg_hba_file_rules
     ) r;`,
  );
}

/** Rules from the main file only — an `include`d file's line numbers aren't ours to edit. */
async function mainRules(session: SshSession, path: string): Promise<HbaRule[]> {
  return (await rules(session)).filter((r) => !r.file_name || r.file_name === path);
}

/** Swaps in `next`, checks PostgreSQL can parse it, then reloads — or restores. */
async function replaceHba(session: SshSession, path: string, next: string): Promise<void> {
  const previous = await readHba(session, path);
  await writeHba(session, `${path}.ssher-bak`, previous);
  await writeHba(session, path, next);
  const broken = (await rules(session)).filter((r) => r.error);
  if (broken.length) {
    await writeHba(session, path, previous);
    throw new Error(`PostgreSQL would reject that (line ${broken[0].line_number}: ${broken[0].error}) — nothing was changed.`);
  }
  await runPgSql(session, 'SELECT pg_reload_conf();');
}

/** Every PostgreSQL on the server: Debian's clusters, and containers publishing 5432. */
async function servers(session: SshSession): Promise<{ clusters: Cluster[]; containers: string[] }> {
  const ls = await execAsPostgres(session, 'pg_lsclusters --no-header 2>/dev/null || true');
  const clusters = ls.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 4 && /^\d+$/.test(f[2]))
    .map(([version, name, port, status]) => ({ version, name, port: Number(port), online: status.startsWith('online') }));
  const docker = await run(session, `docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || true`).catch(() => null);
  const containers = (docker?.stdout ?? '')
    .split('\n')
    .filter((line) => /postgres|:543\d->|->543\d/i.test(line))
    .map((line) => line.trim());
  return { clusters, containers };
}

interface Cluster {
  version: string;
  name: string;
  port: number;
  online: boolean;
}

/** Docker's private range: where a container's host.docker.internal connection comes from. */
const DOCKER_RANGE = '172.16.0.0/12';
const UFW_COMMENT = 'ssher: postgres from docker';

/** Whether ufw is on, and whether it lets containers through to `pgPort`. With ufw's
 *  default-deny, a container's connection to the host is dropped like any other
 *  incoming one — pg_hba and listen_addresses can be perfect and it still times out. */
async function firewall(session: SshSession, pgPort: number): Promise<{ active: boolean; containersAllowed: boolean }> {
  const status = await run(session, 'command -v ufw >/dev/null && ufw status 2>/dev/null || true', true);
  const active = /Status:\s+active/i.test(status.stdout);
  const containersAllowed = status.stdout
    .split('\n')
    .some((l) => new RegExp(`^${pgPort}(/tcp)?\\s+ALLOW(\\s+IN)?\\s+172\\.16\\.0\\.0/12\\b`).test(l.trim()));
  return { active, containersAllowed };
}

async function allowContainersThroughFirewall(session: SshSession, pgPort: number): Promise<string> {
  return runOrThrow(session, `ufw allow from ${DOCKER_RANGE} to any port ${pgPort} proto tcp comment '${UFW_COMMENT}' 2>&1`);
}

export function registerPgHba(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/postgres/hba',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [path, port, listen, list, found, docker] = await Promise.all([
        hbaFile(session),
        runPgSql(session, 'SHOW port;'),
        runPgSql(session, 'SHOW listen_addresses;'),
        rules(session),
        servers(session),
        exec(session, 'command -v docker >/dev/null 2>&1 && echo yes || true', true),
      ]);
      res.json({
        path,
        port: Number(port.trim()),
        listenAddresses: listen.trim(),
        hasDocker: docker.stdout.trim() === 'yes',
        firewall: await firewall(session, Number(port.trim())),
        rules: list,
        ...found,
      });
    }),
  );

  /** Lets containers through ufw to PostgreSQL — the step "Allow containers" was missing. */
  app.post(
    '/api/postgres/firewall-containers',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const pgPort = Number((await runPgSql(session, 'SHOW port;')).trim());
      res.json({ ok: true, output: await allowContainersThroughFirewall(session, pgPort) });
    }),
  );

  /**
   * Moves PostgreSQL to another port. The line that actually sets it is found through
   * pg_settings (postgresql.conf, a conf.d file, …) and rewritten there, because Debian's
   * psql wrapper and pg_lsclusters read the port from those files — an ALTER SYSTEM value
   * in postgresql.auto.conf would move the server but leave every `sudo -u postgres psql`,
   * including SSHer's own, knocking on the old port. A port set there is reset instead.
   *
   * Afterwards: a firewall rule letting containers in follows to the new port, an open
   * SSH tunnel is re-pointed, and if PostgreSQL won't come back up the old file is
   * restored and it is restarted again — so a bad choice can't leave it down.
   */
  app.post(
    '/api/postgres/port',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const next = port(req.body?.port, 'Port');
      const current = Number((await runPgSql(session, 'SHOW port;')).trim());
      if (next === current) {
        res.json({ ok: true, from: current, to: next, notes: ['Already on that port.'] });
        return;
      }
      const busy = await run(session, `ss -Htln | awk '{print $4}' | grep -Eq ':${next}$' && echo busy || true`, true);
      need(busy.stdout.trim() !== 'busy', `Port ${next} is already in use on this server`);

      const source = await runPgJson<{ file: string | null; line: number | null; config: string }>(
        session,
        `SELECT json_build_object('file', sourcefile, 'line', sourceline, 'config', current_setting('config_file')) FROM pg_settings WHERE name = 'port';`,
      );
      let file = source.file && !source.file.endsWith('postgresql.auto.conf') ? source.file : source.config;
      if (source.file?.endsWith('postgresql.auto.conf')) await runPgSql(session, 'ALTER SYSTEM RESET port;');
      need(/^\/[\w./-]+$/.test(file), 'Could not find the PostgreSQL config file');
      file = file.trim();
      const backup = `${file}.ssher-bak-port`;
      const line = source.file === file && source.line ? source.line : 0;
      const setting = `port = ${next}    # set by SSHer ${new Date().toISOString().slice(0, 10)} (was ${current})`;

      await runOrThrow(session, `cp -a '${file}' '${backup}'`);
      await runOrThrow(
        session,
        line
          ? `sed -i '${line}s/.*/${setting.replace(/[/&]/g, '\\$&')}/' '${file}'`
          : `printf '\\n%s\\n' '${setting}' >> '${file}'`,
      );

      const restart = await run(session, 'systemctl restart postgresql 2>&1 && sleep 2 && pg_lsclusters --no-header 2>/dev/null || true');
      const now = await runPgSql(session, 'SHOW port;').then((p) => Number(p.trim())).catch(() => 0);
      if (now !== next) {
        await run(session, `cp -a '${backup}' '${file}' && systemctl restart postgresql`);
        throw new Error(`PostgreSQL did not come back on ${next}, so the old config was restored:\n${(restart.stdout + restart.stderr).trim()}`);
      }

      const notes: string[] = [`PostgreSQL now listens on ${next} (was ${current}). Backup of the old config: ${backup}`];
      const fw = await firewall(session, current);
      if (fw.active && fw.containersAllowed) {
        await allowContainersThroughFirewall(session, next);
        notes.push(`Docker containers are allowed through ufw on ${next} too. The old ${current} rule is left in place; remove it on the Ports page.`);
      }
      retargetPgTunnel(session.id, next);
      notes.push(`Anything that connects on ${current} must be changed to ${next} — e.g. DB_PORT in a compose file — and restarted.`);
      res.json({ ok: true, from: current, to: next, notes });
    }),
  );

  /** Added ABOVE the existing rules: pg_hba is first-match, so a rule appended at
   *  the end would never be reached past Debian's own catch-alls. */
  app.post(
    '/api/postgres/hba/rules',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const type = str(req.body?.type);
      const database = str(req.body?.database) || 'all';
      const user = str(req.body?.user) || 'all';
      const address = str(req.body?.address);
      const method = str(req.body?.method);
      need((TYPES as readonly string[]).includes(type), 'Unknown connection type');
      need((METHODS as readonly string[]).includes(method), 'Unknown login method');
      need(NAME_LIST_RE.test(database), 'Database: "all", or names separated by commas');
      need(NAME_LIST_RE.test(user), 'User: "all", or names separated by commas');
      if (type !== 'local') need(ADDRESS_RE.test(address), 'Address: an IP with a /prefix (127.0.0.1/32), or "all"');

      const line = [type, database, user, ...(type === 'local' ? [] : [address]), method].join('\t');
      const path = await hbaFile(session);
      const lines = (await readHba(session, path)).split('\n');
      const firstRule = (await mainRules(session, path)).find((r) => r.line_number)?.line_number;
      const at = firstRule ? firstRule - 1 : lines.length;
      lines.splice(at, 0, `# added by SSHer ${new Date().toISOString().slice(0, 10)}`, line);
      await replaceHba(session, path, lines.join('\n'));
      res.json({ ok: true });
    }),
  );

  /** Where PostgreSQL accepts connections. Debian ships 'localhost', which a
   *  container can't reach: it comes in through the Docker bridge
   *  (host.docker.internal → 172.17.0.1). '*' is used rather than the bridge
   *  address because that address doesn't exist yet when PostgreSQL starts before
   *  Docker at boot, and a listen address that can't be bound stops it starting.
   *  Who gets in is still decided by pg_hba — and the firewall keeps the port shut
   *  from the internet. ALTER SYSTEM (postgresql.auto.conf) wins over
   *  postgresql.conf, and the change only applies on a restart. */
  app.post(
    '/api/postgres/listen',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const value = str(req.body?.value);
      need(/^(\*|localhost|[0-9A-Fa-f.:]+)(,\s*(\*|localhost|[0-9A-Fa-f.:]+))*$/.test(value), 'Addresses: "*", "localhost", or IPs separated by commas');
      await runPgSql(session, `ALTER SYSTEM SET listen_addresses = '${value.replace(/'/g, "''")}';`);
      const restart = await run(session, 'systemctl restart postgresql 2>&1');
      need(restart.code === 0, `Saved, but the restart failed: ${(restart.stdout + restart.stderr).trim()}`);
      res.json({ ok: true });
    }),
  );

  /** Commented out rather than deleted, so it can be seen and put back by hand. */
  app.post(
    '/api/postgres/hba/rules/:line/delete',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const lineNumber = Number(req.params.line);
      const path = await hbaFile(session);
      const known = (await mainRules(session, path)).some((r) => r.line_number === lineNumber);
      need(Number.isInteger(lineNumber) && known, 'That rule is no longer in the file — refresh');
      const lines = (await readHba(session, path)).split('\n');
      lines[lineNumber - 1] = `# removed by SSHer ${new Date().toISOString().slice(0, 10)}: ${lines[lineNumber - 1]}`;
      await replaceHba(session, path, lines.join('\n'));
      res.json({ ok: true });
    }),
  );
}
