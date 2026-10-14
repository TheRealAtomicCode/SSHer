// What a container connects to, read from its environment — and how to write a change back.
//
// An image (or a compose service) can DECLARE its links with labels, which is exact:
//
//   io.ssher.link.database = "postgres host=DB_HOST_IN_DOCKER port=DB_PORT database=DB_NAME user=DB_USER password=DB_PASSWORD"
//   io.ssher.link.redis    = "redis host=REDIS_HOST_IN_DOCKER port=REDIS_PORT password=REDIS_PASSWORD"
//   io.ssher.link.api      = "http url=API_BASE"
//   io.ssher.link.db       = "postgres connstr=ConnectionStrings__Default"
//   io.ssher.link.<name>.note = "free text shown under it"
//
// Kinds: postgres | redis | http | tcp. Fields name the env variables that hold each part:
// host port database user password (discrete), url (one URI), connstr (Npgsql/ADO
// "Host=…;Port=…" or StackExchange.Redis "host:port,password=…").
//
// Without labels the links are guessed from the env: connection strings, URLs, and groups of
// X_HOST / X_PORT / X_USER / X_PASSWORD / X_NAME (preferring X_HOST_IN_DOCKER when both exist).

export type LinkKind = 'postgres' | 'redis' | 'http' | 'tcp';
export type Part = 'host' | 'port' | 'database' | 'user' | 'password' | 'url';
export type Parts = Record<Part, string>;

type Shape =
  | { type: 'fields'; keys: Partial<Record<Exclude<Part, 'url'>, string>> }
  | { type: 'url'; key: string }
  | { type: 'connstr'; key: string; flavor: 'ado' | 'redis' };

export interface Link {
  id: string;
  name: string;
  kind: LinkKind;
  declared: boolean;
  note: string;
  shape: Shape;
}

export const DEFAULT_PORT: Record<LinkKind, string> = { postgres: '5432', redis: '6379', http: '', tcp: '' };

const LABEL = 'io.ssher.link.';

// ---------------------------------------------------------------- detection

function fromLabels(labels: Record<string, string>): Link[] {
  const links: Link[] = [];
  for (const [label, value] of Object.entries(labels)) {
    if (!label.startsWith(LABEL) || label.endsWith('.note')) continue;
    const id = label.slice(LABEL.length);
    const [kindWord, ...pairs] = value.trim().split(/\s+/);
    const kind = (['postgres', 'redis', 'http', 'tcp'] as const).find((k) => k === kindWord) ?? 'tcp';
    const fields: Record<string, string> = {};
    for (const p of pairs) {
      const eq = p.indexOf('=');
      if (eq > 0) fields[p.slice(0, eq)] = p.slice(eq + 1);
    }
    let shape: Shape;
    if (fields.url) shape = { type: 'url', key: fields.url };
    else if (fields.connstr) shape = { type: 'connstr', key: fields.connstr, flavor: kind === 'redis' ? 'redis' : 'ado' };
    else {
      const keys: Partial<Record<Exclude<Part, 'url'>, string>> = {};
      for (const k of ['host', 'port', 'database', 'user', 'password'] as const) if (fields[k]) keys[k] = fields[k];
      shape = { type: 'fields', keys };
    }
    links.push({ id, name: id, kind, declared: true, note: labels[`${label}.note`] ?? '', shape });
  }
  return links.sort((a, b) => a.id.localeCompare(b.id));
}

const SCHEME_KIND: Record<string, LinkKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  redis: 'redis',
  rediss: 'redis',
  http: 'http',
  https: 'http',
};

function guessKind(name: string, port: string): LinkKind {
  if (/pg|postgres|npgsql/i.test(name) || port === '5432') return 'postgres';
  if (/redis/i.test(name) || port === '6379') return 'redis';
  return 'tcp';
}

