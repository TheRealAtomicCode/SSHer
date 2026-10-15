import type {
  ContainerStat,
  ContainerConfigInfo,
  LogTail,
  MonitorSample,
  NetConnection,
  DiskUsage,
  PgBackRestSchedule,
  PgBackRestStats,
  AclEntry,
  ArchiveSupport,
  ComposeInfo,
  ComposeOp,
  CompressFormat,
  CommandLogEntry,
  Container,
  Credentials,
  DeploySpec,
  DockerContext,
  DockerImage,
  DotnetApp,
  DotnetContext,
  DotnetDeploySpec,
  DotnetInspectResult,
  FilePermissions,
  ImageInfo,
  LinkTestResult,
  Listing,
  LocalApp,
  NginxCert,
  NginxSite,
  NginxSiteSpec,
  PgBackRestBackupsResponse,
  PgBackRestBackupType,
  PgBackRestConfigureSpec,
  PgBackRestContext,
  PortsState,
  PostgresContext,
  PostgresDatabase,
  PostgresDatabasePrivilege,
  PostgresDatabasePrivileges,
  PostgresRole,
  PostgresSchemaPrivilege,
  PostgresSchemaPrivileges,
  PostgresTablePrivilege,
  PostgresTablePrivileges,
  PostgresTunnelState,
  PgHbaState,
  ProcessInfo,
  Session,
  Signal,
  StepResult,
  StackCrash,
  StackDetail,
  StackOp,
  StackRef,
  StackSummary,
  SudoChange,
  SystemGroup,
  SystemUser,
  TextContent,
} from './types';
import { sudoMode } from './sudoMode';

