// Stacks: whole docker compose projects — several services, one file — as opposed to the
// one-container apps the deploy wizard writes. The DigitalOcean-style flow:
//
//   1. bring a compose file: upload it, paste it, start from a template, or point at one
//      already on the server (every project a running container came from is found too)
//   2. see each service's image, and whether it is on the server yet (drop its .tar)
//   3. fill in the settings — every `KEY: value` under an `x-…:` block or an
//      `environment:` — in a form, with secrets masked and CHANGE_ME placeholders flagged
//   4. deploy, and be told within seconds if a container is crash-looping, with its logs
//
// The compose file stays the single source of truth: the form edits its lines in place
// (comments and layout survive), and nothing is kept anywhere else.
import posix from 'node:path/posix';
import type { Express, Response } from 'express';
import {
  BadRequest,
  badRequestRoute,
  listDockerContainers,
  need,
  OVERRIDE_FILE,
  RE,
  run,
  runOrThrow,
  str,
  writeRemote,
  type AsyncRoute,
  type SessionRequest,
} from './ops.js';
import { runPgSql } from './postgres.js';
import { shellQuote, type SshSession } from './ssh.js';

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const PLACEHOLDER = /CHANGE_?ME/i;
const SECRET = /pass|secret|key|token|pwd|credential/i;
/** How long a freshly started container must stay up before the deploy calls it healthy. */
const SETTLE_SECONDS = 12;

// ------------------------------------------------------------------ settings

export interface StackSetting {
  /** 1-based line in the file — the handle an edit is made by. */
  line: number;
  /** The `x-…` block or the service whose `environment:` this is in. */
  block: string;
  key: string;
  value: string;
  secret: boolean;
  placeholder: boolean;
  /** `- KEY=value` rather than `KEY: value`. */
  listForm: boolean;
  /** The nearest comment lines above it, as help text. */
  comment: string;
}

