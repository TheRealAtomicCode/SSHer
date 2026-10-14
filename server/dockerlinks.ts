// "Connects to": what a container talks to (a database, Redis, an HTTP service), whether it
// can actually reach it, and changing where it points without touching the app's own files.
//
// Detection of the links themselves happens in the client (client/src/links.ts) from the
// container's env and labels, which it already has. This module does the two things only the
// server can:
//
//   test  — connect from INSIDE the container's network namespace (nsenter), so localhost,
//           host.docker.internal, compose service names, firewalls and pg_hba all behave
//           exactly as they do for the app. A stopped or crash-looping container is tested
//           from a throwaway copy of its image on the same network(s).
//   save  — environment overrides go in <project dir>/ssher.override.yml, layered on after
//           the project's own compose files (see composeCmd in ops.ts), and the service is
//           recreated. Works the same whatever shape the original compose file has.
import posix from 'node:path/posix';
import type { Express, RequestHandler, Response } from 'express';
import {
  BadRequest,
  OVERRIDE_FILE,
  RE,
  badRequestRoute,
  composeCmd,
  need,
  port,
  run,
  str,
  writeRemote,
  type AsyncRoute,
  type SessionRequest,
} from './ops.js';
import { SUDO_STDIN, execWithInput, shellQuote, type SshSession } from './ssh.js';

type Kind = 'postgres' | 'redis' | 'http' | 'tcp';

interface TestStep {
  title: string;
  ok: boolean;
  detail: string;
  /** What to do about a failure, when we can tell. */
  hint?: string;
}

export interface Inspected {
  Id: string;
  Image: string;
  State: { Running: boolean; Pid?: number; Status: string };
  Config: { Labels: Record<string, string> | null };
  HostConfig: { ExtraHosts?: string[] | null; NetworkMode?: string };
  NetworkSettings: { Networks: Record<string, { IPAddress?: string; Aliases?: string[] | null }> | null };
}

export async function inspect(session: SshSession, id: string): Promise<Inspected> {
  need(RE.id.test(id), 'invalid container id');
  const out = await run(session, `docker inspect ${shellQuote(id)}`);
  if (out.code !== 0) throw new BadRequest((out.stderr || out.stdout).trim() || 'container not found');
  return (JSON.parse(out.stdout) as Inspected[])[0];
}

/** Runs `script` as root with bash reading it from stdin, so secrets in it never appear on a
 *  command line (the activity log, `ps`). `-k` makes sudo always read its password line —
 *  with a cached timestamp it would skip it, and bash would run the password as a command. */
export function rootScript(session: SshSession, script: string) {
  const command =
    session.username === 'root' ? 'bash -s' : session.sudoPassword ? `${SUDO_STDIN} -k bash -s` : 'sudo -n bash -s';
  return execWithInput(session, command, script);
}

const isIPv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** Host names a container could be told to use. Deliberately strict: they reach a shell. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;

// ---------------------------------------------------------------- the netns to test from

interface Vantage {
  pid: number;
  /** Container to `docker exec` into for name lookups. */
  cid: string;
  /** Set when a throwaway copy was started; removed afterwards. */
  temporary: string;
  note: string;
}