/** Carries the JSON body of a failed response, e.g. the step log of a failed deploy. */
export class ApiError extends Error {
  constructor(
    message: string,
    public payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

const STORAGE_KEY = 'ssh-session-id';

let sessionId: string | null = sessionStorage.getItem(STORAGE_KEY);

export function getSessionId(): string | null {
  return sessionId;
}

function setSessionId(id: string | null): void {
  sessionId = id;
  if (id) sessionStorage.setItem(STORAGE_KEY, id);
  else sessionStorage.removeItem(STORAGE_KEY);
}

// ------------------------------------------------------------- access key

const ACCESS_STORAGE = 'ssh-fb.accessKey';

function readAccessKey(): string {
  try {
    return localStorage.getItem(ACCESS_STORAGE) ?? '';
  } catch {
    return '';
  }
}

let accessKey = readAccessKey();

export function setAccessKey(key: string): void {
  accessKey = key;
  try {
    if (key) localStorage.setItem(ACCESS_STORAGE, key);
    else localStorage.removeItem(ACCESS_STORAGE);
  } catch {
    // Private mode: the key then lasts for this tab only.
  }
}

/** Whether the server wants an access key, and whether the one we hold works. */
export async function accessStatus(): Promise<{ required: boolean; ok: boolean }> {
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  if (!health.accessKey) return { required: false, ok: true };
  const check = await fetch('/api/access', { headers: { 'x-access-key': accessKey } });
  return { required: true, ok: check.ok };
}

// ------------------------------------------------------------------- sudo

/** sudo's own wording when it needs a password it wasn't given (or got a wrong one). */
const SUDO_NEEDS_PASSWORD =
  /sudo: (a password is required|a terminal is required|no tty present|\d+ incorrect password attempts?|no password was provided|unable to read password)/i;

/** Set by the app: shows the password prompt, resolves true once sudo accepted one. */
let sudoHandler: ((message: string) => Promise<boolean>) | null = null;

export function onSudoPasswordNeeded(handler: (message: string) => Promise<boolean>): void {
  sudoHandler = handler;
}

/** Checks a sudo password on the server; on success it is used for this session. */
export function setSudoPassword(password: string): Promise<{ ok: boolean; sudo: string }> {
  return request('/sudo', { method: 'POST', body: json({ password }) }, false);
}

export function forgetSudoPassword(): Promise<{ ok: boolean; sudo: string }> {
  return request('/sudo/forget', { method: 'POST' }, false);
}

async function request<T>(path: string, init: RequestInit = {}, sudoRetry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (sessionId) headers.set('x-session-id', sessionId);
  if (accessKey) headers.set('x-access-key', accessKey);
  if (init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`/api${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // An access-key 401 says nothing about the SSH session, so keep it.
    if (response.status === 401 && !payload.accessKey) setSessionId(null);
    const message = payload.error || `Request failed (${response.status})`;
    // The error can be the route's message or buried in a step log, so search all of it.
    if (sudoRetry && sudoHandler && SUDO_NEEDS_PASSWORD.test(JSON.stringify(payload))) {
      if (await sudoHandler(message)) return request<T>(path, init, false);
    }
    throw new ApiError(message, payload);
  }
  // Some reads report "can't do this" as a normal answer, e.g. the Docker page's
  // { available: false, error: 'sudo: a password is required' }.
  if (
    sudoRetry &&
    sudoHandler &&
    typeof payload?.error === 'string' &&
    SUDO_NEEDS_PASSWORD.test(payload.error) &&
    (await sudoHandler(payload.error))
  ) {
    return request<T>(path, init, false);
  }
  return payload as T;
}

const json = (body: unknown) => JSON.stringify(body);

export async function connect(credentials: Credentials): Promise<Session> {
  const session = await request<Session>('/connect', {
    method: 'POST',
    body: json(credentials),
  });
  setSessionId(session.sessionId);
  return session;
}

/** Revives a session id kept in sessionStorage across a page reload. */
export async function restore(): Promise<Session | null> {
  if (!sessionId) return null;
  try {
    return await request<Session>('/session');
  } catch {
    return null;
  }
}

export async function disconnect(): Promise<void> {
  try {
    await request('/disconnect', { method: 'POST' });
  } finally {
    setSessionId(null);
  }
}

export function list(path: string): Promise<Listing> {
  return request<Listing>(`/list?path=${encodeURIComponent(path)}`);
}

export function rename(path: string, newName: string): Promise<{ path: string }> {
  return request('/rename', { method: 'POST', body: json({ path, newName, sudo: sudoMode.enabled }) });
}

export function mkdir(path: string): Promise<void> {
  return request('/mkdir', { method: 'POST', body: json({ path, sudo: sudoMode.enabled }) });
}

/** `recursive: false` maps to rmdir, which refuses to delete a non-empty directory. */
export function remove(paths: string[], recursive = true): Promise<void> {
  return request('/delete', { method: 'POST', body: json({ paths, recursive, sudo: sudoMode.enabled }) });
}

export function saveText(path: string, content: string): Promise<{ size: number }> {
  return request('/save', { method: 'POST', body: json({ path, content }) });
}

export function paste(sources: string[], dest: string, mode: 'copy' | 'cut'): Promise<void> {
  return request('/paste', { method: 'POST', body: json({ sources, dest, mode, sudo: sudoMode.enabled }) });
}

export function readText(path: string): Promise<TextContent> {
  return request<TextContent>(`/text?path=${encodeURIComponent(path)}`);
}

/** A database backup streamed from pg_dump — a plain link, like fileUrl(). `db`
 *  omitted means every database on the server (pg_dumpall, roles included). */
export function postgresDumpUrl(opts: { db?: string; format: 'custom' | 'sql' }): string {
  const params = new URLSearchParams({ sid: sessionId ?? '', format: opts.format });
  if (opts.db) params.set('db', opts.db);
  else params.set('all', '1');
  if (accessKey) params.set('key', accessKey);
  return `/api/postgres/dump?${params.toString()}`;
}

/** Direct URL for <img> and download links, which cannot send custom headers. */
export function fileUrl(path: string, inline = false): string {
  const params = new URLSearchParams({ path, sid: sessionId ?? '' });
  if (accessKey) params.set('key', accessKey);
  if (inline) params.set('inline', '1');
  return `/api/download?${params.toString()}`;
}

export interface UploadItem {
  file: File;
  relPath: string;
}

export async function upload(
  items: UploadItem[],
  dest: string,
  onProgress?: (percent: number) => void,
  transferId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append('dest', dest);
  form.append('relPaths', JSON.stringify(items.map((item) => item.relPath)));
  if (transferId) form.append('transferId', transferId);
  for (const item of items) form.append('files', item.file);
  await postForm('/upload', form, onProgress, signal);
}

export interface TransferJob {
  id: string;
  label: string;
  stage: 'copying' | 'processing' | 'done' | 'error' | 'cancelled';
  processing: string;
  total: number;
  transferred: number;
  error: string;
  startedAt: number;
}

/** This login's uploads still running server-side (or just ended) — survives a reload. */
export function listTransfers(): Promise<{ transfers: TransferJob[] }> {
  return request('/transfers');
}

export function cancelTransfer(id: string): Promise<{ ok: boolean }> {
  return request(`/transfers/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
}

/** The part of an upload that happens after the browser's own progress event
 *  already reports 100% — relaying the file on to the actual remote target
 *  (see transferProgress.ts's watchTransfer, which polls this). */
export function transferProgress(
  id: string,
): Promise<{ total: number; transferred: number; done: boolean; error: string; pending?: boolean }> {
  return request(`/transfer-progress/${encodeURIComponent(id)}`);
}

function postForm<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  // XHR rather than fetch: it is the only way to observe upload progress.
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const xhr = new XMLHttpRequest();
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.addEventListener('abort', () => reject(new Error('Cancelled')));
    xhr.open('POST', `/api${path}`);
    if (sessionId) xhr.setRequestHeader('x-session-id', sessionId);
    if (accessKey) xhr.setRequestHeader('x-access-key', accessKey);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          return resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          return resolve({} as T);
        }
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        /* keep the default message */
      }
      reject(new Error(message));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed — connection lost')));
    xhr.send(form);
  });
}

