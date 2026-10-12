<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
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
  StepResult,
} from '../types';
import StepLog from './StepLog.vue';

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
const NEW_ROLE_DEFAULTS = { name: '', login: true, password: '', superuser: false, createdb: false, createrole: false, replication: false, bypassrls: false };
const newRole = reactive({ ...NEW_ROLE_DEFAULTS });

const newPassword = ref('');

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
  busy.value = true;
  try {
    await api.postgresCreateRole({ ...newRole });
    notify(`Created role ${newRole.name}`);
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

onMounted(refresh);

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
          class="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
          @click="newRoleOpen = true"
        >
          <v-icon name="fa-plus" scale="0.75" /> New role
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

        <div v-else class="overflow-hidden rounded-xl border border-slate-800">
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
              <option v-for="d in databases" :key="d.name" :value="d.name">{{ d.name }}</option>
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
        <h2 class="mb-4 text-base font-semibold text-white">New role</h2>
        <label :class="label">Name</label>
        <input v-model="newRole.name" :class="[field, 'mb-3 font-mono']" placeholder="app_user" />
        <label class="mb-3 flex items-center gap-2 text-xs text-slate-300">
          <input v-model="newRole.login" type="checkbox" class="accent-sky-500" /> Can log in
        </label>
        <template v-if="newRole.login">
          <label :class="label">Password</label>
          <input v-model="newRole.password" type="password" :class="[field, 'mb-3 font-mono']" />
        </template>
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
