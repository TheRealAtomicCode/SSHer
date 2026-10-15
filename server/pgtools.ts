// PostgreSQL upkeep and insight, beside postgres.ts (roles, databases, grants):
//
//   overview      version, uptime, connections, cache hit rate
//   indexes       per database: size, how much they are used, fragmentation, when each was last
//                 rebuilt and its table last vacuumed — and Rebuild (REINDEX CONCURRENTLY) /
//                 Defragment (VACUUM ANALYZE, or VACUUM FULL)
//   activity      what is running right now, longest first — Cancel / End
//   top queries   the slowest statements overall, from pg_stat_statements
//   dumps         per-database backups (pg_dump), kept on the server — pick which databases
//
// Everything runs as the postgres OS user through runPgSql / execAsPostgres, like postgres.ts.
import type { Express, Response } from 'express';
import { badRequestRoute, need, run, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { execAsPostgres, pgIdent, pgLiteral, runPgJson, runPgSql, streamDump } from './postgres.js';
import { shellQuote, type SshSession } from './ssh.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** Database names may carry more than identifiers do; they are always passed quoted. */
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,62}$/;
/** Where per-database backups live: the postgres user's own home, readable by it only. */
const DUMP_DIR = '/var/lib/postgresql/ssher-backups';

async function requireDb(session: SshSession, db: string): Promise<void> {
  need(DB_NAME.test(db), 'invalid database name');
  const ok = await runPgJson<boolean>(session, `SELECT to_json(EXISTS (SELECT 1 FROM pg_database WHERE datname = ${pgLiteral(db)} AND datallowconn));`);
  need(ok === true, `There is no database named "${db}" that accepts connections`);
}