// ------------------------------------------------------------------- docker

export function dockerContainers(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
  containers: Container[];
}> {
  return request('/docker/containers');
}

export function dockerImages(): Promise<{ images: DockerImage[] }> {
  return request('/docker/images');
}

export function dockerLogs(id: string, tail = 300): Promise<{ logs: string }> {
  return request(`/docker/logs?id=${encodeURIComponent(id)}&tail=${tail}`);
}

/** The real on-disk file `docker logs` reads from — empty when the log driver
 *  isn't file-backed (journald, syslog, none). */
export function dockerLogPath(id: string): Promise<{ path: string }> {
  return request(`/docker/log-path?id=${encodeURIComponent(id)}`);
}

export function dockerInspect(id: string): Promise<{ inspect: Record<string, unknown> }> {
  return request(`/docker/inspect?id=${encodeURIComponent(id)}`);
}

export function dockerImageInfo(image: string): Promise<ImageInfo> {
  return request(`/docker/image-info?image=${encodeURIComponent(image)}`);
}

export function dockerContext(): Promise<DockerContext> {
  return request('/docker/context');
}

export function dockerAction(
  id: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
): Promise<{ output: string }> {
  return request('/docker/action', { method: 'POST', body: json({ id, action }) });
}

export function dockerCompose(
  compose: ComposeInfo,
  op: ComposeOp,
  opts: { service?: string; image?: string; imageId?: string } = {},
): Promise<{ log: StepResult[]; rollbackTag?: string }> {
  return request('/docker/compose', {
    method: 'POST',
    body: json({ ...compose, ...opts, op }),
  });
}

/** Env keys SSHer overrides for this container (ssher.override.yml), and whether it can. */
export function dockerLinkOverrides(
  id: string,
): Promise<{ editable: boolean; reason: string; file: string; env: Record<string, string> }> {
  return request(`/docker/links/overrides?id=${encodeURIComponent(id)}`);
}

/** Tests a target from inside the container's network: resolve, connect, then log in/PING/GET. */
export function dockerLinkTest(
  id: string,
  target: { kind: string; host?: string; port?: number | string; database?: string; user?: string; password?: string; url?: string },
): Promise<LinkTestResult> {
  return request('/docker/links/test', { method: 'POST', body: json({ id, ...target }) });
}

/** Sets/clears env overrides for the container's compose service and recreates it. */
export function dockerLinkSave(
  id: string,
  set: Record<string, string>,
  unset: string[] = [],
): Promise<{ log: StepResult[]; file: string }> {
  return request('/docker/links/save', { method: 'POST', body: json({ id, set, unset }) });
}

/** Every file this container is configured from: compose files, env files, appsettings. */
export function dockerConfigFiles(id: string): Promise<ContainerConfigInfo> {
  return request(`/docker/config/files?id=${encodeURIComponent(id)}`);
}

/** Creates a missing env file the container reads (empty, mode 600). */
export function dockerConfigCreate(id: string, path: string): Promise<{ path: string }> {
  return request('/docker/config/create', { method: 'POST', body: json({ id, path }) });
}

/** Copies an appsettings file out of the image, bind-mounts it back and recreates the service. */
export function dockerConfigExtract(id: string, containerPath: string): Promise<{ log: StepResult[]; path: string }> {
  return request('/docker/config/extract', { method: 'POST', body: json({ id, containerPath }) });
}

export function dockerPull(image: string): Promise<{ output: string }> {
  return request('/docker/pull', { method: 'POST', body: json({ image }) });
}

export function dockerRemoveImage(image: string): Promise<{ output: string }> {
  return request('/docker/remove-image', { method: 'POST', body: json({ image }) });
}

export function dockerLoad(
  file: File,
  onProgress?: (percent: number) => void,
  transferId?: string,
  signal?: AbortSignal,
): Promise<{ images: string[]; output: string }> {
  const form = new FormData();
  if (transferId) form.append('transferId', transferId);
  form.append('image', file);
  return postForm('/docker/load', form, onProgress, signal);
}

