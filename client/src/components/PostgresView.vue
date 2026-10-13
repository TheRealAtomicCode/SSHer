<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { formatSize } from '../files';
import { sudoMode } from '../sudoMode';
import { fail, notify } from '../toast';
import type {
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
  PgHbaRule,
  PgHbaState,
  StepResult,
  View,
} from '../types';
import StepLog from './StepLog.vue';

/** `navigate` opens the Transfer page (next to "New role"). */
const emit = defineEmits<{ navigate: [View] }>();

const ROLE_ATTRS = ['canlogin', 'superuser', 'createdb', 'createrole', 'replication', 'bypassrls'] as const;
const ROLE_ATTR_LABEL: Record<(typeof ROLE_ATTRS)[number], string> = {
  canlogin: 'Can log in',
  superuser: 'Superuser',
  createdb: 'Createdb',
  createrole: 'Createrole',
  replication: 'Replication',
  bypassrls: 'Bypass RLS',
};

const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const TABLE_PRIV_ABBR: Record<(typeof TABLE_PRIVS)[number], string> = {
  SELECT: 'Se', INSERT: 'In', UPDATE: 'Up', DELETE: 'De', TRUNCATE: 'Tn', REFERENCES: 'Rf', TRIGGER: 'Tg',
};
type TableKey = 'select' | 'insert' | 'update' | 'delete' | 'truncate' | 'references' | 'trigger';

const DB_PRIVS: { privilege: PostgresDatabasePrivilege; key: keyof PostgresDatabasePrivileges; label: string }[] = [
  { privilege: 'CONNECT', key: 'connect', label: 'Can CONNECT' },
  { privilege: 'CREATE', key: 'create', label: 'Can CREATE schemas' },
  { privilege: 'TEMPORARY', key: 'temporary', label: 'Can create TEMP tables' },
];

const SCHEMA_PRIVS: { privilege: PostgresSchemaPrivilege; key: keyof PostgresSchemaPrivileges; label: string }[] = [
  { privilege: 'USAGE', key: 'usage', label: 'USAGE (can see this schema at all)' },
  { privilege: 'CREATE', key: 'create', label: 'CREATE (can add new tables here)' },
];

const loading = ref(true);
const context = ref<PostgresContext | null>(null);
const roles = ref<PostgresRole[]>([]);
const databases = ref<PostgresDatabase[]>([]);

const selected = ref<PostgresRole | null>(null);
const tab = ref<'role' | 'access'>('role');
const busy = ref(false);

const newRoleOpen = ref(false);
const NEW_ROLE_DEFAULTS = {
  name: '',
  login: true,
  password: '',
  superuser: false,
  createdb: false,
  createrole: false,
  replication: false,
  bypassrls: false,
  database: '',
  access: 'readwrite' as 'readonly' | 'readwrite',
};
const newRole = reactive({ ...NEW_ROLE_DEFAULTS });

const newPassword = ref('');
const showNewRolePassword = ref(false);

/** 24 characters from an alphabet with nothing a connection string or a shell
 *  would trip over (no quotes, @, :, / or %). */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function fillGeneratedPassword() {
  newRole.password = generatePassword();
  showNewRolePassword.value = true;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`Copied ${what}`);
  } catch (err) {
    fail(err);
  }
}

// ------------------------------------------------------------- databases

const newDbOpen = ref(false);
const NEW_DB_DEFAULTS = { name: '', ownerMode: 'new' as 'new' | 'existing', owner: 'postgres', userName: '', password: '' };
const newDb = reactive({ ...NEW_DB_DEFAULTS });
const showNewDbPassword = ref(false);

function openNewDatabase() {
  Object.assign(newDb, NEW_DB_DEFAULTS);
  showNewDbPassword.value = false;
  newDbOpen.value = true;
}

