// pgBackRest — install, configure WAL archiving + backup repos, run backups,
// and point-in-time restore. Always elevated (same bucket as users.ts/
// Docker/nginx): writing /etc/pgbackrest/pgbackrest.conf and postgresql.conf,
// and restarting services, needs root regardless of the File Explorer's
// sudo-mode toggle.
//
// pgBackRest (and WAL-based PITR generally) restores a whole PostgreSQL
// *cluster* — the entire data directory — to a point in time. There is no
// "restore just one database" with this tool; the write-ahead log doesn't
// work that way. The database picker this module's /context response
// supports on the client is for *context* when choosing a restore point
// (which database you care about, how active it's been), never a restore
// scope — /restore always acts on the whole cluster, and says so.
//
// A remote backup repo (repo2) is plain `ssh user@host` as far as pgBackRest
// is concerned — it needs that host to already trust an SSH key from this
// one. This module generates postgres's own keypair here if missing and
// hands back the public key; it does not open a second live connection to
// bootstrap trust on a server nobody has pointed this tool at — that is a
// separate, manual, one-line step the UI shows plainly instead of guessing at.
import type { Express, Response } from 'express';
import {
  badRequestRoute,
  need,
  run,
  runSteps,
  str,
  type AsyncRoute,
  type SessionRequest,
  type Step,
} from './ops.js';
import { execAsPostgres, runPgJson } from './postgres.js';
import { shellQuote, type SshSession } from './ssh.js';

const CONF_PATH = '/etc/pgbackrest/pgbackrest.conf';
const STANZA_RE = /^[A-Za-z0-9_-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;

// ------------------------------------------------------------------ helpers

/** `pgbackrest.conf` is small and ini-like — a line parser is simpler and
 *  more honest about what it does and doesn't handle than pulling in an ini
 *  library for one file. */
function parseIni(content: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = '';
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1];
      sections[current] ??= {};
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && current) sections[current][kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

interface BackupEntry {
  label: string;
  type: string;
  startTime: number;
  stopTime: number;
  sizeBytes: number;
}

/** `pgbackrest info --output=json`'s schema varies a little across versions —
 *  parsed defensively, degrading to an empty list rather than failing the
 *  whole page over a field that moved. */
function parseBackupInfo(json: string): { backups: BackupEntry[]; earliest: number | null; latest: number | null } {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { backups: [], earliest: null, latest: null };
  }
  const stanza = Array.isArray(data) ? (data[0] as Record<string, unknown>) : null;
  const rawBackups = Array.isArray(stanza?.backup) ? (stanza!.backup as Record<string, unknown>[]) : [];
  const backups: BackupEntry[] = rawBackups.map((b) => {
    const timestamp = (b.timestamp as Record<string, number>) ?? {};
    const info = (b.info as Record<string, unknown>) ?? {};
    return {
      label: String(b.label ?? ''),
      type: String(b.type ?? ''),
      startTime: (timestamp.start ?? 0) * 1000,
      stopTime: (timestamp.stop ?? 0) * 1000,
      sizeBytes: Number(info.size ?? 0),
    };
  });
  const starts = backups.map((b) => b.startTime).filter(Boolean);
  const stops = backups.map((b) => b.stopTime).filter(Boolean);
  return {
    backups,
    earliest: starts.length ? Math.min(...starts) : null,
    latest: stops.length ? Math.max(...stops) : null,
  };
}

