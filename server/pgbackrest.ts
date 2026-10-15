// pgBackRest — install, configure WAL archiving + backup repos, run and schedule
// backups, and point-in-time restore ("rewind"). Always elevated (same bucket as
// users.ts/Docker/nginx): writing /etc/pgbackrest/pgbackrest.conf and
// postgresql.conf, and restarting services, needs root regardless of the File
// Explorer's sudo-mode toggle.
//
// How a rewind works, and why it has the limits it has:
//   * A rewind is "restore a full backup taken BEFORE the target time, then replay the
//     archived write-ahead log (WAL) up to that time". PostgreSQL keeps no undo history
//     of its own, so with no backup older than the target there is nothing to rewind
//     from — no matter how much WAL exists.
//   * The newest point you can reach is the newest WAL that has been archived. With
//     archive_timeout = 60 (set here), that is never more than about a minute ago; a
//     rewind also forces out the current segment first (pg_switch_wal) so "1 minute
//     ago" really is reachable.
//   * It rewinds the whole PostgreSQL *cluster* — every database on the server. WAL is
//     cluster-wide; there is no per-database replay.
//
// A remote backup repo (repo2) is plain `ssh user@host` as far as pgBackRest is
// concerned — it needs that host to already trust an SSH key from this one. This
// module generates postgres's own keypair here if missing and hands back the public
// key; it does not open a second live connection to bootstrap trust on a server
// nobody has pointed this tool at — that is a manual one-line step the UI shows.
import type { Express, Response } from 'express';
import {
  badRequestRoute,
  need,
  run,
  runSteps,
  str,
  writeRemote,
  type AsyncRoute,
  type SessionRequest,
  type Step,
} from './ops.js';
import { execAsPostgres, runPgJson } from './postgres.js';
import { shellQuote, type SshSession } from './ssh.js';

