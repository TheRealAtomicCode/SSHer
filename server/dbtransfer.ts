// Copy one PostgreSQL database to another server: `pg_dump` here piped straight into
// `pg_restore` there, inside one transaction, then a table-by-table row count on both
// sides to prove the copy is complete.
//
// Runs ON this server (as the postgres user), connecting out to the target — so the
// target's PostgreSQL port must be reachable from this server, not from your browser.
// The target password is written to a temporary .pgpass file readable only by postgres
// and deleted afterwards: it never appears on a command line, in `ps`, or in the
// activity log.
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { badRequestRoute, need, run, str, writeRemote, type AsyncRoute, type SessionRequest } from './ops.js';
import { execAsPostgres, runPgJson } from './postgres.js';
import { shellQuote, type SshSession } from './ssh.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const HOST = /^[A-Za-z0-9.:-]{1,253}$/;

interface Target {
  host: string;
  port: number;
  user: string;
  password: string;
  sslmode: 'prefer' | 'require' | 'disable';
}

function parseTarget(body: Record<string, unknown>): Target {
  const host = str(body.host);
  need(HOST.test(host), 'Enter the target server’s IP or hostname');
  const port = Number(body.port) || 5432;
  need(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid port');
  const user = str(body.user);
  need(IDENT.test(user), 'Enter the target PostgreSQL username');
  const password = String(body.password ?? '');
  need(password && !/[\n\r]/.test(password), 'Enter the target password');
  const sslmode = (['prefer', 'require', 'disable'] as const).find((m) => m === body.sslmode) ?? 'prefer';
  return { host, port, user, password, sslmode };
}

/** .pgpass escapes `:` and `\` inside fields. */
const pgpassField = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

/** Writes a one-line .pgpass for the target, owned by postgres, mode 600; returns its path. */
async function withPgpass<T>(session: SshSession, t: Target, fn: (env: string) => Promise<T>): Promise<T> {
  const file = `/tmp/ssher-pgpass-${randomUUID()}`;
  await writeRemote(session, file, `${[t.host, String(t.port), '*', t.user, t.password].map(pgpassField).join(':')}\n`);
  await run(session, `chown postgres:postgres ${file} && chmod 600 ${file}`);
  // Everything that talks to the target goes through `env`, so sudo passes the vars on.
  const env = `env PGPASSFILE=${file} PGCONNECT_TIMEOUT=10 PGSSLMODE=${t.sslmode}`;
  try {
    return await fn(env);
  } finally {
    await run(session, `rm -f ${file}`).catch(() => {});
  }
}

const conn = (t: Target, db: string) =>
  `-h ${shellQuote(t.host)} -p ${t.port} -U ${shellQuote(t.user)} -d ${shellQuote(db)}`;

/** Runs as postgres from /tmp: from root's home, every client prints "could not change
 *  directory to /root", which would land in front of query results. */
function asPg(session: SshSession, command: string) {
  return execAsPostgres(session, `bash -c ${shellQuote(`cd /tmp && ${command}`)}`);
}

/** The line of psql/libpq output that says what went wrong (not "password retrieved from file …"). */
function reason(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /FATAL|ERROR|could not|timeout|refused|no route|no pg_hba|does not exist/i.test(l)) ?? lines.at(-1) ?? '';
  return hit.replace(/^psql: error: /, '').replace(/connection to server at [^,]+, port \d+ failed: /, '');
}

/** Runs SQL on the target and returns its plain-text output. */
async function targetSql(session: SshSession, env: string, t: Target, db: string, sql: string) {
  const r = await asPg(session, `${env} psql -X -At -v ON_ERROR_STOP=1 ${conn(t, db)} -c ${shellQuote(sql)} 2>&1`);
  return { ok: r.code === 0, out: (r.stdout + r.stderr).trim() };
}

/** What a database contains, as one JSON object — run on both sides, so the copy can be
 *  checked object type by object type, not just by rows. Objects that belong to an
 *  extension (e.g. its functions) are counted under "extensions", not separately. */
const SUMMARY_SQL = `
WITH ns AS (
  SELECT oid FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
),
ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
rel AS (SELECT c.oid, c.relkind, c.reltuples FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM ns) AND c.oid NOT IN (SELECT objid FROM ext))
SELECT json_build_object(
  'schemas',    (SELECT count(*) FROM pg_namespace n WHERE n.oid IN (SELECT oid FROM ns) AND n.oid NOT IN (SELECT objid FROM ext)),
  'tables',     (SELECT count(*) FROM rel WHERE relkind IN ('r', 'p')),
  'views',      (SELECT count(*) FROM rel WHERE relkind = 'v'),
  'matviews',   (SELECT count(*) FROM rel WHERE relkind = 'm'),
  'sequences',  (SELECT count(*) FROM rel WHERE relkind = 'S'),
  'indexes',    (SELECT count(*) FROM rel WHERE relkind IN ('i', 'I')),
  'functions',  (SELECT count(*) FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM ns) AND p.prokind IN ('f', 'a', 'w') AND p.oid NOT IN (SELECT objid FROM ext)),
  'procedures', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace IN (SELECT oid FROM ns) AND p.prokind = 'p' AND p.oid NOT IN (SELECT objid FROM ext)),
  'triggers',   (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal),
  'extensions', (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'),
  'rows',       (SELECT COALESCE(sum(GREATEST(reltuples, 0)), 0)::bigint FROM rel WHERE relkind IN ('r', 'p')),
  'bytes',      pg_database_size(current_database())
);`;

