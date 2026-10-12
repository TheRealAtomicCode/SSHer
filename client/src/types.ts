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

export type View =
  | 'home'
  | 'files'
  | 'shortcuts'
  | 'links'
  | 'users'
  | 'processes'
  | 'nginx'
  | 'docker'
  | 'dotnet'
  | 'logs'
  | 'ports'
  | 'postgres'
  | 'backups';

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

// --------------------------------------------------------------------- nginx

export interface NginxSite {
  name: string;
  path: string;
  enabled: boolean;
  /** Only a site SSHer wrote itself gets structured edit fields re-offered. */
  managed: boolean;
  domains: string[];
  target: string;
  maxBody: string;
}

export interface NginxSiteSpec {
  name: string;
  domain: string;
  target: string;
  maxBody: string;
  overwrite: boolean;
}

export interface LocalApp {
  name: string;
  kind: 'docker' | 'dotnet';
  /** `host:port` — pre-fills the add-site wizard's target field. */
  target: string;
}

// -------------------------------------------------------------------- .NET

export interface DotnetRuntime {
  name: string;
  version: string;
}

export interface DotnetContext {
  available: boolean;
  runtimes: DotnetRuntime[];
  usedPorts: number[];
}

export interface DotnetInspectResult {
  ok: boolean;
  stagingDir: string;
  mainDll: string;
  suggestedName: string;
  selfContained: boolean;
  required: DotnetRuntime | null;
  dotnetAvailable: boolean;
  installedRuntimes: DotnetRuntime[];
  compatible: boolean;
}

export interface DotnetDeploySpec {
  stagingDir: string;
  mainDll: string;
  name: string;
  port: number | null;
  env: { key: string; value: string }[];
  domain: string;
  maxBody: string;
  overwrite: boolean;
}

export interface DotnetApp {
  name: string;
  state: string;
  port: number;
  dir: string;
}

// -------------------------------------------------------------------- users

export interface SystemUser {
  name: string;
  uid: number;
  gid: number;
  comment: string;
  home: string;
  shell: string;
  groups: string[];
  canLogin: boolean;
  locked: boolean;
  hasPassword: boolean;
  sudoGroup: boolean;
  sudoFile: boolean;
}

export interface SystemGroup {
  name: string;
  gid: number;
  members: string[];
}

export interface SudoChange {
  group?: boolean;
  passwordless?: boolean;
  rule?: string;
  removeAll?: boolean;
  confirmSelf?: boolean;
}

// ----------------------------------------------------------- file permissions

export interface AclEntry {
  tag: string;
  name?: string;
  perms: string;
  default: boolean;
}

export interface FilePermissions {
  owner: string;
  group: string;
  mode: string;
  hasAcl: boolean;
  acl: AclEntry[];
}

// ----------------------------------------------------------------- postgres

export interface PostgresContext {
  installed: boolean;
  running: boolean;
  reachable: boolean;
  version: string;
  error: string;
}

export interface PostgresRole {
  name: string;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  canlogin: boolean;
  replication: boolean;
  bypassrls: boolean;
  validuntil: string | null;
  memberof: string[];
}

export interface PostgresDatabase {
  name: string;
  owner: string;
}

/** The real grantable table privileges — there is no ALTER/DROP here because
 *  Postgres doesn't have one; that's governed by `owner` instead. */
export interface PostgresTablePrivileges {
  name: string;
  owner: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  references: boolean;
  trigger: boolean;
}

export type PostgresTablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER';
export type PostgresDatabasePrivilege = 'CONNECT' | 'CREATE' | 'TEMPORARY';
export type PostgresSchemaPrivilege = 'USAGE' | 'CREATE';

export interface PostgresDatabasePrivileges {
  connect: boolean;
  create: boolean;
  temporary: boolean;
}

export interface PostgresSchemaPrivileges {
  usage: boolean;
  create: boolean;
}

// -------------------------------------------------------------- activity log

export interface CommandLogEntry {
  id: number;
  time: number;
  command: string;
  code: number | null;
  durationMs: number;
}

// ----------------------------------------------------------------processes

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  etime: string;
  stat: string;
  command: string;
}

export type Signal = 'TERM' | 'KILL' | 'HUP' | 'INT';

// ---------------------------------------------------------------- pgbackrest

export interface PgBackRestContext {
  installed: boolean;
  configured: boolean;
  stanza: string;
  dataDir: string;
  repo1: { path: string } | null;
  repo2: { host: string; user: string; path: string } | null;
  publicKey: string | null;
}

export interface PgBackRestConfigureSpec {
  stanza: string;
  repo1Path: string;
  remote?: { host: string; port?: number; user: string; path: string };
}

export type PgBackRestBackupType = 'full' | 'diff' | 'incr';

export interface PgBackRestBackupEntry {
  label: string;
  type: string;
  startTime: number;
  stopTime: number;
  sizeBytes: number;
}

export interface PgBackRestBackupsResponse {
  backups: PgBackRestBackupEntry[];
  earliest: number | null;
  latest: number | null;
}