const CONF_PATH = '/etc/pgbackrest/pgbackrest.conf';
const CRON_PATH = '/etc/cron.d/ssher-pgbackrest';
const STANZA_RE = /^[A-Za-z0-9_-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const USER_RE = /^[a-z_][a-z0-9_-]*$/;
const PATH_RE = /^\/[^\0\n\r"'`$\\]*$/;
/** How often, at most, a WAL segment is shipped even when the database is quiet. */
const ARCHIVE_TIMEOUT = 60;

// ------------------------------------------------------------------ helpers

type Ini = Record<string, Record<string, string>>;

/** `pgbackrest.conf` is small and ini-like — a line parser is simpler and more honest
 *  about what it does and doesn't handle than pulling in an ini library for one file. */
function parseIni(content: string): Ini {
  const sections: Ini = {};
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

function writeIni(ini: Ini): string {
  const order = ['global', ...Object.keys(ini).filter((k) => k !== 'global')];
  const out = ['# Managed by SSHer (Backups page). Hand edits to keys it sets are overwritten.'];
  for (const name of order) {
    if (!ini[name]) continue;
    out.push('', `[${name}]`, ...Object.entries(ini[name]).map(([k, v]) => `${k}=${v}`));
  }
  return `${out.join('\n')}\n`;
}

async function readConf(session: SshSession): Promise<Ini> {
  const raw = await run(session, `cat ${shellQuote(CONF_PATH)} 2>/dev/null || true`);
  return parseIni(raw.stdout);
}

const stanzaOf = (ini: Ini) => Object.keys(ini).find((k) => k !== 'global') ?? '';

interface BackupEntry {
  label: string;
  type: string;
  startTime: number;
  stopTime: number;
  /** Size of the database when this backup was taken. */
  sizeBytes: number;
  /** What this backup itself occupies in the repo (compressed; only the changes, for diff/incr). */
  repoBytes: number;
}

interface StanzaInfo {
  /** pgBackRest's own status: 0 ok, 2 no backups yet — both mean the stanza exists. */
  statusCode: number | null;
  statusMessage: string;
  backups: BackupEntry[];
  /** Oldest instant a rewind can reach: when the oldest backup finished. */
  earliest: number | null;
  /** Newest WAL pgBackRest has in its archive, per its own info. */
  archiveMax: string | null;
}

/** `pgbackrest info --output=json`'s schema varies a little across versions — parsed
 *  defensively, degrading to "no info" rather than failing the whole page. */
function parseInfo(json: string): StanzaInfo {
  const empty: StanzaInfo = { statusCode: null, statusMessage: '', backups: [], earliest: null, archiveMax: null };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ...empty, statusMessage: json.trim().split('\n').at(-1) ?? '' };
  }
  const stanza = Array.isArray(data) ? (data[0] as Record<string, unknown>) : null;
  if (!stanza) return empty;
  const status = (stanza.status as { code?: number; message?: string }) ?? {};
  const rawBackups = Array.isArray(stanza.backup) ? (stanza.backup as Record<string, unknown>[]) : [];
  const backups: BackupEntry[] = rawBackups.map((b) => {
    const timestamp = (b.timestamp as Record<string, number>) ?? {};
    const info = (b.info as Record<string, unknown>) ?? {};
    const repo = (info.repository as Record<string, number>) ?? {};
    return {
      label: String(b.label ?? ''),
      type: String(b.type ?? ''),
      startTime: (timestamp.start ?? 0) * 1000,
      stopTime: (timestamp.stop ?? 0) * 1000,
      sizeBytes: Number(info.size ?? 0),
      repoBytes: Number(repo.delta ?? repo.size ?? 0),
    };
  });
  const stops = backups.map((b) => b.stopTime).filter(Boolean);
  const archives = Array.isArray(stanza.archive) ? (stanza.archive as Record<string, unknown>[]) : [];
  const archiveMax = archives.map((a) => String(a.max ?? '')).filter(Boolean).sort().at(-1) ?? null;
  return {
    statusCode: typeof status.code === 'number' ? status.code : null,
    statusMessage: status.message ?? '',
    backups,
    earliest: stops.length ? Math.min(...stops) : null,
    archiveMax,
  };
}

async function stanzaInfo(session: SshSession, stanza: string): Promise<StanzaInfo> {
  const result = await execAsPostgres(session, `pgbackrest --stanza=${stanza} info --output=json 2>&1`);
  return parseInfo(result.stdout);
}

interface Archiving {
  mode: string;
  command: string;
  timeout: string;
  walLevel: string;
  /** archive_command points at this stanza's pgbackrest archive-push. */
  usesPgBackRest: boolean;
  archivedCount: number;
  lastArchivedWal: string | null;
  lastArchivedTime: string | null;
  failedCount: number;
  lastFailedWal: string | null;
  lastFailedTime: string | null;
}

async function archiving(session: SshSession, stanza: string): Promise<Archiving | null> {
  const row = await runPgJson<Record<string, unknown>>(
    session,
    `SELECT row_to_json(a) FROM (
       SELECT current_setting('archive_mode') AS mode,
              current_setting('archive_command') AS command,
              current_setting('archive_timeout') AS timeout,
              current_setting('wal_level') AS wal_level,
              archived_count, last_archived_wal, last_archived_time,
              failed_count, last_failed_wal, last_failed_time
       FROM pg_stat_archiver
     ) a;`,
  ).catch(() => null);
  if (!row || Array.isArray(row)) return null;
  const command = String(row.command ?? '');
  return {
    mode: String(row.mode ?? ''),
    command,
    timeout: String(row.timeout ?? ''),
    walLevel: String(row.wal_level ?? ''),
    usesPgBackRest: Boolean(stanza) && command.includes(`--stanza=${stanza}`) && command.includes('archive-push'),
    archivedCount: Number(row.archived_count ?? 0),
    lastArchivedWal: (row.last_archived_wal as string) ?? null,
    lastArchivedTime: (row.last_archived_time as string) ?? null,
    failedCount: Number(row.failed_count ?? 0),
    lastFailedWal: (row.last_failed_wal as string) ?? null,
    lastFailedTime: (row.last_failed_time as string) ?? null,
  };
}

/** Deletes any existing archive_mode/archive_command/archive_timeout lines (commented out
 *  or not) and appends fresh ones — an in-place edit, not a full rewrite: postgresql.conf
 *  has far too much else in it to regenerate wholesale. */
function enableArchivingCommand(configFile: string, stanza: string, walLevelMinimal: boolean): string {
  const lines = [
    '# --- WAL archiving for pgBackRest (managed by SSHer) ---',
    'archive_mode = on',
    `archive_command = 'pgbackrest --stanza=${stanza} archive-push %p'`,
    // Ships a WAL segment at least this often even when the database is quiet, so the
    // newest point you can rewind to is never more than about a minute old.
    `archive_timeout = ${ARCHIVE_TIMEOUT}`,
  ];
  if (walLevelMinimal) lines.push('wal_level = replica');
  const removeKeys = ['archive_mode', 'archive_command', 'archive_timeout', ...(walLevelMinimal ? ['wal_level'] : [])];
  const sed = removeKeys.map((k) => `/^[[:space:]]*#?[[:space:]]*${k}[[:space:]]*=/d`).join('; ');
  return [
    `sed -i -E '/^# --- WAL archiving for pgBackRest/d; ${sed}' ${shellQuote(configFile)}`,
    `printf '%s\\n' ${lines.map(shellQuote).join(' ')} >> ${shellQuote(configFile)}`,
  ].join(' && ');
}

interface Schedule {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday: the day of the weekly full backup. */
  fullDay: number;
  /** Hour (server time) both the full and the daily differential run. */
  hour: number;
}

function cronFile(stanza: string, s: Schedule): string {
  const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== s.fullDay).join(',');
  return [
    '# Managed by SSHer (Backups page): pgBackRest schedule.',
    '# A weekly full backup and a differential every other day. Old backups beyond the',
    '# retention window are expired automatically after each backup.',
    'SHELL=/bin/sh',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `0 ${s.hour} * * ${s.fullDay} postgres pgbackrest --stanza=${stanza} --type=full backup`,
    `0 ${s.hour} * * ${others} postgres pgbackrest --stanza=${stanza} --type=diff backup`,
    '',
  ].join('\n');
}