/** `CREATE EXTENSION` needs the library to be loaded at start for pg_stat_statements. */
async function statStatementsState(session: SshSession) {
  const preload = (await runPgSql(session, 'SHOW shared_preload_libraries;')).trim();
  const loaded = preload.split(',').map((s) => s.trim().replace(/"/g, '')).includes('pg_stat_statements');
  const created = await runPgJson<boolean>(session, `SELECT to_json(EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'));`);
  return { loaded, created: created === true, preload };
}

export function registerPgTools(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  // ----------------------------------------------------------------- overview

  app.get(
    '/api/postgres/overview',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const info = await runPgJson<Record<string, unknown>>(
        session,
        `SELECT json_build_object(
           'version', current_setting('server_version'),
           'port', current_setting('port')::int,
           'listen', current_setting('listen_addresses'),
           'startedAt', pg_postmaster_start_time(),
           'maxConnections', current_setting('max_connections')::int,
           'connections', (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'),
           'active', (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active'),
           'idleInTransaction', (SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'),
           'longestSeconds', (SELECT COALESCE(max(EXTRACT(EPOCH FROM now() - query_start)), 0) FROM pg_stat_activity
                              WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()),
           'cacheHitPct', (SELECT round(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 1) FROM pg_stat_database),
           'dataDirectory', current_setting('data_directory')
         );`,
      );
      res.json({ ...info, statStatements: await statStatementsState(session) });
    }),
  );

  // ------------------------------------------------------------------ indexes

  /**
   * Every index in one database. "Last rebuilt" is when its file was created: REINDEX writes a
   * brand-new file, so the file's birth time is the last rebuild (or creation) — PostgreSQL
   * keeps no such timestamp itself. Fragmentation comes from pgstattuple when it is installed
   * in that database (btree indexes only).
   */
  app.get(
    '/api/postgres/indexes',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const db = str(req.query.db);
      await requireDb(session, db);
      const hasStats = await runPgJson<boolean>(session, `SELECT to_json(EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple'));`, db);
      // last_idx_scan arrived in PostgreSQL 16.
      const v16 = Number((await runPgSql(session, 'SHOW server_version_num;')).trim()) >= 160000;
      const rows = await runPgJson<Record<string, unknown>[]>(
        session,
        `SELECT COALESCE(json_agg(row_to_json(r) ORDER BY r.bytes DESC), '[]'::json) FROM (
           SELECT n.nspname AS schema, t.relname AS "table", c.relname AS index,
                  pg_relation_size(c.oid) AS bytes,
                  am.amname AS method,
                  i.indisprimary AS "primary", i.indisunique AS "unique", i.indisvalid AS valid,
                  COALESCE(s.idx_scan, 0) AS scans,
                  ${v16 ? 's.last_idx_scan' : 'NULL::timestamptz'} AS "lastUsed",
                  pg_relation_filepath(c.oid) AS file,
                  pg_get_indexdef(c.oid) AS definition,
                  ts.last_vacuum AS "lastVacuum", ts.last_autovacuum AS "lastAutovacuum",
                  ts.last_analyze AS "lastAnalyze", ts.last_autoanalyze AS "lastAutoanalyze",
                  ts.n_dead_tup AS "deadRows", ts.n_live_tup AS "liveRows",
                  pg_total_relation_size(t.oid) AS "tableBytes"
                  ${hasStats ? `, CASE WHEN am.amname = 'btree' AND i.indisvalid AND pg_relation_size(c.oid) < 1073741824
                                    THEN (SELECT row_to_json(p) FROM (SELECT leaf_fragmentation, avg_leaf_density FROM pgstatindex(c.oid)) p) END AS frag` : ''}
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_am am ON am.oid = c.relam
           LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
           LEFT JOIN pg_stat_user_tables ts ON ts.relid = t.oid
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
         ) r;`,
        db,
      );

      // Birth time of each index's file (root reads the data directory); 0 = the filesystem
      // doesn't record it, shown as unknown.
      const dataDir = (await runPgSql(session, 'SHOW data_directory;')).trim();
      const files = rows.map((r) => String(r.file ?? '')).filter((f) => /^[A-Za-z0-9_./]+$/.test(f));
      const born = new Map<string, number>();
      if (files.length && /^\/[\w./-]+$/.test(dataDir)) {
        const out = await run(session, `cd ${shellQuote(dataDir)} && stat -c '%n %W' ${files.map(shellQuote).join(' ')} 2>/dev/null`, true);
        for (const line of out.stdout.split('\n')) {
          const [name, w] = line.trim().split(' ');
          if (name && Number(w) > 0) born.set(name, Number(w) * 1000);
        }
      }
      res.json({
        pgstattuple: hasStats,
        indexes: rows.map(({ file, ...r }) => ({ ...r, rebuiltAt: born.get(String(file)) ?? null })),
      });
    }),
  );

  /** pgstattuple ships with PostgreSQL (contrib) — only the extension has to be created. */
  app.post(
    '/api/postgres/indexes/enable-stats',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const db = str(req.body?.db);
      await requireDb(session, db);
      await runPgSql(session, 'CREATE EXTENSION IF NOT EXISTS pgstattuple;', db);
      res.json({ ok: true });
    }),
  );

  /**
   * Rebuild = REINDEX … CONCURRENTLY: a fresh, compact copy is built beside the old one and
   * swapped in, with no lock that stops reads or writes. Defragment = VACUUM (ANALYZE) on the
   * table (reclaims dead rows, refreshes statistics, no blocking lock), or with `full` VACUUM
   * FULL, which rewrites table and indexes into the smallest size but LOCKS the table for the
   * whole time.
   */
  app.post(
    '/api/postgres/maintenance',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const db = str(req.body?.db);
      await requireDb(session, db);
      const action = str(req.body?.action);
      const schema = str(req.body?.schema);
      const target = str(req.body?.name);
      need(IDENT.test(schema) && IDENT.test(target), 'invalid schema or name');
      const qualified = `${pgIdent(schema)}.${pgIdent(target)}`;
      const sql: Record<string, string> = {
        'reindex-index': `REINDEX INDEX CONCURRENTLY ${qualified};`,
        'reindex-table': `REINDEX TABLE CONCURRENTLY ${qualified};`,
        vacuum: `VACUUM (ANALYZE, VERBOSE) ${qualified};`,
        'vacuum-full': `VACUUM (FULL, ANALYZE, VERBOSE) ${qualified};`,
      };
      need(sql[action], 'unknown action');
      const started = Date.now();
      const out = await runPgSql(session, `SET client_min_messages = info;\n${sql[action]}`, db);
      res.json({ ok: true, seconds: Math.round((Date.now() - started) / 100) / 10, output: out.trim().split('\n').slice(-8).join('\n') });
    }),
  );

  // ----------------------------------------------------------------- activity

  app.get(
    '/api/postgres/activity',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const rows = await runPgJson<unknown[]>(
        session,
        `SELECT COALESCE(json_agg(row_to_json(a) ORDER BY a.seconds DESC NULLS LAST), '[]'::json) FROM (
           SELECT pid, datname AS database, usename AS "user", application_name AS application,
                  host(client_addr) AS client, backend_type AS kind, state,
                  wait_event_type AS "waitType", wait_event AS wait,
                  query_start AS "queryStart", xact_start AS "transactionStart",
                  round(EXTRACT(EPOCH FROM now() - COALESCE(query_start, backend_start))::numeric, 1) AS seconds,
                  left(query, 4000) AS query
           FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
         ) a;`,
      );
      res.json({ sessions: rows });
    }),
  );

  /** Cancel = stop the current statement (the connection stays). End = close the connection. */
  app.post(
    '/api/postgres/activity/stop',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const pid = Number(req.body?.pid);
      need(Number.isInteger(pid) && pid > 0, 'invalid pid');
      const fn = req.body?.terminate ? 'pg_terminate_backend' : 'pg_cancel_backend';
      const ok = await runPgJson<boolean>(session, `SELECT to_json(${fn}(${pid}));`);
      res.json({ ok: ok === true });
    }),
  );

  // -------------------------------------------------------------- top queries

  app.get(
    '/api/postgres/top-queries',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const state = await statStatementsState(session);
      if (!state.loaded || !state.created) {
        res.json({ ...state, queries: [] });
        return;
      }
      const order = str(req.query.by) === 'mean' ? 'mean_exec_time' : str(req.query.by) === 'calls' ? 'calls' : 'total_exec_time';
      const queries = await runPgJson<unknown[]>(
        session,
        `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
           SELECT d.datname AS database, r.rolname AS "user", s.calls,
                  round(s.total_exec_time::numeric, 1) AS "totalMs", round(s.mean_exec_time::numeric, 2) AS "meanMs",
                  round(s.max_exec_time::numeric, 1) AS "maxMs", s.rows, left(s.query, 4000) AS query
           FROM pg_stat_statements s
           LEFT JOIN pg_database d ON d.oid = s.dbid
           LEFT JOIN pg_roles r ON r.oid = s.userid
           ORDER BY s.${order} DESC LIMIT 30
         ) q;`,
      );
      const since = await runPgJson<string | null>(session, `SELECT to_json(stats_reset) FROM pg_stat_statements_info;`).catch(() => null);
      res.json({ ...state, queries, since });
    }),
  );

  /** Loads pg_stat_statements at start (shared_preload_libraries, kept alongside what is
   *  there already), restarts PostgreSQL, and creates the extension. */
  app.post(
    '/api/postgres/top-queries/enable',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const state = await statStatementsState(session);
      if (!state.loaded) {
        const libs = [...state.preload.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean), 'pg_stat_statements'];
        await runPgSql(session, `ALTER SYSTEM SET shared_preload_libraries = ${pgLiteral(libs.join(','))};`);
        const restart = await run(session, 'systemctl restart postgresql 2>&1');
        need(restart.code === 0, `Saved, but the restart failed: ${(restart.stdout + restart.stderr).trim()}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await runPgSql(session, 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
      res.json({ ok: true, restarted: !state.loaded });
    }),
  );

  app.post(
    '/api/postgres/top-queries/reset',
    requireSession,
    route(async (req, res) => {
      await runPgSql(req.session!, 'SELECT pg_stat_statements_reset();');
      res.json({ ok: true });
    }),
  );

  // --------------------------------------------------------- per-database backups

  /** Saved backups: <DUMP_DIR>/<db>/<db>-<stamp>.dump, newest first. */
  app.get(
    '/api/postgres/dumps',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const out = await execAsPostgres(
        session,
        `sh -c ${shellQuote(`[ -d ${DUMP_DIR} ] && find ${DUMP_DIR} -mindepth 2 -maxdepth 2 -name '*.dump' -printf '%P\\t%s\\t%T@\\n' || true`)}`,
      );
      const dumps = out.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [path, size, mtime] = line.split('\t');
          return { file: path, database: path.split('/')[0], bytes: Number(size), createdAt: Math.round(Number(mtime) * 1000) };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      res.json({ dumps, dir: DUMP_DIR });
    }),
  );

  /** Backs up the chosen databases now, one pg_dump (custom format, compressed) each. */
  app.post(
    '/api/postgres/dumps',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const dbs = (Array.isArray(req.body?.databases) ? req.body.databases : []).map(String);
      need(dbs.length, 'Pick at least one database');
      for (const db of dbs) await requireDb(session, db);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const results: { database: string; ok: boolean; output: string }[] = [];
      for (const db of dbs) {
        const dir = `${DUMP_DIR}/${db}`;
        const file = `${dir}/${db}-${stamp}.dump`;
        const r = await execAsPostgres(
          session,
          `sh -c ${shellQuote(`umask 077 && mkdir -p ${shellQuote(dir)} && pg_dump -Fc -d ${shellQuote(db)} -f ${shellQuote(file)} && du -h ${shellQuote(file)} | cut -f1`)}`,
        );
        results.push({ database: db, ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
      }
      res.json({ ok: results.every((r) => r.ok), results });
    }),
  );

  function dumpPath(raw: unknown): string {
    const file = str(raw);
    need(/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+\.dump$/.test(file) && !file.includes('..'), 'invalid backup file');
    return `${DUMP_DIR}/${file}`;
  }

  app.get(
    '/api/postgres/dumps/download',
    requireSession,
    route(async (req, res) => {
      const path = dumpPath(req.query.file);
      await streamDump(req.session!, `cat ${shellQuote(path)}`, path.split('/').pop()!, res);
    }),
  );

  app.post(
    '/api/postgres/dumps/delete',
    requireSession,
    route(async (req, res) => {
      const path = dumpPath(req.body?.file);
      const r = await execAsPostgres(req.session!, `rm -f ${shellQuote(path)}`);
      need(r.code === 0, r.stderr.trim() || 'could not delete it');
      res.json({ ok: true });
    }),
  );

  /** Restores a backup into a NEW database (never over an existing one), owned like the
   *  original was — compare, copy data back, or switch an app to it. */
  app.post(
    '/api/postgres/dumps/restore',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const path = dumpPath(req.body?.file);
      const target = str(req.body?.target);
      const owner = str(req.body?.owner);
      need(DB_NAME.test(target), 'Pick a name for the new database');
      need(!owner || IDENT.test(owner), 'invalid owner');
      const exists = await runPgJson<boolean>(session, `SELECT to_json(EXISTS (SELECT 1 FROM pg_database WHERE datname = ${pgLiteral(target)}));`);
      need(exists !== true, `"${target}" already exists — restoring only ever creates a new database`);
      await runPgSql(session, `CREATE DATABASE ${pgIdent(target)}${owner ? ` OWNER ${pgIdent(owner)}` : ''} TEMPLATE template0;`);
      const r = await execAsPostgres(
        session,
        `sh -c ${shellQuote(`pg_restore --no-owner ${owner ? `--role=${shellQuote(owner)}` : ''} -d ${shellQuote(target)} ${shellQuote(path)} 2>&1 | tail -5`)}`,
      );
      res.json({ ok: true, output: (r.stdout + r.stderr).trim() });
    }),
  );
}
