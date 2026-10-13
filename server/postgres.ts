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
import { badRequestRoute, need, run, runSteps, str, type AsyncRoute, type SessionRequest, type Step } from './ops.js';
import { exec, execWithInput, shellQuote, sudoPrefix, type SshSession } from './ssh.js';

const PG_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The real grantable Postgres table privileges — there is no "ALTER"/"DROP" in
// this list because Postgres doesn't have one: altering or dropping a table is
// gated by ownership, not a GRANT, which is why there's a separate "owner" grant
// kind below rather than a fictitious privilege.
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

const DATABASE_PRIVILEGES = ['CONNECT', 'CREATE', 'TEMPORARY'] as const;
type DatabasePrivilege = (typeof DATABASE_PRIVILEGES)[number];

// USAGE is the one people forget: without it a role can't even "see" the schema,
// so table-level grants inside it quietly do nothing.
const SCHEMA_PRIVILEGES = ['USAGE', 'CREATE'] as const;
type SchemaPrivilege = (typeof SCHEMA_PRIVILEGES)[number];

const ROLE_ATTRIBUTES: Record<string, string> = {
  canlogin: 'LOGIN',
  superuser: 'SUPERUSER',
  createdb: 'CREATEDB',
  createrole: 'CREATEROLE',
  replication: 'REPLICATION',
  bypassrls: 'BYPASSRLS',
};

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

/** Runs a command as the `postgres` OS user, $HOME correctly reset to its own
 *  (not the connecting user's) — exported for pgbackrest.ts, which needs the
 *  exact same thing for pgbackrest itself (it has to run as the user that
 *  owns the data directory) and for generating postgres's own SSH keypair
 *  when configuring a remote backup repo. */
export async function execAsPostgres(session: SshSession, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // -H resets $HOME to postgres's own home for the duration of the command —
  // without it, psql (run as postgres but with the connecting user's $HOME still
  // set) can fail in ways that don't fail the *process*: e.g. it can't write
  // there, prints a warning to stderr, and — since stderr is merged into stdout
  // below so real psql errors aren't lost — that warning text ends up ahead of
  // the actual JSON, which breaks runPgJson's JSON.parse despite psql itself
  // having exited 0.
  return exec(session, session.username === 'postgres' ? command : `${sudoPrefix(session, '-H -u postgres')} ${command}`);
}

/** Writes `sql` to a scratch file as the connected (unprivileged) user — no root
 *  needed just to create a file under /tmp — then runs it as `postgres`, which
 *  only needs read access, not ownership. The explicit chmod matters: `tee`'s
 *  default mode comes from the connecting user's umask, which isn't always
 *  world-readable, and a postgres that can't even open the file is just another
 *  way to end up with stderr text instead of the JSON runPgJson expects. */
