// PostgreSQL role & grant management — shells out to `psql` as the `postgres` OS
// user over the existing SSH session (peer-authenticated, no separate database
// credentials needed) rather than adding a `pg` driver dependency, keeping this on
// the same "shell commands over one SSH session" architecture as the rest of the
// app. Every query is wrapped so psql's reply is a single JSON value
// (`to_json`/`row_to_json`/`json_agg`) instead of column-aligned text — reliable to
// parse, unlike scraping psql's normal tabular output.
//
// Needs the connected user to be root, or to have sudo rights broad enough to run
// `sudo -u postgres ...` (not just `sudo -u root`/plain `sudo`) — surfaced as the
// literal error from attempting it, in /api/postgres/context, rather than guessed at.
import { randomUUID } from 'node:crypto';
import type { Express, Response } from 'express';
import { badRequestRoute, need, run, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { exec, execWithInput, shellQuote, type SshSession } from './ssh.js';

const PG_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
type Privilege = (typeof PRIVILEGES)[number];

/** Double-quoted SQL identifier — the only values ever interpolated this way are
 *  names the server itself already validated against `PG_IDENT_RE`, or ones a
 *  prior query of this server's own returned. */
function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quoted SQL string literal (doubled `'`) — used for the one piece of
 *  genuinely free-text input here, a new password. */
function pgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ------------------------------------------------------------------ exec helpers

async function execAsPostgres(session: SshSession, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec(session, session.username === 'postgres' ? command : `sudo -n -u postgres ${command}`);
}

/** Writes `sql` to a world-readable scratch file as the connected (unprivileged)
 *  user — no root needed just to create a file under /tmp — then runs it as
 *  `postgres`, which only needs read access, not ownership. */
async function runPgSql(session: SshSession, sql: string, database = 'postgres'): Promise<string> {
  const tmp = `/tmp/ssher-pg-${randomUUID()}.sql`;
  try {
    const write = await execWithInput(session, `tee ${shellQuote(tmp)} >/dev/null`, sql);
    if (write.code !== 0) throw new Error(write.stderr.trim() || `could not stage the query`);
    const result = await execAsPostgres(
      session,
      `psql -v ON_ERROR_STOP=1 -X -At -q -d ${shellQuote(database)} -f ${shellQuote(tmp)} 2>&1`,
    );
    if (result.code !== 0) throw new Error((result.stdout + result.stderr).trim() || 'psql failed');
    return result.stdout;
  } finally {
    await exec(session, `rm -f ${shellQuote(tmp)}`).catch(() => {});
  }
}

async function runPgJson<T>(session: SshSession, sql: string, database = 'postgres'): Promise<T> {
  const out = (await runPgSql(session, sql, database)).trim();
  return (out ? JSON.parse(out) : []) as T;
}

function validIdent(name: string, label: string): string {
  need(PG_IDENT_RE.test(name), `Invalid ${label}`);
  return name;
}

// ------------------------------------------------------------------- routes

export function registerPostgres(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/postgres/context',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const installed = await run(session, 'command -v psql >/dev/null 2>&1 && echo yes || true');
      if (installed.stdout.trim() !== 'yes') {
        res.json({ installed: false, running: false, reachable: false, version: '', error: '' });
        return;
      }
      const state = await run(session, 'systemctl is-active postgresql 2>/dev/null || true');
      const check = await execAsPostgres(session, 'psql -At -q -c "SELECT version()" 2>&1');
      res.json({
        installed: true,
        running: state.stdout.trim() === 'active',
        reachable: check.code === 0,
        version: check.code === 0 ? check.stdout.trim() : '',
        error: check.code === 0 ? '' : (check.stdout + check.stderr).trim(),
      });
    }),
  );

  app.get(
    '/api/postgres/roles',
    requireSession,
    route(async (req, res) => {
      const roles = await runPgJson(
        req.session!,
        `SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
           SELECT rolname AS name, rolsuper AS superuser, rolcreatedb AS createdb,
                  rolcreaterole AS createrole, rolcanlogin AS canlogin,
                  rolvaliduntil AS validuntil,
                  COALESCE((SELECT array_agg(b.rolname ORDER BY b.rolname)
                            FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid
                            WHERE m.member = r.oid), ARRAY[]::text[]) AS memberof
           FROM pg_roles r
           WHERE rolname !~ '^pg_'
           ORDER BY rolname
         ) r;`,
      );
      res.json({ roles });
    }),
  );

  app.post(
    '/api/postgres/roles',
    requireSession,
    route(async (req, res) => {
      const name = validIdent(str(req.body?.name), 'role name');
      const parts = [`CREATE ROLE ${pgIdent(name)}`, req.body?.login ? 'LOGIN' : 'NOLOGIN'];
      if (req.body?.superuser) parts.push('SUPERUSER');
      if (req.body?.createdb) parts.push('CREATEDB');
      if (req.body?.createrole) parts.push('CREATEROLE');
      const password = str(req.body?.password);
      if (password) parts.push(`PASSWORD ${pgLiteral(password)}`);
      await runPgSql(req.session!, `${parts.join(' ')};`);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/postgres/roles/:name/delete',
    requireSession,
    route(async (req, res) => {
      const name = validIdent(str(req.params.name), 'role name');
      await runPgSql(req.session!, `DROP ROLE ${pgIdent(name)};`);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/postgres/roles/:name/password',
    requireSession,
    route(async (req, res) => {
      const name = validIdent(str(req.params.name), 'role name');
      const password = str(req.body?.password);
      need(password, 'A password is required');
      await runPgSql(req.session!, `ALTER ROLE ${pgIdent(name)} WITH PASSWORD ${pgLiteral(password)};`);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/postgres/roles/:name/attributes',
    requireSession,
    route(async (req, res) => {
      const name = validIdent(str(req.params.name), 'role name');
      const toggles: Record<string, string> = { superuser: 'SUPERUSER', createdb: 'CREATEDB', createrole: 'CREATEROLE', canlogin: 'LOGIN' };
      const sets: string[] = [];
      for (const [key, word] of Object.entries(toggles)) {
        if (typeof req.body?.[key] === 'boolean') sets.push(req.body[key] ? word : `NO${word}`);
      }
      need(sets.length, 'No attributes given');
      await runPgSql(req.session!, `ALTER ROLE ${pgIdent(name)} ${sets.join(' ')};`);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/postgres/databases',
    requireSession,
    route(async (req, res) => {
      const databases = await runPgJson(
        req.session!,
        `SELECT COALESCE(json_agg(row_to_json(d)), '[]'::json) FROM (
           SELECT datname AS name, pg_catalog.pg_get_userbyid(datdba) AS owner
           FROM pg_database WHERE datistemplate = false ORDER BY datname
         ) d;`,
      );
      res.json({ databases });
    }),
  );

  app.get(
    '/api/postgres/databases/:db/schemas',
    requireSession,
    route(async (req, res) => {
      const db = validIdent(str(req.params.db), 'database name');
      const schemas = await runPgJson<string[]>(
        req.session!,
        `SELECT COALESCE(json_agg(schema_name ORDER BY schema_name), '[]'::json)
         FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
           AND schema_name !~ '^pg_';`,
        db,
      );
      res.json({ schemas });
    }),
  );

  app.get(
    '/api/postgres/databases/:db/schemas/:schema/tables',
    requireSession,
    route(async (req, res) => {
      const db = validIdent(str(req.params.db), 'database name');
      const schema = validIdent(str(req.params.schema), 'schema name');
      const role = validIdent(str(req.query.role), 'role name');
      const priv = (p: Privilege) =>
        `has_table_privilege(${pgLiteral(role)}, format('%I.%I', table_schema, table_name), '${p}') AS "${p.toLowerCase()}"`;
      const tables = await runPgJson(
        req.session!,
        `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
           SELECT table_name AS name, ${PRIVILEGES.map(priv).join(', ')}
           FROM information_schema.tables
           WHERE table_schema = ${pgLiteral(schema)} AND table_type = 'BASE TABLE'
           ORDER BY table_name
         ) t;`,
        db,
      );
      const connect = await runPgJson<boolean>(
        req.session!,
        `SELECT to_json(has_database_privilege(${pgLiteral(role)}, ${pgLiteral(db)}, 'CONNECT'));`,
        db,
      );
      res.json({ tables, connect });
    }),
  );

  app.post(
    '/api/postgres/grant',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const db = validIdent(str(req.body?.db), 'database name');
      const role = validIdent(str(req.body?.role), 'role name');
      const kind = str(req.body?.kind);
      const grant = Boolean(req.body?.grant);
      const verb = grant ? 'GRANT' : 'REVOKE';
      const prep = grant ? 'TO' : 'FROM';

      if (kind === 'database') {
        await runPgSql(session, `${verb} CONNECT ON DATABASE ${pgIdent(db)} ${prep} ${pgIdent(role)};`);
        res.json({ ok: true });
        return;
      }

      if (kind === 'table') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        const table = validIdent(str(req.body?.table), 'table name');
        const privilege = str(req.body?.privilege).toUpperCase();
        need((PRIVILEGES as readonly string[]).includes(privilege), 'invalid privilege');
        await runPgSql(session, `${verb} ${privilege} ON TABLE ${pgIdent(schema)}.${pgIdent(table)} ${prep} ${pgIdent(role)};`, db);
        res.json({ ok: true });
        return;
      }

      if (kind === 'schema') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        let sql = `${verb} ${PRIVILEGES.join(', ')} ON ALL TABLES IN SCHEMA ${pgIdent(schema)} ${prep} ${pgIdent(role)};`;
        if (req.body?.includeFuture) {
          sql += `\nALTER DEFAULT PRIVILEGES IN SCHEMA ${pgIdent(schema)} ${verb} ${PRIVILEGES.join(', ')} ON TABLES ${prep} ${pgIdent(role)};`;
        }
        await runPgSql(session, sql, db);
        res.json({ ok: true });
        return;
      }

      need(false, 'unknown grant kind');
    }),
  );
}