function parseCron(content: string): Schedule | null {
  const full = /^0 (\d{1,2}) \* \* (\d) postgres pgbackrest .*--type=full/m.exec(content);
  if (!full) return null;
  return { enabled: true, hour: Number(full[1]), fullDay: Number(full[2]) };
}

function retentionDays(ini: Ini): number | null {
  const g = ini.global ?? {};
  return g['repo1-retention-full-type'] === 'time' && g['repo1-retention-full'] ? Number(g['repo1-retention-full']) : null;
}

/** Bytes of each path that exists, via du — the repo is root/postgres-owned. */
async function duBytes(session: SshSession, paths: string[]): Promise<Record<string, number>> {
  const valid = paths.filter((p) => PATH_RE.test(p));
  if (!valid.length) return {};
  const out = await run(session, `du -sb ${valid.map(shellQuote).join(' ')} 2>/dev/null || true`);
  const sizes: Record<string, number> = {};
  for (const line of out.stdout.split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (m) sizes[m[2]] = Number(m[1]);
  }
  return sizes;
}

/** Free space of the filesystems holding each path (deduplicated by mount). */
async function diskFor(session: SshSession, paths: string[]) {
  const valid = paths.filter((p) => PATH_RE.test(p));
  if (!valid.length) return [];
  const out = await run(session, `df -B1 --output=target,size,used,avail ${valid.map(shellQuote).join(' ')} 2>/dev/null | tail -n +2`);
  const seen = new Map<string, { mount: string; size: number; used: number; avail: number; holds: string[] }>();
  out.stdout
    .split('\n')
    .filter(Boolean)
    .forEach((line, i) => {
      const [mount, size, used, avail] = line.trim().split(/\s+/);
      const entry = seen.get(mount) ?? { mount, size: Number(size), used: Number(used), avail: Number(avail), holds: [] };
      if (valid[i]) entry.holds.push(valid[i]);
      seen.set(mount, entry);
    });
  return [...seen.values()];
}

/** On Debian/Ubuntu `postgresql.service` is only an umbrella; the database itself runs as
 *  `postgresql@15-main` and so on. Stopping the umbrella returns before the cluster has
 *  actually shut down, so wait for postmaster.pid to go — pgBackRest refuses to restore
 *  while it exists. The glob matches nothing on distros with a single real unit. */
function stopPostgres(dataDir: string): string {
  return [
    `systemctl stop postgresql 'postgresql@*' 2>&1`,
    `for i in $(seq 1 90); do [ -e ${shellQuote(`${dataDir}/postmaster.pid`)} ] || { echo stopped; exit 0; }; sleep 1; done`,
    `echo "PostgreSQL did not stop within 90 s" >&2; exit 1`,
  ].join('; ');
}

/** `systemctl start` doesn't take globs, so name the cluster units explicitly. */
function startPostgres(): string {
  return `systemctl start postgresql $(systemctl list-units --all --plain --no-legend 'postgresql@*' | awk '{print $1}') 2>&1 && echo started`;
}