async function vantage(session: SshSession, c: Inspected, extraHosts: string[]): Promise<Vantage> {
  if (c.State.Running && c.State.Pid) {
    return { pid: c.State.Pid, cid: c.Id.slice(0, 12), temporary: '', note: 'Tested from inside the running container.' };
  }
  const networks = Object.keys(c.NetworkSettings.Networks ?? {});
  const mode = c.HostConfig.NetworkMode ?? '';
  const first = networks[0] ?? (mode && mode !== 'default' ? mode : 'bridge');
  need(RE.id.test(first), `cannot test from network ${first}`);
  const hosts = [...new Set([...(c.HostConfig.ExtraHosts ?? []), ...extraHosts])]
    .filter((h) => /^[A-Za-z0-9._-]+:[A-Za-z0-9.:_-]+$/.test(h))
    .map((h) => `--add-host ${shellQuote(h)}`)
    .join(' ');
  // `sleep` is in both busybox and coreutils, so this works for alpine and debian images.
  const started = await run(
    session,
    `docker run -d --rm --network ${shellQuote(first)} ${hosts} --entrypoint sleep ${shellQuote(c.Image)} 120 2>&1`,
  );
  const tmp = started.stdout.trim().split('\n').pop() ?? '';
  if (started.code !== 0 || !/^[0-9a-f]{12,64}$/.test(tmp)) {
    throw new Error(
      `The container is not running, and a test copy of its image could not be started:\n${started.stdout.trim()}`,
    );
  }
  for (const n of networks.slice(1)) {
    if (RE.id.test(n)) await run(session, `docker network connect ${shellQuote(n)} ${tmp} 2>&1`);
  }
  const pid = Number((await run(session, `docker inspect -f '{{.State.Pid}}' ${tmp}`)).stdout.trim());
  if (!pid) {
    await run(session, `docker rm -f ${tmp} >/dev/null 2>&1`);
    throw new Error('The container is not running, and its test copy exited straight away.');
  }
  return {
    pid,
    cid: tmp.slice(0, 12),
    temporary: tmp,
    note: `The container is ${c.State.Status}, so this ran from a temporary copy of its image on the same network.`,
  };
}

// ---------------------------------------------------------------- name resolution