export function dockerDeployPlan(spec: DeploySpec): Promise<{
  files: { path: string; content: string }[];
  steps: { title: string; command: string }[];
}> {
  return request('/docker/deploy', { method: 'POST', body: json({ spec, dryRun: true }) });
}

export function dockerDeploy(
  spec: DeploySpec,
): Promise<{ log: StepResult[]; dir: string; url: string }> {
  return request('/docker/deploy', { method: 'POST', body: json({ spec }) });
}

// -------------------------------------------------------------------- ports

export function ports(): Promise<PortsState> {
  return request('/ports');
}

export function addFirewallRule(rule: {
  action: 'allow' | 'deny' | 'reject' | 'limit';
  port: string;
  proto: 'tcp' | 'udp' | 'any';
  from?: string;
  comment?: string;
}): Promise<{ output: string }> {
  return request('/ports/rule', { method: 'POST', body: json(rule) });
}

export function deleteFirewallRule(number: number, expect: string): Promise<{ output: string }> {
  return request('/ports/delete', { method: 'POST', body: json({ number, expect }) });
}

/** `onlyAnywhere` removes just the open-to-everyone rules, keeping per-IP ones. */
export function closePort(
  port: number,
  proto: string,
  force = false,
  onlyAnywhere = false,
): Promise<{ removed: string[] }> {
  return request('/ports/close', {
    method: 'POST',
    body: json({ port, proto, force, onlyAnywhere }),
  });
}

export function setFirewall(enabled: boolean): Promise<{ output: string }> {
  return request('/ports/ufw', { method: 'POST', body: json({ enabled }) });
}

// ----------------------------------------------------------------- services

export type ServiceName = 'nginx' | 'docker' | 'postgresql' | 'ufw';

export function services(): Promise<{ status: Record<string, string> }> {
  return request('/services');
}

export function serviceAction(service: ServiceName, action: string): Promise<{ output: string }> {
  return request('/services/action', { method: 'POST', body: json({ service, action }) });
}

export function exists(paths: string[]): Promise<{ found: Record<string, 'file' | 'dir'> }> {
  return request('/exists', { method: 'POST', body: json({ paths }) });
}

// -------------------------------------------------------------------- nginx

export function nginxSites(): Promise<{ installed: boolean; sites: NginxSite[] }> {
  return request('/nginx/sites');
}

export function nginxInstall(): Promise<{ log: StepResult[] }> {
  return request('/nginx/install', { method: 'POST' });
}

export function localApps(): Promise<{ apps: LocalApp[] }> {
  return request('/local-apps');
}

export function nginxUploadSite(
  file: File,
): Promise<{ suggestedName: string; domain: string; target: string; maxBody: string; raw: string }> {
  const form = new FormData();
  form.append('filename', file.name);
  form.append('site', file);
  return postForm('/nginx/upload-site', form);
}

export function nginxCerts(): Promise<{ certs: NginxCert[] }> {
  return request('/nginx/certs');
}

export function nginxAddCert(cert: { name: string; cert: string; key: string }): Promise<{ certs: NginxCert[] }> {
  return request('/nginx/certs', { method: 'POST', body: json(cert) });
}

export function nginxAddSite(spec: NginxSiteSpec): Promise<{ log: StepResult[]; site: NginxSite }> {
  return request('/nginx/sites', { method: 'POST', body: json(spec) });
}

export function nginxSetEnabled(name: string, enabled: boolean): Promise<{ output: string }> {
  return request(`/nginx/sites/${encodeURIComponent(name)}/enabled`, {
    method: 'POST',
    body: json({ enabled }),
  });
}

export function nginxDeleteSite(name: string): Promise<{ output: string }> {
  return request(`/nginx/sites/${encodeURIComponent(name)}/delete`, { method: 'POST' });
}

// -------------------------------------------------------------------- stacks

export function stacks(): Promise<{ stacks: StackSummary[] }> {
  return request('/stacks');
}

export function stackDetail(ref: StackRef): Promise<StackDetail> {
  return request('/stacks/detail', { method: 'POST', body: json(ref) });
}

export function stackSaveSettings(ref: StackRef, edits: { line: number; key: string; value: string }[]): Promise<{ saved: number }> {
  return request('/stacks/settings', { method: 'POST', body: json({ ...ref, edits }) });
}

export function stackSaveRaw(ref: StackRef, content: string): Promise<void> {
  return request('/stacks/raw', { method: 'POST', body: json({ ...ref, content }) });
}

export function stackCreate(spec: { dir: string; content: string; overwrite?: boolean }): Promise<{ dir: string; files: string[] }> {
  return request('/stacks', { method: 'POST', body: json(spec) });
}

