// The Config tab: every file a container takes its configuration from, so each can be
// opened in the editor (or uploaded over) where it actually lives.
//
//   compose      the project's compose files
//   project-env  `--env-file` files — only fill in ${…} inside the compose files
//   service-env  the service's own `env_file:` entries — these become the container's
//                environment. Resolved by `docker compose config`, so `${ENV_FILE:-.env.prod}`
//                and relative paths come out as the real file; one that is missing (the
//                classic "Missing required configuration" crash loop) is listed as missing
//                and can be created here.
//   appsettings  appsettings*.json. Bind-mounted from the server: edited in place. Only in
//                the image: "Make editable" copies it out to <project>/ssher-config/<service>/,
//                bind-mounts it back through ssher.override.yml and recreates the service, so
//                later edits survive a recreate or a new image.
import posix from 'node:path/posix';
import type { Express, RequestHandler, Response } from 'express';
import {
  OVERRIDE_FILE,
  RE,
  badRequestRoute,
  composeCmd,
  need,
  run,
  str,
  writeRemote,
  type AsyncRoute,
  type SessionRequest,
} from './ops.js';
import {
  composeOf,
  emptyOverrides,
  inspect,
  readOverrides,
  renderOverrides,
  type ComposeLabels,
  type Inspected,
} from './dockerlinks.js';
import { shellQuote, type SshSession } from './ssh.js';

type Kind = 'compose' | 'project-env' | 'service-env' | 'appsettings';

export interface ConfigFile {
  kind: Kind;
  /** Path on the server; for an image-only file, the path inside the container. */
  path: string;
  /** Where the app sees it (appsettings only). */
  containerPath: string;
  /** 'host' is a file on the server; 'image' exists only inside the container. */
  location: 'host' | 'image';
  exists: boolean;
  size: number;
  required: boolean;
}

interface Full extends Inspected {
  Name: string;
  Config: Inspected['Config'] & { WorkingDir?: string; Env?: string[] | null };
  Mounts?: { Type: string; Source: string; Destination: string; RW: boolean }[] | null;
}

const APPSETTINGS = /^appsettings(\.[A-Za-z0-9_-]+)?\.json$/i;

/** Sizes of host files in one round trip; -1 for a missing one. */
async function sizes(session: SshSession, paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = paths.filter((p) => RE.absPath.test(p));
  if (!valid.length) return out;
  const script = valid.map((p) => `stat -c %s -- ${shellQuote(p)} 2>/dev/null || echo -1`).join('; ');
  const lines = (await run(session, script, true)).stdout.trim().split('\n');
  valid.forEach((p, i) => out.set(p, Number(lines[i] ?? -1)));
  return out;
}

/** The service's `env_file:` entries, as compose resolves them. `--no-env-resolution`
 *  keeps them as paths (plain `config` inlines their contents into `environment:` and
 *  drops the list) and lists a missing one instead of failing. Older compose lacks the
 *  flag; there a missing file fails `config`, and its error names the file. Run quietly:
 *  the rendered config can carry secrets, so it stays out of the activity log. */
async function serviceEnvFiles(
  session: SshSession,
  compose: ComposeLabels,
): Promise<{ files: { path: string; required: boolean }[]; error: string }> {
  const base = `${composeCmd(compose)} config --format json`;
  let r = await run(session, `${base} --no-env-resolution`, true);
  if (r.code !== 0 && /unknown flag/i.test(r.stderr)) r = await run(session, base, true);
  let raw = false;
  if (r.code !== 0) {
    // Usually the --env-file itself is missing (or a ${X:?} it should fill is), and compose
    // stops before reading env_file:. Ask again without it and without interpolation; the
    // ${…} left in a path are filled in from their defaults below.
    const retry = await run(
      session,
      `${composeCmd({ ...compose, envFiles: [] })} config --format json --no-interpolate --no-env-resolution`,
      true,
    );
    if (retry.code === 0) {
      r = { ...retry, stderr: r.stderr || r.stdout };
      raw = true;
    }
  }
  const error = raw ? r.stderr.trim().split('\n').slice(-3).join('\n') : '';
  if (r.code !== 0) {
    const error = (r.stderr || r.stdout).trim();
    // A missing required env file stops `config` itself; that file is the answer anyway.
    const missing = [...error.matchAll(/env file (\/\S+?) not found/g)].map((m) => ({ path: m[1], required: true }));
    return { files: missing, error: error.split('\n').slice(-3).join('\n') };
  }
  try {
    const cfg = JSON.parse(r.stdout) as { services?: Record<string, { env_file?: unknown }> };
    const raw = cfg.services?.[compose.service]?.env_file;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const files = list
      .map((e) =>
        typeof e === 'string'
          ? { path: e, required: true }
          : { path: String((e as { path?: unknown }).path ?? ''), required: (e as { required?: unknown }).required !== false },
      )
      .filter((e) => e.path)
      .map((e) => ({ ...e, path: posix.resolve(compose.workingDir, raw ? withDefaults(e.path) : e.path) }));
    return { files, error };
  } catch {
    return { files: [], error: 'Could not read the output of docker compose config.' };
  }
}