function detect(env: Record<string, string>, skip: Set<string>, seen: Set<string>): Link[] {
  const links: Link[] = [];
  const keys = Object.keys(env).filter((k) => !skip.has(k) && env[k]);

  // Connection strings and URIs, one variable each.
  for (const key of keys) {
    const value = env[key];
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
    if (scheme && /url|uri|dsn|endpoint|upstream|host|server|base|conn|database|redis/i.test(key) && !/^urls?__/i.test(key)) {
      links.push({ id: key, name: key, kind: SCHEME_KIND[scheme] ?? 'tcp', declared: false, note: '', shape: { type: 'url', key } });
    } else if (/(^|;)\s*(host|server|data source)\s*=/i.test(value)) {
      const parts = parseAdo(value);
      links.push({
        id: key,
        name: key.replace(/^ConnectionStrings__/i, ''),
        // Npgsql spells it Host=; SQL Server uses Server= / Data Source=.
        kind: /(^|;)\s*host\s*=/i.test(value) ? 'postgres' : guessKind(key + value, parts.port),
        declared: false,
        note: '',
        shape: { type: 'connstr', key, flavor: 'ado' },
      });
    } else if (/redis/i.test(key) && /^[A-Za-z0-9._-]+:\d+(,|$)/.test(value)) {
      links.push({ id: key, name: key.replace(/^ConnectionStrings__/i, ''), kind: 'redis', declared: false, note: '', shape: { type: 'connstr', key, flavor: 'redis' } });
    }
  }

  // X_HOST (+ X_HOST_IN_DOCKER) / X_PORT / X_USER / X_PASSWORD / X_NAME groups.
  const groups = new Map<string, string>();
  for (const key of keys) {
    const m = /^(.+?)_(HOST|HOSTNAME|SERVER|ADDR|ADDRESS)(_IN_DOCKER)?$/i.exec(key);
    if (!m || !/^[A-Za-z0-9._-]+$/.test(env[key])) continue;
    const prefix = m[1];
    // A declared link already owns this group (it named DB_HOST_IN_DOCKER; DB_HOST is the
    // same database seen from the server, not a second link).
    if ([...skip].some((k) => k.startsWith(`${prefix}_`))) continue;
    // Inside a container the _IN_DOCKER variant is the one the app uses.
    if (!groups.has(prefix) || m[3]) groups.set(prefix, key);
  }
  const pick = (prefix: string, names: string[]) =>
    names.map((n) => `${prefix}_${n}`).find((k) => k in env && !skip.has(k));
  for (const [prefix, hostKey] of groups) {
    const shape: Shape = {
      type: 'fields',
      keys: {
        host: hostKey,
        port: pick(prefix, ['PORT']),
        database: pick(prefix, ['NAME', 'DB', 'DATABASE', 'DBNAME']),
        user: pick(prefix, ['USER', 'USERNAME']),
        password: pick(prefix, ['PASSWORD', 'PASS', 'PWD']),
      },
    };
    const port = shape.keys.port ? env[shape.keys.port] : '';
    links.push({ id: prefix, name: prefix, kind: guessKind(prefix, port), declared: false, note: '', shape });
  }

  // The same target found twice (a composed connection string AND its parts): keep the
  // first, which is the variable the app actually reads.
  return links.filter((l) => {
    const p = readParts(l, env);
    const target = `${p.host.toLowerCase()}:${p.port}`;
    if (!p.host || seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

const targetOf = (l: Link, env: Record<string, string>) => {
  const p = readParts(l, env);
  return `${p.host.toLowerCase()}:${p.port}`;
};

/** Declared links, everything else that looks like one, and `mirrors`: connection strings
 *  carrying the same address as a declared link. Those are what the app really reads when a
 *  compose file sets one explicitly (it then wins over the discrete parts), so saving the
 *  declared link must update them too or the change silently does nothing. */
export function findLinks(
  env: Record<string, string>,
  labels: Record<string, string>,
): { declared: Link[]; detected: Link[]; mirrors: Record<string, Link[]> } {
  const declared = fromLabels(labels);
  const used = new Set(declared.flatMap(envKeys));
  const byTarget = new Map(declared.map((l) => [targetOf(l, env), l.id]));
  const mirrors: Record<string, Link[]> = {};
  const detected: Link[] = [];
  for (const l of detect(env, used, new Set())) {
    const owner = byTarget.get(targetOf(l, env));
    if (!owner) detected.push(l);
    else if (l.shape.type !== 'fields') (mirrors[owner] ??= []).push(l);
  }
  return { declared, detected, mirrors };
}

export function envKeys(link: Link): string[] {
  return link.shape.type === 'fields' ? Object.values(link.shape.keys).filter(Boolean) as string[] : [link.shape.key];
}

// ---------------------------------------------------------------- parts

const ADO_KEYS: Record<Exclude<Part, 'url'>, string[]> = {
  host: ['host', 'server', 'data source', 'address', 'addr'],
  port: ['port'],
  database: ['database', 'initial catalog', 'db'],
  user: ['username', 'user id', 'userid', 'user', 'uid'],
  password: ['password', 'pwd'],
};

function adoPairs(value: string): { key: string; value: string }[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const eq = s.indexOf('=');
      return eq < 0 ? { key: s, value: '' } : { key: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() };
    });
}

function parseAdo(value: string): Parts {
  const parts: Parts = { host: '', port: '', database: '', user: '', password: '', url: '' };
  for (const { key, value: v } of adoPairs(value)) {
    for (const [part, names] of Object.entries(ADO_KEYS)) {
      if (names.includes(key.toLowerCase())) parts[part as Part] = v;
    }
  }
  return parts;
}

function writeAdo(original: string, parts: Parts, kind: LinkKind): string {
  const pairs = adoPairs(original);
  const done = new Set<string>();
  for (const pair of pairs) {
    for (const [part, names] of Object.entries(ADO_KEYS)) {
      if (names.includes(pair.key.toLowerCase())) {
        pair.value = parts[part as Part];
        done.add(part);
      }
    }
  }
  const label: Record<string, string> = { host: 'Host', port: 'Port', database: 'Database', user: 'Username', password: 'Password' };
  for (const part of ['host', 'port', 'database', 'user', 'password']) {
    if (!done.has(part) && parts[part as Part] && !(part === 'port' && parts.port === DEFAULT_PORT[kind])) {
      pairs.push({ key: label[part], value: parts[part as Part] });
    }
  }
  return pairs.map((p) => (p.value || p.key.includes('=') ? `${p.key}=${p.value}` : p.key)).join(';');
}

function parseRedisConn(value: string): Parts {
  const [first, ...opts] = value.split(',');
  const colon = first.lastIndexOf(':');
  const parts: Parts = {
    host: colon > 0 ? first.slice(0, colon) : first,
    port: colon > 0 ? first.slice(colon + 1) : '',
    database: '',
    user: '',
    password: '',
    url: '',
  };
  for (const o of opts) {
    const eq = o.indexOf('=');
    const k = o.slice(0, eq).trim().toLowerCase();
    const v = o.slice(eq + 1);
    if (k === 'password') parts.password = v;
    else if (k === 'user') parts.user = v;
    else if (k === 'defaultdatabase') parts.database = v;
  }
  return parts;
}

function writeRedisConn(original: string, parts: Parts): string {
  const opts = original.split(',').slice(1).filter((o) => !/^\s*(password|user|defaultDatabase)=/i.test(o));
  if (parts.database) opts.unshift(`defaultDatabase=${parts.database}`);
  if (parts.user) opts.push(`user=${parts.user}`);
  if (parts.password) opts.push(`password=${parts.password}`);
  return [`${parts.host}:${parts.port || '6379'}`, ...opts].join(',');
}

function parseUrl(value: string): Parts {
  const parts: Parts = { host: '', port: '', database: '', user: '', password: '', url: value };
  try {
    const u = new URL(value);
    parts.host = u.hostname.replace(/^\[|\]$/g, '');
    parts.port = u.port || ({ 'http:': '80', 'https:': '443', 'postgres:': '5432', 'postgresql:': '5432', 'redis:': '6379', 'rediss:': '6379' } as Record<string, string>)[u.protocol] || '';
    parts.user = decodeURIComponent(u.username);
    parts.password = decodeURIComponent(u.password);
    parts.database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    /* left as a bare URL */
  }
  return parts;
}

function writeUrl(original: string, parts: Parts, kind: LinkKind): string {
  if (kind === 'http') return parts.url;
  try {
    const u = new URL(original);
    u.hostname = parts.host;
    u.port = parts.port;
    u.username = encodeURIComponent(parts.user);
    u.password = encodeURIComponent(parts.password);
    u.pathname = parts.database ? `/${encodeURIComponent(parts.database)}` : '';
    return u.toString();
  } catch {
    return original;
  }
}

/** The link's target as editable parts, from the container's current env. */
export function readParts(link: Link, env: Record<string, string>): Parts {
  const s = link.shape;
  if (s.type === 'url') return parseUrl(env[s.key] ?? '');
  if (s.type === 'connstr') return s.flavor === 'redis' ? parseRedisConn(env[s.key] ?? '') : parseAdo(env[s.key] ?? '');
  const parts: Parts = { host: '', port: '', database: '', user: '', password: '', url: '' };
  for (const [part, key] of Object.entries(s.keys)) if (key) parts[part as Part] = env[key] ?? '';
  return parts;
}

/** The env variables to set so the container uses `parts` — only the ones that change. */
export function writeParts(link: Link, env: Record<string, string>, parts: Parts): Record<string, string> {
  const s = link.shape;
  const next: Record<string, string> = {};
  if (s.type === 'url') next[s.key] = writeUrl(env[s.key] ?? '', parts, link.kind);
  else if (s.type === 'connstr') {
    next[s.key] = s.flavor === 'redis' ? writeRedisConn(env[s.key] ?? '', parts) : writeAdo(env[s.key] ?? '', parts, link.kind);
  } else for (const [part, key] of Object.entries(s.keys)) if (key) next[key] = parts[part as Part];
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => (env[k] ?? '') !== v));
}

/** Which parts this link can carry — a discrete link only shows the fields it has. */
export function editableParts(link: Link): Part[] {
  if (link.kind === 'http') return ['url'];
  const s = link.shape;
  if (s.type === 'fields') return (['host', 'port', 'database', 'user', 'password'] as const).filter((p) => s.keys[p]);
  if (link.kind === 'redis') return ['host', 'port', 'user', 'password'];
  if (link.kind === 'tcp') return ['host', 'port'];
  return ['host', 'port', 'database', 'user', 'password'];
}

export function envOf(inspect: Record<string, unknown> | null): Record<string, string> {
  const list = ((inspect as { Config?: { Env?: string[] } } | null)?.Config?.Env ?? []) as string[];
  return Object.fromEntries(list.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
}

export function labelsOf(inspect: Record<string, unknown> | null): Record<string, string> {
  return ((inspect as { Config?: { Labels?: Record<string, string> | null } } | null)?.Config?.Labels ?? {}) as Record<string, string>;
}