export function stackOp(
  ref: StackRef,
  op: StackOp,
  opts: { services?: string[]; force?: boolean } = {},
): Promise<{ ok: boolean; log: StepResult[]; crashed: StackCrash[] }> {
  return request('/stacks/op', { method: 'POST', body: json({ ...ref, op, ...opts }) });
}

// -------------------------------------------------------------------- .NET

export function dotnetContext(): Promise<DotnetContext> {
  return request('/dotnet/context');
}

export function dotnetInspect(
  file: File,
  onProgress?: (percent: number) => void,
  transferId?: string,
  signal?: AbortSignal,
): Promise<DotnetInspectResult> {
  const form = new FormData();
  if (transferId) form.append('transferId', transferId);
  form.append('app', file);
  return postForm('/dotnet/inspect', form, onProgress, signal);
}

export function dotnetInstallRuntime(name: string, version: string): Promise<{ output: string }> {
  return request('/dotnet/install-runtime', { method: 'POST', body: json({ name, version }) });
}

export function dotnetDeploy(
  spec: DotnetDeploySpec,
): Promise<{ log: StepResult[]; name: string; port: number; dir: string; url: string }> {
  return request('/dotnet/deploy', { method: 'POST', body: json(spec) });
}

export function dotnetApps(): Promise<{ apps: DotnetApp[] }> {
  return request('/dotnet/apps');
}

export function dotnetAction(name: string, action: 'start' | 'stop' | 'restart' | 'remove'): Promise<{ output: string }> {
  return request('/dotnet/action', { method: 'POST', body: json({ name, action }) });
}

// ------------------------------------------------------------------ archive

export function archiveSupport(): Promise<ArchiveSupport> {
  return request('/archive/support');
}

export function compress(
  paths: string[],
  name: string,
  format: CompressFormat,
  overwrite = false,
): Promise<{ path: string }> {
  return request('/archive/compress', { method: 'POST', body: json({ paths, name, format, overwrite, sudo: sudoMode.enabled }) });
}

export function extract(path: string, dest?: string, overwrite = false): Promise<{ path: string }> {
  return request('/archive/extract', { method: 'POST', body: json({ path, dest, overwrite, sudo: sudoMode.enabled }) });
}

/** A throwaway archive of `paths`, streamed on the fly — for dragging a multi-selection
 *  or a folder out of the browser onto the desktop (see `onFileDragStart` in
 *  `FileExplorer.vue`). Query string, not a POST: this URL is handed to the browser's
 *  own download machinery via a `DownloadURL` drag, which cannot carry a request body
 *  or headers — the same reason `fileUrl()` puts `sid`/`key` in the query string. */
export function zipDownloadUrl(paths: string[], name: string, format: CompressFormat): string {
  const params = new URLSearchParams({
    paths: JSON.stringify(paths),
    name,
    format,
    sid: sessionId ?? '',
  });
  if (accessKey) params.set('key', accessKey);
  return `/api/archive/download-zip?${params.toString()}`;
}

// -------------------------------------------------------------------- users

export function users(): Promise<{ users: SystemUser[]; groups: SystemGroup[] }> {
  return request('/users');
}

export function createUser(spec: {
  name: string;
  createHome?: boolean;
  systemAccount?: boolean;
  shell?: string;
  groups?: string[];
  password?: string;
}): Promise<void> {
  return request('/users', { method: 'POST', body: json(spec) });
}

export function deleteUser(name: string, removeHome = false): Promise<{ output: string }> {
  return request(`/users/${encodeURIComponent(name)}/delete`, { method: 'POST', body: json({ removeHome }) });
}

export function setUserSudo(name: string, change: SudoChange): Promise<void> {
  return request(`/users/${encodeURIComponent(name)}/sudo`, { method: 'POST', body: json(change) });
}

// ----------------------------------------------------------- file permissions

export function filePermissions(path: string): Promise<FilePermissions> {
  const params = new URLSearchParams({ path, sudo: sudoMode.enabled ? '1' : '0' });
  return request(`/files/permissions?${params.toString()}`);
}

export function setFilePermissions(
  paths: string[],
  changes: { mode?: string; owner?: string; group?: string; recursive?: boolean },
): Promise<void> {
  return request('/files/permissions', { method: 'POST', body: json({ paths, ...changes, sudo: sudoMode.enabled }) });
}

export function setFileAcl(
  paths: string[],
  opts: { user: string; perms?: string; recursive?: boolean; alsoDefault?: boolean; remove?: boolean },
): Promise<void> {
  return request('/files/acl', { method: 'POST', body: json({ paths, ...opts, sudo: sudoMode.enabled }) });
}

// ----------------------------------------------------------------- postgres

export function postgresContext(): Promise<PostgresContext> {
  return request('/postgres/context');
}