/** Fills `${X:-default}` / `${X-default}` with the default and any other `${X}` with
 *  nothing — what compose does when X is unset, as it is once the --env-file is missing.
 *  Uninterpolated paths come back already joined to the project dir, so a default that
 *  is itself absolute starts the path over. */
function withDefaults(path: string): string {
  let out = path;
  for (;;) {
    const m = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?([-?])([^}]*))?\}/.exec(out);
    if (!m) return out;
    const value = m[1] === '-' ? m[2] : '';
    out = value.startsWith('/') ? value + out.slice(m.index + m[0].length) : out.slice(0, m.index) + value + out.slice(m.index + m[0].length);
  }
}

/** appsettings*.json inside the container's own filesystem (its working directory). */
async function imageAppsettings(session: SshSession, c: Full): Promise<string[]> {
  const wd = c.Config.WorkingDir || '/app';
  if (!RE.absPath.test(wd)) return [];
  const pid = c.State.Running ? c.State.Pid : 0;
  if (pid) {
    const root = `/proc/${pid}/root`;
    const r = await run(session, `ls -1 ${shellQuote(root + wd)} 2>/dev/null`, true);
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((n) => APPSETTINGS.test(n))
      .map((n) => posix.join(wd, n));
  }
  // Not running (stopped, or between crash-loop restarts): no filesystem to list, but
  // `docker cp` still reads it. Try the two names an ASP.NET app loads.
  const env = Object.fromEntries((c.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  const name = env.ASPNETCORE_ENVIRONMENT || env.DOTNET_ENVIRONMENT || 'Production';
  const candidates = ['appsettings.json', `appsettings.${name}.json`].filter((n) => APPSETTINGS.test(n)).map((n) => posix.join(wd, n));
  const script = candidates
    .map((p) => `docker cp ${shellQuote(`${c.Id}:${p}`)} - >/dev/null 2>&1 && echo ${shellQuote(p)}`)
    .join('; ');
  return (await run(session, `${script}; true`, true)).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function listFiles(session: SshSession, c: Full) {
  const compose = composeOf(c);
  const files: ConfigFile[] = [];
  let configError = '';
  const host = (kind: Kind, path: string, required = true, containerPath = ''): ConfigFile => ({
    kind,
    path,
    containerPath,
    location: 'host',
    exists: true,
    size: 0,
    required,
  });

  if (compose) {
    for (const f of compose.configFiles) files.push(host('compose', f));
    const override = posix.join(compose.workingDir, OVERRIDE_FILE);
    if (!compose.configFiles.includes(override)) {
      const s = await sizes(session, [override]);
      if ((s.get(override) ?? -1) >= 0) files.push(host('compose', override));
    }
    for (const f of compose.envFiles) files.push(host('project-env', f));
    if (compose.service) {
      const svc = await serviceEnvFiles(session, compose);
      configError = svc.error;
      for (const f of svc.files) if (!files.some((x) => x.kind === 'service-env' && x.path === f.path)) files.push(host('service-env', f.path, f.required));
    }
  }

  // Bind-mounted appsettings: a mounted file itself, or one inside a mounted directory.
  const mounts = (c.Mounts ?? []).filter((m) => m.Type === 'bind' && RE.absPath.test(m.Source) && RE.absPath.test(m.Destination));
  const mounted = new Set<string>();
  for (const m of mounts) {
    if (APPSETTINGS.test(posix.basename(m.Destination))) {
      files.push(host('appsettings', m.Source, true, m.Destination));
      mounted.add(m.Destination);
    }
  }
  const dirs = mounts.filter((m) => !APPSETTINGS.test(posix.basename(m.Destination)));
  if (dirs.length) {
    const script = dirs.map((m, i) => `for f in ${shellQuote(m.Source)}/appsettings*.json; do [ -f "$f" ] && echo "${i} $f"; done`).join('; ');
    for (const line of (await run(session, `${script}; true`, true)).stdout.split('\n')) {
      const m = /^(\d+) (\/.*)$/.exec(line.trim());
      if (!m || !APPSETTINGS.test(posix.basename(m[2]))) continue;
      const dest = posix.join(dirs[Number(m[1])].Destination, posix.basename(m[2]));
      if (mounted.has(dest)) continue;
      files.push(host('appsettings', m[2], true, dest));
      mounted.add(dest);
    }
  }
  for (const p of await imageAppsettings(session, c)) {
    if (mounted.has(p) || [...mounted].some((d) => p.startsWith(`${d}/`))) continue;
    files.push({ kind: 'appsettings', path: p, containerPath: p, location: 'image', exists: true, size: 0, required: true });
  }

  const s = await sizes(session, files.filter((f) => f.location === 'host').map((f) => f.path));
  for (const f of files) {
    if (f.location !== 'host') continue;
    const n = s.get(f.path) ?? -1;
    f.exists = n >= 0;
    f.size = Math.max(n, 0);
  }
  return { compose, files, configError };
}

export function registerContainerConfig(app: Express, requireSession: RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/docker/config/files',
    requireSession,
    route(async (req, res) => {
      const c = (await inspect(req.session!, str(req.query.id))) as Full;
      const { compose, files, configError } = await listFiles(req.session!, c);
      res.json({
        compose: compose && { project: compose.project, service: compose.service, workingDir: compose.workingDir },
        files,
        configError,
      });
    }),
  );

  /** Creates a missing env file the container is configured to read (empty, mode 600,
   *  owned like its folder), so it can then be edited or uploaded into. */
  app.post(
    '/api/docker/config/create',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const c = (await inspect(session, str(req.body?.id))) as Full;
      const path = str(req.body?.path);
      const { files } = await listFiles(session, c);
      const f = files.find((x) => x.path === path && x.location === 'host');
      need(f && (f.kind === 'service-env' || f.kind === 'project-env'), 'Only an env file this container uses can be created here.');
      need(!f!.exists, `${path} already exists.`);
      need(RE.absPath.test(path), 'invalid path');
      const dir = shellQuote(posix.dirname(path));
      const r = await run(
        session,
        `mkdir -p ${dir} && install -m 600 -o "$(stat -c %u ${dir})" -g "$(stat -c %g ${dir})" /dev/null ${shellQuote(path)} 2>&1`,
      );
      need(r.code === 0, (r.stdout + r.stderr).trim() || `could not create ${path}`);
      res.json({ ok: true, path });
    }),
  );

  /** Copies an appsettings file out of the image and bind-mounts it back, so it can be edited. */
  app.post(
    '/api/docker/config/extract',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const c = (await inspect(session, str(req.body?.id))) as Full;
      const compose = composeOf(c);
      need(
        compose && compose.service,
        'This container was not started by docker compose, so there is nowhere to keep the mount. Redeploy it with Deploy new to make it editable.',
      );
      const containerPath = str(req.body?.containerPath);
      const { files } = await listFiles(session, c);
      need(
        files.some((f) => f.kind === 'appsettings' && f.location === 'image' && f.containerPath === containerPath),
        `${containerPath} is not an appsettings file inside this container.`,
      );
      need(RE.id.test(compose!.service), 'invalid service name');
      const hostPath = posix.join(compose!.workingDir, 'ssher-config', compose!.service, posix.basename(containerPath));
      need(RE.absPath.test(hostPath), 'invalid path');

      const log: { title: string; ok: boolean; output: string }[] = [];
      const step = async (title: string, command: string) => {
        const r = await run(session, `${command} 2>&1`);
        log.push({ title, ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
        return r.code === 0;
      };

      // An earlier copy is kept: it may hold edits made before the mount was lost.
      const copied = await step(
        `Copy ${containerPath} to ${hostPath}`,
        `mkdir -p ${shellQuote(posix.dirname(hostPath))} && if [ -e ${shellQuote(hostPath)} ]; then echo "kept the existing ${hostPath}"; ` +
          `else docker cp ${shellQuote(`${c.Id}:${containerPath}`)} ${shellQuote(hostPath)} && echo "copied"; fi`,
      );
      if (!copied) {
        res.status(500).json({ error: `Could not copy ${containerPath} out of the container.`, log });
        return;
      }

      const { path, text, map } = await readOverrides(session, compose!);
      const entry = map.get(compose!.service) ?? emptyOverrides();
      for (const v of [...entry.volumes]) if (v.endsWith(`:${containerPath}`)) entry.volumes.delete(v);
      entry.volumes.add(`${hostPath}:${containerPath}`);
      map.set(compose!.service, entry);
      const content = renderOverrides(map);
      await writeRemote(session, path, content);
      log.push({ title: `Write ${path}`, ok: true, output: content });

      const base = composeCmd(compose!);
      if (!(await step('Validate the compose files', `${base} config --quiet && echo valid`))) {
        if (text) await writeRemote(session, path, text);
        else await run(session, `rm -f ${shellQuote(path)}`);
        res.status(500).json({ error: 'The compose files did not validate with the mount, so it was undone.', log });
        return;
      }
      if (!(await step(`Recreate ${compose!.service}`, `${base} up -d --no-build ${shellQuote(compose!.service)}`))) {
        res.status(500).json({ error: `Recreating ${compose!.service} failed.`, log });
        return;
      }
      res.json({ ok: true, log, path: hostPath });
    }),
  );
}