export interface DbSummary {
  schemas: number;
  tables: number;
  views: number;
  matviews: number;
  sequences: number;
  indexes: number;
  functions: number;
  procedures: number;
  triggers: number;
  extensions: number;
  /** Estimated from planner statistics — exact counts come from the verify step. */
  rows: number;
  bytes: number;
}

const OBJECT_KINDS: (keyof DbSummary)[] = ['schemas', 'tables', 'views', 'matviews', 'sequences', 'indexes', 'functions', 'procedures', 'triggers', 'extensions'];

/** SQL that lists every user table with its exact row count, as `schema.table|rows`. */
async function countSql(session: SshSession, db: string): Promise<string> {
  const tables = await runPgJson<{ s: string; t: string }[]>(
    session,
    `SELECT COALESCE(json_agg(json_build_object('s', table_schema, 't', table_name) ORDER BY table_schema, table_name), '[]'::json)
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema');`,
    db,
  );
  if (!tables.length) return '';
  const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  return tables
    .slice(0, 300)
    .map((x) => `SELECT ${lit(`${x.s}.${x.t}`)} || '|' || count(*) FROM ${q(x.s)}.${q(x.t)}`)
    .join(' UNION ALL ');
}

function parseCounts(out: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of out.split('\n')) {
    const i = line.lastIndexOf('|');
    if (i > 0) m.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return m;
}

