export interface RemoteFile {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: number;
  mode: number;
}

export interface Listing {
  path: string;
  parent: string | null;
  files: RemoteFile[];
}

export interface Session {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  home: string;
}

export interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface TextContent {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

export type FileApp = 'editor' | 'image' | 'download';

export type ViewMode = 'list' | 'grid';

/** Operations we can reverse. Deleting shells out to `rm -rf`, so it is absent here. */
export type UndoEntry =
  | { type: 'rename'; from: string; to: string }
  | { type: 'move'; moves: { from: string; to: string }[] }
  | { type: 'copy'; created: string[] }
  | { type: 'mkdir'; path: string };

export type ClipboardMode = 'copy' | 'cut';

export interface Clipboard {
  mode: ClipboardMode;
  files: RemoteFile[];
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  message: string;
}

// ------------------------------------------------------------ saved servers

export interface SavedServer {
  /** `user@host:port` — one entry per login. */
  id: string;
  host: string;
  port: number;
  username: string;
  /** Only present when "remember password" was ticked. */
  password?: string;
  label?: string;
  lastUsed: number;
}

export interface Shortcut {
  id: string;
  name: string;
  description: string;
  path: string;
  isDirectory: boolean;
  createdAt: number;
}

export type View = 'home' | 'files' | 'shortcuts' | 'links' | 'docker' | 'logs' | 'ports';

// ------------------------------------------------------------------- docker

export interface ComposeInfo {
  project: string;
  service: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
}

export interface Container {
  id: string;
  name: string;
  image: string;
  imageId: string;
  /** Came from a dropped file rather than a registry, so updates come from a new file too. */
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
  compose: ComposeInfo | null;
}

export interface DockerImage {
  repository: string;
  tag: string;
  id: string;
  created: string;
  size: string;
  ref: string;
}

export interface ImageInfo {
  found: boolean;
  exposedPorts?: string[];
  env?: string[];
  volumes?: string[];
  workingDir?: string;
  cmd?: string;
  size?: number;
  created?: string;
}

export interface DockerContext {
  usedPorts: number[];
  nginx: boolean;
  ufwActive: boolean;
  optDirs: string[];
  isRoot: boolean;
}

export interface DeploySpec {
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

export interface StepResult {
  title: string;
  ok: boolean;
  output: string;
}

export type ComposeOp = 'up' | 'recreate' | 'restart' | 'pull' | 'down' | 'config' | 'update' | 'rollback' | 'destroy' | 'redeploy';

// -------------------------------------------------------------------- ports

export type Exposure = 'local' | 'docker' | 'open' | 'restricted' | 'blocked';

export interface Listener {
  proto: string;
  port: number;
  addresses: string[];
  processes: string[];
  local: boolean;
  containers: string[];
  exposure: Exposure;
  rules: number[];
}

export interface UfwRule {
  number: number;
  to: string;
  action: string;
  direction: string;
  from: string;
  v6: boolean;
  ports: { port: string; proto: string }[];
  raw: string;
}

export interface PortsState {
  listeners: Listener[];
  ufw: {
    installed: boolean;
    active: boolean;
    defaultIncoming: string;
    defaults: string;
    rules: UfwRule[];
    error: string;
  };
  sshPort: number;
}

// ----------------------------------------------------------------- archive

export type CompressFormat = 'zip' | 'tar.gz' | 'tar.bz2' | 'tar.xz';

export interface ArchiveSupport {
  compress: Record<CompressFormat, boolean>;
  extract: Record<'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | '7z' | 'rar', boolean>;
}
