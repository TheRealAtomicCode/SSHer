// Server operations beyond files: Docker containers/images/deploys, and listening
// ports + the ufw firewall. Everything runs as shell commands over the SSH session,
// so it works on any Linux host with docker/ufw installed — nothing is installed
// on the remote side.
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import posix from 'node:path/posix';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { exec, execWithInput, shellQuote, type ExecResult, type SshSession } from './ssh.js';
import { advanceTransfer, finishTransfer, startTransfer } from './transfers.js';

export interface SessionRequest extends Request {
  session?: SshSession;
}
export type AsyncRoute = (
  handler: (req: SessionRequest, res: Response) => Promise<void>,
) => (req: Request, res: Response, next: NextFunction) => void;

// ------------------------------------------------------------------ helpers

/** Non-root logins go through `sudo -n` (fails fast instead of hanging on a password prompt). */
export function asRoot(session: SshSession, command: string): string {
  return session.username === 'root' ? command : `sudo -n sh -c ${shellQuote(command)}`;
}

export async function run(session: SshSession, command: string): Promise<ExecResult> {
  return exec(session, asRoot(session, command));
}

export async function runOrThrow(session: SshSession, command: string): Promise<string> {
  const result = await run(session, command);
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || `command failed with exit code ${result.code}`,
    );
  }
  return result.stdout;
}

/** File Explorer / archive / permissions actions are unprivileged by default
 *  (same level as plain SFTP). The sudo-mode toggle in the client header lets a
 *  request opt into running as root instead — never the reverse, so a stray
 *  request can't accidentally escalate on its own. */
export function execMaybeRoot(session: SshSession, command: string, sudo: boolean): Promise<ExecResult> {
  return exec(session, sudo ? asRoot(session, command) : command);
}

export async function execMaybeRootOrThrow(session: SshSession, command: string, sudo: boolean): Promise<string> {
  const result = await execMaybeRoot(session, command, sudo);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `command failed with exit code ${result.code}`);
  return result.stdout;
}

export async function writeRemote(session: SshSession, path: string, content: string): Promise<void> {
  const result = await execWithInput(
    session,
    asRoot(session, `tee ${shellQuote(path)} >/dev/null`),
    content,
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || `could not write ${path}`);
}

export class BadRequest extends Error {}

export const RE = {
  id: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  name: /^[a-z0-9][a-z0-9_-]{0,62}$/,
  image: /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/,
  envKey: /^[A-Za-z_][A-Za-z0-9_.]*$/,
  absPath: /^\/[^\0\n\r"'`$\\]*$/,
  volumeName: /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
  domain: /^(?=.{1,253}$)(\*\.)?([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/,
  source: /^[0-9a-fA-F:.]+(\/\d{1,3})?$/,
  portSpec: /^\d{1,5}(:\d{1,5})?$/,
  /** A proxy_pass target: `127.0.0.1:3002`, `localhost:3002`, or a bare hostname. */
  hostPort: /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:\d{1,5}$/,
};

export function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw new BadRequest(message);
}

export function port(value: unknown, label: string): number {
  const n = Number(value);
  need(Number.isInteger(n) && n >= 1 && n <= 65535, `${label} must be a port between 1 and 65535`);
  return n;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Wraps a route handler so a thrown `BadRequest` becomes a 400 instead of a 500 — the
 *  same mapping every module's routes want, so each one calls this once with its own
 *  `asyncRoute` rather than redefining the try/catch. */
export function badRequestRoute(
  asyncRoute: AsyncRoute,
  handler: (req: SessionRequest, res: Response) => Promise<void>,
) {
  return asyncRoute(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof BadRequest) res.status(400).json({ error: err.message });
      else throw err;
    }
  });
}

/** A YAML double-quoted scalar. JSON strings are valid YAML; `$` is doubled for compose. */
const yq = (value: string) => JSON.stringify(value.replace(/\$/g, '$$$$'));

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** `ghcr.io/x/app:prod` -> `ghcr.io/x/app`. A registry port (`host:5000/app`) is not a tag. */
function repoOf(image: string): string {
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? image.slice(0, colon) : image;
}

// ------------------------------------------------------------------- docker

export interface Container {
  id: string;
  name: string;
  image: string;
  imageId: string;
  /** Loaded from a file (`docker load`), not pulled — so there is no registry to pull updates from. */
  imageLocal: boolean;
  state: string;
  running: boolean;
  health: string | null;
  startedAt: string;
  createdAt: string;
  restartPolicy: string;
  ports: { containerPort: string; proto: string; hostIp: string; hostPort: string }[];
  networks: string[];
  mounts: { type: string; source: string; destination: string; rw: boolean }[];
  compose: {
    project: string;
    service: string;
    workingDir: string;
    configFiles: string[];
    envFiles: string[];
  } | null;
}

// Docker's inspect output is large and loosely typed; only the fields we read are listed.
interface Inspect {
  Id: string;
  Image: string;
  Name: string;
  Created: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Status: string; Running: boolean; StartedAt: string; Health?: { Status: string } };
  HostConfig: { RestartPolicy?: { Name: string } };
  NetworkSettings: {
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
    Networks: Record<string, unknown> | null;
  };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[] | null;
}