/** A compose double-quoted scalar -> its value. `$$` is compose's escaped `$`. */
function unquote(raw: string): string {
  let v = raw.trim();
  if (v.startsWith('"')) {
    const end = closingQuote(v);
    try {
      v = JSON.parse(v.slice(0, end + 1)) as string;
    } catch {
      v = v.slice(1, end);
    }
  } else if (v.startsWith("'")) {
    const end = closingQuote(v);
    v = v.slice(1, end).replace(/''/g, "'");
  } else {
    v = v.replace(/\s+#.*$/, '');
  }
  return v.replace(/\$\$/g, '$');
}

/** Index of the quote that closes the scalar starting at v[0]. */
function closingQuote(v: string): number {
  const q = v[0];
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === '\\') {
      i++;
      continue;
    }
    if (v[i] === q) {
      if (q === "'" && v[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return v.length - 1;
}

/** value -> a double-quoted compose scalar (JSON strings are valid YAML; `$` doubled). */
function quote(value: string): string {
  return JSON.stringify(value.replace(/\$/g, '$$$$'));
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Every editable setting in a compose file: the children of a top-level `x-…:` block,
 * and the entries of any `environment:` mapping or list. Line-based on purpose — a YAML
 * round trip would throw away the comments that explain each value, and these files
 * are hand-written and commented.
 */
export function parseSettings(text: string): StackSetting[] {
  const lines = text.split('\n');
  const out: StackSetting[] = [];
  let topKey = '';
  let service = '';
  let envIndent = -1; // indent of the active `environment:` / x-block key, -1 = none
  let envBlock = '';

  const commentAbove = (i: number) => {
    const notes: string[] = [];
    for (let j = i - 1; j >= 0 && notes.length < 4; j--) {
      const t = lines[j].trim();
      if (!t.startsWith('#')) break;
      notes.unshift(t.replace(/^#+\s?/, ''));
    }
    return notes.join(' ').replace(/^-+\s*|\s*-+$/g, '').trim();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);

    if (indent === 0) {
      topKey = /^([^:\s]+):/.exec(trimmed)?.[1] ?? '';
      service = '';
      envIndent = -1;
      // `x-devise-env: &devise-env` — a mapping of settings shared by reference.
      if (topKey.startsWith('x-') && /^[^:]+:\s*(&\S+)?\s*$/.test(trimmed)) {
        envIndent = 0;
        envBlock = topKey;
      }
      continue;
    }

    if (envIndent >= 0 && indent <= envIndent) envIndent = -1;

    if (topKey === 'services' && indent === 2) {
      service = /^([^:\s]+):/.exec(trimmed)?.[1] ?? '';
      continue;
    }

    if (envIndent < 0) {
      // `environment:` with nothing after it opens a block (`environment: *anchor` doesn't).
      if (topKey === 'services' && /^environment:\s*$/.test(trimmed)) {
        envIndent = indent;
        envBlock = service;
      }
      continue;
    }

    const list = /^-\s+(["']?)([A-Za-z_][A-Za-z0-9_.-]*)=(.*?)\1\s*$/.exec(trimmed);
    const map = /^([A-Za-z_][A-Za-z0-9_.-]*):\s+(.*)$/.exec(trimmed) ?? /^([A-Za-z_][A-Za-z0-9_.-]*):\s*$/.exec(trimmed);
    if (!list && !map) continue;
    const key = list ? list[2] : map![1];
    const rawValue = list ? list[3] : (map![2] ?? '');
    // `<<: *anchor`, `KEY: *alias` (a reference to a value declared elsewhere — that
    // declaration is the one shown) and nested mappings aren't settings. `KEY: &name "v"`
    // IS one: the named value itself, e.g. a password in an x-secrets block.
    const anchored = /^&[A-Za-z0-9_-]+(\s+|$)/.exec(rawValue.trim());
    if (key === '<<' || rawValue.trim().startsWith('*') || (anchored && !rawValue.trim().slice(anchored[0].length)) || (!list && !map![2] && lines[i + 1] && indentOf(lines[i + 1]) > indent)) continue;
    const value = list ? rawValue.replace(/\$\$/g, '$') : unquote(anchored ? rawValue.trim().slice(anchored[0].length) : rawValue);
    out.push({
      line: i + 1,
      block: envBlock,
      key,
      value,
      secret: SECRET.test(key),
      placeholder: PLACEHOLDER.test(value) || (SECRET.test(key) && value === '' && !/OPTIONS$/.test(key)),
      listForm: Boolean(list),
      comment: commentAbove(i),
    });
  }
  return out;
}

/** Rewrites the given lines' values in place; returns the new text. */
export function applySettings(text: string, edits: { line: number; key: string; value: string }[]): string {
  const lines = text.split('\n');
  const known = new Map(parseSettings(text).map((s) => [s.line, s]));
  for (const e of edits) {
    const s = known.get(e.line);
    need(s && s.key === e.key, `Line ${e.line} is no longer ${e.key} — the file changed; reload it`);
    need(!/[\n\r]/.test(e.value), `${e.key} cannot contain a line break`);
    const raw = lines[e.line - 1];
    const cr = raw.endsWith('\r') ? '\r' : '';
    const pad = raw.slice(0, indentOf(raw));
    if (s.listForm) {
      lines[e.line - 1] = `${pad}- ${quote(`${e.key}=${e.value}`)}${cr}`;
    } else {
      // Keep an `&anchor` (other lines refer to it by name) and a trailing comment.
      let after = raw.trimEnd().replace(/\r$/, '').slice(raw.indexOf(':') + 1).trim();
      const anchor = /^&[A-Za-z0-9_-]+\s+/.exec(after)?.[0] ?? '';
      after = after.slice(anchor.length);
      let tail = '';
      if (after.startsWith('"') || after.startsWith("'")) tail = after.slice(closingQuote(after) + 1);
      lines[e.line - 1] = `${pad}${e.key}: ${anchor}${quote(e.value)}${tail}${cr}`;
    }
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------- reading

interface StackRef {
  dir: string;
  files: string[];
  project: string;
}

interface StackService {
  name: string;
  image: string;
  hasBuild: boolean;
  imagePresent: boolean;
  ports: string[];
  state: string | null;
  container: string | null;
}

/** `cd dir && docker compose [-p project] -f a -f b [-f ssher.override.yml]` — the override
 *  file the "Connects to" tab writes is layered on last whenever it exists, exactly as
 *  ops.ts's composeCmd does, so a deploy from here never drops those overrides. */
function composeBase(ref: StackRef): string {
  need(RE.absPath.test(ref.dir) && ref.dir !== '/', 'invalid stack directory');
  for (const f of ref.files) need(RE.absPath.test(f), `invalid compose file ${f}`);
  need(!ref.project || RE.id.test(ref.project), 'invalid project name');
  const overridePath = posix.join(ref.dir, OVERRIDE_FILE);
  const override = shellQuote(overridePath);
  const files = ref.files.filter((f) => f !== overridePath).map((f) => `-f ${shellQuote(f)}`).join(' ');
  // "$@" rather than $(…): a path with a space survives it.
  return (
    `cd ${shellQuote(ref.dir)} && if [ -f ${override} ]; then set -- -f ${override}; else set --; fi && ` +
    `docker compose${ref.project ? ` -p ${shellQuote(ref.project)}` : ''} ${files} "$@"`
  );
}

/** The override file is never a stack's "own" file: the settings form and the raw editor
 *  work on the project's compose files, and composeBase adds the override itself. */
function withoutOverride(dir: string, files: string[]): string[] {
  return files.filter((f) => f !== posix.join(dir, OVERRIDE_FILE));
}

function parseRef(body: Record<string, unknown>): StackRef {
  const all = (Array.isArray(body.files) ? body.files : []).map(String).filter(Boolean);
  need(all.length, 'no compose file given');
  const dir = str(body.dir) || posix.dirname(all[0]);
  const files = withoutOverride(dir, all);
  need(files.length, 'no compose file given');
  return { dir, files, project: str(body.project) };
}

async function readRoot(session: SshSession, path: string): Promise<string> {
  need(RE.absPath.test(path), 'invalid path');
  return runOrThrow(session, `cat ${shellQuote(path)}`);
}

/** Every compose project the server knows of: those a container was started from, and
 *  any compose file directly under /opt (where a stack waits before its first start). */
async function discover(session: SshSession): Promise<StackRef[]> {
  const [docker, found] = await Promise.all([
    listDockerContainers(session).catch(() => ({ containers: [] as Awaited<ReturnType<typeof listDockerContainers>>['containers'] })),
    run(session, `ls -1 ${COMPOSE_NAMES.map((n) => `/opt/*/${n}`).join(' ')} 2>/dev/null || true`),
  ]);
  const refs = new Map<string, StackRef>();
  for (const c of docker.containers) {
    if (!c.compose?.configFiles.length || !c.compose.workingDir) continue;
    const files = withoutOverride(c.compose.workingDir, c.compose.configFiles);
    if (!files.length) continue;
    const key = files[0];
    if (!refs.has(key)) refs.set(key, { dir: c.compose.workingDir, files, project: c.compose.project });
  }
  for (const file of found.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!refs.has(file)) refs.set(file, { dir: posix.dirname(file), files: [file], project: '' });
  }
  return [...refs.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

async function describe(session: SshSession, ref: StackRef) {
  const base = composeBase(ref);
  const [config, ps, raw] = await Promise.all([
    run(session, `${base} config --format json 2>&1`, true),
    run(session, `${base} ps -a --format json 2>/dev/null`, true),
    readRoot(session, ref.files[0]).catch(() => ''),
  ]);

  let project = ref.project;
  let services: StackService[] = [];
  let error = '';
  if (config.code === 0) {
    const json = JSON.parse(config.stdout) as {
      name: string;
      services: Record<string, { image?: string; build?: unknown; ports?: { host_ip?: string; published?: string; target: number }[] }>;
    };
    project ||= json.name;
    services = Object.entries(json.services).map(([name, s]) => ({
      name,
      image: s.image ?? '',
      hasBuild: Boolean(s.build),
      imagePresent: false,
      ports: (s.ports ?? []).map((p) => `${p.host_ip ? `${p.host_ip}:` : ''}${p.published ?? ''}→${p.target}`),
      state: null,
      container: null,
    }));
  } else {
    error = config.stdout.trim() || config.stderr.trim() || 'docker compose config failed';
  }

  const images = [...new Set(services.map((s) => s.image).filter((i) => RE.image.test(i)))];
  if (images.length) {
    const present = await run(
      session,
      images.map((i) => `docker image inspect ${shellQuote(i)} >/dev/null 2>&1 && echo ${shellQuote(i)}`).join('; ') + '; true',
      true,
    );
    const have = new Set(present.stdout.split('\n').map((l) => l.trim()));
    for (const s of services) s.imagePresent = have.has(s.image);
  }

  // `ps --format json` is one JSON object per line on current compose, an array on old ones.
  const rows: { Service: string; State: string; Name: string }[] = [];
  const text = ps.stdout.trim();
  if (text.startsWith('[')) rows.push(...(JSON.parse(text) as typeof rows));
  else for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line) as (typeof rows)[number]);
  for (const r of rows) {
    const s = services.find((x) => x.name === r.Service);
    if (s) {
      s.state = r.State;
      s.container = r.Name;
    }
  }

  const settings = parseSettings(raw);
  return {
    ...ref,
    project,
    services,
    error,
    placeholders: settings.filter((s) => s.placeholder).length,
    running: services.filter((s) => s.state === 'running').length,
    settings,
    raw,
  };
}

/** Waits, then reports every container of the stack that isn't steadily running —
 *  exited, restarting, or restarted at least once — with its last log lines. This is
 *  the check that turns "deployed fine" into "crash-looping on missing config" before
 *  anyone has to go looking. */
export async function settleCheck(session: SshSession, base: string, services: string[] = []) {
  await new Promise((r) => setTimeout(r, SETTLE_SECONDS * 1000));
  const svc = services.map(shellQuote).join(' ');
  const ids = (await run(session, `${base} ps -a -q ${svc} 2>/dev/null`, true)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return [];
  const states = await run(
    session,
    `docker inspect --format '{{.Name}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{.RestartCount}}|{{.State.ExitCode}}' ${ids.map(shellQuote).join(' ')}`,
    true,
  );
  const bad: { service: string; container: string; state: string; restarts: number; exitCode: number; logs: string }[] = [];
  for (const line of states.stdout.split('\n').filter(Boolean)) {
    const [name, service, state, restarts, exitCode] = line.split('|');
    if (state === 'running' && Number(restarts) === 0) continue;
    const container = name.replace(/^\//, '');
    const logs = await run(session, `docker logs --tail 40 ${shellQuote(container)} 2>&1`, true);
    bad.push({ service, container, state, restarts: Number(restarts), exitCode: Number(exitCode), logs: logs.stdout.trim() });
  }
  return bad;
}

// ------------------------------------------------------------- changing a secret

/** `name: &anchor "value"` declarations anywhere in the file, anchor -> value. */
function anchorValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const m = /^\s+[^\s:#][^:]*:\s+&([A-Za-z0-9_-]+)\s+(.+?)\s*$/.exec(raw.replace(/\r$/, ''));
    if (m) out.set(m[1], unquote(m[2]));
  }
  return out;
}

/** Every `KEY: value` / `KEY: *alias` in the file, with aliases resolved — first one wins. */
function resolvedEnv(text: string): Map<string, string> {
  const anchors = anchorValues(text);
  const out = new Map<string, string>();
  for (const s of parseSettings(text)) if (!out.has(s.key)) out.set(s.key, s.value);
  for (const raw of text.split('\n')) {
    const m = /^\s+([A-Za-z_][A-Za-z0-9_.]*):\s+\*([A-Za-z0-9_-]+)\s*$/.exec(raw.replace(/\r$/, ''));
    if (m && !out.has(m[1]) && anchors.has(m[2])) out.set(m[1], anchors.get(m[2])!);
  }
  return out;
}

const pgIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const pgLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A database the server's own PostgreSQL serves — the only kind SSHer can change a password on. */
const isLocalDb = (hostInDocker: string, host: string) =>
  ['host.docker.internal', '172.17.0.1', 'localhost', '127.0.0.1'].includes(hostInDocker || host);

interface SecretPlan {
  key: string;
  anchor: string;
  /** The settings that take their value from this one (KEY: *anchor), plus itself. */
  uses: string[];
  /** What happens besides rewriting the line — shown before anything is done. */
  actions: string[];
  database: { user: string; name: string } | null;
  warnings: string[];
}

/** Works out what changing the setting on `line` touches. */
function planSecretChange(text: string, line: number, key: string): SecretPlan {
  const setting = parseSettings(text).find((s) => s.line === line);
  need(setting && setting.key === key, `Line ${line} is no longer ${key} — the file changed; reload it`);
  const anchor = /:\s+&([A-Za-z0-9_-]+)/.exec(text.split('\n')[line - 1] ?? '')?.[1] ?? '';
  const uses = new Set<string>([key]);
  if (anchor) {
    for (const raw of text.split('\n')) {
      const m = new RegExp(`^\\s+([A-Za-z_][A-Za-z0-9_.]*):\\s+\\*${anchor}\\s*$`).exec(raw.replace(/\r$/, ''));
      if (m) uses.add(m[1]);
    }
  }
  const env = resolvedEnv(text);
  const actions: string[] = [`Write the new value into the compose file (${uses.size > 1 ? `${[...uses].filter((u) => u !== key).join(', ')} follow it` : 'one place'})`];
  const warnings: string[] = [];
  let database: SecretPlan['database'] = null;

  if (uses.has('DB_PASSWORD')) {
    const user = env.get('DB_USER') ?? '';
    const name = env.get('DB_NAME') ?? '';
    if (!user) warnings.push('DB_USER is not set, so the database password cannot be changed on the server.');
    else if (!isLocalDb(env.get('DB_HOST_IN_DOCKER') ?? '', env.get('DB_HOST') ?? '')) {
      warnings.push(`The database is not on this server (${env.get('DB_HOST_IN_DOCKER') || env.get('DB_HOST')}) — change ${user}'s password there first, then here.`);
    } else {
      database = { user, name };
      actions.push(`Change PostgreSQL role "${user}"'s password on this server (ALTER ROLE)`);
    }
  }
  if (uses.has('REDIS_PASSWORD')) actions.push('Redis restarts with the new password (sessions are kept on disk)');
  if (uses.has('MINIO_ROOT_PASSWORD') || uses.has('MINIO_ROOT_USER')) actions.push('MinIO restarts with the new root login (stored files are kept)');
  if ([...uses].some((u) => /SecretKey$/.test(u) && /^token__|^refreshToken__/.test(u))) warnings.push('Everyone is signed out: tokens signed with the old key stop being valid.');
  if ([...uses].some((u) => /^Email__(Password|Username)$/.test(u))) warnings.push('This only changes what the app logs in with — change the mailbox password on the mail server too.');
  actions.push('Recreate the running containers whose settings changed (docker compose up -d), then check they stay up');
  return { key, anchor, uses: [...uses], actions, database, warnings };
}

// --------------------------------------------------------------------- routes

export function registerStacks(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/stacks',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const refs = await discover(session);
      // One at a time: each describe opens several SSH channels, and sshd caps how many
      // one connection may have open (MaxSessions, 10 by default).
      const stacks = [];
      for (const ref of refs) {
        const { settings: _settings, raw: _raw, ...summary } = await describe(session, ref);
        stacks.push(summary);
      }
      res.json({ stacks });
    }),
  );

  app.post(
    '/api/stacks/detail',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ref = parseRef(req.body ?? {});
      const detail = await describe(session, ref);
      const perms = await run(session, `stat -c '%a %U' ${shellQuote(ref.files[0])}`, true);
      res.json({ ...detail, mode: perms.stdout.trim() });
    }),
  );

  /** Edits setting lines in place, validates, and puts the old file back if compose
   *  rejects the result — a typo here can't leave a stack that won't start. */
  app.post(
    '/api/stacks/settings',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ref = parseRef(req.body ?? {});
      const edits = (Array.isArray(req.body?.edits) ? req.body.edits : []).map((e: { line?: unknown; key?: unknown; value?: unknown }) => ({
        line: Number(e.line),
        key: str(e.key),
        value: String(e.value ?? ''),
      }));
      need(edits.length, 'nothing to save');
      const file = ref.files[0];
      const before = await readRoot(session, file);
      await writeRemote(session, file, applySettings(before, edits));
      const check = await run(session, `${composeBase(ref)} config --quiet 2>&1`);
      if (check.code !== 0) {
        await writeRemote(session, file, before);
        throw new Error(`docker compose rejected the file, so it was put back:\n${(check.stdout + check.stderr).trim()}`);
      }
      res.json({ ok: true, saved: edits.length });
    }),
  );

  /**
   * Changes one secret EVERYWHERE it is used, so the stack keeps working: the line in the
   * compose file (every `*alias` follows it), the PostgreSQL role's password when it is the
   * database password, and the running containers whose settings changed — Redis and MinIO
   * take their password from their environment at start, so recreating them is the change.
   *
   * `dryRun` returns the plan only. Order matters: the file first (validated, put back if
   * compose rejects it), then the database (file put back if ALTER ROLE fails), then the
   * containers — so a failure never leaves the file and the database disagreeing.
   */
  app.post(
    '/api/stacks/secret',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ref = parseRef(req.body ?? {});
      const base = composeBase(ref);
      const line = Number(req.body?.line);
      const key = str(req.body?.key);
      const value = String(req.body?.value ?? '');
      const file = ref.files[0];
      const before = await readRoot(session, file);
      const plan = planSecretChange(before, line, key);
      if (req.body?.dryRun) {
        res.json({ plan });
        return;
      }
      need(value.trim(), 'The new value is empty');
      need(!/[\n\r]/.test(value), 'The value cannot contain a line break');
      need(!PLACEHOLDER.test(value), 'That is a placeholder, not a value');
      // JWT signing keys (token__SecretKey …) are HMAC-SHA512 in the apps SSHer deploys, and .NET
      // refuses a key of 512 bits or fewer — every sign-in then fails with IDX10720.
      if (plan.uses.some((u) => /Token__SecretKey$|^token__SecretKey$/i.test(u))) {
        need(
          new TextEncoder().encode(value).length > 64,
          `A signing key must be longer than 64 bytes (more than 512 bits) — this one is ${new TextEncoder().encode(value).length}. Use the dice button for an 86-character key.`,
        );
      }

      const log: { title: string; ok: boolean; output: string }[] = [];
      try {
        await writeRemote(session, file, applySettings(before, [{ line, key, value }]));
        const check = await run(session, `${base} config --quiet 2>&1`);
        if (check.code !== 0) {
          await writeRemote(session, file, before);
          throw new BadRequest(`docker compose rejected the file, so it was put back:\n${(check.stdout + check.stderr).trim()}`);
        }
        log.push({ title: `Write ${key} into ${file}`, ok: true, output: `${plan.uses.join(', ')} now use the new value` });

        if (plan.database) {
          try {
            await runPgSql(
              session,
              `SET log_statement = 'none';\nALTER ROLE ${pgIdent(plan.database.user)} WITH PASSWORD ${pgLiteral(value)};`,
            );
          } catch (err) {
            await writeRemote(session, file, before);
            throw new BadRequest(`PostgreSQL refused the change, so the file was put back too: ${(err as Error).message.split('\n')[0]}`);
          }
          log.push({ title: `Change the password of PostgreSQL role "${plan.database.user}"`, ok: true, output: 'ALTER ROLE done' });
        }

        const running = (await run(session, `${base} ps --services --status running 2>/dev/null`, true)).stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => RE.id.test(s));
        if (!running.length) {
          log.push({ title: 'Nothing is running', ok: true, output: 'The new value is used from the next Deploy.' });
          res.json({ ok: true, log, crashed: [], plan });
          return;
        }
        const up = await run(session, `${base} up -d ${running.map(shellQuote).join(' ')} 2>&1`);
        log.push({ title: `Recreate what changed (${running.join(', ')})`, ok: up.code === 0, output: (up.stdout + up.stderr).trim() });
        if (up.code !== 0) throw new Error('docker compose up failed');
        const crashed = await settleCheck(session, base, running);
        log.push({
          title: 'Still running afterwards',
          ok: !crashed.length,
          output: crashed.length ? crashed.map((c) => `${c.service}: ${c.state}, exit ${c.exitCode}`).join('\n') : 'every container is up',
        });
        res.json({ ok: !crashed.length, log, crashed, plan });
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        res.status(500).json({ error: (err as Error).message, log });
      }
    }),
  );

  /** Replaces the whole first compose file (the raw editor). Validated as a staged copy
   *  alongside the stack's other files first; written with `cat >` so the file keeps
   *  its owner and mode (a 600 file with secrets stays 600). */
  app.post(
    '/api/stacks/raw',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ref = parseRef(req.body ?? {});
      const content = String(req.body?.content ?? '');
      need(content.trim(), 'The compose file is empty');
      need(content.length < 512 * 1024, 'That compose file is too large');
      const file = ref.files[0];
      const staged = posix.join(posix.dirname(file), `.${posix.basename(file)}.ssher-new`);
      await writeRemote(session, staged, content);
      const check = await run(session, `${composeBase({ ...ref, files: [staged, ...ref.files.slice(1)] })} config --quiet 2>&1`);
      if (check.code !== 0) {
        await run(session, `rm -f ${shellQuote(staged)}`);
        throw new Error(`docker compose rejected it — nothing was saved:\n${(check.stdout + check.stderr).trim()}`);
      }
      await runOrThrow(session, `cat ${shellQuote(staged)} > ${shellQuote(file)} && rm -f ${shellQuote(staged)}`);
      res.json({ ok: true });
    }),
  );

  /** A new stack from uploaded / pasted / template YAML. Validated in place before it
   *  becomes the real file, and made 600: a compose file with settings holds secrets. */
  app.post(
    '/api/stacks',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const dir = str(req.body?.dir).replace(/\/+$/, '');
      need(RE.absPath.test(dir) && dir.split('/').filter(Boolean).length >= 2, 'Folder must be an absolute path like /opt/myapp');
      const fileName = COMPOSE_NAMES.includes(str(req.body?.fileName)) ? str(req.body?.fileName) : 'docker-compose.yml';
      const content = String(req.body?.content ?? '');
      need(content.trim(), 'The compose file is empty');
      need(content.length < 512 * 1024, 'That compose file is too large');
      const file = posix.join(dir, fileName);
      if (!req.body?.overwrite) {
        const exists = await run(session, `[ -e ${shellQuote(file)} ] && echo yes || true`);
        need(exists.stdout.trim() !== 'yes', `${file} already exists — tick "replace" to overwrite it`);
      }
      const staged = posix.join(dir, `.${fileName}.ssher-new`);
      await writeRemote(session, staged, content);
      const check = await run(
        session,
        `cd ${shellQuote(dir)} && docker compose --project-directory ${shellQuote(dir)} -f ${shellQuote(staged)} config --quiet 2>&1`,
      );
      if (check.code !== 0) {
        await run(session, `rm -f ${shellQuote(staged)}`);
        throw new Error(`That isn't a valid compose file:\n${(check.stdout + check.stderr).trim()}`);
      }
      await runOrThrow(session, `chmod 600 ${shellQuote(staged)} && mv -f ${shellQuote(staged)} ${shellQuote(file)}`);
      res.json({ ok: true, dir, files: [file] });
    }),
  );

  app.post(
    '/api/stacks/op',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const ref = parseRef(req.body ?? {});
      const base = composeBase(ref);
      const op = str(req.body?.op);
      const services = (Array.isArray(req.body?.services) ? req.body.services : []).map(String);
      for (const s of services) need(RE.id.test(s), `invalid service ${s}`);
      const svc = services.map(shellQuote).join(' ');
      const log: { title: string; ok: boolean; output: string }[] = [];
      const step = async (title: string, command: string) => {
        const result = await run(session, `${command} 2>&1`);
        const output = (result.stdout + result.stderr).trim();
        log.push({ title, ok: result.code === 0, output });
        if (result.code !== 0) throw new Error(`${title} failed:\n${output}`);
        return output;
      };

      try {
        if (op === 'up') {
          if (!req.body?.force) {
            const settings = parseSettings(await readRoot(session, ref.files[0]));
            const open = settings.filter((s) => s.placeholder);
            need(!open.length, `${open.length} setting(s) still need a value: ${open.slice(0, 6).map((s) => s.key).join(', ')}${open.length > 6 ? '…' : ''}`);
          }
          await step('Validate', `${base} config --quiet && echo "compose file is valid"`);
          await step(`Start ${services.length ? services.join(', ') : 'every service'}`, `${base} up -d --remove-orphans ${svc}`);
          const crashed = await settleCheck(session, base, services);
          log.push({
            title: `Still running after ${SETTLE_SECONDS}s`,
            ok: !crashed.length,
            output: crashed.length ? crashed.map((c) => `${c.service}: ${c.state}, restarted ${c.restarts}×, exit code ${c.exitCode}`).join('\n') : 'every container is up',
          });
          res.json({ ok: !crashed.length, log, crashed });
          return;
        }
        if (op === 'validate') await step('Validate', `${base} config --quiet && echo "compose file is valid"`);
        else if (op === 'pull') await step('Pull images', `${base} pull --ignore-buildable ${svc}`);
        else if (op === 'restart') await step('Restart', `${base} restart ${svc}`);
        else if (op === 'stop') await step('Stop', `${base} stop ${svc}`);
        else if (op === 'down') await step('Stop and remove containers (volumes kept)', `${base} down`);
        else throw new Error(`unknown operation ${op}`);
        res.json({ ok: true, log, crashed: [] });
      } catch (err) {
        if (err instanceof BadRequest || log.length === 0) throw err;
        res.status(500).json({ error: (err as Error).message, log });
      }
    }),
  );
}