export async function runPgSql(session: SshSession, sql: string, database = 'postgres'): Promise<string> {
  const tmp = `/tmp/ssher-pg-${randomUUID()}.sql`;
  try {
    const write = await execWithInput(session, `tee ${shellQuote(tmp)} >/dev/null && chmod 644 ${shellQuote(tmp)}`, sql);
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

export async function runPgJson<T>(session: SshSession, sql: string, database = 'postgres'): Promise<T> {
  const out = (await runPgSql(session, sql, database)).trim();
  if (!out) return [] as T;
  // The query's own output is always the last thing printed — anything stray
  // ahead of it (a one-time notice from sudo or psql, say) lands on an earlier
  // line, so try the whole output first, then just its last line, before
  // giving up. Keeps exit-0-but-not-pure-JSON from being treated as a hard
  // failure when the real result is in there regardless.
  const lines = out.split('\n');
  for (const candidate of [out, lines.at(-1)?.trim() ?? '']) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  // Exit code 0 but still not JSON anywhere in it — show it verbatim instead of
  // letting JSON.parse's own cryptic "Unexpected token" reach the user.
  throw new Error(`psql didn't return the expected JSON — here is what it printed:\n${out.slice(0, 1000)}`);
}

function validIdent(name: string, label: string): string {
  need(PG_IDENT_RE.test(name), `Invalid ${label}`);
  return name;
}

/** What "give this user access to <db>" means, as one transaction run inside that
 *  database: CONNECT on it, USAGE on every schema, and either SELECT or
 *  SELECT/INSERT/UPDATE/DELETE on every table and sequence — now AND for tables
 *  created later. Default privileges only cover objects made by the role they name,
 *  so they're set for both the database's owner (whoever the app migrates as) and
 *  postgres. */
async function accessGrantSql(session: SshSession, role: string, db: string, write: boolean): Promise<string> {
  const info = await runPgJson<{ owner: string; schemas: string[] }>(
    session,
    `SELECT json_build_object(
       'owner', (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
       'schemas', COALESCE((SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace
                            WHERE nspname NOT IN ('information_schema') AND nspname !~ '^pg_'), '[]'::json));`,
    db,
  );
  const r = pgIdent(role);
  const tablePrivs = write ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT';
  const seqPrivs = write ? 'SELECT, USAGE' : 'SELECT';
  const creators = [...new Set([info.owner, 'postgres'])].filter((x) => PG_IDENT_RE.test(x));
  const lines = ['BEGIN;', `GRANT CONNECT ON DATABASE ${pgIdent(db)} TO ${r};`];
  for (const schema of info.schemas.filter((x) => PG_IDENT_RE.test(x))) {
    const s = pgIdent(schema);
    lines.push(
      `GRANT USAGE ON SCHEMA ${s} TO ${r};`,
      `GRANT ${tablePrivs} ON ALL TABLES IN SCHEMA ${s} TO ${r};`,
      `GRANT ${seqPrivs} ON ALL SEQUENCES IN SCHEMA ${s} TO ${r};`,
    );
    for (const creator of creators) {
      lines.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${pgIdent(creator)} IN SCHEMA ${s} GRANT ${tablePrivs} ON TABLES TO ${r};`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${pgIdent(creator)} IN SCHEMA ${s} GRANT ${seqPrivs} ON SEQUENCES TO ${r};`,
      );
    }
  }
  lines.push('COMMIT;');
  return lines.join('\n');
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

  /** Where this server's PostgreSQL keeps its config — the version is in the path
   *  on Debian (/etc/postgresql/17/main), so Quick Links can't hard-code it. Asked
   *  of PostgreSQL itself first (the cluster psql connects to, i.e. the one this
   *  app manages), then guessed from the newest cluster directory when it can't
   *  be asked (stopped, or no sudo -u postgres). Empty strings when neither works. */
  app.get(
    '/api/postgres/paths',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const asked = await execAsPostgres(
        session,
        `psql -X -At -q -c "SELECT current_setting('hba_file') || '|' || current_setting('config_file') || '|' || current_setting('port')" 2>/dev/null`,
      ).catch(() => null);
      const [hbaFile, configFile, port] = asked?.code === 0 ? asked.stdout.trim().split('|') : [];
      if (hbaFile && configFile) {
        res.json({ hbaFile, configFile, port: Number(port) || 5432, source: 'postgres' });
        return;
      }
      const dirs = await exec(session, 'ls -d /etc/postgresql/*/*/ 2>/dev/null | sort -V', true);
      const dir = dirs.stdout.trim().split('\n').filter(Boolean).at(-1)?.replace(/\/$/, '') ?? '';
      res.json({
        hbaFile: dir ? `${dir}/pg_hba.conf` : '',
        configFile: dir ? `${dir}/postgresql.conf` : '',
        port: 0,
        source: dir ? 'guess' : 'none',
      });
    }),
  );

  /** Debian/Ubuntu's default `postgresql` package — the same distro-family
   *  assumption the rest of the app already makes (apt, systemd, ufw). */
  app.post(
    '/api/postgres/install',
    requireSession,
    route(async (req, res) => {
      const steps: Step[] = [
        { title: 'Update package lists', command: 'apt-get update 2>&1' },
        { title: 'Install PostgreSQL', command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib 2>&1' },
        { title: 'Enable and start the service', command: 'systemctl enable --now postgresql 2>&1' },
      ];
      const { log, ok } = await runSteps(req.session!, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      res.json({ ok: true, log });
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
                  rolreplication AS replication, rolbypassrls AS bypassrls,
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
      for (const [key, word] of Object.entries(ROLE_ATTRIBUTES)) {
        if (key !== 'canlogin' && req.body?.[key]) parts.push(word);
      }
      const password = str(req.body?.password);
      if (password) parts.push(`PASSWORD ${pgLiteral(password)}`);

      const access = str(req.body?.access);
      const db = str(req.body?.database);
      need(!db || access === 'readonly' || access === 'readwrite', 'Choose read-only or read-write access');
      if (db) validIdent(db, 'database name');

      const session = req.session!;
      await runPgSql(session, `${parts.join(' ')};`);
      if (db) {
        try {
          await runPgSql(session, await accessGrantSql(session, name, db, access === 'readwrite'), db);
        } catch (err) {
          // Half a user — able to log in but not to the database it was made for —
          // is worse than none; take it back so the form can simply be retried.
          await runPgSql(session, `DROP ROLE IF EXISTS ${pgIdent(name)};`).catch(() => {});
          throw err;
        }
      }
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
      const sets: string[] = [];
      for (const [key, word] of Object.entries(ROLE_ATTRIBUTES)) {
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
           SELECT datname AS name, pg_catalog.pg_get_userbyid(datdba) AS owner, pg_database_size(datname) AS bytes
           FROM pg_database WHERE datistemplate = false ORDER BY datname
         ) d;`,
      );
      res.json({ databases });
    }),
  );

  /** A database, owned by an existing role or by a login user made for it in the
   *  same step — the usual "one app, one database, one user" setup. The owner
   *  is what an app migrating its own schema needs: since PostgreSQL 15 the
   *  public schema belongs to the database's owner, so nothing else is granted. */
  app.post(
    '/api/postgres/databases',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const name = validIdent(str(req.body?.name), 'database name');
      const newOwner = req.body?.newOwner as { name?: unknown; password?: unknown } | undefined;
      let owner = str(req.body?.owner) || 'postgres';
      let createdRole = '';
      if (newOwner) {
        owner = validIdent(str(newOwner.name), 'user name');
        const password = str(newOwner.password);
        need(password, 'The new user needs a password');
        await runPgSql(session, `CREATE ROLE ${pgIdent(owner)} LOGIN PASSWORD ${pgLiteral(password)};`);
        createdRole = owner;
      } else {
        validIdent(owner, 'owner');
      }
      try {
        // CREATE DATABASE can't run inside a transaction, so it is a statement of its own.
        await runPgSql(session, `CREATE DATABASE ${pgIdent(name)} OWNER ${pgIdent(owner)} ENCODING 'UTF8';`);
      } catch (err) {
        if (createdRole) await runPgSql(session, `DROP ROLE IF EXISTS ${pgIdent(createdRole)};`).catch(() => {});
        throw err;
      }
      res.json({ ok: true, owner });
    }),
  );

  app.post(
    '/api/postgres/databases/:db/owner',
    requireSession,
    route(async (req, res) => {
      const db = validIdent(str(req.params.db), 'database name');
      const owner = validIdent(str(req.body?.owner), 'owner');
      // The schema too: a database created before PG 15, or restored from a dump,
      // can still have public owned by postgres, which leaves the new owner unable
      // to create tables in it.
      await runPgSql(req.session!, `ALTER DATABASE ${pgIdent(db)} OWNER TO ${pgIdent(owner)};`);
      await runPgSql(
        req.session!,
        `DO $$ BEGIN
           IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspowner = 'postgres'::regrole) THEN
             EXECUTE format('ALTER SCHEMA public OWNER TO %I', ${pgLiteral(owner)});
           END IF;
         END $$;`,
        db,
      );
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/postgres/databases/:db/delete',
    requireSession,
    route(async (req, res) => {
      const db = validIdent(str(req.params.db), 'database name');
      need(!['postgres', 'template0', 'template1'].includes(db), `${db} is a system database`);
      need(str(req.body?.confirm) === db, 'Type the database name to confirm');
      await runPgSql(req.session!, `DROP DATABASE ${pgIdent(db)};`);
      res.json({ ok: true });
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
      const session = req.session!;
      const db = validIdent(str(req.params.db), 'database name');
      const schema = validIdent(str(req.params.schema), 'schema name');
      const role = validIdent(str(req.query.role), 'role name');

      const tablePriv = (p: TablePrivilege) =>
        `has_table_privilege(${pgLiteral(role)}, format('%I.%I', schemaname, tablename), '${p}') AS "${p.toLowerCase()}"`;
      const tables = await runPgJson(
        session,
        `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
           SELECT tablename AS name, tableowner AS owner, ${TABLE_PRIVILEGES.map(tablePriv).join(', ')}
           FROM pg_catalog.pg_tables
           WHERE schemaname = ${pgLiteral(schema)}
           ORDER BY tablename
         ) t;`,
        db,
      );

      const dbPriv = (p: DatabasePrivilege) => `'${p.toLowerCase()}', has_database_privilege(${pgLiteral(role)}, ${pgLiteral(db)}, '${p}')`;
      const database = await runPgJson<Record<string, boolean>>(
        session,
        `SELECT json_build_object(${DATABASE_PRIVILEGES.map(dbPriv).join(', ')});`,
        db,
      );

      const schemaPriv = (p: SchemaPrivilege) => `'${p.toLowerCase()}', has_schema_privilege(${pgLiteral(role)}, ${pgLiteral(schema)}, '${p}')`;
      const schemaPrivs = await runPgJson<Record<string, boolean>>(
        session,
        `SELECT json_build_object(${SCHEMA_PRIVILEGES.map(schemaPriv).join(', ')});`,
        db,
      );

      res.json({ tables, database, schema: schemaPrivs });
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
        const privilege = str(req.body?.privilege).toUpperCase();
        need((DATABASE_PRIVILEGES as readonly string[]).includes(privilege), 'invalid privilege');
        await runPgSql(session, `${verb} ${privilege} ON DATABASE ${pgIdent(db)} ${prep} ${pgIdent(role)};`);
        res.json({ ok: true });
        return;
      }

      if (kind === 'schema-privilege') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        const privilege = str(req.body?.privilege).toUpperCase();
        need((SCHEMA_PRIVILEGES as readonly string[]).includes(privilege), 'invalid privilege');
        await runPgSql(session, `${verb} ${privilege} ON SCHEMA ${pgIdent(schema)} ${prep} ${pgIdent(role)};`, db);
        res.json({ ok: true });
        return;
      }

      if (kind === 'table') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        const table = validIdent(str(req.body?.table), 'table name');
        const privilege = str(req.body?.privilege).toUpperCase();
        need((TABLE_PRIVILEGES as readonly string[]).includes(privilege), 'invalid privilege');
        await runPgSql(session, `${verb} ${privilege} ON TABLE ${pgIdent(schema)}.${pgIdent(table)} ${prep} ${pgIdent(role)};`, db);
        res.json({ ok: true });
        return;
      }

      /** Ownership, not a grant — this is what actually governs ALTER/DROP TABLE,
       *  which Postgres has no GRANT privilege for at all. */
      if (kind === 'owner') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        const table = validIdent(str(req.body?.table), 'table name');
        await runPgSql(session, `ALTER TABLE ${pgIdent(schema)}.${pgIdent(table)} OWNER TO ${pgIdent(role)};`, db);
        res.json({ ok: true });
        return;
      }

      if (kind === 'schema') {
        const schema = validIdent(str(req.body?.schema), 'schema name');
        const statements = [`${verb} ${TABLE_PRIVILEGES.join(', ')} ON ALL TABLES IN SCHEMA ${pgIdent(schema)} ${prep} ${pgIdent(role)};`];
        if (req.body?.includeFuture) {
          statements.push(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${pgIdent(schema)} ${verb} ${TABLE_PRIVILEGES.join(', ')} ON TABLES ${prep} ${pgIdent(role)};`,
          );
        }
        // The common gotcha: INSERT on a table with a serial/identity column
        // also needs USAGE (and usually SELECT, for currval()) on its sequence —
        // granted separately because Postgres has no "cascade to sequences" option.
        if (req.body?.includeSequences) {
          statements.push(`${verb} SELECT, USAGE ON ALL SEQUENCES IN SCHEMA ${pgIdent(schema)} ${prep} ${pgIdent(role)};`);
          if (req.body?.includeFuture) {
            statements.push(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA ${pgIdent(schema)} ${verb} SELECT, USAGE ON SEQUENCES ${prep} ${pgIdent(role)};`,
            );
          }
        }
        await runPgSql(session, statements.join('\n'), db);
        res.json({ ok: true });
        return;
      }

      need(false, 'unknown grant kind');
    }),
  );
}