async function resolve(
  session: SshSession,
  c: Inspected,
  v: Vantage,
  host: string,
): Promise<{ ip: string; how: string; addsHostGateway: boolean } | null> {
  if (isIPv4(host)) return { ip: host, how: 'an IP address', addsHostGateway: false };

  // 1. The container's /etc/hosts: extra_hosts (host.docker.internal), its own name, localhost.
  const hosts = await run(session, `cat /proc/${v.pid}/root/etc/hosts 2>/dev/null`, true);
  for (const line of hosts.stdout.split('\n')) {
    const [ip, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (ip && isIPv4(ip) && names.some((n) => n.toLowerCase() === host.toLowerCase())) {
      return { ip, how: "the container's /etc/hosts", addsHostGateway: false };
    }
  }

  // 2. Its DNS: Docker's embedded resolver answers compose service names and aliases.
  const viaExec = await run(session, `timeout 6 docker exec ${v.cid} getent ahostsv4 ${shellQuote(host)} 2>/dev/null`, true);
  const execIp = viaExec.stdout.trim().split(/\s+/)[0];
  if (viaExec.code === 0 && isIPv4(execIp)) return { ip: execIp, how: "the container's DNS", addsHostGateway: false };

  // 3. The image may have no getent: look the name up among containers on the same networks.
  const nets = new Set(Object.keys(c.NetworkSettings.Networks ?? {}));
  const peers = await run(
    session,
    `ids=$(docker ps -q); [ -n "$ids" ] && docker inspect -f '{{json .NetworkSettings.Networks}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.service"}}' $ids`,
    true,
  );
  for (const line of peers.stdout.split('\n').filter(Boolean)) {
    const [json, name, service] = line.split('|');
    const names = [name.replace(/^\//, ''), service].filter(Boolean);
    try {
      for (const [net, n] of Object.entries(JSON.parse(json) as Record<string, { IPAddress: string; Aliases: string[] | null }>)) {
        if (!nets.has(net) || !n.IPAddress) continue;
        if ([...names, ...(n.Aliases ?? [])].some((x) => x.toLowerCase() === host.toLowerCase())) {
          return { ip: n.IPAddress, how: `container ${name.replace(/^\//, '')} on network ${net}`, addsHostGateway: false };
        }
      }
    } catch {
      /* skip a container that changed mid-listing */
    }
  }

  // 4. host.docker.internal only exists where extra_hosts adds it. Saving adds it, so test
  //    against what it will be: the default bridge's gateway, which is what host-gateway means.
  if (host.toLowerCase() === 'host.docker.internal') {
    const gw = await run(session, `docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}'`, true);
    const ip = gw.stdout.trim().split(/\s+/).find(isIPv4);
    if (ip) return { ip, how: 'host-gateway (not defined in this container yet)', addsHostGateway: true };
  }

  // 5. Public names: the server's resolver (the container normally forwards to it).
  const viaHost = await run(session, `getent ahostsv4 ${shellQuote(host)} 2>/dev/null`, true);
  const hostIp = viaHost.stdout.trim().split(/\s+/)[0];
  if (isIPv4(hostIp)) return { ip: hostIp, how: "the server's DNS", addsHostGateway: false };
  return null;
}

// ---------------------------------------------------------------- the probe

// Runs as root in bash. Parameters arrive as assignments prepended by probeScript(). Each
// check prints one line "@@<name>\t<exit code>\t<output>". Written without "${" so it can
// live in a template literal; bash printf turns the \r \n and octal escapes into bytes.
const PROBE = String.raw`
export LC_ALL=C
NS="nsenter -t $PID -n"
emit() { printf '@@%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\r\n\t' '   ' | cut -c1-800)"; }

out=$($NS timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$IP" "$PORT" 2>&1); emit tcp $? "$out"

if [ "$KIND" = postgres ]; then
  # SSLRequest: a Postgres server answers one byte, S or N.
  out=$($NS timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1" || exit 9; printf "\000\000\000\010\004\322\026\057" >&3; head -c1 <&3' "$IP" "$PORT" 2>&1)
  emit pg_hello $? "$out"
  if [ -n "$DBUSER" ]; then
    if command -v psql >/dev/null 2>&1; then
      out=$(PGHOST="$IP" PGPORT="$PORT" PGUSER="$DBUSER" PGPASSWORD="$PASS" PGDATABASE="$DB" PGCONNECT_TIMEOUT=6 PGSSLMODE=prefer \
        $NS timeout 10 psql -XtA -c 'select current_user || chr(64) || current_database() || chr(32) || split_part(version(), chr(32), 2)' 2>&1)
      emit pg_login $? "$out"
    else
      emit pg_login 127 "psql is not installed on this server"
    fi
  fi
fi

if [ "$KIND" = redis ]; then
  out=$($NS timeout 8 bash -c '
    exec 3<>"/dev/tcp/$0/$1" || exit 9
    if [ -n "$3" ]; then
      if [ -n "$2" ]; then
        printf "*3\r\n\$4\r\nAUTH\r\n\$%d\r\n%s\r\n\$%d\r\n%s\r\n" "$(printf %s "$2" | wc -c)" "$2" "$(printf %s "$3" | wc -c)" "$3" >&3
      else
        printf "*2\r\n\$4\r\nAUTH\r\n\$%d\r\n%s\r\n" "$(printf %s "$3" | wc -c)" "$3" >&3
      fi
      IFS= read -r -t 4 a <&3; printf "AUTH=%s|" "$a"
    fi
    printf "*1\r\n\$4\r\nPING\r\n" >&3
    IFS= read -r -t 4 b <&3; printf "PING=%s" "$b"
  ' "$IP" "$PORT" "$DBUSER" "$PASS" 2>&1)
  emit redis $? "$out"
fi

if [ "$KIND" = http ]; then
  if command -v curl >/dev/null 2>&1; then
    out=$($NS curl -sk -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$URLHOST:$PORT:$IP" "$URL" 2>&1)
    emit http $? "$out"
  else
    emit http 127 "curl is not installed on this server"
  fi
fi
`;

export function probeScript(params: Record<string, string | number>): string {
  const lines = Object.entries(params).map(([k, v]) => `${k}=${shellQuote(String(v))}`);
  return `${lines.join('\n')}\n${PROBE}`;
}

export function parseProbe(out: string): Record<string, { code: number; out: string }> {
  const result: Record<string, { code: number; out: string }> = {};
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)\t(\d+)\t(.*)$/.exec(line);
    if (m) result[m[1]] = { code: Number(m[2]), out: m[3].trim() };
  }
  return result;
}

function tcpStep(r: { code: number; out: string } | undefined, ip: string, p: number, host: string): TestStep {
  const title = `Open a TCP connection to ${ip}:${p}`;
  if (!r) return { title, ok: false, detail: 'no answer from the test' };
  if (r.code === 0) return { title, ok: true, detail: 'connected' };
  const local = host === 'localhost' || ip.startsWith('127.');
  if (/refused/i.test(r.out)) {
    return {
      title,
      ok: false,
      detail: 'connection refused — nothing is listening there',
      hint: local
        ? 'Inside a container, localhost is the container itself. Use host.docker.internal for a service on the server, or the other container\'s name.'
        : 'The service is down, on another port, or only listening on 127.0.0.1. A database on the server must listen on the Docker bridge too (Postgres: listen_addresses = \'*\').',
    };
  }
  if (r.code === 124) {
    return {
      title,
      ok: false,
      detail: 'timed out — packets are being dropped',
      hint: 'Usually a firewall. With ufw, allow the Docker networks: ufw allow from 172.16.0.0/12 to any port ' + p,
    };
  }
  return { title, ok: false, detail: r.out || `failed (exit ${r.code})` };
}

function pgSteps(probe: Record<string, { code: number; out: string }>, user: string, database: string): TestStep[] {
  const steps: TestStep[] = [];
  const hello = probe.pg_hello;
  if (hello) {
    const ok = hello.code === 0 && (hello.out === 'S' || hello.out === 'N');
    steps.push({
      title: 'Talk to it as PostgreSQL',
      ok,
      detail: ok ? `PostgreSQL answered (SSL ${hello.out === 'S' ? 'available' : 'off'})` : `not a PostgreSQL server (${hello.out || 'no answer'})`,
      hint: ok ? undefined : 'Something else is listening on that port. Check the port number.',
    });
  }
  const login = probe.pg_login;
  if (!login) {
    steps.push({ title: 'Log in', ok: false, detail: 'skipped — no user set' });
    return steps;
  }
  if (login.code === 127 && /psql is not installed/.test(login.out)) {
    steps.push({
      title: 'Log in',
      ok: true,
      detail: 'not checked: psql is not installed on this server (apt install postgresql-client)',
    });
    return steps;
  }
  if (login.code === 0) {
    const [who, ver] = login.out.split(' ');
    steps.push({ title: `Log in as ${user}`, ok: true, detail: `logged in as ${who}${ver ? ` — PostgreSQL ${ver}` : ''}` });
    return steps;
  }
  const out = login.out.replace(/^psql: error: /, '');
  let hint: string | undefined;
  if (/no pg_hba\.conf entry/i.test(out)) {
    const from = /host "([^"]+)"/.exec(out)?.[1] ?? 'the container';
    hint = `Postgres refuses connections from ${from}. Add a pg_hba.conf line for the Docker networks (Postgres → Access, or: host all all 172.16.0.0/12 scram-sha-256) and reload.`;
  } else if (/password authentication failed/i.test(out)) hint = 'Wrong user or password.';
  else if (/database "[^"]+" does not exist/i.test(out)) hint = `There is no database "${database}" on that server. Check the name (it is case-sensitive).`;
  else if (/role "[^"]+" does not exist/i.test(out)) hint = `There is no user "${user}" on that server.`;
  steps.push({ title: `Log in as ${user}`, ok: false, detail: out, hint });
  return steps;
}