async function getStanzaAndDataDir(session: SshSession): Promise<{ stanza: string; dataDir: string; configFile: string }> {
  const confRaw = await run(session, `cat ${shellQuote(CONF_PATH)} 2>/dev/null || true`);
  const sections = parseIni(confRaw.stdout);
  const stanza = Object.keys(sections).find((k) => k !== 'global') ?? '';
  const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`).catch(() => '');
  const configFile = await runPgJson<string>(session, `SELECT to_json(current_setting('config_file'));`).catch(() => '');
  return { stanza, dataDir, configFile };
}

/** Deletes any existing archive_mode/archive_command lines (commented out or
 *  not) and appends fresh ones — an in-place edit, not a full rewrite:
 *  postgresql.conf has far too much else in it to regenerate wholesale the
 *  way a fully SSHer-owned file (an nginx site, pgbackrest.conf itself) can be. */
function enableArchivingCommand(configFile: string, stanza: string): string {
  const archiveCmd = `pgbackrest --stanza=${stanza} archive-push %p`;
  const line1 = 'archive_mode = on';
  const line2 = `archive_command = '${archiveCmd}'`;
  return [
    `sed -i -E '/^#?archive_mode/d; /^#?archive_command/d' ${shellQuote(configFile)}`,
    `printf '%s\\n%s\\n' ${shellQuote(line1)} ${shellQuote(line2)} >> ${shellQuote(configFile)}`,
  ].join(' && ');
}

// ------------------------------------------------------------------- routes

export function registerPgBackRest(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/pgbackrest/context',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const installed = await run(session, 'command -v pgbackrest >/dev/null 2>&1 && echo yes || true');
      if (installed.stdout.trim() !== 'yes') {
        res.json({ installed: false, configured: false, stanza: '', dataDir: '', repo1: null, repo2: null, publicKey: null });
        return;
      }

      const confRaw = await run(session, `cat ${shellQuote(CONF_PATH)} 2>/dev/null || true`);
      const sections = parseIni(confRaw.stdout);
      const global = sections.global ?? {};
      const stanza = Object.keys(sections).find((k) => k !== 'global') ?? '';
      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`).catch(() => '');
      const keyCheck = await execAsPostgres(session, 'cat ~/.ssh/id_ed25519.pub 2>/dev/null || true');

      res.json({
        installed: true,
        configured: Boolean(stanza),
        stanza: stanza || 'main',
        dataDir,
        repo1: global['repo1-path'] ? { path: global['repo1-path'] } : null,
        repo2: global['repo2-host']
          ? { host: global['repo2-host'], user: global['repo2-host-user'] ?? '', path: global['repo2-path'] ?? '' }
          : null,
        publicKey: keyCheck.stdout.trim() || null,
      });
    }),
  );

  app.post(
    '/api/pgbackrest/install',
    requireSession,
    route(async (req, res) => {
      const steps: Step[] = [
        { title: 'Update package lists', command: 'apt-get update 2>&1' },
        { title: 'Install pgBackRest', command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y pgbackrest 2>&1' },
      ];
      const { log, ok } = await runSteps(req.session!, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** postgres's own keypair, for trusting it on a remote repo host — the one
   *  manual step (adding the returned public key to that host) is never done
   *  from here, see the note at the top of this file. */
  app.post(
    '/api/pgbackrest/ssh-key',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const gen = await execAsPostgres(
        session,
        `sh -c "[ -f ~/.ssh/id_ed25519 ] || (mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -q)"`,
      );
      need(gen.code === 0, (gen.stderr || gen.stdout).trim() || 'Could not generate a keypair');
      const pub = await execAsPostgres(session, 'cat ~/.ssh/id_ed25519.pub');
      need(pub.code === 0, 'Keypair generated but the public key could not be read back');
      res.json({ publicKey: pub.stdout.trim() });
    }),
  );

  app.post(
    '/api/pgbackrest/configure',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const stanza = str(req.body?.stanza) || 'main';
      need(STANZA_RE.test(stanza), 'Invalid stanza name');
      const repo1Path = str(req.body?.repo1Path) || '/var/lib/pgbackrest';
      need(/^\/[^\0\n\r"'`$\\]*$/.test(repo1Path), 'repo1 path must be absolute');

      const remote = req.body?.remote as { host?: string; port?: number; user?: string; path?: string } | undefined;
      let remoteHost = '';
      let remoteUser = '';
      let remotePath = '';
      let remotePort = 22;
      if (remote?.host) {
        remoteHost = str(remote.host);
        remoteUser = str(remote.user) || 'postgres';
        remotePath = str(remote.path) || '/var/lib/pgbackrest';
        remotePort = Number(remote.port) || 22;
        need(HOST_RE.test(remoteHost), 'Invalid remote host');
        need(USER_RE.test(remoteUser), 'Invalid remote user');
        need(/^\/[^\0\n\r"'`$\\]*$/.test(remotePath), 'Remote repo path must be absolute');
      }

      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`);
      need(dataDir, 'Could not determine the PostgreSQL data directory — is PostgreSQL running?');
      const configFile = await runPgJson<string>(session, `SELECT to_json(current_setting('config_file'));`);
      need(configFile, 'Could not determine postgresql.conf’s path');

      const confLines = ['[global]', `repo1-path=${repo1Path}`, 'repo1-retention-full=2'];
      if (remoteHost) {
        confLines.push('repo2-type=ssh', `repo2-host=${remoteHost}`, `repo2-host-user=${remoteUser}`, `repo2-path=${remotePath}`);
        if (remotePort !== 22) confLines.push(`repo2-host-port=${remotePort}`);
      }
      confLines.push('', `[${stanza}]`, `pg1-path=${dataDir}`);
      const confContent = `${confLines.join('\n')}\n`;

      const steps: Step[] = [
        {
          title: `Write ${CONF_PATH}`,
          command: `mkdir -p /etc/pgbackrest && tee ${shellQuote(CONF_PATH)} >/dev/null`,
          file: { path: CONF_PATH, content: confContent },
        },
        {
          title: `Create the local repo directory (${repo1Path})`,
          command: `mkdir -p ${shellQuote(repo1Path)} && chown postgres:postgres ${shellQuote(repo1Path)}`,
        },
        { title: 'Enable WAL archiving in postgresql.conf', command: enableArchivingCommand(configFile, stanza) },
        { title: 'Restart PostgreSQL', command: 'systemctl restart postgresql 2>&1' },
      ];
      const { log, ok } = await runSteps(session, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }

      const create = await execAsPostgres(session, `pgbackrest --stanza=${stanza} stanza-create 2>&1`);
      log.push({ title: `Create the stanza (${stanza})`, ok: create.code === 0, output: (create.stdout + create.stderr).trim() });
      if (create.code !== 0) {
        res.status(500).json({ error: `Create the stanza (${stanza}) failed`, log });
        return;
      }

      res.json({ ok: true, log });
    }),
  );

  app.post(
    '/api/pgbackrest/backup',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const { stanza } = await getStanzaAndDataDir(session);
      need(stanza, 'pgBackRest is not configured yet');
      const type = str(req.body?.type) || 'incr';
      need(['full', 'diff', 'incr'].includes(type), 'invalid backup type');
      const repo = Number(req.body?.repo) || 0;
      const repoArg = repo ? ` --repo=${repo}` : '';

      const result = await execAsPostgres(session, `pgbackrest --stanza=${stanza} --type=${type}${repoArg} backup 2>&1`);
      if (result.code !== 0) {
        res.status(500).json({ error: (result.stdout + result.stderr).trim() || 'Backup failed' });
        return;
      }
      res.json({ ok: true, output: result.stdout });
    }),
  );

  app.get(
    '/api/pgbackrest/backups',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const { stanza } = await getStanzaAndDataDir(session);
      if (!stanza) {
        res.json({ backups: [], earliest: null, latest: null });
        return;
      }
      const result = await execAsPostgres(session, `pgbackrest --stanza=${stanza} info --output=json 2>&1`);
      res.json(parseBackupInfo(result.stdout));
    }),
  );

  /** The single most destructive thing in this app: the data directory's
   *  current contents are gone the moment this starts. Refuses without an
   *  explicit confirm — a second gate behind whatever the client already
   *  showed, not trusting the UI alone to have asked. */
  app.post(
    '/api/pgbackrest/restore',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      need(req.body?.confirm === true, 'This restore was not confirmed');
      const { stanza } = await getStanzaAndDataDir(session);
      need(stanza, 'pgBackRest is not configured yet');
      const targetTime = str(req.body?.targetTime);
      need(targetTime, 'A restore point is required');
      // A loose shape check only — pgbackrest itself is the authority on
      // whether this is a real, restorable instant.
      need(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(targetTime), 'Invalid restore point');
      const repo = Number(req.body?.repo) || 0;
      const repoArg = repo ? ` --repo=${repo}` : '';

      const steps: Step[] = [{ title: 'Stop PostgreSQL', command: 'systemctl stop postgresql 2>&1' }];
      const { log: stopLog, ok: stopOk } = await runSteps(session, steps);
      if (!stopOk) {
        res.status(500).json({ error: `${stopLog.at(-1)!.title} failed`, log: stopLog });
        return;
      }

      const restore = await execAsPostgres(
        session,
        `pgbackrest --stanza=${stanza} --type=time --target=${shellQuote(targetTime)} --delta${repoArg} restore 2>&1`,
      );
      const restoreStep = { title: `Restore to ${targetTime}`, ok: restore.code === 0, output: (restore.stdout + restore.stderr).trim() };
      const log = [...stopLog, restoreStep];
      if (restore.code !== 0) {
        // The server is stopped either way at this point — leaving it down
        // on a failed restore is safer than starting it against a
        // half-restored data directory.
        res.status(500).json({ error: `${restoreStep.title} failed — PostgreSQL is left stopped`, log });
        return;
      }

      const { log: startLog, ok: startOk } = await runSteps(session, [{ title: 'Start PostgreSQL', command: 'systemctl start postgresql 2>&1' }]);
      log.push(...startLog);
      if (!startOk) {
        res.status(500).json({ error: `${startLog.at(-1)!.title} failed`, log });
        return;
      }

      res.json({ ok: true, log });
    }),
  );
}
