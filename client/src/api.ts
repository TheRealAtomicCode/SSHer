import type {
  ArchiveSupport,
  ComposeInfo,
  ComposeOp,
  CompressFormat,
  Container,
  Credentials,
  DeploySpec,
  DockerContext,
  DockerImage,
  ImageInfo,
  Listing,
  LocalApp,
  NginxSite,
  NginxSiteSpec,
  PortsState,
  Session,
  StepResult,
  TextContent,
} from './types';

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
  return request('/rename', { method: 'POST', body: json({ path, newName }) });
}

export function mkdir(path: string): Promise<void> {
  return request('/mkdir', { method: 'POST', body: json({ path }) });
}

/** `recursive: false` maps to rmdir, which refuses to delete a non-empty directory. */
export function remove(paths: string[], recursive = true): Promise<void> {
  return request('/delete', { method: 'POST', body: json({ paths, recursive }) });
}

export function saveText(path: string, content: string): Promise<{ size: number }> {
  return request('/save', { method: 'POST', body: json({ path, content }) });
}

export function paste(sources: string[], dest: string, mode: 'copy' | 'cut'): Promise<void> {
  return request('/paste', { method: 'POST', body: json({ sources, dest, mode }) });
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
  return request('/archive/compress', { method: 'POST', body: json({ paths, name, format, overwrite }) });
}

export function extract(path: string, dest?: string, overwrite = false): Promise<{ path: string }> {
  return request('/archive/extract', { method: 'POST', body: json({ path, dest, overwrite }) });
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