function redisStep(r: { code: number; out: string } | undefined, hasPassword: boolean): TestStep {
  const title = hasPassword ? 'Authenticate and PING Redis' : 'PING Redis';
  if (!r) return { title, ok: false, detail: 'no answer' };
  const auth = /AUTH=([^|]*)/.exec(r.out)?.[1]?.trim() ?? '';
  const ping = /PING=(.*)$/.exec(r.out)?.[1]?.trim() ?? '';
  if (auth && !auth.startsWith('+OK')) {
    return {
      title,
      ok: false,
      detail: auth,
      hint: /without any password configured/i.test(auth)
        ? 'This Redis has no password, so leave it empty — or start Redis with requirepass.'
        : 'Wrong password (or user).',
    };
  }
  if (ping.startsWith('+PONG')) return { title, ok: true, detail: 'PONG' };
  if (/NOAUTH/i.test(ping)) return { title, ok: false, detail: ping, hint: 'This Redis needs a password.' };
  return { title, ok: false, detail: ping || r.out || 'not a Redis server', hint: ping ? undefined : 'Something else is listening on that port.' };
}

// ---------------------------------------------------------------- overrides file

/** service -> its overrides. Only the shape writeOverride() produces is accepted. */
export type Overrides = Map<string, ServiceOverrides>;
export interface ServiceOverrides {
  env: Map<string, string>;
  extraHosts: Set<string>;
  /** Bind mounts ("host:container") — the Config tab's editable copies of files from the image. */
  volumes: Set<string>;
}
export const emptyOverrides = (): ServiceOverrides => ({ env: new Map(), extraHosts: new Set(), volumes: new Set() });