/** "X/Y" pg_lsn minus one byte, done here rather than in SQL (pg_lsn - numeric is PG14+). */
function lsnMinusOne(lsn: string): string {
  const [hi, lo] = lsn.split('/');
  const n = ((BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`)) - 1n;
  return `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;
}

/** Forces out the WAL segment being written now and waits for it to be archived, so
 *  the moments just before a rewind are actually in the archive.
 *
 *  It first commits one empty transaction (txid_current() assigns an xid, so its commit
 *  is a real, timestamped commit record). A time target is only "reached" when replay
 *  meets a commit made after it — on a quiet database there may be none, and PostgreSQL
 *  then refuses to start ("recovery ended before configured recovery target was
 *  reached"). This one guarantees every target before now has a commit after it, on
 *  this timeline, for this rewind and any later one that comes back to it. It also
 *  means pg_switch_wal() always has something to switch: on an idle segment it's a
 *  no-op. */
async function flushWal(session: SshSession): Promise<{ ok: boolean; output: string }> {
  const switched = await runPgJson<string>(session, `SELECT txid_current(); SELECT to_json(pg_switch_wal()::text);`).catch(() => '');
  if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(switched)) return { ok: false, output: 'Could not switch WAL (is PostgreSQL running?)' };
  // pg_switch_wal() returns the end of its switch record, plus one. When there was
  // nothing to switch it returns the current position instead — the first byte of a
  // segment that isn't finished, so waiting on *that* name stalls until archive_timeout
  // (or forever, if idle). The byte before it is always in a finished segment.
  const segment = await runPgJson<string>(session, `SELECT to_json(pg_walfile_name('${lsnMinusOne(switched)}'));`).catch(() => '');
  if (!/^[0-9A-F]{24}$/.test(segment)) return { ok: false, output: 'Could not work out which WAL segment was just closed' };
  for (let i = 0; i < 20; i++) {
    const row = await runPgJson<{ last: string | null; done: boolean }>(
      session,
      `SELECT json_build_object(
         'last', (SELECT last_archived_wal FROM pg_stat_archiver),
         'done', (pg_stat_file('pg_wal/archive_status/${segment}.done', true)).size IS NOT NULL);`,
    ).catch(() => null);
    // .done is the archiver's own receipt for this exact file. The name check covers a
    // checkpoint having already recycled it: same-timeline names sort in order, and
    // last_archived_wal can also be a "…history" / "….partial" file, which doesn't count.
    const last = row?.last ?? '';
    const later = /^[0-9A-F]{24}$/.test(last) && last.slice(0, 8) === segment.slice(0, 8) && last >= segment;
    if (row?.done || later) return { ok: true, output: `archived ${segment}` };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, output: `WAL segment ${segment} was not archived within 30 s — check archive_command and the Backups page's archiving status` };
}

/** Which timeline was live at `targetMs` — the one a rewind to that moment must follow.
 *
 *  Every rewind forks a new timeline (2, 3, …), and PostgreSQL's default is to replay
 *  along the *newest* one. After one rewind, the newest timeline is the rewound one,
 *  which jumps straight from the old target to "now" — so a second rewind to a time in
 *  between either lands on the wrong data or, when that branch has no commit after the
 *  target, refuses to start at all ("recovery ended before configured recovery target
 *  was reached"). A timeline's .history file is archived the moment it is created, so
 *  the live timeline at T is the newest one whose history file is no newer than T.
 *  'current' (the backup's own timeline) when none was created before T yet; null when
 *  the archive can't be listed, leaving pgBackRest's default. */
async function timelineAt(session: SshSession, stanza: string, targetMs: number, repoArg: string): Promise<string | null> {
  const info = await execAsPostgres(session, `pgbackrest --stanza=${stanza}${repoArg} info --output=json 2>/dev/null`);
  let archiveId = '';
  try {
    const archives = (JSON.parse(info.stdout)[0]?.archive ?? []) as { id?: string }[];
    archiveId = String(archives.at(-1)?.id ?? '');
  } catch {
    return null;
  }
  if (!/^[0-9]+-[0-9]+$/.test(archiveId)) return null;
  const ls = await execAsPostgres(
    session,
    `pgbackrest --stanza=${stanza}${repoArg} repo-ls --output=json --filter=${shellQuote('\\.history$')} archive/${stanza}/${archiveId} 2>/dev/null`,
  );
  let files: Record<string, { time?: number }>;
  try {
    files = JSON.parse(ls.stdout);
  } catch {
    return null;
  }
  let best = 0;
  for (const [name, f] of Object.entries(files)) {
    const m = /^([0-9A-F]{8})\.history$/.exec(name);
    if (m && typeof f.time === 'number' && f.time * 1000 <= targetMs) best = Math.max(best, parseInt(m[1], 16));
  }
  return best ? String(best) : 'current';
}

/** The tail of PostgreSQL's own log — `systemctl start` only says "failed", the reason is here. */
async function postgresLogTail(session: SshSession): Promise<string> {
  const out = await run(
    session,
    `{ journalctl -u 'postgresql*' -n 40 --no-pager -o cat 2>/dev/null; tail -n 40 /var/log/postgresql/postgresql-*.log 2>/dev/null; } | tail -n 60`,
  ).catch(() => null);
  return out?.stdout.trim() ?? '';
}

// ------------------------------------------------------------------- routes

export function registerPgBackRest(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  /** Everything the page needs to know about the setup's health, in one call. */
  app.get(
    '/api/pgbackrest/context',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const installed = await run(session, 'command -v pgbackrest >/dev/null 2>&1 && echo yes || true');
      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`).catch(() => '');
      if (installed.stdout.trim() !== 'yes') {
        res.json({ installed: false, configured: false, stanza: 'main', dataDir, repo1: null, repo2: null, publicKey: null });
        return;
      }

      const ini = await readConf(session);
      const global = ini.global ?? {};
      const stanza = stanzaOf(ini);
      const [keyCheck, info, arch, cron] = await Promise.all([
        execAsPostgres(session, 'cat ~/.ssh/id_ed25519.pub 2>/dev/null || true'),
        stanza ? stanzaInfo(session, stanza) : Promise.resolve(null),
        archiving(session, stanza),
        run(session, `cat ${shellQuote(CRON_PATH)} 2>/dev/null || true`),
      ]);

      // Status 0 = ok, 2 = no backups yet: the stanza exists either way. Anything else
      // ("missing stanza path", …) means setup stopped part-way.
      const stanzaReady = info?.statusCode === 0 || info?.statusCode === 2;
      res.json({
        installed: true,
        configured: Boolean(stanza),
        stanzaReady,
        stanzaStatus: info?.statusMessage ?? '',
        stanza: stanza || 'main',
        dataDir,
        repo1: global['repo1-path'] ? { path: global['repo1-path'] } : null,
        repo2: global['repo2-host']
          ? { host: global['repo2-host'], user: global['repo2-host-user'] ?? '', path: global['repo2-path'] ?? '' }
          : null,
        publicKey: keyCheck.stdout.trim() || null,
        archiving: arch,
        retentionDays: retentionDays(ini),
        retentionCount: global['repo1-retention-full-type'] !== 'time' && global['repo1-retention-full'] ? Number(global['repo1-retention-full']) : null,
        schedule: parseCron(cron.stdout) ?? { enabled: false, fullDay: 0, hour: 2 },
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

  /** postgres's own keypair, for trusting it on a remote repo host — the one manual step
   *  (adding the returned public key to that host) is never done from here. */
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

  /** Creates the stanza and proves archiving works end to end. Shared by first-time
   *  setup and "finish setup" for a stanza that exists only in the config file. */
  async function createAndCheck(session: SshSession, stanza: string, log: { title: string; ok: boolean; output: string }[]) {
    const create = await execAsPostgres(session, `pgbackrest --stanza=${stanza} stanza-create 2>&1`);
    log.push({ title: `Create the stanza (${stanza})`, ok: create.code === 0, output: (create.stdout + create.stderr).trim() });
    if (create.code !== 0) return false;
    // `check` forces a WAL switch and waits for it to reach the repo: the only real
    // proof that archive_command works, which a rewind depends on completely.
    const check = await execAsPostgres(session, `pgbackrest --stanza=${stanza} check 2>&1`);
    log.push({ title: 'Check WAL archiving works', ok: check.code === 0, output: (check.stdout + check.stderr).trim() || 'archive_command is working' });
    return check.code === 0;
  }

  app.post(
    '/api/pgbackrest/configure',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const stanza = str(req.body?.stanza) || 'main';
      need(STANZA_RE.test(stanza), 'Invalid stanza name');
      const repo1Path = str(req.body?.repo1Path) || '/var/lib/pgbackrest';
      need(PATH_RE.test(repo1Path), 'repo1 path must be absolute');
      const days = Math.round(Number(req.body?.retentionDays) || 7);
      need(days >= 1 && days <= 3650, 'Keep backups for 1 to 3650 days');

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
        need(PATH_RE.test(remotePath), 'Remote repo path must be absolute');
      }

      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`);
      need(dataDir, 'Could not determine the PostgreSQL data directory — is PostgreSQL running?');
      const configFile = await runPgJson<string>(session, `SELECT to_json(current_setting('config_file'));`);
      need(configFile, 'Could not determine postgresql.conf’s path');
      const walLevel = await runPgJson<string>(session, `SELECT to_json(current_setting('wal_level'));`).catch(() => 'replica');

      const global: Record<string, string> = {
        'repo1-path': repo1Path,
        // Keep as many full backups as needed to be able to rewind `days` days.
        'repo1-retention-full-type': 'time',
        'repo1-retention-full': String(days),
        // Begin a backup immediately rather than waiting for the next checkpoint.
        'start-fast': 'y',
      };
      if (remoteHost) {
        Object.assign(global, { 'repo2-type': 'ssh', 'repo2-host': remoteHost, 'repo2-host-user': remoteUser, 'repo2-path': remotePath });
        if (remotePort !== 22) global['repo2-host-port'] = String(remotePort);
        Object.assign(global, { 'repo2-retention-full-type': 'time', 'repo2-retention-full': String(days) });
      }
      const conf = writeIni({ global, [stanza]: { 'pg1-path': dataDir } });

      const steps: Step[] = [
        { title: `Write ${CONF_PATH}`, command: '', file: { path: CONF_PATH, content: conf } },
        { title: 'Let pgBackRest read its config', command: `chmod 640 ${shellQuote(CONF_PATH)} && chown postgres:postgres ${shellQuote(CONF_PATH)}` },
        {
          title: `Create the backup folder (${repo1Path})`,
          command: `mkdir -p ${shellQuote(repo1Path)} && chown postgres:postgres ${shellQuote(repo1Path)} && chmod 750 ${shellQuote(repo1Path)}`,
        },
        {
          title: `Turn on WAL archiving in postgresql.conf (archive_timeout = ${ARCHIVE_TIMEOUT}s)`,
          command: enableArchivingCommand(configFile, stanza, walLevel === 'minimal'),
        },
        { title: 'Restart PostgreSQL (archive_mode only takes effect on restart)', command: 'systemctl restart postgresql 2>&1' },
      ];
      const { log, ok } = await runSteps(session, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      if (!(await createAndCheck(session, stanza, log))) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** For a stanza that's in the config but was never created (setup stopped part-way):
   *  makes sure archiving is on, then creates and checks the stanza. */
  app.post(
    '/api/pgbackrest/finish-setup',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ini = await readConf(session);
      const stanza = stanzaOf(ini);
      need(stanza, 'pgBackRest is not configured yet');
      const log: { title: string; ok: boolean; output: string }[] = [];

      const arch = await archiving(session, stanza);
      if (!arch || arch.mode !== 'on' || !arch.usesPgBackRest) {
        const configFile = await runPgJson<string>(session, `SELECT to_json(current_setting('config_file'));`);
        need(configFile, 'Could not determine postgresql.conf’s path — is PostgreSQL running?');
        const steps: Step[] = [
          { title: 'Turn on WAL archiving in postgresql.conf', command: enableArchivingCommand(configFile, stanza, arch?.walLevel === 'minimal') },
          { title: 'Restart PostgreSQL', command: 'systemctl restart postgresql 2>&1' },
        ];
        const result = await runSteps(session, steps);
        log.push(...result.log);
        if (!result.ok) {
          res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
          return;
        }
      } else {
        log.push({ title: 'WAL archiving is already on', ok: true, output: arch.command });
      }
      const repo = ini.global?.['repo1-path'];
      if (repo) {
        const r = await run(session, `mkdir -p ${shellQuote(repo)} && chown postgres:postgres ${shellQuote(repo)} 2>&1`);
        log.push({ title: `Backup folder ${repo}`, ok: r.code === 0, output: (r.stdout + r.stderr).trim() || 'ready' });
      }
      if (!(await createAndCheck(session, stanza, log))) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** "How far back": time-based retention, and the backup schedule that makes it real. */
  app.post(
    '/api/pgbackrest/settings',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ini = await readConf(session);
      const stanza = stanzaOf(ini);
      need(stanza, 'pgBackRest is not configured yet');
      const days = Math.round(Number(req.body?.retentionDays));
      need(days >= 1 && days <= 3650, 'Keep backups for 1 to 3650 days');
      const sch = req.body?.schedule ?? {};
      const schedule: Schedule = {
        enabled: Boolean(sch.enabled),
        fullDay: Math.min(6, Math.max(0, Math.round(Number(sch.fullDay) || 0))),
        hour: Math.min(23, Math.max(0, Math.round(Number(sch.hour) || 0))),
      };

      ini.global ??= {};
      ini.global['repo1-retention-full-type'] = 'time';
      ini.global['repo1-retention-full'] = String(days);
      if (ini.global['repo2-host']) {
        ini.global['repo2-retention-full-type'] = 'time';
        ini.global['repo2-retention-full'] = String(days);
      }

      const steps: Step[] = [{ title: `Keep backups for ${days} day(s)`, command: '', file: { path: CONF_PATH, content: writeIni(ini) } }];
      steps.push(
        schedule.enabled
          ? { title: 'Write the backup schedule', command: '', file: { path: CRON_PATH, content: cronFile(stanza, schedule) } }
          : { title: 'Turn off scheduled backups', command: `rm -f ${shellQuote(CRON_PATH)}` },
      );
      const { log, ok } = await runSteps(session, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      // Apply the new retention right away rather than at the next backup.
      const expire = await execAsPostgres(session, `pgbackrest --stanza=${stanza} expire 2>&1`);
      log.push({ title: 'Expire backups outside the new window', ok: expire.code === 0, output: (expire.stdout + expire.stderr).trim() || 'nothing to expire' });
      res.json({ ok: true, log });
    }),
  );

  app.post(
    '/api/pgbackrest/backup',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const stanza = stanzaOf(await readConf(session));
      need(stanza, 'pgBackRest is not configured yet');
      const type = str(req.body?.type) || 'incr';
      need(['full', 'diff', 'incr'].includes(type), 'invalid backup type');
      const repo = Number(req.body?.repo) || 0;
      const repoArg = repo ? ` --repo=${repo}` : '';

      const result = await execAsPostgres(session, `pgbackrest --stanza=${stanza} --type=${type}${repoArg} backup 2>&1`);
      if (result.code !== 0) {
        const output = (result.stdout + result.stderr).trim();
        const hint = /stanza-create/.test(output) ? ' — setup was not finished: press "Finish setup" on the Backups page.' : '';
        res.status(500).json({ error: (output || 'Backup failed') + hint });
        return;
      }
      res.json({ ok: true, output: result.stdout });
    }),
  );

  /** Backups, the rewind window, and sizes — the page's main data. */
  app.get(
    '/api/pgbackrest/backups',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ini = await readConf(session);
      const stanza = stanzaOf(ini);
      if (!stanza) {
        res.json({ backups: [], earliest: null, latest: null, sizes: null });
        return;
      }
      const repo = ini.global?.['repo1-path'] ?? '/var/lib/pgbackrest';
      const [info, arch, sizes] = await Promise.all([
        stanzaInfo(session, stanza),
        archiving(session, stanza),
        duBytes(session, [`${repo}/backup/${stanza}`, `${repo}/archive/${stanza}`]),
      ]);
      // The newest reachable instant is the newest archived WAL, not the last backup.
      // Only offered while archiving is healthy and there's a backup to start from.
      const lastArchived = arch?.lastArchivedTime ? Date.parse(arch.lastArchivedTime) : null;
      const latest = info.earliest && arch?.usesPgBackRest && lastArchived ? lastArchived : (info.backups.at(-1)?.stopTime ?? null);
      res.json({
        backups: info.backups,
        earliest: info.earliest,
        latest,
        archiveTimeout: ARCHIVE_TIMEOUT,
        sizes: {
          backupsBytes: sizes[`${repo}/backup/${stanza}`] ?? 0,
          walArchiveBytes: sizes[`${repo}/archive/${stanza}`] ?? 0,
        },
      });
    }),
  );

  /** Disk, database and WAL sizes for the stats cards. */
  app.get(
    '/api/pgbackrest/stats',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ini = await readConf(session);
      const repo = ini.global?.['repo1-path'] ?? '';
      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`).catch(() => '');
      const [databases, walLocal, disks] = await Promise.all([
        runPgJson<{ name: string; bytes: number }[]>(
          session,
          `SELECT COALESCE(json_agg(row_to_json(d) ORDER BY d.bytes DESC), '[]'::json) FROM (
             SELECT datname AS name, pg_database_size(datname) AS bytes
             FROM pg_database WHERE datistemplate = false
           ) d;`,
        ).catch(() => []),
        // pg_wal: segments still on the server, not yet recycled.
        runPgJson<number>(session, `SELECT to_json(COALESCE(sum(size), 0)) FROM pg_ls_waldir();`).catch(() => 0),
        diskFor(session, ['/', ...(dataDir ? [dataDir] : []), ...(repo ? [repo] : [])]),
      ]);
      res.json({ databases, walLocalBytes: Number(walLocal) || 0, disks, dataDir, repoPath: repo });
    }),
  );

  /** The single most destructive thing in this app: the data directory's current
   *  contents are gone the moment this starts. Refuses without an explicit confirm — a
   *  second gate behind whatever the client already showed. */
  app.post(
    '/api/pgbackrest/restore',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      need(req.body?.confirm === true, 'This restore was not confirmed');
      const stanza = stanzaOf(await readConf(session));
      need(stanza, 'pgBackRest is not configured yet');
      const targetTime = str(req.body?.targetTime);
      need(targetTime, 'A restore point is required');
      // A loose shape check only — pgbackrest itself is the authority on whether this is
      // a real, restorable instant.
      need(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/.test(targetTime), 'Invalid restore point');
      const repo = Number(req.body?.repo) || 0;
      const repoArg = repo ? ` --repo=${repo}` : '';
      const log: { title: string; ok: boolean; output: string }[] = [];
      const dataDir = await runPgJson<string>(session, `SELECT to_json(current_setting('data_directory'));`).catch(() => '');
      need(dataDir, 'PostgreSQL must be running to start a rewind (its latest changes are archived first)');

      // Refuse an unreachable target while the database is still up — not after stopping it.
      const targetMs = Date.parse(targetTime.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
      need(Number.isFinite(targetMs), 'Invalid restore point');
      need(targetMs <= Date.now() + 60_000, 'That time is in the future');
      const { earliest } = await stanzaInfo(session, stanza);
      need(earliest, 'There is no backup to rewind from yet — take a full backup first');
      need(
        targetMs >= earliest,
        `Too far back: the oldest backup finished ${new Date(earliest).toISOString().replace('T', ' ').slice(0, 19)} UTC, and a rewind can't go before it`,
      );

      // Which branch of history to replay along — see timelineAt. Worked out while the
      // database is still up, so a failure here costs nothing.
      const timeline = await timelineAt(session, stanza, targetMs, repoArg);
      const timelineArg = timeline ? ` --target-timeline=${timeline}` : '';

      // 1. Make sure the WAL right up to now is in the archive before stopping.
      const flushed = await flushWal(session);
      log.push({ title: 'Archive the latest WAL', ok: flushed.ok, output: flushed.output });
      if (!flushed.ok) {
        res.status(500).json({ error: 'The latest changes could not be archived, so the rewind was not started (PostgreSQL is still running, nothing was changed)', log });
        return;
      }

      // 2. Stop.
      const stop = await runSteps(session, [{ title: 'Stop PostgreSQL (and wait until it has fully shut down)', command: stopPostgres(dataDir) }]);
      log.push(...stop.log);
      if (!stop.ok) {
        res.status(500).json({ error: 'Stop PostgreSQL failed', log });
        return;
      }

      // 3. Restore + replay to the target, then promote: without --target-action=promote
      //    pgBackRest's default is "pause", which leaves the database read-only.
      const restore = await execAsPostgres(
        session,
        `pgbackrest --stanza=${stanza} --type=time --target=${shellQuote(targetTime)}${timelineArg} --target-action=promote --delta${repoArg} restore 2>&1`,
      );
      const restoreStep = {
        title: `Restore and replay WAL up to ${targetTime}${timeline && timeline !== 'current' ? ` (timeline ${timeline})` : ''}`,
        ok: restore.code === 0,
        output: (restore.stdout + restore.stderr).trim(),
      };
      log.push(restoreStep);
      if (restore.code !== 0) {
        // [075] "unable to find backup set" is decided before any file is touched, so the
        // data directory is intact and it's safe to bring the database back.
        if (/ERROR: \[075\]/.test(restoreStep.output)) {
          const back = await runSteps(session, [{ title: 'Start PostgreSQL again (no files were changed)', command: startPostgres() }]);
          log.push(...back.log);
          res.status(500).json({ error: `${restoreStep.title} failed — nothing was changed${back.ok ? ', PostgreSQL is running again' : ''}`, log });
          return;
        }
        // Otherwise leaving it down is safer than starting it against a half-restored
        // data directory.
        res.status(500).json({ error: `${restoreStep.title} failed — PostgreSQL is left stopped`, log });
        return;
      }

      // 4. Start, and wait for recovery to finish.
      let start = await runSteps(session, [{ title: 'Start PostgreSQL', command: startPostgres() }]);
      if (start.ok) log.push(...start.log);
      else {
        const pgLog = await postgresLogTail(session);
        // A time target only "arrives" at the first commit after it. When nothing was
        // committed between the target and the end of that timeline (a timeline left
        // by a rewind made before flushWal committed its marker transaction), PostgreSQL
        // refuses — yet the end of that timeline IS the state at the target. Replay to
        // its end instead; that's an expected detour, not a failure to show in red.
        if (/recovery ended before configured recovery target was reached/.test(pgLog)) {
          log.push({
            title: `No change was made after ${targetTime} on this timeline, so its last state is the one you asked for`,
            ok: true,
            output: pgLog.split('\n').filter((l) => /last completed transaction|recovery target/.test(l)).join('\n'),
          });
          const replay = await execAsPostgres(
            session,
            `pgbackrest --stanza=${stanza} --type=default --target-timeline=${timeline ?? 'current'} --delta${repoArg} restore 2>&1`,
          );
          log.push({
            title: 'Replay that timeline to its end instead',
            ok: replay.code === 0,
            output: (replay.stdout + replay.stderr).trim(),
          });
          if (replay.code === 0) {
            start = await runSteps(session, [{ title: 'Start PostgreSQL', command: `systemctl reset-failed 'postgresql@*' 2>/dev/null; ${startPostgres()}` }]);
            log.push(...start.log);
            if (!start.ok) log.push({ title: 'Why PostgreSQL did not start (its log)', ok: false, output: (await postgresLogTail(session)) || 'no log output found' });
          }
        } else {
          log.push(...start.log, { title: 'Why PostgreSQL did not start (its log)', ok: false, output: pgLog || 'no log output found' });
        }
      }
      if (!start.ok) {
        res.status(500).json({ error: 'Start PostgreSQL failed — PostgreSQL is left stopped; see its log above', log });
        return;
      }
      let state = '';
      for (let i = 0; i < 40; i++) {
        state = await runPgJson<string>(session, `SELECT to_json(CASE WHEN pg_is_in_recovery() THEN 'recovering' ELSE 'ready' END);`).catch(() => 'starting');
        if (state === 'ready') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      log.push({
        title: 'Recovery finished, database is writable',
        ok: state === 'ready',
        output: state === 'ready' ? 'pg_is_in_recovery() = false' : `still ${state} after 60 s — check the PostgreSQL log`,
      });
      if (state !== 'ready') {
        res.status(500).json({ error: 'PostgreSQL started but has not finished recovery', log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );
}
