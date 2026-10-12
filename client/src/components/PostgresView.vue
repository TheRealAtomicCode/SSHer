<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { sudoMode } from '../sudoMode';
import { fail, notify } from '../toast';
import type { PostgresContext, PostgresDatabase, PostgresRole, PostgresTablePrivilege, PostgresTablePrivileges } from '../types';

const loading = ref(true);
const context = ref<PostgresContext | null>(null);
const roles = ref<PostgresRole[]>([]);
const databases = ref<PostgresDatabase[]>([]);

const selected = ref<PostgresRole | null>(null);
const tab = ref<'role' | 'access'>('role');
const busy = ref(false);

const newRoleOpen = ref(false);
const newRole = reactive({ name: '', login: true, password: '', superuser: false, createdb: false, createrole: false });

const newPassword = ref('');

const accessDb = ref('');
const accessSchemas = ref<string[]>([]);
const accessSchema = ref('');
const accessTables = ref<PostgresTablePrivileges[]>([]);
const accessConnect = ref(false);
const accessLoading = ref(false);

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
    Object.assign(newRole, { name: '', login: true, password: '', superuser: false, createdb: false, createrole: false });
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

async function toggleAttribute(role: PostgresRole, key: 'superuser' | 'createdb' | 'createrole' | 'canlogin') {
  if (key === 'superuser' && !role.superuser && !confirm(`Make ${role.name} a superuser?\n\nThis bypasses every permission check in the database.`)) return;
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
    accessConnect.value = res.connect;
  } catch (err) {
    fail(err);
  } finally {
    accessLoading.value = false;
  }
}

watch(accessSchema, loadTables);

async function toggleConnect() {
  if (!selected.value || !accessDb.value) return;
  const grant = !accessConnect.value;
  try {
    await api.postgresGrant({ db: accessDb.value, role: selected.value.name, kind: 'database', grant });
    accessConnect.value = grant;
    notify(`${grant ? 'Granted' : 'Revoked'} CONNECT on ${accessDb.value}`);
  } catch (err) {
    fail(err);
  }
}

async function toggleTablePrivilege(table: PostgresTablePrivileges, privilege: PostgresTablePrivilege) {
  if (!selected.value || !accessDb.value || !accessSchema.value) return;
  const key = privilege.toLowerCase() as 'select' | 'insert' | 'update' | 'delete';
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
  if (!confirm(`Grant SELECT/INSERT/UPDATE/DELETE on every table in "${accessSchema.value}" to ${selected.value.name}${includeFuture ? ', including tables created later' : ''}?`)) return;
  try {
    await api.postgresGrant({ db: accessDb.value, role: selected.value.name, kind: 'schema', schema: accessSchema.value, grant: true, includeFuture });
    notify('Granted');
    await loadTables();
  } catch (err) {
    fail(err);
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
            <label v-for="attr in (['canlogin','superuser','createdb','createrole'] as const)" :key="attr" class="flex items-center gap-1.5 rounded-lg border border-slate-800 px-2.5 py-1.5 text-xs text-slate-300">
              <input type="checkbox" :checked="selected[attr]" class="accent-sky-500" :disabled="busy" @change="toggleAttribute(selected, attr)" />
              {{ attr === 'canlogin' ? 'Can log in' : attr }}
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
            <label class="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" :checked="accessConnect" class="accent-sky-500" @change="toggleConnect" />
              Can CONNECT to {{ accessDb }}
            </label>

            <div>
              <label :class="label">Schema</label>
              <select v-model="accessSchema" :class="field">
                <option value="">Pick a schema…</option>
                <option v-for="s in accessSchemas" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>

            <template v-if="accessSchema">
              <div class="flex gap-2">
                <button :class="btn" @click="grantWholeSchema(false)">Grant on whole schema</button>
                <button :class="btn" @click="grantWholeSchema(true)">+ future tables too</button>
              </div>

              <div v-if="accessLoading" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
              <table v-else-if="accessTables.length" class="w-full text-xs">
                <thead class="text-slate-500">
                  <tr>
                    <th class="py-1 text-left font-medium">Table</th>
                    <th v-for="p in (['SELECT','INSERT','UPDATE','DELETE'] as const)" :key="p" class="w-12 font-medium">{{ p[0] }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="table in accessTables" :key="table.name" class="border-t border-slate-800/70">
                    <td class="py-1.5 font-mono text-slate-200">{{ table.name }}</td>
                    <td v-for="p in (['SELECT','INSERT','UPDATE','DELETE'] as const)" :key="p" class="text-center">
                      <input
                        type="checkbox"
                        class="accent-sky-500"
                        :checked="table[p.toLowerCase() as 'select'|'insert'|'update'|'delete']"
                        @change="toggleTablePrivilege(table, p)"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
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
        </div>
        <div class="flex justify-end gap-2">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="newRoleOpen = false">Cancel</button>
          <button class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50" :disabled="!newRole.name || busy" @click="createRole">
            Create
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