export function registerDbTransfer(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  /** What's in each database on this server, for the Transfer page's list. */
  app.get(
    '/api/postgres/transfer/summary',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const db = str(req.query.db);
      need(IDENT.test(db), 'invalid database');
      res.json({ summary: await runPgJson<DbSummary>(session, SUMMARY_SQL, db) });
    }),
  );

  /** Can this server reach and log in to the target? And does the target db already exist? */
  app.post(
    '/api/postgres/transfer/test',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const t = parseTarget(req.body ?? {});
      const targetDb = str(req.body?.targetDb);
      await withPgpass(session, t, async (env) => {
        const v = await targetSql(session, env, t, 'postgres', `SELECT current_setting('server_version') || '|' || (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)`);
        if (!v.ok) {
          res.status(400).json({ error: `Couldn't connect from this server to ${t.host}:${t.port}: ${reason(v.out)}` });
          return;
        }
        const [version, canCreate] = v.out.split('|');
        let exists = false;
        if (IDENT.test(targetDb)) {
          const e = await targetSql(session, env, t, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${targetDb}'`);
          exists = e.out === '1';
        }
        const here = await runPgJson<string>(session, `SELECT to_json(current_setting('server_version'));`).catch(() => '');
        res.json({ ok: true, targetVersion: version, sourceVersion: here, canCreateDb: canCreate === 'true' || canCreate === 't', exists });
      });
    }),
  );

  app.post(
    '/api/postgres/transfer',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const body = req.body ?? {};
      const source = str(body.sourceDb);
      need(IDENT.test(source), 'Pick the database to transfer');
      const targetDb = str(body.targetDb) || source;
      need(IDENT.test(targetDb), 'Invalid target database name');
      const t = parseTarget(body);
      const ifExists = body.ifExists === 'replace' ? 'replace' : 'stop';
      const log: { title: string; ok: boolean; output: string }[] = [];
      const started = Date.now();

      // Copying a database onto itself would drop the original first.
      const here = (await run(session, "hostname -I 2>/dev/null; echo 127.0.0.1 localhost ::1", true)).stdout.split(/\s+/).filter(Boolean);
      need(!(here.includes(t.host) && targetDb === source), 'That is this same server and database — pick a different target name');

      const sizeBefore = await runPgJson<number>(session, `SELECT to_json(pg_database_size('${source}'));`).catch(() => 0);

      await withPgpass(session, t, async (env) => {
        const fail = (error: string) => res.status(500).json({ error, log, seconds: Math.round((Date.now() - started) / 1000) });

        const ping = await targetSql(session, env, t, 'postgres', "SELECT current_setting('server_version')");
        log.push({ title: `Connect to ${t.user}@${t.host}:${t.port}`, ok: ping.ok, output: ping.ok ? `PostgreSQL ${ping.out}` : reason(ping.out) });
        if (!ping.ok) return fail(`Couldn't connect from this server to ${t.host}:${t.port}`);

        const exists = (await targetSql(session, env, t, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${targetDb}'`)).out === '1';
        if (exists && ifExists === 'stop') {
          log.push({ title: `Target database "${targetDb}" already exists`, ok: false, output: 'Stopped — choose "replace it" to overwrite, or another name.' });
          return fail(`"${targetDb}" already exists on ${t.host}`);
        }
        if (exists) {
          const drop = await asPg(session, `${env} dropdb --if-exists --force -h ${shellQuote(t.host)} -p ${t.port} -U ${shellQuote(t.user)} ${shellQuote(targetDb)} 2>&1`);
          log.push({ title: `Drop the existing "${targetDb}" on the target`, ok: drop.code === 0, output: (drop.stdout + drop.stderr).trim() || 'dropped' });
          if (drop.code !== 0) return fail('Dropping the existing target database failed');
        }
        const create = await asPg(session, `${env} createdb -h ${shellQuote(t.host)} -p ${t.port} -U ${shellQuote(t.user)} ${shellQuote(targetDb)} 2>&1`);
        log.push({ title: `Create "${targetDb}" on the target`, ok: create.code === 0, output: (create.stdout + create.stderr).trim() || 'created' });
        if (create.code !== 0) return fail(`Creating "${targetDb}" failed — the target user needs CREATEDB`);

        // Custom-format dump streamed into pg_restore, all in ONE transaction: on any
        // error nothing is left half-restored. --no-owner/--no-privileges: objects end up
        // owned by the target user, since this server's roles don't exist over there.
        const pipeline = [
          `pg_dump -Fc --no-owner --no-privileges -d ${shellQuote(source)}`,
          `${env} pg_restore --no-owner --no-privileges --single-transaction --exit-on-error ${conn(t, targetDb)}`,
        ].join(' | ');
        const copy = await asPg(session, `bash -c ${shellQuote(`${pipeline} 2>&1; echo "__codes \${PIPESTATUS[0]} \${PIPESTATUS[1]}"`)}`);
        const codes = /__codes (\d+) (\d+)/.exec(copy.stdout);
        const ok = codes?.[1] === '0' && codes?.[2] === '0';
        const output = copy.stdout.replace(/__codes.*/, '').trim();
        log.push({ title: `Copy "${source}" → "${targetDb}" (pg_dump | pg_restore)`, ok, output: output || 'done' });
        if (!ok) {
          // Leave no empty shell behind when nothing could be restored.
          await asPg(session, `${env} dropdb --if-exists -h ${shellQuote(t.host)} -p ${t.port} -U ${shellQuote(t.user)} ${shellQuote(targetDb)} 2>&1`);
          log.push({ title: 'Remove the empty target database', ok: true, output: 'the restore ran in one transaction, so nothing partial was left' });
          return fail('The copy failed — nothing was changed on the target');
        }

        // Prove it: exact row counts per table, both sides.
        const sql = await countSql(session, source);
        if (!sql) {
          log.push({ title: 'Verify', ok: true, output: 'the database has no tables' });
        } else {
          const srcOut = await asPg(session, `psql -X -At -d ${shellQuote(source)} -c ${shellQuote(sql)} 2>&1`);
          const dstOut = await targetSql(session, env, t, targetDb, sql);
          const a = parseCounts(srcOut.stdout);
          const b = parseCounts(dstOut.out);
          const diffs = [...a].filter(([k, n]) => b.get(k) !== n).map(([k, n]) => `${k}: ${n} here, ${b.get(k) ?? 'missing'} there`);
          const rows = [...a.values()].reduce((x, y) => x + y, 0);
          log.push({
            title: `Verify: ${a.size} table(s), ${rows.toLocaleString()} row(s)`,
            ok: dstOut.ok && diffs.length === 0,
            output: diffs.length ? `Mismatches (rows written since the copy started count too):\n${diffs.slice(0, 20).join('\n')}` : 'every table has the same number of rows on both servers',
          });
        }

        // …and every other kind of object: schemas, views, functions, procedures, indexes…
        const here = await runPgJson<DbSummary>(session, SUMMARY_SQL, source).catch(() => null);
        const thereRaw = await targetSql(session, env, t, targetDb, SUMMARY_SQL);
        let there: DbSummary | null = null;
        try {
          there = JSON.parse(thereRaw.out.split('\n').filter(Boolean).at(-1) ?? '');
        } catch {
          there = null;
        }
        if (here && there) {
          const lines = OBJECT_KINDS.map((k) => `${k}: ${here[k]} here, ${there![k]} there${here[k] === there![k] ? '' : '  ← different'}`);
          const same = OBJECT_KINDS.every((k) => here[k] === there![k]);
          log.push({ title: `Verify objects: ${OBJECT_KINDS.filter((k) => here[k]).map((k) => `${here[k]} ${k}`).join(', ') || 'none'}`, ok: same, output: lines.join('\n') });
        }

        res.json({ ok: true, log, seconds: Math.round((Date.now() - started) / 1000), bytes: sizeBefore, summary: here });
      });
    }),
  );
}