const unquote = (v: string) => {
  const s = v.trim();
  const raw = s.startsWith('"') ? (JSON.parse(s) as string) : s.replace(/^'(.*)'$/, '$1');
  return raw.replace(/\$\$/g, '$');
};
const quote = (v: string) => JSON.stringify(v.replace(/\$/g, '$$$$'));

export function parseOverrides(text: string): Overrides {
  const map: Overrides = new Map();
  let service = '';
  let section = '';
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    let m: RegExpExecArray | null;
    if (line === 'services:') continue;
    if ((m = /^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):$/.exec(line))) {
      service = m[1];
      map.set(service, emptyOverrides());
    } else if ((m = /^ {4}(environment|extra_hosts|volumes):$/.exec(line)) && service) section = m[1];
    else if ((m = /^ {6}([A-Za-z_][A-Za-z0-9_.]*): (.*)$/.exec(line)) && service && section === 'environment') {
      map.get(service)!.env.set(m[1], unquote(m[2]));
    } else if ((m = /^ {6}- (.*)$/.exec(line)) && service && section === 'extra_hosts') {
      map.get(service)!.extraHosts.add(unquote(m[1]));
    } else if ((m = /^ {6}- (.*)$/.exec(line)) && service && section === 'volumes') {
      map.get(service)!.volumes.add(unquote(m[1]));
    } else {
      throw new BadRequest(
        `${OVERRIDE_FILE} line ${i + 1} is not in the shape SSHer writes ("${line.trim()}"). Fix or delete the file, then try again.`,
      );
    }
  }
  return map;
}