export function postgresInstall(): Promise<{ log: StepResult[] }> {
  return request('/postgres/install', { method: 'POST' });
}

export function postgresRoles(): Promise<{ roles: PostgresRole[] }> {
  return request('/postgres/roles');
}

export function postgresCreateRole(spec: {
  name: string;
  login: boolean;
  password?: string;
  superuser?: boolean;
  createdb?: boolean;
  createrole?: boolean;
  replication?: boolean;
  bypassrls?: boolean;
  /** Also give the new role access to this database (every schema, existing and future tables). */
  database?: string;
  access?: 'readonly' | 'readwrite';
}): Promise<void> {
  return request('/postgres/roles', { method: 'POST', body: json(spec) });
}

export function postgresPaths(): Promise<{ hbaFile: string; configFile: string; port: number; source: 'postgres' | 'guess' | 'none' }> {
  return request('/postgres/paths');
}

export function postgresHba(): Promise<PgHbaState> {
  return request('/postgres/hba');
}

export function postgresHbaAdd(rule: { type: string; database: string; user: string; address: string; method: string }): Promise<void> {
  return request('/postgres/hba/rules', { method: 'POST', body: json(rule) });
}

export function postgresSetListen(value: string): Promise<void> {
  return request('/postgres/listen', { method: 'POST', body: json({ value }) });
}

export function postgresAllowContainersFirewall(): Promise<{ output: string }> {
  return request('/postgres/firewall-containers', { method: 'POST' });
}

export function postgresSetPort(port: number): Promise<{ from: number; to: number; notes: string[] }> {
  return request('/postgres/port', { method: 'POST', body: json({ port }) });
}

export function postgresHbaRemove(line: number): Promise<void> {
  return request(`/postgres/hba/rules/${line}/delete`, { method: 'POST' });
}

export function postgresTunnel(): Promise<PostgresTunnelState> {
  return request('/postgres/tunnel');
}

export function postgresTunnelStart(localPort: number): Promise<PostgresTunnelState> {
  return request('/postgres/tunnel/start', { method: 'POST', body: json({ localPort }) });
}

export function postgresTunnelStop(): Promise<PostgresTunnelState> {
  return request('/postgres/tunnel/stop', { method: 'POST' });
}

export function postgresDeleteRole(name: string): Promise<void> {
  return request(`/postgres/roles/${encodeURIComponent(name)}/delete`, { method: 'POST' });
}

export function postgresSetPassword(name: string, password: string): Promise<void> {
  return request(`/postgres/roles/${encodeURIComponent(name)}/password`, { method: 'POST', body: json({ password }) });
}

export function postgresSetAttributes(
  name: string,
  attrs: {
    superuser?: boolean;
    createdb?: boolean;
    createrole?: boolean;
    canlogin?: boolean;
    replication?: boolean;
    bypassrls?: boolean;
  },
): Promise<void> {
  return request(`/postgres/roles/${encodeURIComponent(name)}/attributes`, { method: 'POST', body: json(attrs) });
}

export function postgresDatabases(): Promise<{ databases: PostgresDatabase[] }> {
  return request('/postgres/databases');
}

export function postgresCreateDatabase(spec: {
  name: string;
  /** An existing role… */
  owner?: string;
  /** …or a login user created for it in the same step. */
  newOwner?: { name: string; password: string };
}): Promise<{ owner: string }> {
  return request('/postgres/databases', { method: 'POST', body: json(spec) });
}

export function postgresSetDatabaseOwner(db: string, owner: string): Promise<void> {
  return request(`/postgres/databases/${encodeURIComponent(db)}/owner`, { method: 'POST', body: json({ owner }) });
}

export function postgresDeleteDatabase(db: string, confirm: string): Promise<void> {
  return request(`/postgres/databases/${encodeURIComponent(db)}/delete`, { method: 'POST', body: json({ confirm }) });
}

export function postgresSchemas(db: string): Promise<{ schemas: string[] }> {
  return request(`/postgres/databases/${encodeURIComponent(db)}/schemas`);
}

export function postgresTables(
  db: string,
  schema: string,
  role: string,
): Promise<{ tables: PostgresTablePrivileges[]; database: PostgresDatabasePrivileges; schema: PostgresSchemaPrivileges }> {
  return request(`/postgres/databases/${encodeURIComponent(db)}/schemas/${encodeURIComponent(schema)}/tables?role=${encodeURIComponent(role)}`);
}

