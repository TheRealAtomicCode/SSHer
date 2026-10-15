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
  /** How this login gets root — see SudoState in server/ssh.ts. */
  sudo?: SudoState;
  /** Set on connect when a saved sudo password was sent but sudo refused it. */
  sudoSavedRejected?: boolean;
}

export type SudoState = 'root' | 'nopasswd' | 'ok' | 'needed' | 'denied' | 'missing';

export interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
  /** A remembered sudo password to try first, when it differs from the login one. */
  sudoPassword?: string;
  /** 6-digit authenticator code, for servers with SSH two-factor. Never saved. */
  otp?: string;
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
  /** Only present when "remember" was ticked in the sudo password prompt. */
  sudoPassword?: string;
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
  | 'monitor'
  | 'security'
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
  | 'dbtransfer'
  | 'backups';

// ------------------------------------------------------------------- docker

export interface ComposeInfo {
  project: string;
  service: string;
  workingDir: string;
  configFiles: string[];
  envFiles: string[];
}

// ---------------------------------------------------------------- monitoring

export interface MonitorSample {
  time: number;
  cpu: { total: number; idle: number; iowait: number; cores: number };
  load: [number, number, number];
  uptimeSeconds: number;
  memory: { total: number; available: number; buffersCached: number; swapTotal: number; swapFree: number };
  network: { name: string; rx: number; tx: number; virtual: boolean }[];
  disks: { name: string; readBytes: number; writeBytes: number }[];
  filesystems: { mount: string; size: number; used: number; avail: number }[];
}

export interface NetConnection {
  proto: string;
  state: string;
  local: string;
  localPort: number;
  peer: string;
  peerPort: number;
  process: string;
  pid: number | null;
}

export interface LogTail {
  path: string;
  exists: boolean;
  size?: number;
  lines: string[];
}