export function renderOverrides(map: Overrides): string {
  const lines = [
    '# Managed by SSHer (Docker → container → Connects to / Config). Values here win over the compose',
    '# files and env files the project was started with. Hand edits are fine if they keep this',
    '# shape. By hand, add it last:  docker compose ... -f <your files> -f ' + OVERRIDE_FILE + ' up -d',
    'services:',
  ];
  for (const [service, o] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    if (!o.env.size && !o.extraHosts.size && !o.volumes.size) continue;
    lines.push(`  ${service}:`);
    if (o.env.size) {
      lines.push('    environment:');
      for (const [k, v] of [...o.env].sort(([a], [b]) => a.localeCompare(b))) lines.push(`      ${k}: ${quote(v)}`);
    }
    if (o.extraHosts.size) {
      lines.push('    extra_hosts:');
      for (const h of o.extraHosts) lines.push(`      - ${quote(h)}`);
    }
    if (o.volumes.size) {
      lines.push('    volumes:');
      for (const v of o.volumes) lines.push(`      - ${quote(v)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface ComposeLabels {
  project: string;
  service: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
}

export function composeOf(c: Inspected): ComposeLabels | null {
  const l = c.Config.Labels ?? {};
  const split = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (!l['com.docker.compose.project'] || !l['com.docker.compose.project.working_dir']) return null;
  return {
    project: l['com.docker.compose.project'],
    service: l['com.docker.compose.service'] ?? '',
    workingDir: l['com.docker.compose.project.working_dir'],
    configFiles: split(l['com.docker.compose.project.config_files']),
    envFiles: split(l['com.docker.compose.project.environment_file']),
  };
}

export async function readOverrides(session: SshSession, compose: ComposeLabels): Promise<{ path: string; text: string; map: Overrides }> {
  const path = posix.join(compose.workingDir, OVERRIDE_FILE);
  const out = await run(session, `cat ${shellQuote(path)} 2>/dev/null`, true);
  const text = out.code === 0 ? out.stdout : '';
  return { path, text, map: parseOverrides(text) };
}

// ---------------------------------------------------------------- routes

export function registerDockerLinks(app: Express, requireSession: RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  /** Which env keys SSHer currently overrides for this container, and whether it can. */
  app.get(
    '/api/docker/links/overrides',
    requireSession,
    route(async (req, res) => {
      const c = await inspect(req.session!, str(req.query.id));
      const compose = composeOf(c);
      if (!compose || !compose.service) {
        res.json({
          editable: false,
          reason: 'This container was not started by docker compose, so there is no file to keep a change in. Redeploy it with Deploy new to make it editable.',
          file: '',
          env: {},
        });
        return;
      }
      const { path, map } = await readOverrides(req.session!, compose);
      res.json({ editable: true, reason: '', file: path, env: Object.fromEntries(map.get(compose.service)?.env ?? []) });
    }),
  );

  /** Can this container reach host:port, and does the service there accept us? */
  app.post(
    '/api/docker/links/test',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const body = req.body ?? {};
      const kind = (['postgres', 'redis', 'http', 'tcp'] as const).find((k) => k === body.kind) ?? 'tcp';
      let host = str(body.host);
      let p = Number(body.port) || 0;
      const url = str(body.url);
      let urlHost = '';
      if (kind === 'http') {
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          throw new BadRequest(`Not a URL: ${url || '(empty)'}`);
        }
        need(u.protocol === 'http:' || u.protocol === 'https:', 'Only http:// and https:// URLs can be tested');
        host = u.hostname.replace(/^\[|\]$/g, '');
        urlHost = host;
        p = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      }
      need(HOST_RE.test(host), `Not a valid host name: ${host || '(empty)'}`);
      p = port(p, 'Port');
      const user = String(body.user ?? '');
      const password = String(body.password ?? '');
      const database = String(body.database ?? '');
      for (const v of [user, password, database, url]) need(!/[\0\n\r]/.test(v), 'Values cannot contain line breaks');

      const c = await inspect(session, str(body.id));
      const steps: TestStep[] = [];
      const wantsGateway = host.toLowerCase() === 'host.docker.internal' ? ['host.docker.internal:host-gateway'] : [];
      let v: Vantage;
      try {
        v = await vantage(session, c, wantsGateway);
      } catch (err) {
        res.json({ ok: false, note: '', steps: [{ title: 'Get inside the container', ok: false, detail: (err as Error).message }] });
        return;
      }
      try {
        const r = await resolve(session, c, v, host);
        if (!r) {
          steps.push({
            title: `Find ${host}`,
            ok: false,
            detail: 'the name does not resolve from this container',
            hint:
              'A container on another compose project is not visible by name: use host.docker.internal with its published port, or put both on one network.',
          });
          res.json({ ok: false, note: v.note, steps });
          return;
        }
        steps.push({
          title: `Find ${host}`,
          ok: true,
          detail: `${r.ip} (via ${r.how})`,
          hint: r.addsHostGateway ? 'host.docker.internal is added to the container (extra_hosts) when you save.' : undefined,
        });

        const result = await rootScript(
          session,
          probeScript({ PID: v.pid, IP: r.ip, PORT: p, KIND: kind, DB: database, DBUSER: user, PASS: password, URL: url, URLHOST: urlHost }),
        );
        const probe = parseProbe(result.stdout);
        if (!probe.tcp) {
          steps.push({ title: 'Run the test', ok: false, detail: (result.stderr || result.stdout).trim() || 'the test did not run' });
        } else {
          const tcp = tcpStep(probe.tcp, r.ip, p, host);
          steps.push(tcp);
          if (tcp.ok) {
            if (kind === 'postgres') steps.push(...pgSteps(probe, user, database));
            if (kind === 'redis') steps.push(redisStep(probe.redis, Boolean(password)));
            if (kind === 'http') {
              const h = probe.http;
              const code = Number(h?.out);
              steps.push({
                title: `GET ${url}`,
                ok: Boolean(h && h.code === 0 && code > 0 && code < 500),
                detail: h?.code === 0 ? `HTTP ${h.out}` : h?.out || 'no answer',
              });
            }
          }
        }
        res.json({ ok: steps.every((s) => s.ok), note: v.note, steps });
      } finally {
        if (v.temporary) await run(session, `docker rm -f ${v.temporary} >/dev/null 2>&1`, true);
      }
    }),
  );

  /** Writes env overrides for the container's compose service and recreates it. */
  app.post(
    '/api/docker/links/save',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const body = req.body ?? {};
      const c = await inspect(session, str(body.id));
      const compose = composeOf(c);
      need(compose && compose.service, 'This container was not started by docker compose, so it cannot be changed in place.');
      const set = (body.set && typeof body.set === 'object' ? body.set : {}) as Record<string, unknown>;
      const unset = Array.isArray(body.unset) ? body.unset.map(String) : [];
      for (const [k, v] of Object.entries(set)) {
        need(RE.envKey.test(k), `Invalid variable name: ${k}`);
        need(typeof v === 'string' && !/[\0\n\r]/.test(v), `${k} must be a single line`);
      }
      for (const k of unset) need(RE.envKey.test(k), `Invalid variable name: ${k}`);

      const { path, text, map } = await readOverrides(session, compose);
      const entry = map.get(compose.service) ?? emptyOverrides();
      for (const k of unset) entry.env.delete(k);
      for (const [k, v] of Object.entries(set)) entry.env.set(k, v as string);
      const hasGateway = (c.HostConfig.ExtraHosts ?? []).some((h) => h.startsWith('host.docker.internal:'));
      if (!hasGateway && [...entry.env.values()].some((v) => /host\.docker\.internal/i.test(v))) {
        entry.extraHosts.add('host.docker.internal:host-gateway');
      }
      map.set(compose.service, entry);
      const content = renderOverrides(map);

      const log: { title: string; ok: boolean; output: string }[] = [];
      const step = async (title: string, command: string) => {
        const r = await run(session, `${command} 2>&1`);
        const output = (r.stdout + r.stderr).trim();
        log.push({ title, ok: r.code === 0, output });
        return r.code === 0;
      };

      await writeRemote(session, path, content);
      log.push({ title: `Write ${path}`, ok: true, output: content });
      const base = composeCmd(compose);
      if (!(await step('Validate the compose files', `${base} config --quiet && echo valid`))) {
        // Put the previous file back so the project keeps working exactly as before.
        if (text) await writeRemote(session, path, text);
        else await run(session, `rm -f ${shellQuote(path)}`);
        res.status(500).json({ error: 'The compose files did not validate with the change, so it was undone.', log });
        return;
      }
      if (!(await step(`Recreate ${compose.service}`, `${base} up -d --no-build ${shellQuote(compose.service)}`))) {
        res.status(500).json({ error: `Recreating ${compose.service} failed.`, log });
        return;
      }
      await step('Status', `${base} ps ${shellQuote(compose.service)}`);
      res.json({ ok: true, log, file: path });
    }),
  );
}