export function postgresGrant(spec: {
  db: string;
  role: string;
  kind: 'database' | 'schema-privilege' | 'table' | 'schema' | 'owner';
  schema?: string;
  table?: string;
  privilege?: PostgresTablePrivilege | PostgresDatabasePrivilege | PostgresSchemaPrivilege;
  grant?: boolean;
  includeFuture?: boolean;
  includeSequences?: boolean;
}): Promise<void> {
  return request('/postgres/grant', { method: 'POST', body: json(spec) });
}

// ---------------------------------------------------------------- pgbackrest

export function pgbackrestContext(): Promise<PgBackRestContext> {
  return request('/pgbackrest/context');
}

export function pgbackrestInstall(): Promise<{ log: StepResult[] }> {
  return request('/pgbackrest/install', { method: 'POST' });
}

export function pgbackrestSshKey(): Promise<{ publicKey: string }> {
  return request('/pgbackrest/ssh-key', { method: 'POST' });
}

export function pgbackrestConfigure(spec: PgBackRestConfigureSpec): Promise<{ log: StepResult[] }> {
  return request('/pgbackrest/configure', { method: 'POST', body: json(spec) });
}

export function pgbackrestBackup(type: PgBackRestBackupType, repo?: 1 | 2): Promise<{ ok: true; output: string }> {
  return request('/pgbackrest/backup', { method: 'POST', body: json({ type, repo }) });
}

export function pgbackrestBackups(): Promise<PgBackRestBackupsResponse> {
  return request('/pgbackrest/backups');
}

export function pgbackrestFinishSetup(): Promise<{ log: StepResult[] }> {
  return request('/pgbackrest/finish-setup', { method: 'POST' });
}

export function pgbackrestSettings(settings: {
  retentionDays: number;
  schedule: PgBackRestSchedule;
}): Promise<{ log: StepResult[] }> {
  return request('/pgbackrest/settings', { method: 'POST', body: json(settings) });
}

export function pgbackrestStats(): Promise<PgBackRestStats> {
  return request('/pgbackrest/stats');
}

export function systemDisk(): Promise<{ disks: DiskUsage[] }> {
  return request('/system/disk');
}

/** One phase of the server's own internet speed test (curl → speed.cloudflare.com). */
export function speedTest(phase: 'latency'): Promise<{ latencyMs: number; location: string }>;
export function speedTest(phase: 'download' | 'upload'): Promise<{ mbps: number; bytes: number; seconds: number }>;
export function speedTest(phase: string): Promise<unknown> {
  return request('/system/speedtest', { method: 'POST', body: json({ phase }) });
}

export function pgbackrestRestore(targetTime: string, repo?: 1 | 2): Promise<{ log: StepResult[] }> {
  return request('/pgbackrest/restore', { method: 'POST', body: json({ targetTime, repo, confirm: true }) });
}

// -------------------------------------------------------------- activity log

export function commandLog(): Promise<{ entries: CommandLogEntry[] }> {
  return request('/command-log');
}

// ----------------------------------------------------------------- terminal

/** A real interactive shell — WebSocket, not fetch(), so credentials travel the
 *  same "query string, not a header" way fileUrl()'s downloads already do. */
