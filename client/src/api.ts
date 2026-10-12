import type {
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
  Listing,
  LocalApp,
  NginxSite,
  NginxSiteSpec,
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
  Session,
  StepResult,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new ApiError(payload.error || `Request failed (${response.status})`, payload);
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
): Promise<void> {
  const form = new FormData();
  form.append('dest', dest);
  form.append('relPaths', JSON.stringify(items.map((item) => item.relPath)));
  for (const item of items) form.append('files', item.file);
  await postForm('/upload', form, onProgress);
}

function postForm<T = unknown>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  // XHR rather than fetch: it is the only way to observe upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
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

export function dockerPull(image: string): Promise<{ output: string }> {
  return request('/docker/pull', { method: 'POST', body: json({ image }) });
}

export function dockerRemoveImage(image: string): Promise<{ output: string }> {
  return request('/docker/remove-image', { method: 'POST', body: json({ image }) });
}

export function dockerLoad(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ images: string[]; output: string }> {
  const form = new FormData();
  form.append('image', file);
  return postForm('/docker/load', form, onProgress);
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

export function nginxSites(): Promise<{ sites: NginxSite[] }> {
  return request('/nginx/sites');
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

// -------------------------------------------------------------------- .NET

export function dotnetContext(): Promise<DotnetContext> {
  return request('/dotnet/context');
}

export function dotnetInspect(file: File, onProgress?: (percent: number) => void): Promise<DotnetInspectResult> {
  const form = new FormData();
  form.append('app', file);
  return postForm('/dotnet/inspect', form, onProgress);
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
}): Promise<void> {
  return request('/postgres/roles', { method: 'POST', body: json(spec) });
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

// -------------------------------------------------------------- activity log

export function commandLog(): Promise<{ entries: CommandLogEntry[] }> {
  return request('/command-log');
}