async function createDatabase() {
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(newDb.name)) return fail(new Error('Database name must start with a letter or underscore, then letters/digits/underscores.'));
  if (newDb.ownerMode === 'new') {
    if (!ident.test(newDb.userName)) return fail(new Error('User name must start with a letter or underscore, then letters/digits/underscores.'));
    if (!newDb.password) return fail(new Error('The new user needs a password — or press Generate.'));
  }
  busy.value = true;
  try {
    const res = await api.postgresCreateDatabase(
      newDb.ownerMode === 'new'
        ? { name: newDb.name, newOwner: { name: newDb.userName, password: newDb.password } }
        : { name: newDb.name, owner: newDb.owner },
    );
    notify(`Created database ${newDb.name}, owned by ${res.owner}`);
    newDbOpen.value = false;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

const dbDetail = ref<PostgresDatabase | null>(null);
const dbOwner = ref('');
const dbDropConfirm = ref('');

function openDatabase(d: PostgresDatabase) {
  dbDetail.value = d;
  dbOwner.value = d.owner;
  dbDropConfirm.value = '';
}

async function saveDatabaseOwner() {
  const d = dbDetail.value;
  if (!d || !dbOwner.value || dbOwner.value === d.owner) return;
  busy.value = true;
  try {
    await api.postgresSetDatabaseOwner(d.name, dbOwner.value);
    notify(`${d.name} is now owned by ${dbOwner.value}`);
    dbDetail.value = null;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function dropDatabase() {
  const d = dbDetail.value;
  if (!d || dbDropConfirm.value !== d.name) return;
  busy.value = true;
  try {
    await api.postgresDeleteDatabase(d.name, dbDropConfirm.value);
    notify(`Dropped database ${d.name}`);
    dbDetail.value = null;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

// ------------------------------------------------- logins (pg_hba.conf)

const hba = ref<PgHbaState | null>(null);
const hbaOpen = ref(false);
const hbaBusy = ref(false);
const HBA_DEFAULTS = { type: 'host', database: 'all', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' };
const hbaNew = reactive({ ...HBA_DEFAULTS });

async function loadHba() {
  try {
    hba.value = await api.postgresHba();
  } catch (err) {
    fail(err);
  }
}

function toggleHba() {
  hbaOpen.value = !hbaOpen.value;
  if (hbaOpen.value && !hba.value) loadHba();
}

/** A password rule that covers every database and user from this address — what
 *  a tunnelled pgAdmin (arriving on the server's loopback) needs. */
function allowsPasswordFrom(address: string, mask: string): boolean {
  return Boolean(
    hba.value?.rules.find(
      (r) =>
        !r.error &&
        r.type?.startsWith('host') &&
        r.type !== 'hostssl' &&
        r.address === address &&
        r.netmask === mask &&
        r.database?.includes('all') &&
        r.user_name?.includes('all'),
    )?.auth_method?.match(/^(scram-sha-256|md5)$/),
  );
}

const tunnelLoginsAllowed = computed(() => allowsPasswordFrom('127.0.0.1', '255.255.255.255'));

/** Docker's private range, where host.docker.internal connections come from. */
const containerLoginsAllowed = computed(() => allowsPasswordFrom('172.16.0.0', '255.240.0.0'));
/** 'localhost' alone shuts the containers out before pg_hba is even read. */
const listensForContainers = computed(() => {
  const value = hba.value?.listenAddresses ?? '';
  return value.split(',').some((a) => a.trim() === '*' || a.trim().startsWith('172.') || a.trim() === '0.0.0.0');
});

async function allowContainers() {
  const h = hba.value;
  if (!h) return;
  const restart = !listensForContainers.value;
  if (
    !confirm(
      'Let Docker containers (the DeviseHR API via host.docker.internal) log in with a password?\n\n' +
        '• pg_hba: host all all 172.16.0.0/12 scram-sha-256\n' +
        (restart ? `• listen_addresses: '${h.listenAddresses}' → '*', and PostgreSQL RESTARTS (open connections drop for a few seconds)\n` : '') +
        '\nKeep port ' + h.port + ' closed in the firewall (Ports page) — the containers reach it from inside the server.',
    )
  )
    return;
  if (!containerLoginsAllowed.value) {
    if (!(await addHbaRule({ type: 'host', database: 'all', user: 'all', address: '172.16.0.0/12', method: 'scram-sha-256' }, true))) return;
  }
  if (restart) {
    hbaBusy.value = true;
    try {
      await api.postgresSetListen('*');
    } catch (err) {
      fail(err);
      return;
    } finally {
      hbaBusy.value = false;
    }
  }
  notify('Containers can now log in with a password');
  await loadHba();
}

/** Other PostgreSQLs on the box — the usual reason a correct password "fails". */
const otherServers = computed(() => {
  const h = hba.value;
  if (!h) return [];
  return [
    ...h.clusters.filter((c) => c.port !== h.port).map((c) => `PostgreSQL ${c.version} (${c.name}) on port ${c.port}${c.online ? '' : ' — stopped'}`),
    ...h.containers.map((c) => `Docker: ${c}`),
  ];
});

async function addHbaRule(rule: typeof HBA_DEFAULTS, quiet = false) {
  if (rule.method === 'trust' && !confirm(`"trust" lets anyone matching this rule in WITHOUT a password.\n\nAdd it anyway?`)) return false;
  hbaBusy.value = true;
  try {
    await api.postgresHbaAdd(rule);
    if (!quiet) notify('Rule added and PostgreSQL reloaded');
    return true;
  } catch (err) {
    fail(err);
    return false;
  } finally {
    hbaBusy.value = false;
  }
}

async function allowTunnelLogins() {
  const v4 = await addHbaRule({ type: 'host', database: 'all', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' }, true);
  if (v4 && !allowsPasswordFrom('::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')) {
    await addHbaRule({ type: 'host', database: 'all', user: 'all', address: '::1/128', method: 'scram-sha-256' }, true);
  }
  if (v4) notify('Password logins over the tunnel are allowed');
  await loadHba();
}

async function addCustomHbaRule() {
  if (await addHbaRule({ ...hbaNew })) {
    Object.assign(hbaNew, HBA_DEFAULTS);
    await loadHba();
  }
}

async function removeHbaRule(rule: PgHbaRule) {
  if (!rule.line_number) return;
  const text = `${rule.type} ${rule.database?.join(',')} ${rule.user_name?.join(',')} ${rule.address ?? ''} ${rule.auth_method}`;
  if (!confirm(`Remove this rule?\n\n${text}\n\nIt's commented out in the file, not deleted, and PostgreSQL is reloaded. Anyone who logs in only through it will be refused.`)) return;
  hbaBusy.value = true;
  try {
    await api.postgresHbaRemove(rule.line_number);
    notify('Rule removed and PostgreSQL reloaded');
    await loadHba();
  } catch (err) {
    fail(err);
  } finally {
    hbaBusy.value = false;
  }
}

// ------------------------------------------------------------- SSH tunnel

const tunnel = ref<PostgresTunnelState | null>(null);
const tunnelPort = ref(15432);
const tunnelBusy = ref(false);
/** Which of pgAdmin's two ways in the guide shows: through SSHer's tunnel, or
 *  pgAdmin's own SSH Tunnel tab (no SSHer needed). Follows the switch until picked. */
const guideMode = ref<'ssher' | 'pgadmin'>('pgadmin');

interface GuideRow {
  tab: string;
  field: string;
  /** Exact value to type (copyable)… */
  value?: string;
  /** …or what to put there when only the user knows it. */
  note?: string;
}

const pgAdminGuide = computed<GuideRow[]>(() => {
  const t = tunnel.value;
  if (!t) return [];
  const db: GuideRow[] = [
    { tab: 'General', field: 'Name', note: `anything, e.g. ${t.ssh.host}` },
    { tab: 'Connection', field: 'Maintenance database', value: 'postgres' },
    { tab: 'Connection', field: 'Username', note: 'your PostgreSQL username (a role below that can log in)' },
    { tab: 'Connection', field: 'Password', note: 'your PostgreSQL password for that role' },
  ];
  if (guideMode.value === 'ssher') {
    return [
      db[0],
      { tab: 'Connection', field: 'Host name/address', value: t.bindHost },
      { tab: 'Connection', field: 'Port', value: String(t.tunnel?.localPort ?? tunnelPort.value) },
      ...db.slice(1),
      { tab: 'SSH Tunnel', field: 'Use SSH tunneling', note: 'OFF — this SSHer tunnel already is one' },
    ];
  }
  return [
    db[0],
    { tab: 'Connection', field: 'Host name/address', value: '127.0.0.1' },
    { tab: 'Connection', field: 'Port', value: String(t.postgresPort) },
    ...db.slice(1),
    { tab: 'SSH Tunnel', field: 'Use SSH tunneling', note: 'ON' },
    { tab: 'SSH Tunnel', field: 'Tunnel host', value: t.ssh.host },
    { tab: 'SSH Tunnel', field: 'Tunnel port', value: String(t.ssh.port) },
    { tab: 'SSH Tunnel', field: 'Username', value: t.ssh.username },
    { tab: 'SSH Tunnel', field: 'Authentication', note: 'Password (or Identity file if you log in with a key)' },
    { tab: 'SSH Tunnel', field: 'Password', note: `your SSH password — the one you log in to this server with as ${t.ssh.username}` },
  ];
});
let tunnelPoll: ReturnType<typeof setInterval> | undefined;

async function loadTunnel() {
  try {
    const first = !tunnel.value;
    tunnel.value = await api.postgresTunnel();
    if (tunnel.value.tunnel) tunnelPort.value = tunnel.value.tunnel.localPort;
    if (first && tunnel.value.tunnel) guideMode.value = 'ssher';
  } catch {
    // The rest of the page still works without it.
  }
}

async function toggleTunnel() {
  tunnelBusy.value = true;
  try {
    if (tunnel.value?.tunnel) {
      tunnel.value = await api.postgresTunnelStop();
      notify('Tunnel closed');
    } else {
      tunnel.value = await api.postgresTunnelStart(tunnelPort.value);
      guideMode.value = 'ssher';
      notify(`Tunnel open on ${tunnel.value.bindHost}:${tunnel.value.tunnel!.localPort}`);
    }
  } catch (err) {
    fail(err);
  } finally {
    tunnelBusy.value = false;
  }
}

// Keeps the connection count fresh while it's open; nothing to poll for otherwise.
watch(
  () => Boolean(tunnel.value?.tunnel),
  (open) => {
    clearInterval(tunnelPoll);
    if (open) tunnelPoll = setInterval(loadTunnel, 5000);
  },
);
onUnmounted(() => clearInterval(tunnelPoll));

const accessDb = ref('');
const accessSchemas = ref<string[]>([]);
const accessSchema = ref('');
const accessTables = ref<PostgresTablePrivileges[]>([]);
const accessDbPrivs = ref<PostgresDatabasePrivileges>({ connect: false, create: false, temporary: false });
const accessSchemaPrivs = ref<PostgresSchemaPrivileges>({ usage: false, create: false });
const accessLoading = ref(false);
const grantSequencesToo = ref(true);
const ownerBusy = ref<string | null>(null);

const usable = computed(() => Boolean(context.value?.installed && context.value?.reachable));

async function refresh() {
  loading.value = true;
  try {
    context.value = await api.postgresContext();
    if (context.value.installed && context.value.reachable) {
      const [r, d] = await Promise.all([api.postgresRoles(), api.postgresDatabases()]);
      roles.value = r.roles;
      databases.value = d.databases;
      if (selected.value) selected.value = roles.value.find((x) => x.name === selected.value!.name) ?? null;
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const installing = ref(false);
const installLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

async function installPostgres() {
  if (!confirm('Install PostgreSQL on this server?\n\nRuns apt-get install postgresql postgresql-contrib, then enables and starts the service.')) return;
  installing.value = true;
  installLog.value = { title: 'Installing PostgreSQL', steps: [], running: true, error: '' };
  try {
    const res = await api.postgresInstall();
    installLog.value = { title: 'Installing PostgreSQL', steps: res.log, running: false, error: '' };
    await refresh();
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    installLog.value = { title: 'Installing PostgreSQL', steps: log, running: false, error: (err as Error).message };
  } finally {
    installing.value = false;
  }
}

function select(role: PostgresRole) {
  selected.value = selected.value?.name === role.name ? null : role;
  tab.value = 'role';
  newPassword.value = '';
  accessDb.value = '';
  accessSchema.value = '';
  accessTables.value = [];
}

async function createRole() {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newRole.name)) {
    fail(new Error('Role name must start with a letter or underscore, then letters/digits/underscores.'));
    return;
  }
  if (newRole.login && !newRole.password) {
    fail(new Error('A user that can log in needs a password — or press Generate.'));
    return;
  }
  busy.value = true;
  try {
    const { database, access, ...rest } = newRole;
    await api.postgresCreateRole(database ? { ...rest, database, access } : rest);
    notify(`Created ${newRole.login ? 'user' : 'role'} ${newRole.name}${database ? ` with ${access === 'readonly' ? 'read-only' : 'read-write'} access to ${database}` : ''}`);
    showNewRolePassword.value = false;
    newRoleOpen.value = false;
    Object.assign(newRole, NEW_ROLE_DEFAULTS);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function deleteRole(role: PostgresRole) {
  if (!confirm(`Drop role "${role.name}"?\n\nFails if it still owns databases/tables — Postgres will say so.`)) return;
  busy.value = true;
  try {
    await api.postgresDeleteRole(role.name);
    notify(`Dropped ${role.name}`);
    selected.value = null;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function setPassword(role: PostgresRole) {
  if (!newPassword.value) return;
  busy.value = true;
  try {
    await api.postgresSetPassword(role.name, newPassword.value);
    notify(`Password updated for ${role.name}`);
    newPassword.value = '';
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function toggleAttribute(role: PostgresRole, key: (typeof ROLE_ATTRS)[number]) {
  if (key === 'superuser' && !role.superuser && !confirm(`Make ${role.name} a superuser?\n\nThis bypasses every permission check in the database.`)) return;
  if (key === 'bypassrls' && !role.bypassrls && !confirm(`Let ${role.name} bypass row-level security?\n\nAny RLS policy on any table stops applying to it.`)) return;
  busy.value = true;
  try {
    await api.postgresSetAttributes(role.name, { [key]: !role[key] });
    notify(`Updated ${role.name}`);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

watch(accessDb, async (db) => {
  accessSchema.value = '';
  accessTables.value = [];
  accessSchemas.value = db ? (await api.postgresSchemas(db).catch(() => ({ schemas: [] }))).schemas : [];
  if (accessSchemas.value.includes('public')) accessSchema.value = 'public';
});

async function loadTables() {
  if (!accessDb.value || !accessSchema.value || !selected.value) return;
  accessLoading.value = true;
  try {
    const res = await api.postgresTables(accessDb.value, accessSchema.value, selected.value.name);
    accessTables.value = res.tables;
    accessDbPrivs.value = res.database;
    accessSchemaPrivs.value = res.schema;
  } catch (err) {
    fail(err);
  } finally {
    accessLoading.value = false;
  }
}

watch(accessSchema, loadTables);

async function toggleDatabasePrivilege(privilege: PostgresDatabasePrivilege, key: keyof PostgresDatabasePrivileges) {
  if (!selected.value || !accessDb.value) return;
  const grant = !accessDbPrivs.value[key];
  try {
    await api.postgresGrant({ db: accessDb.value, role: selected.value.name, kind: 'database', privilege, grant });
    accessDbPrivs.value = { ...accessDbPrivs.value, [key]: grant };
    notify(`${grant ? 'Granted' : 'Revoked'} ${privilege} on ${accessDb.value}`);
  } catch (err) {
    fail(err);
  }
}

async function toggleSchemaPrivilege(privilege: PostgresSchemaPrivilege, key: keyof PostgresSchemaPrivileges) {
  if (!selected.value || !accessDb.value || !accessSchema.value) return;
  const grant = !accessSchemaPrivs.value[key];
  try {
    await api.postgresGrant({ db: accessDb.value, role: selected.value.name, kind: 'schema-privilege', schema: accessSchema.value, privilege, grant });
    accessSchemaPrivs.value = { ...accessSchemaPrivs.value, [key]: grant };
    notify(`${grant ? 'Granted' : 'Revoked'} ${privilege} on schema ${accessSchema.value}`);
  } catch (err) {
    fail(err);
  }
}

async function toggleTablePrivilege(table: PostgresTablePrivileges, privilege: PostgresTablePrivilege) {
  if (!selected.value || !accessDb.value || !accessSchema.value) return;
  const key = privilege.toLowerCase() as TableKey;
  const grant = !table[key];
  try {
    await api.postgresGrant({ db: accessDb.value, role: selected.value.name, kind: 'table', schema: accessSchema.value, table: table.name, privilege, grant });
    table[key] = grant;
  } catch (err) {
    fail(err);
  }
}

async function grantWholeSchema(includeFuture: boolean) {
  if (!selected.value || !accessDb.value || !accessSchema.value) return;
  const seq = grantSequencesToo.value;
  if (
    !confirm(
      `Grant SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on every table in "${accessSchema.value}" to ${selected.value.name}` +
        `${includeFuture ? ', including tables created later' : ''}${seq ? ', plus USAGE on its sequences (needed for serial/identity columns)' : ''}?`,
    )
  )
    return;
  try {
    await api.postgresGrant({
      db: accessDb.value,
      role: selected.value.name,
      kind: 'schema',
      schema: accessSchema.value,
      grant: true,
      includeFuture,
      includeSequences: seq,
    });
    notify('Granted');
    await loadTables();
  } catch (err) {
    fail(err);
  }
}

/** Ownership, not a grant — the actual mechanism behind "can this role ALTER or
 *  DROP the table", since Postgres has no privilege for either of those. */
async function changeOwner(table: PostgresTablePrivileges, newOwner: string) {
  if (!accessDb.value || !accessSchema.value || !newOwner || newOwner === table.owner) return;
  if (!confirm(`Make "${newOwner}" the owner of ${accessSchema.value}.${table.name}?\n\nOwnership — not a grant — is what lets a role ALTER or DROP this table.`)) return;
  ownerBusy.value = table.name;
  try {
    await api.postgresGrant({ db: accessDb.value, role: newOwner, kind: 'owner', schema: accessSchema.value, table: table.name });
    table.owner = newOwner;
    notify(`${table.name} is now owned by ${newOwner}`);
  } catch (err) {
    fail(err);
  } finally {
    ownerBusy.value = null;
  }
}

onMounted(() => {
  refresh();
  loadTunnel();
});

const btn = 'rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40';
const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
        <v-icon name="fa-database" scale="1.3" class="text-sky-300" />
        <div>
          <h1 class="text-base font-semibold text-white">PostgreSQL</h1>
          <p class="text-xs text-slate-500">
            <template v-if="usable">{{ roles.length }} roles · {{ databases.length }} databases</template>
            <template v-else>Not usable</template>
          </p>
        </div>
        <div class="flex-1" />
        <button class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh" @click="refresh">
          <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
        </button>
        <button
          v-if="usable"
          class="flex items-center gap-1.5 rounded-lg border border-sky-700/60 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/10"
          title="Copy a whole database to PostgreSQL on another server"
          @click="emit('navigate', 'dbtransfer')"
        >
          <v-icon name="fa-arrow-right" scale="0.75" /> Transfer
        </button>
        <button
          v-if="usable"
          class="flex items-center gap-1.5 rounded-lg border border-sky-600 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-500/10"
          @click="openNewDatabase"
        >
          <v-icon name="fa-database" scale="0.75" /> New database
        </button>
        <button
          v-if="usable"
          class="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
          @click="newRoleOpen = true"
        >
          <v-icon name="fa-plus" scale="0.75" /> New user
        </button>
      </div>


      <div class="min-h-0 flex-1 overflow-auto p-5">
        <div v-if="loading && !context" class="py-16 text-center">
          <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" />
        </div>

        <div v-else-if="!context?.installed" class="rounded-xl border border-amber-800/50 bg-amber-950/30 p-6 text-sm text-amber-200">
          <p class="font-medium">PostgreSQL isn't installed on this server.</p>
          <button
            class="mt-3 flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
            :disabled="installing"
            @click="installPostgres"
          >
            <v-icon :name="installing ? 'fa-spinner' : 'fa-cloud-download-alt'" :class="installing && 'animate-spin'" scale="0.8" />
            {{ installing ? 'Installing…' : 'Install PostgreSQL' }}
          </button>
        </div>

        <div v-else-if="!context.reachable" class="rounded-xl border border-amber-800/50 bg-amber-950/30 p-6 text-sm text-amber-200">
          <p class="font-medium">Installed, but couldn't connect as the postgres user.</p>
          <p class="mt-2 text-xs text-amber-300/80">
            This needs the connected account to be root, or to have sudo rights broad enough to run
            <code class="text-amber-200">sudo -u postgres …</code> (not just commands as root).
            {{ !sudoMode.enabled ? 'Sudo mode (top of the screen) does not change this — it only affects File Explorer actions.' : '' }}
          </p>
          <pre v-if="context.error" class="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950/60 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-amber-100/70">{{ context.error }}</pre>
        </div>

        <template v-else>
        <div v-if="tunnel" class="mb-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div class="flex flex-wrap items-center gap-3">
            <v-icon name="fa-plug" scale="0.9" :class="tunnel.tunnel ? 'text-emerald-400' : 'text-slate-500'" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-white">
                SSH tunnel for pgAdmin
                <span
                  class="ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  :class="tunnel.tunnel ? 'bg-emerald-900/50 text-emerald-300' : 'bg-slate-800 text-slate-400'"
                >
                  {{ tunnel.tunnel ? 'ON' : 'OFF' }}
                </span>
              </p>
              <p class="text-xs text-slate-500">
                Reach this server's PostgreSQL from your computer through the SSH connection — no VPN, and port 5432 stays closed to the internet.
              </p>
            </div>
            <label v-if="!tunnel.tunnel" class="flex items-center gap-1.5 text-xs text-slate-400">
              Local port
              <input v-model.number="tunnelPort" type="number" min="1" max="65535" class="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none" />
            </label>
            <button
              class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              :class="tunnel.tunnel ? 'bg-red-700 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-500'"
              :disabled="tunnelBusy || (!tunnel.tunnel && !tunnelPort)"
              @click="toggleTunnel"
            >
              <v-icon :name="tunnelBusy ? 'fa-spinner' : tunnel.tunnel ? 'fa-stop' : 'fa-play'" :class="tunnelBusy && 'animate-spin'" scale="0.7" />
              {{ tunnel.tunnel ? 'Disable' : 'Enable' }}
            </button>
          </div>

          <p v-if="tunnel.inContainer" class="mt-3 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
            This SSHer back end is running inside a container, so the tunnel opens on the container's own 127.0.0.1 — your computer can't reach it.
            Use the SSHer you run on your own PC (<code>npm start</code>) for this, or pgAdmin's built-in SSH Tunnel tab.
          </p>

          <div class="mt-3 border-t border-slate-800 pt-3 text-xs">
            <div class="mb-3 flex flex-wrap items-center gap-2">
              <span class="text-slate-400">pgAdmin › Register › Server — how it connects:</span>
              <button
                v-for="m in ([['ssher', 'Through this tunnel'], ['pgadmin', `pgAdmin's own SSH Tunnel tab`]] as const)"
                :key="m[0]"
                class="rounded-md border px-2 py-1 transition"
                :class="guideMode === m[0] ? 'border-emerald-500 text-white' : 'border-slate-700 text-slate-400 hover:text-slate-200'"
                @click="guideMode = m[0]"
              >
                {{ m[1] }}
              </button>
            </div>

            <p v-if="guideMode === 'ssher' && !tunnel.tunnel" class="mb-2 text-amber-300">Press Enable above first — these values only work while the tunnel is on.</p>

            <table class="w-full">
              <tbody>
                <tr v-for="row in pgAdminGuide" :key="row.tab + row.field" class="border-t border-slate-800/60 first:border-t-0">
                  <td class="w-28 py-1.5 align-top text-slate-500">{{ row.tab }}</td>
                  <td class="w-44 py-1.5 align-top text-slate-300">{{ row.field }}</td>
                  <td class="py-1.5">
                    <button v-if="row.value" class="font-mono text-emerald-300 hover:underline" title="Copy" @click="copy(row.value, row.field)">{{ row.value }}</button>
                    <span v-else class="italic text-sky-200">{{ row.note }}</span>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-if="guideMode === 'ssher' && tunnel.tunnel" class="mt-2 text-slate-500">
              Forwards to {{ tunnel.tunnel.remoteHost }}:{{ tunnel.tunnel.remotePort }} on the server ·
              {{ tunnel.tunnel.active }} open connection{{ tunnel.tunnel.active === 1 ? '' : 's' }} ({{ tunnel.tunnel.total }} so far) ·
              closes when you disable it or disconnect.
            </p>
            <p v-if="guideMode === 'pgadmin'" class="mt-2 text-slate-500">
              pgAdmin makes its own SSH connection here, so SSHer's Enable switch isn't needed for this way.
              "Host name" is 127.0.0.1 because it's read from the server's side of the tunnel.
            </p>
            <p v-if="tunnel.tunnel?.lastError" class="mt-2 text-red-300">{{ tunnel.tunnel.lastError }}</p>
          </div>
        </div>

        <div class="mb-4 rounded-xl border border-slate-800 bg-slate-900/60">
          <button class="flex w-full items-center gap-3 p-4 text-left" @click="toggleHba">
            <v-icon name="fa-shield-alt" scale="0.9" class="text-sky-300" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-white">Logins (pg_hba.conf)</p>
              <p class="text-xs text-slate-500">Who may log in, from where, and how — and which PostgreSQL servers this machine runs.</p>
            </div>
            <v-icon :name="hbaOpen ? 'fa-angle-down' : 'fa-chevron-right'" scale="0.8" class="text-slate-500" />
          </button>

          <div v-if="hbaOpen" class="border-t border-slate-800 p-4 text-xs">
            <div v-if="!hba" class="py-4 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
            <template v-else>
              <p class="mb-2 text-slate-400">
                Managing the PostgreSQL on port <span class="font-mono text-white">{{ hba.port }}</span> ·
                <button class="font-mono text-emerald-300 hover:underline" title="Copy" @click="copy(hba.path, 'path')">{{ hba.path }}</button>
                <button class="ml-2 text-slate-500 hover:text-white" title="Refresh" @click="loadHba"><v-icon name="fa-sync-alt" scale="0.7" /></button>
              </p>

              <div v-if="otherServers.length" class="mb-3 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-amber-200">
                <p class="font-medium">This server runs more than one PostgreSQL:</p>
                <ul class="mt-1 list-disc pl-5 font-mono text-[11px] text-amber-100/80">
                  <li v-for="o in otherServers" :key="o">{{ o }}</li>
                </ul>
                <p class="mt-1 text-[11px] text-amber-300/80">
                  Everything on this page is the one on port {{ hba.port }}. A client pointed at another port reaches a different server, with
                  different users and passwords — "password authentication failed" even when the password is right.
                </p>
              </div>

              <div class="mb-3 flex flex-wrap items-center gap-2">
                <template v-if="tunnelLoginsAllowed">
                  <span class="flex items-center gap-1.5 text-emerald-300"><v-icon name="fa-check-circle" scale="0.75" /> Password logins over the SSH tunnel are allowed (127.0.0.1).</span>
                </template>
                <template v-else>
                  <span class="text-amber-300">Password logins from 127.0.0.1 (the tunnel) aren't allowed yet.</span>
                  <button class="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50" :disabled="hbaBusy" @click="allowTunnelLogins">
                    Allow them
                  </button>
                </template>
              </div>

              <div v-if="hba.hasDocker" class="mb-3 flex flex-wrap items-center gap-2">
                <template v-if="containerLoginsAllowed && listensForContainers">
                  <span class="flex items-center gap-1.5 text-emerald-300"><v-icon name="fa-check-circle" scale="0.75" /> Docker containers can log in with a password (172.16.0.0/12, listening on '{{ hba.listenAddresses }}').</span>
                </template>
                <template v-else>
                  <span class="text-amber-300">
                    Docker containers can't reach this PostgreSQL yet<template v-if="!listensForContainers"> — it only listens on '{{ hba.listenAddresses }}'</template><template v-if="!containerLoginsAllowed">{{ listensForContainers ? ' —' : ',' }} no password rule for 172.16.0.0/12</template>.
                  </span>
                  <button class="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50" :disabled="hbaBusy" @click="allowContainers">
                    Allow containers
                  </button>
                </template>
              </div>

              <table class="w-full">
                <thead class="text-slate-500">
                  <tr>
                    <th class="py-1 text-left font-medium">Line</th>
                    <th class="text-left font-medium">Type</th>
                    <th class="text-left font-medium">Database</th>
                    <th class="text-left font-medium">User</th>
                    <th class="text-left font-medium">Address</th>
                    <th class="text-left font-medium">Method</th>
                    <th />
                  </tr>
                </thead>
                <tbody class="font-mono">
                  <tr v-for="r in hba.rules" :key="`${r.file_name}:${r.line_number}`" class="border-t border-slate-800/70" :class="r.error && 'text-red-300'">
                    <td class="py-1.5 text-slate-500">{{ r.line_number }}</td>
                    <td>{{ r.type }}</td>
                    <td>{{ r.database?.join(', ') }}</td>
                    <td>{{ r.user_name?.join(', ') }}</td>
                    <td>{{ r.address ?? '' }}<span v-if="r.netmask" class="text-slate-500"> / {{ r.netmask }}</span></td>
                    <td :class="r.auth_method === 'trust' ? 'text-red-300' : r.auth_method === 'reject' ? 'text-slate-500' : 'text-slate-200'">
                      {{ r.auth_method }}<span v-if="r.error" class="ml-2 font-sans">— {{ r.error }}</span>
                    </td>
                    <td class="text-right">
                      <button
                        v-if="!r.file_name || r.file_name === hba.path"
                        class="rounded p-1 text-slate-500 hover:bg-red-950 hover:text-red-300 disabled:opacity-40"
                        title="Remove (comments the line out)"
                        :disabled="hbaBusy"
                        @click="removeHbaRule(r)"
                      >
                        <v-icon name="fa-trash-alt" scale="0.65" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p class="mt-1 text-[11px] text-slate-500">Read top to bottom; the first line that matches decides. New rules go at the top.</p>

              <div class="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3">
                <label class="flex flex-col gap-1 text-slate-500">Type
                  <select v-model="hbaNew.type" class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100">
                    <option v-for="t in ['host', 'hostssl', 'hostnossl', 'local']" :key="t">{{ t }}</option>
                  </select>
                </label>
                <label class="flex flex-col gap-1 text-slate-500">Database
                  <input v-model="hbaNew.database" class="w-28 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
                </label>
                <label class="flex flex-col gap-1 text-slate-500">User
                  <input v-model="hbaNew.user" class="w-28 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" />
                </label>
                <label v-if="hbaNew.type !== 'local'" class="flex flex-col gap-1 text-slate-500">Address
                  <input v-model="hbaNew.address" class="w-36 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100" placeholder="172.16.0.0/12" />
                </label>
                <label class="flex flex-col gap-1 text-slate-500">Method
                  <select v-model="hbaNew.method" class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-100">
                    <option v-for="m in ['scram-sha-256', 'md5', 'peer', 'trust', 'reject']" :key="m">{{ m }}</option>
                  </select>
                </label>
                <button :class="btn" :disabled="hbaBusy" @click="addCustomHbaRule">Add rule</button>
              </div>
              <p class="mt-2 text-[11px] text-slate-500">
                Every change is checked by PostgreSQL before it's reloaded, and put back if it wouldn't parse. The previous file is kept as
                <span class="font-mono">{{ hba.path }}.ssher-bak</span>. Avoid 0.0.0.0/0 — use the SSH tunnel instead of opening the database to the internet.
              </p>
            </template>
          </div>
        </div>

        <div class="overflow-hidden rounded-xl border border-slate-800">
          <div v-if="databases.length" class="border-b border-slate-800 bg-slate-900/60 px-4 py-3">
            <p class="mb-2 flex items-center gap-2 text-xs text-slate-400">
              <v-icon name="fa-database" scale="0.7" class="text-sky-300" /> Databases
              <span class="text-slate-600">· {{ formatSize(databases.reduce((n, d) => n + (d.bytes ?? 0), 0)) }} in total</span>
            </p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="d in [...databases].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))"
                :key="d.name"
                class="rounded-md bg-slate-800 px-2 py-1 text-[11px] transition hover:bg-slate-700"
                :title="`Owner: ${d.owner} — click to change the owner or drop it`"
                @click="openDatabase(d)"
              >
                <span class="font-mono text-slate-200">{{ d.name }}</span>
                <span class="ml-1.5 text-slate-500">{{ d.owner }}</span>
                <span class="ml-1.5 text-sky-300">{{ formatSize(d.bytes ?? 0) }}</span>
              </button>
            </div>
          </div>
          <div
            v-for="role in roles"
            :key="role.name"
            class="border-b border-slate-800/70 bg-slate-950/40 last:border-b-0 hover:bg-slate-900/60"
          >
            <button class="flex w-full items-center gap-3 px-4 py-3 text-left" :class="selected?.name === role.name && 'bg-sky-500/5'" @click="select(role)">
              <v-icon name="fa-user" scale="0.9" class="text-sky-300" />
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                  {{ role.name }}
                  <span v-if="role.superuser" class="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300">superuser</span>
                  <span v-if="!role.canlogin" class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">no login</span>
                  <span v-if="role.createdb" class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">createdb</span>
                </p>
                <p class="truncate text-xs text-slate-500">{{ role.memberof.join(', ') || '—' }}</p>
              </div>
            </button>
          </div>
        </div>
        </template>
      </div>
    </div>

    <!-- Detail drawer -->
    <aside v-if="selected" class="flex w-[28rem] max-w-[50vw] shrink-0 flex-col border-l border-slate-800 bg-slate-900">
      <div class="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <v-icon name="fa-user" scale="0.9" class="text-sky-300" />
        <p class="min-w-0 flex-1 truncate text-sm font-semibold text-white">{{ selected.name }}</p>
        <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="selected = null"><v-icon name="fa-times" scale="0.8" /></button>
      </div>
      <div class="flex gap-1 border-b border-slate-800 px-3 pt-2 text-xs">
        <button v-for="t in (['role', 'access'] as const)" :key="t" class="rounded-t-md border-b-2 px-3 py-1.5 capitalize transition" :class="tab === t ? 'border-sky-400 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'" @click="tab = t">
          {{ t === 'role' ? 'Role' : 'Database access' }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-4 text-sm">
        <!-- Role tab -->
        <div v-if="tab === 'role'" class="space-y-4">
          <div class="flex flex-wrap gap-2">
            <label v-for="attr in ROLE_ATTRS" :key="attr" class="flex items-center gap-1.5 rounded-lg border border-slate-800 px-2.5 py-1.5 text-xs text-slate-300">
              <input type="checkbox" :checked="selected[attr]" class="accent-sky-500" :disabled="busy" @change="toggleAttribute(selected, attr)" />
              {{ ROLE_ATTR_LABEL[attr] }}
            </label>
          </div>

          <div>
            <label :class="label">New password</label>
            <div class="flex gap-2">
              <input v-model="newPassword" type="password" :class="[field, 'font-mono']" placeholder="•••••••" />
              <button :class="btn" :disabled="!newPassword || busy" @click="setPassword(selected)">Set</button>
            </div>
          </div>

          <button class="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950" :disabled="busy" @click="deleteRole(selected)">
            <v-icon name="fa-trash-alt" scale="0.7" /> Drop role
          </button>
        </div>

        <!-- Database access tab -->
        <div v-else class="space-y-4">
          <div>
            <label :class="label">Database</label>
            <select v-model="accessDb" :class="field">
              <option value="">Pick a database…</option>
              <option v-for="d in databases" :key="d.name" :value="d.name">{{ d.name }}{{ d.bytes ? ` (${formatSize(d.bytes)})` : '' }}</option>
            </select>
          </div>

          <template v-if="accessDb">
            <div class="space-y-1">
              <p class="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Database: {{ accessDb }}</p>
              <label v-for="p in DB_PRIVS" :key="p.privilege" class="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" :checked="accessDbPrivs[p.key]" class="accent-sky-500" @change="toggleDatabasePrivilege(p.privilege, p.key)" />
                {{ p.label }}
              </label>
            </div>

            <div>
              <label :class="label">Schema</label>
              <select v-model="accessSchema" :class="field">
                <option value="">Pick a schema…</option>
                <option v-for="s in accessSchemas" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>

            <template v-if="accessSchema">
              <div class="space-y-1">
                <p class="text-[11px] font-medium tracking-wide text-slate-500 uppercase">Schema: {{ accessSchema }}</p>
                <label v-for="p in SCHEMA_PRIVS" :key="p.privilege" class="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" :checked="accessSchemaPrivs[p.key]" class="accent-sky-500" @change="toggleSchemaPrivilege(p.privilege, p.key)" />
                  {{ p.label }}
                </label>
                <p v-if="!accessSchemaPrivs.usage" class="text-[11px] text-amber-300">
                  Without USAGE, the table grants below don't actually let this role do anything here.
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
                <button :class="btn" @click="grantWholeSchema(false)">Grant on whole schema</button>
                <button :class="btn" @click="grantWholeSchema(true)">+ future tables too</button>
                <label class="flex items-center gap-1.5 text-xs text-slate-400">
                  <input v-model="grantSequencesToo" type="checkbox" class="accent-sky-500" /> + sequences
                </label>
              </div>

              <div v-if="accessLoading" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
              <div v-else-if="accessTables.length" class="overflow-x-auto">
                <table class="w-full text-xs">
                  <thead class="text-slate-500">
                    <tr>
                      <th class="py-1 text-left font-medium">Table</th>
                      <th class="text-left font-medium">Owner</th>
                      <th v-for="p in TABLE_PRIVS" :key="p" class="w-9 font-medium" :title="p">{{ TABLE_PRIV_ABBR[p] }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="table in accessTables" :key="table.name" class="border-t border-slate-800/70">
                      <td class="py-1.5 font-mono text-slate-200">{{ table.name }}</td>
                      <td class="py-1.5">
                        <select
                          :value="table.owner"
                          :disabled="ownerBusy === table.name"
                          class="rounded border border-slate-800 bg-slate-950 px-1 py-0.5 font-mono text-[11px] text-slate-300 focus:border-sky-500 focus:outline-none"
                          @change="changeOwner(table, ($event.target as HTMLSelectElement).value)"
                        >
                          <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
                        </select>
                      </td>
                      <td v-for="p in TABLE_PRIVS" :key="p" class="text-center">
                        <input
                          type="checkbox"
                          class="accent-sky-500"
                          :checked="table[p.toLowerCase() as TableKey]"
                          @change="toggleTablePrivilege(table, p)"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p class="mt-2 text-[11px] text-slate-500">
                  Owner controls ALTER/DROP — Postgres has no grantable privilege for those, only ownership.
                </p>
              </div>
              <p v-else class="py-6 text-center text-slate-500">No tables in this schema.</p>
            </template>
          </template>
        </div>
      </div>
    </aside>

    <!-- New role -->
    <div v-if="newRoleOpen" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm" @click.self="newRoleOpen = false">
      <div class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="mb-4 text-base font-semibold text-white">New user</h2>
        <label :class="label">Name</label>
        <input v-model="newRole.name" :class="[field, 'mb-3 font-mono']" placeholder="app_user" />
        <label class="mb-3 flex items-center gap-2 text-xs text-slate-300">
          <input v-model="newRole.login" type="checkbox" class="accent-sky-500" /> Can log in
        </label>
        <template v-if="newRole.login">
          <label :class="label">Password</label>
          <div class="mb-3 flex gap-2">
            <input v-model="newRole.password" :type="showNewRolePassword ? 'text' : 'password'" :class="[field, 'font-mono']" autocomplete="new-password" />
            <button :class="btn" type="button" :title="showNewRolePassword ? 'Hide' : 'Show'" @click="showNewRolePassword = !showNewRolePassword">
              <v-icon :name="showNewRolePassword ? 'fa-eye-slash' : 'fa-eye'" scale="0.75" />
            </button>
            <button :class="btn" type="button" title="Generate a strong password" @click="fillGeneratedPassword">Generate</button>
            <button :class="btn" type="button" title="Copy" :disabled="!newRole.password" @click="copy(newRole.password, 'password')">
              <v-icon name="fa-copy" scale="0.75" />
            </button>
          </div>
        </template>
        <label :class="label">Access to a database (optional)</label>
        <select v-model="newRole.database" :class="[field, 'mb-2']">
          <option value="">None — grant it later under Database access</option>
          <option v-for="d in databases" :key="d.name" :value="d.name">{{ d.name }}</option>
        </select>
        <div v-if="newRole.database" class="mb-3 space-y-1 text-xs text-slate-300">
          <label class="flex items-center gap-1.5"><input v-model="newRole.access" type="radio" value="readonly" class="accent-sky-500" /> Read-only (SELECT)</label>
          <label class="flex items-center gap-1.5"><input v-model="newRole.access" type="radio" value="readwrite" class="accent-sky-500" /> Read-write (SELECT, INSERT, UPDATE, DELETE)</label>
          <p class="text-[11px] text-slate-500">Every schema, on existing tables and ones created later. Ownership (ALTER/DROP) is not given.</p>
        </div>
        <p class="mb-2 text-[11px] font-medium tracking-wide text-slate-500 uppercase">Attributes</p>
        <div class="mb-4 flex flex-wrap gap-3 text-xs text-slate-300">
          <label class="flex items-center gap-1.5"><input v-model="newRole.superuser" type="checkbox" class="accent-sky-500" /> Superuser</label>
          <label class="flex items-center gap-1.5"><input v-model="newRole.createdb" type="checkbox" class="accent-sky-500" /> Createdb</label>
          <label class="flex items-center gap-1.5"><input v-model="newRole.createrole" type="checkbox" class="accent-sky-500" /> Createrole</label>
          <label class="flex items-center gap-1.5"><input v-model="newRole.replication" type="checkbox" class="accent-sky-500" /> Replication</label>
          <label class="flex items-center gap-1.5"><input v-model="newRole.bypassrls" type="checkbox" class="accent-sky-500" /> Bypass RLS</label>
        </div>
        <div class="flex justify-end gap-2">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="newRoleOpen = false">Cancel</button>
          <button class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50" :disabled="!newRole.name || busy" @click="createRole">
            Create
          </button>
        </div>
      </div>
    </div>

    <!-- New database -->
    <div v-if="newDbOpen" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm" @click.self="newDbOpen = false">
      <div class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="mb-4 text-base font-semibold text-white">New database</h2>
        <label :class="label">Name</label>
        <input v-model="newDb.name" :class="[field, 'mb-3 font-mono']" placeholder="DeviseHR" />

        <p :class="label">Owner</p>
        <div class="mb-3 space-y-1 text-xs text-slate-300">
          <label class="flex items-center gap-1.5"><input v-model="newDb.ownerMode" type="radio" value="new" class="accent-sky-500" /> A new user, created now</label>
          <label class="flex items-center gap-1.5"><input v-model="newDb.ownerMode" type="radio" value="existing" class="accent-sky-500" /> An existing role</label>
        </div>

        <template v-if="newDb.ownerMode === 'new'">
          <label :class="label">User name</label>
          <input v-model="newDb.userName" :class="[field, 'mb-3 font-mono']" placeholder="app_db_user" />
          <label :class="label">Password</label>
          <div class="mb-3 flex gap-2">
            <input v-model="newDb.password" :type="showNewDbPassword ? 'text' : 'password'" :class="[field, 'font-mono']" autocomplete="new-password" />
            <button :class="btn" type="button" :title="showNewDbPassword ? 'Hide' : 'Show'" @click="showNewDbPassword = !showNewDbPassword">
              <v-icon :name="showNewDbPassword ? 'fa-eye-slash' : 'fa-eye'" scale="0.75" />
            </button>
            <button :class="btn" type="button" title="Generate a strong password" @click="newDb.password = generatePassword(); showNewDbPassword = true">Generate</button>
            <button :class="btn" type="button" title="Copy" :disabled="!newDb.password" @click="copy(newDb.password, 'password')">
              <v-icon name="fa-copy" scale="0.75" />
            </button>
          </div>
        </template>
        <select v-else v-model="newDb.owner" :class="[field, 'mb-3 font-mono']">
          <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
        </select>

        <p class="mb-4 text-[11px] text-slate-500">
          The owner can create, change and drop everything inside it — what an app that runs its own migrations needs.
          Put this user and password in the app's settings, and in pgAdmin.
        </p>
        <div class="flex justify-end gap-2">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="newDbOpen = false">Cancel</button>
          <button class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50" :disabled="!newDb.name || busy" @click="createDatabase">
            Create
          </button>
        </div>
      </div>
    </div>

    <!-- Database: owner / drop -->
    <div v-if="dbDetail" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm" @click.self="dbDetail = null">
      <div class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="mb-1 font-mono text-base font-semibold text-white">{{ dbDetail.name }}</h2>
        <p class="mb-4 text-xs text-slate-500">{{ formatSize(dbDetail.bytes ?? 0) }} · owned by {{ dbDetail.owner }}</p>

        <label :class="label">Owner</label>
        <div class="mb-4 flex gap-2">
          <select v-model="dbOwner" :class="[field, 'font-mono']">
            <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
          </select>
          <button :class="btn" :disabled="busy || dbOwner === dbDetail.owner" @click="saveDatabaseOwner">Change</button>
        </div>

        <template v-if="!['postgres', 'template0', 'template1'].includes(dbDetail.name)">
          <label :class="label">Drop — type <span class="font-mono text-red-300">{{ dbDetail.name }}</span> to confirm</label>
          <div class="mb-4 flex gap-2">
            <input v-model="dbDropConfirm" :class="[field, 'font-mono']" />
            <button
              class="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950 disabled:opacity-40"
              :disabled="busy || dbDropConfirm !== dbDetail.name"
              @click="dropDatabase"
            >
              Drop
            </button>
          </div>
          <p class="mb-4 text-[11px] text-slate-500">Dropping deletes every table and row in it. Fails while anything is connected to it.</p>
        </template>

        <div class="flex justify-end">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="dbDetail = null">Close</button>
        </div>
      </div>
    </div>

    <StepLog
      v-if="installLog"
      :title="installLog.title"
      :steps="installLog.steps"
      :running="installLog.running"
      :error="installLog.error"
      @close="installLog = null"
    />
  </div>
</template>