export function terminalUrl(cols: number, rows: number): string {
  const params = new URLSearchParams({ sid: sessionId ?? '', cols: String(cols), rows: String(rows) });
  if (accessKey) params.set('key', accessKey);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/terminal?${params.toString()}`;
}

// ---------------------------------------------------------------- processes

export function processes(): Promise<{ processes: ProcessInfo[] }> {
  return request('/processes');
}

export function signalProcess(pid: number, signal: Signal): Promise<{ output: string }> {
  return request(`/processes/${pid}/signal`, { method: 'POST', body: json({ signal }) });
}

// -------------------------------------------------------------- monitoring

export function monitorSample(): Promise<MonitorSample> {
  return request('/monitor/sample');
}

export function monitorConnections(): Promise<{ connections: NetConnection[] }> {
  return request('/monitor/connections');
}

export function logTail(path: string, lines = 500): Promise<LogTail> {
  return request(`/logs/tail?path=${encodeURIComponent(path)}&lines=${lines}`);
}

export function nginxSiteLogs(name: string): Promise<{ access: string; error: string; ports: number[] }> {
  return request(`/nginx/site-logs?name=${encodeURIComponent(name)}`);
}

export function nginxStats(): Promise<{
  processes: { pid: number; cpuPct: number; memBytes: number; uptimeSeconds: number; command: string }[];
  connections: NetConnection[];
}> {
  return request('/nginx/stats');
}

export function dockerStats(): Promise<{ time: number; containers: ContainerStat[] }> {
  return request('/docker/stats');
}

export function dockerContainerConnections(pid: number): Promise<{ connections: NetConnection[] }> {
  return request(`/docker/connections?pid=${pid}`);
}

// ---------------------------------------------------------------- security

export function whoami(): Promise<{ browserIp: string; sshClientIp: string }> {
  return request('/whoami');
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'ok';

export interface SecurityFinding {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: string[];
  link?: 'ports' | 'postgres' | 'users' | 'docker' | 'processes';
  fixCommand?: string;
  process?: { pid: number; exe: string; user: string; name: string; cpu: number };
  file?: string;
}

export interface SecurityTool {
  id: string;
  name: string;
  what: string;
  pkg: string;
  installed: boolean;
}

export function securityScan(): Promise<{ time: number; findings: SecurityFinding[] }> {
  return request('/security/scan');
}

export function securityTools(): Promise<{ tools: SecurityTool[] }> {
  return request('/security/tools');
}

export function securityInstallTool(id: string): Promise<{ log: StepResult[] }> {
  return request(`/security/tools/${id}/install`, { method: 'POST' });
}

export function securityRunTool(id: string): Promise<{ ok: boolean; output: string; seconds: number }> {
  return request(`/security/tools/${id}/run`, { method: 'POST' });
}

export function securityKill(pid: number): Promise<{ output: string }> {
  return request('/security/kill', { method: 'POST', body: json({ pid }) });
}

export function securityQuarantine(path: string): Promise<{ dest: string }> {
  return request('/security/quarantine', { method: 'POST', body: json({ path }) });
}

export function securityUninstallTool(id: string): Promise<{ log: StepResult[] }> {
  return request(`/security/tools/${id}/uninstall`, { method: 'POST' });
}

// -------------------------------------------------------------- SSH 2FA

export interface TwoFactorUser {
  name: string;
  uid: number;
  home: string;
  hasSecret: boolean;
  sudo: boolean;
  email: string;
  enabledAt: number | null;
}

export interface TwoFactorStatus {
  installed: boolean;
  enforced: boolean;
  supportsDropins: boolean;
  sshd: Record<string, string>;
  rootLoginClosedBySsher: boolean;
  connectedAs: string;
  users: TwoFactorUser[];
}

export function twoFactorStatus(): Promise<TwoFactorStatus> {
  return request('/2fa/status');
}

export function twoFactorInstall(): Promise<{ log: StepResult[] }> {
  return request('/2fa/install', { method: 'POST' });
}

export function twoFactorSetup(user: string, email: string): Promise<{ secret: string; scratch: string[]; otpauth: string }> {
  return request('/2fa/setup', { method: 'POST', body: json({ user, email }) });
}

export function twoFactorConfirm(user: string, code: string): Promise<{ ok: true }> {
  return request('/2fa/confirm', { method: 'POST', body: json({ user, code }) });
}

export function twoFactorEmail(user: string, email: string): Promise<{ ok: true }> {
  return request('/2fa/email', { method: 'POST', body: json({ user, email }) });
}

export function twoFactorRemove(user: string): Promise<{ ok: true }> {
  return request('/2fa/remove', { method: 'POST', body: json({ user }) });
}

export function twoFactorEnforce(enabled: boolean, testUser?: string, testPassword?: string): Promise<{ log: StepResult[] }> {
  return request('/2fa/enforce', { method: 'POST', body: json({ enabled, testUser, testPassword }) });
}

export function rootLogin(allow: boolean, testUser?: string, testPassword?: string): Promise<{ log: StepResult[] }> {
  return request('/2fa/root-login', { method: 'POST', body: json({ allow, testUser, testPassword }) });
}

// ------------------------------------------------------- database transfer

export interface TransferTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  sslmode?: 'prefer' | 'require' | 'disable';
  /** Reach the target's PostgreSQL through SSH, when its port isn't open to this server. */
  ssh?: TransferSshTunnel;
}

export interface TransferSshTunnel {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Where PostgreSQL listens as seen from the target itself (normally 127.0.0.1:5432). */
  dbHost: string;
  dbPort: number;
}

export function postgresTransferTest(
  target: TransferTarget & { targetDb: string },
): Promise<{ ok: true; targetVersion: string; sourceVersion: string; canCreateDb: boolean; exists: boolean }> {
  return request('/postgres/transfer/test', { method: 'POST', body: json(target) });
}

export function postgresTransfer(
  spec: TransferTarget & { sourceDb: string; targetDb: string; ifExists: 'stop' | 'replace' },
): Promise<{ log: StepResult[]; seconds: number; bytes: number }> {
  return request('/postgres/transfer', { method: 'POST', body: json(spec) });
}

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
  rows: number;
  bytes: number;
}

export function postgresDbSummary(db: string): Promise<{ summary: DbSummary }> {
  return request(`/postgres/transfer/summary?db=${encodeURIComponent(db)}`);
}