export interface ContainerStat {
  id: string;
  name: string;
  cpuPct: number;
  memUsage: string;
  memPct: number;
  pids: number;
  netRx: number;
  netTx: number;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  imageId: string;
  /** Host PID of the container's main process (0 when stopped). */
  pid?: number;
  /** Docker's json log file for this container. */
  logPath?: string;
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
  labels?: Record<string, string>;
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

export interface LinkTestStep {
  title: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface LinkTestResult {
  ok: boolean;
  /** Where the test ran from (the container, or a temporary copy of it). */
  note: string;
  steps: LinkTestStep[];
}

/** A file a container takes its configuration from (Docker → container → Config). */
export interface ContainerConfigFile {
  /** compose: compose files · project-env: --env-file (fills ${…} in them) ·
   *  service-env: env_file: entries, loaded into the container · appsettings: appsettings*.json */
  kind: 'compose' | 'project-env' | 'service-env' | 'appsettings';
  /** Path on the server; for an image-only file, the path inside the container. */
  path: string;
  containerPath: string;
  /** 'image': only inside the container, not editable until copied out. */
  location: 'host' | 'image';
  exists: boolean;
  size: number;
  required: boolean;
}

export interface ContainerConfigInfo {
  compose: { project: string; service: string; workingDir: string } | null;
  files: ContainerConfigFile[];
  /** Why `docker compose config` failed, when it did (often: a missing env file). */
  configError: string;
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
  /** Has a `listen 443`, whoever wrote it. */
  https: boolean;
  /** The SSHer-stored certificate it uses, if any. */
  tlsCert: string;
  /** Only accepts https from Cloudflare (Authenticated Origin Pulls). */
  originPull: boolean;
}

// -------------------------------------------------------------------- stacks

export interface StackRef {
  dir: string;
  files: string[];
  project: string;
}

export interface StackService {
  name: string;
  image: string;
  hasBuild: boolean;
  imagePresent: boolean;
  ports: string[];
  state: string | null;
  container: string | null;
}

export interface StackSetting {
  line: number;
  block: string;
  key: string;
  value: string;
  secret: boolean;
  placeholder: boolean;
  listForm: boolean;
  comment: string;
}

export interface StackSummary extends StackRef {
  services: StackService[];
  error: string;
  placeholders: number;
  running: number;
}

export interface StackDetail extends StackSummary {
  settings: StackSetting[];
  /** The first compose file as text, for the raw editor. */
  raw: string;
  /** `stat` mode + owner of the compose file, e.g. "600 root". */
  mode: string;
}

export interface StackCrash {
  service: string;
  container: string;
  state: string;
  restarts: number;
  exitCode: number;
  logs: string;
}

export type StackOp = 'up' | 'validate' | 'pull' | 'restart' | 'stop' | 'down';

export interface NginxSiteSpec {
  name: string;
  domain: string;
  target: string;
  maxBody: string;
  overwrite: boolean;
  /** Name of a stored certificate — '' serves plain http only. */
  tlsCert: string;
  originPull: boolean;
}

export interface NginxCert {
  name: string;
  domains: string[];
  issuer: string;
  /** ISO date, '' if unreadable. */
  expires: string;
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
  /** PostgreSQL's own log tail, when it isn't running — the reason it stopped. */
  log?: string;
}

/** The SSH tunnel to the server's PostgreSQL, opened on the machine running the
 *  SSHer back end (127.0.0.1 only) for pgAdmin and friends. */
export interface PostgresTunnel {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  startedAt: number;
  /** Connections open through it right now. */
  active: number;
  total: number;
  lastError: string;
}

export interface PostgresTunnelState {
  /** The back end runs in a container — its 127.0.0.1 isn't this computer's. */
  inContainer: boolean;
  /** This session's SSH login — what pgAdmin's own SSH Tunnel tab asks for. */
  ssh: { host: string; port: number; username: string };
  /** The port PostgreSQL listens on, on the server. */
  postgresPort: number;
  bindHost: string;
  defaultLocalPort: number;
  tunnel: PostgresTunnel | null;
}

/** One parsed line of pg_hba.conf, as PostgreSQL itself reads it (pg_hba_file_rules). */
export interface PgHbaRule {
  file_name: string | null;
  line_number: number | null;
  type: string | null;
  database: string[] | null;
  user_name: string[] | null;
  address: string | null;
  netmask: string | null;
  auth_method: string | null;
  /** Set when PostgreSQL would reject this line. */
  error: string | null;
}

export interface PgHbaState {
  path: string;
  /** The port of the cluster SSHer manages (psql's default one). */
  port: number;
  /** SHOW listen_addresses — 'localhost' means containers can't reach it. */
  listenAddresses: string;
  hasDocker: boolean;
  /** ufw: with default-deny on, containers also need a rule to reach the port. */
  firewall: { active: boolean; containersAllowed: boolean };
  rules: PgHbaRule[];
  clusters: { version: string; name: string; port: number; online: boolean }[];
  /** `docker ps` lines that look like a PostgreSQL. */
  containers: string[];
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
  /** pg_database_size, in bytes. */
  bytes?: number;
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
  /** The stanza exists on disk (stanza-create ran), not just in the config file. */
  stanzaReady?: boolean;
  stanzaStatus?: string;
  archiving?: PgBackRestArchiving | null;
  /** "Rewind up to N days back" — time-based retention. */
  retentionDays?: number | null;
  /** Older count-based retention (keep N full backups), from a hand-written config. */
  retentionCount?: number | null;
  schedule?: PgBackRestSchedule;
}

export interface PgBackRestArchiving {
  mode: string;
  command: string;
  timeout: string;
  walLevel: string;
  usesPgBackRest: boolean;
  archivedCount: number;
  lastArchivedWal: string | null;
  lastArchivedTime: string | null;
  failedCount: number;
  lastFailedWal: string | null;
  lastFailedTime: string | null;
}

export interface PgBackRestSchedule {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  fullDay: number;
  hour: number;
}

export interface PgBackRestStats {
  databases: { name: string; bytes: number }[];
  walLocalBytes: number;
  disks: DiskUsage[];
  dataDir: string;
  repoPath: string;
}

export interface DiskUsage {
  mount: string;
  size: number;
  used: number;
  avail: number;
  source?: string;
  fstype?: string;
  holds?: string[];
}

export interface PgBackRestConfigureSpec {
  stanza: string;
  repo1Path: string;
  retentionDays?: number;
  remote?: { host: string; port?: number; user: string; path: string };
}

export type PgBackRestBackupType = 'full' | 'diff' | 'incr';

export interface PgBackRestBackupEntry {
  label: string;
  type: string;
  startTime: number;
  stopTime: number;
  sizeBytes: number;
  /** Space this backup takes in the repo (compressed; only the changes for diff/incr). */
  repoBytes?: number;
}

export interface PgBackRestBackupsResponse {
  backups: PgBackRestBackupEntry[];
  earliest: number | null;
  latest: number | null;
  archiveTimeout?: number;
  sizes?: { backupsBytes: number; walArchiveBytes: number } | null;
}

// ------------------------------------------------------- postgres: health & upkeep

export interface PgOverview {
  version: string;
  port: number;
  listen: string;
  startedAt: string;
  maxConnections: number;
  connections: number;
  active: number;
  idleInTransaction: number;
  longestSeconds: number;
  cacheHitPct: number | null;
  dataDirectory: string;
  statStatements: { loaded: boolean; created: boolean; preload: string };
}

export interface PgIndex {
  schema: string;
  table: string;
  index: string;
  bytes: number;
  method: string;
  primary: boolean;
  unique: boolean;
  valid: boolean;
  scans: number;
  lastUsed: string | null;
  definition: string;
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  deadRows: number | null;
  liveRows: number | null;
  tableBytes: number;
  /** When the index file was written — its last REINDEX, or creation. ms since epoch. */
  rebuiltAt: number | null;
  /** pgstatindex(), btree only, when pgstattuple is installed in that database. */
  frag?: { leaf_fragmentation: number; avg_leaf_density: number } | null;
}

export type PgMaintenance = 'reindex-index' | 'reindex-table' | 'vacuum' | 'vacuum-full';

export interface PgSession {
  pid: number;
  database: string | null;
  user: string | null;
  application: string;
  client: string | null;
  kind: string;
  state: string | null;
  waitType: string | null;
  wait: string | null;
  queryStart: string | null;
  transactionStart: string | null;
  seconds: number | null;
  query: string;
}

export interface PgTopQuery {
  database: string | null;
  user: string | null;
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
  query: string;
}

export interface PgDump {
  file: string;
  database: string;
  bytes: number;
  createdAt: number;
}