function toContainer(c: Inspect): Container {
  const labels = c.Config.Labels ?? {};
  const project = labels['com.docker.compose.project'];
  const split = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

  const ports: Container['ports'] = [];
  for (const [key, bindings] of Object.entries(c.NetworkSettings.Ports ?? {})) {
    const [containerPort, proto] = key.split('/');
    if (!bindings?.length) ports.push({ containerPort, proto, hostIp: '', hostPort: '' });
    else for (const b of bindings) ports.push({ containerPort, proto, hostIp: b.HostIp, hostPort: b.HostPort });
  }

  return {
    id: c.Id.slice(0, 12),
    name: c.Name.replace(/^\//, ''),
    image: c.Config.Image,
    imageId: c.Image,
    imageLocal: false,
    state: c.State.Status,
    running: c.State.Running,
    health: c.State.Health?.Status ?? null,
    startedAt: c.State.StartedAt,
    createdAt: c.Created,
    restartPolicy: c.HostConfig.RestartPolicy?.Name || 'no',
    ports,
    networks: Object.keys(c.NetworkSettings.Networks ?? {}),
    mounts: (c.Mounts ?? []).map((m) => ({
      type: m.Type,
      source: m.Source,
      destination: m.Destination,
      rw: m.RW,
    })),
    compose: project
      ? {
          project,
          service: labels['com.docker.compose.service'] ?? '',
          workingDir: labels['com.docker.compose.project.working_dir'] ?? '',
          configFiles: split(labels['com.docker.compose.project.config_files']),
          envFiles: split(labels['com.docker.compose.project.environment_file']),
        }
      : null,
  };
}

/** The `docker compose` prefix that reproduces how a project was originally brought up. */
function composeCmd(spec: {
  project: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
}): string {
  need(RE.id.test(spec.project), 'invalid compose project');
  need(RE.absPath.test(spec.workingDir), 'invalid working directory');
  for (const f of [...spec.configFiles, ...spec.envFiles]) need(RE.absPath.test(f), `invalid path ${f}`);
  const parts = [`cd ${shellQuote(spec.workingDir)} && docker compose -p ${shellQuote(spec.project)}`];
  for (const e of spec.envFiles) parts.push(`--env-file ${shellQuote(e)}`);
  for (const f of spec.configFiles) parts.push(`-f ${shellQuote(f)}`);
  return parts.join(' ');
}

interface DeploySpec {
  name: string;
  image: string;
  containerPort: number | null;
  hostPort: number | null;
  bindAddr: '127.0.0.1' | '0.0.0.0';
  restart: string;
  env: { key: string; value: string }[];
  volumes: { host: string; container: string }[];
  hostGateway: boolean;
  envFile: string;
  dir: string;
  domain: string;
  maxBody: string;
  firewall: boolean;
  overwrite: boolean;
}

function parseSpec(raw: Record<string, unknown>): DeploySpec {
  const name = str(raw.name);
  need(RE.name.test(name), 'Name must be lowercase letters, digits, - or _');
  const image = str(raw.image);
  need(RE.image.test(image), 'Invalid image reference');

  const containerPort = raw.containerPort ? port(raw.containerPort, 'Container port') : null;
  const hostPort = raw.hostPort ? port(raw.hostPort, 'Host port') : null;
  need(Boolean(containerPort) === Boolean(hostPort), 'Set both the host and container port, or neither');

  const bindAddr = raw.bindAddr === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const restart = ['no', 'always', 'unless-stopped', 'on-failure'].includes(str(raw.restart))
    ? str(raw.restart)
    : 'unless-stopped';

  const env = (Array.isArray(raw.env) ? raw.env : [])
    .map((e: { key?: unknown; value?: unknown }) => ({ key: str(e.key), value: String(e.value ?? '') }))
    .filter((e) => e.key);
  for (const e of env) {
    need(RE.envKey.test(e.key), `Invalid environment variable name: ${e.key}`);
    need(!/[\n\r]/.test(e.value), `${e.key} cannot contain a line break`);
  }

  const volumes = (Array.isArray(raw.volumes) ? raw.volumes : [])
    .map((v: { host?: unknown; container?: unknown }) => ({ host: str(v.host), container: str(v.container) }))
    .filter((v) => v.host || v.container);
  for (const v of volumes) {
    need(RE.absPath.test(v.container), `Container path must be absolute: ${v.container}`);
    need(
      RE.absPath.test(v.host) || RE.volumeName.test(v.host) || /^\.\/[^\0\n\r"'`$\\]*$/.test(v.host),
      `Host side must be an absolute path, ./relative path or a volume name: ${v.host}`,
    );
  }

  const dir = str(raw.dir) || `/opt/${name}`;
  need(RE.absPath.test(dir) && dir !== '/', 'Directory must be an absolute path');

  const domain = str(raw.domain).toLowerCase();
  for (const d of domain.split(/\s+/).filter(Boolean)) need(RE.domain.test(d), `Invalid domain: ${d}`);
  need(!domain || hostPort, 'A domain needs a host port for nginx to proxy to');

  const maxBody = /^\d{1,4}[kmg]$/i.test(str(raw.maxBody)) ? str(raw.maxBody) : '100m';

  return {
    name,
    image,
    containerPort,
    hostPort,
    bindAddr,
    restart,
    env,
    volumes,
    hostGateway: Boolean(raw.hostGateway),
    envFile: (() => {
      const f = str(raw.envFile);
      need(!f || RE.absPath.test(f), 'Env file must be an absolute path on the server');
      return f;
    })(),
    dir,
    domain,
    maxBody,
    firewall: Boolean(raw.firewall) && bindAddr === '0.0.0.0',
    overwrite: Boolean(raw.overwrite),
  };
}

function composeYaml(s: DeploySpec): string {
  const lines = [
    `# Generated by SSHer on ${new Date().toISOString()}`,
    `# Apply changes with:  cd ${s.dir} && docker compose up -d`,
    `name: ${s.name}`,
    '',
    'services:',
    `  ${s.name}:`,
    `    image: ${yq(s.image)}`,
    `    restart: ${s.restart}`,
  ];
  if (s.envFile) {
    // Values under `environment:` below override the same keys from this file.
    lines.push('    env_file:', `      - ${yq(s.envFile)}`);
  }
  if (s.hostPort && s.containerPort) {
    lines.push('    ports:', `      - ${yq(`${s.bindAddr}:${s.hostPort}:${s.containerPort}`)}`);
  }
  if (s.env.length) {
    lines.push('    environment:');
    for (const e of s.env) lines.push(`      ${e.key}: ${yq(e.value)}`);
  }
  if (s.volumes.length) {
    lines.push('    volumes:');
    for (const v of s.volumes) lines.push(`      - ${yq(`${v.host}:${v.container}`)}`);
  }
  if (s.hostGateway) {
    lines.push(
      '    # Lets the container reach services on the host (e.g. PostgreSQL) as host.docker.internal',
      '    extra_hosts:',
      '      - "host.docker.internal:host-gateway"',
    );
  }
  const named = s.volumes.filter((v) => RE.volumeName.test(v.host));
  if (named.length) {
    lines.push('', 'volumes:');
    for (const v of named) lines.push(`  ${v.host}:`);
  }
  return `${lines.join('\n')}\n`;
}

export interface NginxSiteContent {
  name: string;
  /** Space-separated hostnames. */
  domain: string;
  /** `host:port` to proxy to — usually `127.0.0.1:<port>`, never required to be. */
  target: string;
  maxBody: string;
}

/** The nginx server block for one site. Shared by the Docker deploy wizard (a
 *  container's "expose via nginx" step) and `nginx.ts`'s own "add a site" —
 *  one template, so the two can never drift into writing different configs. */
export function renderNginxSite(s: NginxSiteContent): string {
  return `# ${s.name} — generated by SSHer on ${new Date().toISOString()}
# ${s.domain}  ->  ${s.target}
server {
    listen      80;
    listen      [::]:80;
    server_name ${s.domain};

    client_max_body_size ${s.maxBody};

    proxy_connect_timeout 30s;
    proxy_send_timeout    300s;
    proxy_read_timeout    300s;

    access_log /var/log/nginx/${s.name}.access.log;
    error_log  /var/log/nginx/${s.name}.error.log;

    location / {
        proxy_pass         http://${s.target};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
}

export interface Step {
  title: string;
  command: string;
  /** When set, the command is a `tee` and this is written to it. */
  file?: { path: string; content: string };
}

export interface StepResult {
  title: string;
  ok: boolean;
  output: string;
}

/** Runs a step list in order, stopping at the first failure. Shared by every wizard
 *  that writes files + runs commands and shows a live step log (Docker deploy, nginx
 *  add-site, the .NET deploy to follow) so none of them re-implement the write-vs-run
 *  branching or the stop-on-failure rule differently. */
export async function runSteps(session: SshSession, steps: Step[]): Promise<{ log: StepResult[]; ok: boolean }> {
  const log: StepResult[] = [];
  for (const s of steps) {
    let result: ExecResult;
    if (s.file) {
      try {
        await writeRemote(session, s.file.path, s.file.content);
        result = { code: 0, stdout: `wrote ${s.file.content.length} bytes`, stderr: '' };
      } catch (err) {
        result = { code: 1, stdout: '', stderr: (err as Error).message };
      }
    } else {
      result = await run(session, s.command);
    }
    const output = (result.stdout + result.stderr).trim();
    log.push({ title: s.title, ok: result.code === 0, output });
    if (result.code !== 0) return { log, ok: false };
  }
  return { log, ok: true };
}

/** The write-site + enable + test + reload steps, shared by the Docker wizard's
 *  "expose via nginx" option and `nginx.ts`'s own "add a site". Written and enabled
 *  are kept as one step list so a plan preview (dry run) and the live log describe
 *  exactly the same thing, rather than two hand-kept lists drifting apart. */
export function nginxSiteSteps(name: string, content: string): Step[] {
  const available = `/etc/nginx/sites-available/${name}`;
  const enabled = `/etc/nginx/sites-enabled/${name}`;
  return [
    {
      title: `Write nginx site ${available}`,
      command: `tee ${shellQuote(available)} >/dev/null`,
      file: { path: available, content },
    },
    {
      title: 'Enable the site and test the nginx config',
      command: `ln -sf ${shellQuote(available)} ${shellQuote(enabled)} && (nginx -t 2>&1 || { rm -f ${shellQuote(enabled)}; echo "nginx -t failed — site disabled again" >&2; exit 1; })`,
    },
    { title: 'Reload nginx', command: 'systemctl reload nginx && echo reloaded' },
  ];
}

function deploySteps(s: DeploySpec): Step[] {
  const dir = shellQuote(s.dir);
  const composePath = posix.join(s.dir, 'docker-compose.yml');
  const steps: Step[] = [];

  if (s.hostPort) {
    steps.push({
      title: `Check host port ${s.hostPort} is free`,
      // A port held by this same project (a retry after a later step failed) is fine.
      command: `if ss -Htln | awk '{print $4}' | grep -Eq ':${s.hostPort}$'; then if docker ps --filter label=com.docker.compose.project=${s.name} --format '{{.Ports}}' | grep -q ':${s.hostPort}->'; then echo "already used by ${s.name} itself"; else echo "Port ${s.hostPort} is already in use on this server" >&2; exit 1; fi; else echo free; fi`,
    });
  }
  if (!s.overwrite) {
    steps.push({
      title: 'Check the project directory is not already in use',
      command: `if [ -e ${shellQuote(composePath)} ]; then echo "${composePath} already exists (tick 'overwrite' to replace it)" >&2; exit 1; fi; echo ok`,
    });
  }
  steps.push({ title: `Create ${s.dir}`, command: `mkdir -p ${dir}` });
  steps.push({
    title: `Write ${composePath}`,
    command: `tee ${shellQuote(composePath)} >/dev/null`,
    file: { path: composePath, content: composeYaml(s) },
  });
  steps.push({
    title: 'Pull image (if not already on the server) and start the container',
    command: `cd ${dir} && docker compose up -d 2>&1`,
  });
  steps.push({ title: 'Check it is running', command: `cd ${dir} && docker compose ps 2>&1` });

  if (s.domain) {
    const content = renderNginxSite({ name: s.name, domain: s.domain, target: `${s.bindAddr}:${s.hostPort}`, maxBody: s.maxBody });
    steps.push(...nginxSiteSteps(s.name, content));
  }
  if (s.firewall && s.hostPort) {
    steps.push({
      title: `Open ${s.hostPort}/tcp in ufw`,
      command: `ufw allow ${s.hostPort}/tcp comment ${shellQuote(`ssher: ${s.name}`)}`,
    });
  }
  return steps;
}

// -------------------------------------------------------------------- ports

interface Listener {
  proto: string;
  port: number;
  addresses: string[];
  processes: string[];
  local: boolean;
}

interface UfwRule {
  number: number;
  to: string;
  action: string;
  direction: string;
  from: string;
  v6: boolean;
  ports: { port: string; proto: string }[];
  raw: string;
}

const isLoopback = (addr: string) =>
  /^127\./.test(addr) || addr === '[::1]' || addr === '::1' || addr.includes('%lo');

function parseSs(out: string): Listener[] {
  const map = new Map<string, Listener>();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [proto, , , , local] = cols;
    const process = cols.slice(6).join(' ');
    const colon = local.lastIndexOf(':');
    const addr = local.slice(0, colon);
    const p = Number(local.slice(colon + 1));
    if (!Number.isFinite(p) || p <= 0) continue;

    const key = `${proto}/${p}`;
    const entry = map.get(key) ?? { proto, port: p, addresses: [], processes: [], local: true };
    if (!entry.addresses.includes(addr)) entry.addresses.push(addr);
    for (const m of process.matchAll(/\("([^"]+)"/g)) {
      if (!entry.processes.includes(m[1])) entry.processes.push(m[1]);
    }
    entry.local = entry.addresses.every(isLoopback);
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

// ufw app profiles name a service rather than a port; these are the common ones.
const APP_PORTS: Record<string, string[]> = {
  openssh: ['22/tcp'],
  'nginx http': ['80/tcp'],
  'nginx https': ['443/tcp'],
  'nginx full': ['80/tcp', '443/tcp'],
  'apache': ['80/tcp'],
  'apache secure': ['443/tcp'],
  'apache full': ['80/tcp', '443/tcp'],
  www: ['80/tcp'],
  'www secure': ['443/tcp'],
  'www full': ['80/tcp', '443/tcp'],
};

function parseUfwNumbered(out: string): UfwRule[] {
  const rules: UfwRule[] = [];
  const re = /^\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.+?)\s*$/;
  for (const line of out.split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const to = m[2].trim();
    const v6 = line.includes('(v6)');
    const bare = to.replace(/\s*\(v6\)/g, '').replace(/\s+on\s+\S+$/, '').trim();

    let ports: UfwRule['ports'] = [];
    const pm = /^(?:\S+\s+)?(\d+(?::\d+)?(?:,\d+(?::\d+)?)*)(?:\/(tcp|udp))?$/.exec(
      bare.replace(/\s*\(.*\)$/, ''),
    );
    if (pm) ports = pm[1].split(',').map((port) => ({ port, proto: pm[2] ?? 'any' }));
    else {
      const app = bare.replace(/\s*\(.*\)$/, '').toLowerCase();
      const named = APP_PORTS[app] ?? APP_PORTS[bare.match(/\(([^)]+)\)/)?.[1]?.toLowerCase() ?? ''];
      if (named) ports = named.map((p) => ({ port: p.split('/')[0], proto: p.split('/')[1] }));
    }

    rules.push({
      number: Number(m[1]),
      to,
      action: m[3],
      direction: m[4] ?? 'IN',
      from: m[5].replace(/\s*#.*$/, ''),
      v6,
      ports,
      raw: line.trim().replace(/^\[\s*\d+\]\s*/, ''),
    });
  }
  return rules;
}

function portMatches(rule: UfwRule, p: number, proto: string): boolean {
  return rule.ports.some((rp) => {
    if (rp.proto !== 'any' && rp.proto !== proto) return false;
    const [lo, hi] = rp.port.split(':').map(Number);
    return hi ? p >= lo && p <= hi : p === lo;
  });
}

async function ufwState(session: SshSession) {
  const [verbose, numbered] = await Promise.all([
    run(session, 'ufw status verbose 2>&1'),
    run(session, 'ufw status numbered 2>&1'),
  ]);
  const installed = !/not found/i.test(verbose.stdout + verbose.stderr) && verbose.code !== 127;
  const active = /Status:\s+active/i.test(verbose.stdout);
  const defaults = /Default:\s*(.+)/.exec(verbose.stdout)?.[1] ?? '';
  const defaultIncoming = /(\w+)\s+\(incoming\)/.exec(defaults)?.[1] ?? (active ? 'deny' : 'allow');
  return {
    installed,
    active,
    defaultIncoming,
    defaults,
    rules: active ? parseUfwNumbered(numbered.stdout) : [],
    error: installed ? '' : (verbose.stdout + verbose.stderr).trim(),
  };
}

/** Containers + their compose metadata, with `imageLocal` filled in. Exported so
 *  `/api/local-apps` (nginx.ts) can read the same thing in-process instead of making
 *  an HTTP round trip back into this server. */
export async function listDockerContainers(session: SshSession): Promise<{
  available: boolean;
  version: string;
  error: string;
  containers: Container[];
}> {
  const check = await run(session, 'command -v docker >/dev/null 2>&1 && docker info --format "{{.ServerVersion}}" 2>&1');
  if (check.code !== 0) {
    return {
      available: false,
      error: check.stdout.trim() || check.stderr.trim() || 'Docker is not installed on this server',
      version: '',
      containers: [],
    };
  }
  const out = await runOrThrow(
    session,
    'ids=$(docker ps -aq --no-trunc); if [ -z "$ids" ]; then echo "[]"; else docker inspect $ids; fi',
  );
  const containers = (JSON.parse(out) as Inspect[]).map(toContainer);

  // Pulled images carry a registry digest; `docker load`ed ones have none.
  const imageIds = [...new Set(containers.map((c) => c.imageId).filter((id) => /^sha256:[0-9a-f]+$/.test(id)))];
  if (imageIds.length) {
    const digests = await run(session, `docker image inspect --format '{{.Id}} {{len .RepoDigests}}' ${imageIds.join(' ')} 2>/dev/null`);
    const local = new Set(
      digests.stdout.split('\n').filter((l) => l.endsWith(' 0')).map((l) => l.split(' ')[0]),
    );
    for (const c of containers) c.imageLocal = local.has(c.imageId);
  }
  containers.sort((a, b) =>
    (a.compose?.project ?? '~').localeCompare(b.compose?.project ?? '~') || a.name.localeCompare(b.name),
  );
  return { available: true, version: check.stdout.trim(), error: '', containers };
}

// ------------------------------------------------------------------- routes

export function registerOps(
  app: Express,
  requireSession: RequestHandler,
  asyncRoute: AsyncRoute,
  upload: { single(field: string): RequestHandler },
): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) =>
    badRequestRoute(asyncRoute, handler);

  // ----------------------------------------------------------- docker: read

  app.get(
    '/api/docker/containers',
    requireSession,
    route(async (req, res) => {
      res.json(await listDockerContainers(req.session!));
    }),
  );

  app.get(
    '/api/docker/images',
    requireSession,
    route(async (req, res) => {
      const out = await runOrThrow(req.session!, "docker images --format '{{json .}}'");
      const images = out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, string>)
        .map((i) => ({
          repository: i.Repository,
          tag: i.Tag,
          id: i.ID,
          created: i.CreatedSince,
          size: i.Size,
          ref: i.Tag && i.Tag !== '<none>' ? `${i.Repository}:${i.Tag}` : i.ID,
        }));
      res.json({ images });
    }),
  );

  app.get(
    '/api/docker/logs',
    requireSession,
    route(async (req, res) => {
      const id = str(req.query.id);
      need(RE.id.test(id), 'invalid container id');
      const tail = Math.min(5000, Math.max(10, Number(req.query.tail) || 300));
      const result = await run(req.session!, `docker logs --tail ${tail} --timestamps ${shellQuote(id)} 2>&1`);
      res.json({ logs: result.stdout });
    }),
  );

  /** The real file backing `docker logs`, so it can be opened in the File Explorer
   *  (or just reached over SSH directly) — only meaningful for the default
   *  json-file/local log drivers; empty for journald/syslog/none, which don't write
   *  one on disk, handled as "not available" rather than guessed at. */
  app.get(
    '/api/docker/log-path',
    requireSession,
    route(async (req, res) => {
      const id = str(req.query.id);
      need(RE.id.test(id), 'invalid container id');
      const result = await run(req.session!, `docker inspect --format '{{.LogPath}}' ${shellQuote(id)} 2>&1`);
      const path = result.code === 0 ? result.stdout.trim() : '';
      res.json({ path });
    }),
  );

  app.get(
    '/api/docker/inspect',
    requireSession,
    route(async (req, res) => {
      const id = str(req.query.id);
      need(RE.id.test(id), 'invalid container id');
      const out = await runOrThrow(req.session!, `docker inspect ${shellQuote(id)}`);
      res.json({ inspect: (JSON.parse(out) as unknown[])[0] });
    }),
  );

  /** What an image expects: exposed ports, env defaults, volumes — used to pre-fill the wizard. */
  app.get(
    '/api/docker/image-info',
    requireSession,
    route(async (req, res) => {
      const image = str(req.query.image);
      need(RE.image.test(image), 'invalid image reference');
      const result = await run(req.session!, `docker image inspect ${shellQuote(image)} 2>&1`);
      if (result.code !== 0) {
        res.json({ found: false });
        return;
      }
      const info = (JSON.parse(result.stdout) as Array<{
        Config?: {
          ExposedPorts?: Record<string, unknown>;
          Env?: string[];
          Volumes?: Record<string, unknown>;
          WorkingDir?: string;
          Cmd?: string[];
          Entrypoint?: string[];
        };
        Size?: number;
        Created?: string;
      }>)[0];
      const cfg = info.Config ?? {};
      res.json({
        found: true,
        exposedPorts: Object.keys(cfg.ExposedPorts ?? {}),
        env: cfg.Env ?? [],
        volumes: Object.keys(cfg.Volumes ?? {}),
        workingDir: cfg.WorkingDir ?? '',
        cmd: [...(cfg.Entrypoint ?? []), ...(cfg.Cmd ?? [])].join(' '),
        size: info.Size ?? 0,
        created: info.Created ?? '',
      });
    }),
  );

  /** Facts the deploy wizard uses to make suggestions. */
  app.get(
    '/api/docker/context',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [ss, nginx, ufw, dirs] = await Promise.all([
        run(session, 'ss -Htln 2>/dev/null'),
        run(session, 'command -v nginx >/dev/null && [ -d /etc/nginx/sites-available ] && echo yes'),
        run(session, 'command -v ufw >/dev/null && ufw status 2>/dev/null | head -1'),
        run(session, 'ls -1 /opt 2>/dev/null'),
      ]);
      res.json({
        usedPorts: [...new Set(parseSs(ss.stdout.replace(/^/gm, 'tcp ')).map((l) => l.port))],
        nginx: nginx.stdout.trim() === 'yes',
        ufwActive: /active/i.test(ufw.stdout) && !/inactive/i.test(ufw.stdout),
        optDirs: dirs.stdout.split('\n').filter(Boolean),
        isRoot: session.username === 'root',
      });
    }),
  );

  // ---------------------------------------------------------- docker: write

  app.post(
    '/api/docker/action',
    requireSession,
    route(async (req, res) => {
      const id = str(req.body?.id);
      const action = str(req.body?.action);
      need(RE.id.test(id), 'invalid container id');
      const commands: Record<string, string> = {
        start: `docker start ${shellQuote(id)}`,
        stop: `docker stop ${shellQuote(id)}`,
        restart: `docker restart ${shellQuote(id)}`,
        remove: `docker rm -f ${shellQuote(id)}`,
      };
      need(commands[action], 'unknown action');
      const output = await runOrThrow(req.session!, `${commands[action]} 2>&1`);
      res.json({ ok: true, output });
    }),
  );

  /** Compose operations, replayed with the same -p / --env-file / -f the project was started with. */
  app.post(
    '/api/docker/compose',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const body = req.body ?? {};
      const base = composeCmd({
        project: str(body.project),
        workingDir: str(body.workingDir),
        configFiles: Array.isArray(body.configFiles) ? body.configFiles.map(String) : [],
        envFiles: Array.isArray(body.envFiles) ? body.envFiles.map(String) : [],
      });
      const service = str(body.service);
      need(!service || RE.id.test(service), 'invalid service');
      const svc = service ? ` ${shellQuote(service)}` : '';
      const op = str(body.op);
      const log: { title: string; ok: boolean; output: string }[] = [];

      const step = async (title: string, command: string) => {
        const result = await run(session, `${command} 2>&1`);
        const output = (result.stdout + result.stderr).trim();
        log.push({ title, ok: result.code === 0, output });
        if (result.code !== 0) throw new Error(`${title} failed:\n${output}`);
        return output;
      };

      let rollbackTag = '';
      try {
        if (op === 'up') await step('Apply (compose up -d)', `${base} up -d${svc}`);
        else if (op === 'recreate') await step('Recreate', `${base} up -d --force-recreate${svc}`);
        else if (op === 'restart') await step('Restart', `${base} restart${svc}`);
        else if (op === 'pull') await step('Pull', `${base} pull${svc}`);
        else if (op === 'down') await step('Stop & remove', `${base} down`);
        else if (op === 'config') await step('Validate', `${base} config --quiet && echo "Compose files are valid"`);
        else if (op === 'destroy') {
          // Only for projects the deploy wizard made: the marker line in the compose file
          // is what keeps this from ever tearing down a hand-built stack like devisehr-prod.
          const wd = str(body.workingDir);
          const project = str(body.project);
          const composeFile = posix.join(wd, 'docker-compose.yml');
          need(wd.split('/').filter(Boolean).length >= 2, 'refusing to delete a top-level directory');
          await step(
            'Check this app was deployed by SSHer',
            `grep -q '^# Generated by SSHer' ${shellQuote(composeFile)} && echo "ok — ${composeFile}" || { echo "${composeFile} was not created by SSHer; refusing to remove it. Use Stop/Remove on the containers instead." >&2; exit 1; }`,
          );
          const images = (await step('List its images', `${base} config --images`)).split('\n').map((s) => s.trim()).filter((s) => RE.image.test(s));
          await step('Stop and remove containers, network and volumes', `${base} down --volumes --remove-orphans`);
          // docker rmi refuses while another container uses the image, which is exactly
          // the protection wanted when the app was deployed from a shared image.
          for (const img of images) {
            await step(`Remove image ${img}`, `docker rmi ${shellQuote(img)} 2>&1 || echo "kept ${img} (still used by another container)"`);
          }
          const site = `/etc/nginx/sites-available/${project}`;
          await step(
            'Remove its nginx site (if any)',
            `if grep -qs 'generated by SSHer' ${shellQuote(site)}; then rm -f ${shellQuote(`/etc/nginx/sites-enabled/${project}`)} ${shellQuote(site)} && nginx -t && systemctl reload nginx && echo "removed ${site}"; else echo "no SSHer nginx site"; fi`,
          );
          await step(
            'Remove its ufw rules (if any)',
            `n=0; while num=$(ufw status numbered | grep -F ${shellQuote(`# ssher: ${project}`)} | head -1 | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/'); [ -n "$num" ] && [ $n -lt 20 ]; do ufw --force delete "$num" >/dev/null; n=$((n+1)); done; echo "removed $n rule(s)"`,
          );
          await step(`Delete ${wd}`, `rm -rf -- ${shellQuote(wd)} && echo "deleted ${wd}"`);
        }
        else if (op === 'redeploy') {
          // A newer build of the same tag was just `docker load`ed. The running container
          // still holds the previous image by ID, so tag that ID for rollback before
          // recreating — otherwise the old build would be left dangling and unrecoverable.
          need(service, 'a service is required');
          const image = str(body.image);
          const previous = str(body.imageId);
          need(RE.image.test(image) && !image.includes('@'), 'a tagged image is required');
          need(/^sha256:[0-9a-f]{64}$/.test(previous), 'the running image id is required');
          const repo = repoOf(image);
          rollbackTag = `${repo}:rollback-${stamp()}`;
          await step(
            'Keep the running version as :rollback',
            `docker tag ${previous} ${shellQuote(rollbackTag)} && docker tag ${previous} ${shellQuote(`${repo}:rollback`)} && echo "previous build saved as ${rollbackTag}"`,
          );
          await step('Switch to the new image', `${base} up -d --force-recreate${svc}`);
          await step('Status', `${base} ps${svc}`);
        }
        else if (op === 'update' || op === 'rollback') {
          need(service, 'a service is required');
          const image = str(body.image);
          need(RE.image.test(image) && !image.includes('@'), 'a tagged image is required');
          const repo = repoOf(image);
          if (op === 'update') {
            // Same convention as the existing deploys: keep the running image as
            // :rollback and a dated :rollback-YYYYMMDD-HHMM before pulling the new one.
            rollbackTag = `${repo}:rollback-${stamp()}`;
            await step(
              'Tag current image for rollback',
              `docker tag ${shellQuote(image)} ${shellQuote(rollbackTag)} && docker tag ${shellQuote(image)} ${shellQuote(`${repo}:rollback`)} && echo "saved as ${rollbackTag} and ${repo}:rollback"`,
            );
            await step('Pull the new image', `${base} pull${svc}`);
          } else {
            await step(
              'Restore :rollback image',
              `docker tag ${shellQuote(`${repo}:rollback`)} ${shellQuote(image)} && echo "${image} now points at ${repo}:rollback"`,
            );
          }
          await step('Recreate the container', `${base} up -d${svc}`);
          await step('Status', `${base} ps${svc}`);
        } else throw new BadRequest('unknown compose operation');
        res.json({ ok: true, log, rollbackTag });
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        res.status(500).json({ error: (err as Error).message, log });
      }
    }),
  );

  app.post(
    '/api/docker/pull',
    requireSession,
    route(async (req, res) => {
      const image = str(req.body?.image);
      need(RE.image.test(image), 'invalid image reference');
      const output = await runOrThrow(req.session!, `docker pull ${shellQuote(image)} 2>&1`);
      res.json({ ok: true, output: output.split('\n').slice(-8).join('\n') });
    }),
  );

  app.post(
    '/api/docker/remove-image',
    requireSession,
    route(async (req, res) => {
      const image = str(req.body?.image);
      need(RE.image.test(image), 'invalid image reference');
      const output = await runOrThrow(req.session!, `docker rmi ${shellQuote(image)} 2>&1`);
      res.json({ ok: true, output });
    }),
  );

  /** A dropped `docker save` tarball: copy it over SFTP, `docker load` it, clean up. */
  app.post(
    '/api/docker/load',
    requireSession,
    upload.single('image'),
    route(async (req, res) => {
      const session = req.session!;
      const file = req.file;
      need(file, 'no image file uploaded');
      const remote = `/tmp/ssher-image-${randomUUID()}.tar`;
      // The relay to the actual remote server (often the slow part for a
      // multi-GB image, after the browser→here leg already reported 100%) —
      // see transfers.ts.
      const transferId = str(req.body?.transferId);
      if (transferId) startTransfer(transferId, file.size);
      let sent = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(file.path);
          const write = session.sftp.createWriteStream(remote);
          if (transferId) read.on('data', (chunk: string | Buffer) => advanceTransfer(transferId, (sent += chunk.length)));
          read.on('error', reject);
          write.on('error', reject);
          write.on('close', resolve);
          read.pipe(write);
        });
        if (transferId) finishTransfer(transferId);
        const output = await runOrThrow(session, `docker load -i ${shellQuote(remote)} 2>&1`);
        const images = [...output.matchAll(/Loaded image(?: ID)?:\s*(\S+)/g)].map((m) => m[1]);
        res.json({ ok: true, images, output });
      } catch (err) {
        if (transferId) finishTransfer(transferId, (err as Error).message);
        throw err;
      } finally {
        await fs.unlink(file.path).catch(() => {});
        await exec(session, `rm -f ${shellQuote(remote)}`).catch(() => {});
      }
    }),
  );

  /** Builds a compose project (+ optional nginx site and ufw rule). `dryRun` returns the plan only. */
  app.post(
    '/api/docker/deploy',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const spec = parseSpec(req.body?.spec ?? {});
      const steps = deploySteps(spec);
      const files = steps.filter((s) => s.file).map((s) => s.file!);

      if (req.body?.dryRun) {
        res.json({
          files,
          steps: steps.map((s) => ({ title: s.title, command: s.file ? `write ${s.file.path}` : s.command })),
        });
        return;
      }

      const { log, ok } = await runSteps(session, steps);
      if (!ok) {
        res.status(500).json({ error: `${log.at(-1)!.title} failed`, log });
        return;
      }
      res.json({ ok: true, log, dir: spec.dir, url: spec.domain ? `http://${spec.domain.split(/\s+/)[0]}` : '' });
    }),
  );

  // ----------------------------------------------------------------- services

  /** Whether each system service is running, for the quick-links controls. */
  app.get(
    '/api/services',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [units, ufw] = await Promise.all([
        run(session, 'for u in nginx docker postgresql; do printf "%s " "$u"; systemctl is-active "$u" 2>/dev/null || true; done'),
        run(session, 'command -v ufw >/dev/null && ufw status 2>/dev/null | head -1'),
      ]);
      const status: Record<string, string> = {};
      for (const line of units.stdout.split('\n')) {
        const [unit, state] = line.trim().split(/\s+/);
        if (unit) status[unit] = state || 'unknown';
      }
      status.ufw = !ufw.stdout.trim() ? 'missing' : /inactive/i.test(ufw.stdout) ? 'inactive' : 'active';
      res.json({ status });
    }),
  );

  app.post(
    '/api/services/action',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const service = str(req.body?.service);
      const action = str(req.body?.action);
      // Restart/reload of nginx test the config first, so a typo can't take every site down.
      const commands: Record<string, Record<string, string>> = {
        nginx: {
          start: 'systemctl start nginx',
          stop: 'systemctl stop nginx',
          restart: 'nginx -t && systemctl restart nginx',
          reload: 'nginx -t && systemctl reload nginx',
          test: 'nginx -t',
        },
        docker: {
          start: 'systemctl start docker',
          // docker.socket would start the daemon again on the next `docker` call.
          stop: 'systemctl stop docker.socket docker',
          restart: 'systemctl restart docker',
        },
        postgresql: {
          start: 'systemctl start postgresql',
          stop: 'systemctl stop postgresql',
          restart: 'systemctl restart postgresql',
          reload: 'systemctl reload postgresql',
        },
        ufw: {
          enable: `ufw allow ${session.port}/tcp comment 'ssh (added by SSHer)' && ufw --force enable`,
          disable: 'ufw disable',
          reload: 'ufw reload',
        },
      };
      const command = commands[service]?.[action];
      need(command, 'unknown service action');
      const result = await run(session, `(${command}) 2>&1`);
      const output = (result.stdout + result.stderr).trim();
      if (result.code !== 0) {
        res.status(500).json({ error: output || `${service} ${action} failed`, output });
        return;
      }
      res.json({ ok: true, output: output || `${service} ${action}: done` });
    }),
  );

  /** Which of the given paths exist, and whether each is a directory. */
  app.post(
    '/api/exists',
    requireSession,
    route(async (req, res) => {
      const paths: string[] = (Array.isArray(req.body?.paths) ? req.body.paths : [])
        .map(String)
        .filter((p: string) => RE.absPath.test(p))
        .slice(0, 200);
      if (!paths.length) {
        res.json({ found: {} });
        return;
      }
      const script = paths
        .map((p) => `if [ -d ${shellQuote(p)} ]; then echo "d ${p}"; elif [ -e ${shellQuote(p)} ]; then echo "f ${p}"; fi`)
        .join('; ');
      const out = await run(req.session!, script);
      const found: Record<string, 'file' | 'dir'> = {};
      for (const line of out.stdout.split('\n').filter(Boolean)) {
        found[line.slice(2)] = line[0] === 'd' ? 'dir' : 'file';
      }
      res.json({ found });
    }),
  );

  // -------------------------------------------------------------------- ports

  app.get(
    '/api/ports',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [ss, ufw, docker] = await Promise.all([
        run(session, 'ss -Htulnp 2>/dev/null'),
        ufwState(session),
        run(session, "command -v docker >/dev/null && docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null"),
      ]);

      const published: { container: string; hostIp: string; hostPort: number; target: string }[] = [];
      for (const line of docker.stdout.split('\n').filter(Boolean)) {
        const [container, ports = ''] = line.split('\t');
        for (const m of ports.matchAll(/([\d.:[\]a-f]*):(\d+)->(\d+\/\w+)/g)) {
          published.push({ container, hostIp: m[1] || '0.0.0.0', hostPort: Number(m[2]), target: m[3] });
        }
      }

      const listeners = parseSs(ss.stdout).map((l) => {
        const containers = [...new Set(published.filter((p) => p.hostPort === l.port).map((p) => p.container))];
        const viaDocker = l.processes.includes('docker-proxy') || containers.length > 0;
        const rules = ufw.rules.filter((r) => r.direction === 'IN' && portMatches(r, l.port, l.proto));
        const allow = rules.filter((r) => r.action === 'ALLOW' || r.action === 'LIMIT');

        // Docker writes its own iptables rules ahead of ufw's, so a published
        // port on 0.0.0.0 is reachable whatever ufw says.
        let exposure: string;
        if (l.local) exposure = 'local';
        else if (viaDocker) exposure = 'docker';
        else if (!ufw.active) exposure = 'open';
        else if (allow.some((r) => /^Anywhere/.test(r.from))) exposure = 'open';
        else if (allow.length) exposure = 'restricted';
        else exposure = ufw.defaultIncoming === 'allow' ? 'open' : 'blocked';

        return { ...l, containers, exposure, rules: rules.map((r) => r.number) };
      });

      res.json({ listeners, ufw, sshPort: session.port });
    }),
  );

  app.post(
    '/api/ports/rule',
    requireSession,
    route(async (req, res) => {
      const action = str(req.body?.action);
      need(['allow', 'deny', 'reject', 'limit'].includes(action), 'invalid action');
      const portSpec = str(req.body?.port);
      need(RE.portSpec.test(portSpec), 'port must be a number or a range like 8000:8100');
      for (const p of portSpec.split(':')) port(p, 'Port');
      const proto = ['tcp', 'udp'].includes(str(req.body?.proto)) ? str(req.body?.proto) : '';
      need(!portSpec.includes(':') || proto, 'a port range needs tcp or udp');
      const from = str(req.body?.from);
      need(!from || RE.source.test(from), 'source must be an IP address or CIDR');
      const comment = str(req.body?.comment).slice(0, 60);

      let cmd = from
        ? `ufw ${action} from ${from} to any port ${portSpec}${proto ? ` proto ${proto}` : ''}`
        : `ufw ${action} ${portSpec}${proto ? `/${proto}` : ''}`;
      if (comment) cmd += ` comment ${shellQuote(comment)}`;
      const output = await runOrThrow(req.session!, `${cmd} 2>&1`);
      res.json({ ok: true, output });
    }),
  );

  app.post(
    '/api/ports/delete',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const number = Number(req.body?.number);
      const expect = str(req.body?.expect);
      need(Number.isInteger(number) && number > 0, 'invalid rule number');
      // Rule numbers shift after every delete, so confirm it is still the rule the user saw.
      const { rules } = await ufwState(session);
      const rule = rules.find((r) => r.number === number);
      need(rule && rule.raw === expect, 'The firewall rules changed — refresh and try again');
      const output = await runOrThrow(session, `ufw --force delete ${number} 2>&1`);
      res.json({ ok: true, output });
    }),
  );

  /** Removes every ALLOW/LIMIT rule covering a port, highest number first so numbering stays valid. */
  app.post(
    '/api/ports/close',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const p = port(req.body?.port, 'Port');
      const proto = str(req.body?.proto) === 'udp' ? 'udp' : 'tcp';
      need(p !== session.port || req.body?.force, `Port ${p} is the SSH port you are connected on — closing it would lock you out`);

      // `onlyAnywhere` restricts a port to an allow-list: keep the per-IP rules, drop the open ones.
      const onlyAnywhere = Boolean(req.body?.onlyAnywhere);
      const removed: string[] = [];
      for (let guard = 0; guard < 50; guard++) {
        const { rules } = await ufwState(session);
        const target = rules
          .filter((r) => r.direction === 'IN' && (r.action === 'ALLOW' || r.action === 'LIMIT') && portMatches(r, p, proto))
          .filter((r) => !onlyAnywhere || /^Anywhere/.test(r.from))
          .sort((a, b) => b.number - a.number)[0];
        if (!target) break;
        await runOrThrow(session, `ufw --force delete ${target.number} 2>&1`);
        removed.push(target.raw);
      }
      res.json({ ok: true, removed });
    }),
  );

  app.post(
    '/api/ports/ufw',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      let output = '';
      if (req.body?.enabled) {
        // Enabling with default-deny and no SSH rule would cut this very connection.
        output += await runOrThrow(session, `ufw allow ${session.port}/tcp comment 'ssh (added by SSHer)' 2>&1`);
        output += await runOrThrow(session, 'ufw --force enable 2>&1');
      } else {
        output = await runOrThrow(session, 'ufw disable 2>&1');
      }
      res.json({ ok: true, output });
    }),
  );
}
