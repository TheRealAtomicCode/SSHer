<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import type { DbSummary } from '../api';
import { formatSize } from '../files';
import { fail } from '../toast';
import type { PostgresDatabase, StepResult, View } from '../types';
import StepLog from './StepLog.vue';

const props = defineProps<{ initial?: string }>();
const emit = defineEmits<{ navigate: [View]; select: [string] }>();

const databases = ref<PostgresDatabase[]>([]);
const summaries = ref<Record<string, DbSummary | 'error' | undefined>>({});
const loading = ref(true);
const selected = ref(props.initial ?? '');

async function refresh() {
  loading.value = true;
  try {
    databases.value = (await api.postgresDatabases()).databases;
    if (!selected.value || !databases.value.some((d) => d.name === selected.value)) {
      selected.value = databases.value.find((d) => d.name !== 'postgres')?.name ?? databases.value[0]?.name ?? '';
    }
    // What's in each one — fetched one by one so a slow database doesn't hold up the rest.
    for (const d of databases.value) {
      api
        .postgresDbSummary(d.name)
        .then((r) => (summaries.value = { ...summaries.value, [d.name]: r.summary }))
        .catch(() => (summaries.value = { ...summaries.value, [d.name]: 'error' }));
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

watch(selected, (db) => db && emit('select', db));
watch(() => props.initial, (db) => db && db !== selected.value && (selected.value = db));

const summary = computed(() => {
  const s = summaries.value[selected.value];
  return s && s !== 'error' ? s : null;
});

/** The kinds of objects a full transfer carries, in reading order. */
const KINDS: { key: keyof DbSummary; label: string; icon: string }[] = [
  { key: 'schemas', label: 'Schemas', icon: 'fa-folder' },
  { key: 'tables', label: 'Tables', icon: 'fa-th' },
  { key: 'rows', label: 'Rows (approx.)', icon: 'fa-list-ul' },
  { key: 'views', label: 'Views', icon: 'fa-eye' },
  { key: 'matviews', label: 'Materialized views', icon: 'fa-eye' },
  { key: 'functions', label: 'Functions', icon: 'fa-code' },
  { key: 'procedures', label: 'Procedures', icon: 'fa-code' },
  { key: 'triggers', label: 'Triggers', icon: 'fa-bolt' },
  { key: 'indexes', label: 'Indexes', icon: 'fa-search' },
  { key: 'sequences', label: 'Sequences', icon: 'fa-sort-numeric-down' },
  { key: 'extensions', label: 'Extensions', icon: 'fa-plug' },
];

// ------------------------------------------------------------------ the form

const form = reactive({
  host: '',
  port: 5432,
  user: 'postgres',
  password: '',
  targetDb: '',
  ifExists: 'stop' as 'stop' | 'replace',
  sslmode: 'prefer' as 'prefer' | 'require' | 'disable',
});
/** The target's SSH login, for a PostgreSQL that only listens on the target's own 127.0.0.1. */
const ssh = reactive({ enabled: false, host: '', port: 22, username: '', password: '', dbHost: '127.0.0.1', dbPort: 5432 });
const showPassword = ref(false);
const showSshPassword = ref(false);

// The same server either way — carry the address across when the switch flips.
watch(() => ssh.enabled, (on) => {
  if (on && !ssh.host) ssh.host = form.host.trim();
  if (!on && !form.host) form.host = ssh.host;
});
const testing = ref(false);
const test = ref<{ ok: boolean; message: string; exists?: boolean; canCreateDb?: boolean; versions?: string } | null>(null);
const log = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

// The copy keeps the source's name unless you change it.
watch(selected, (db, old) => {
  if (!form.targetDb || form.targetDb === old) form.targetDb = db;
}, { immediate: true });
watch(() => [form.host, form.port, form.user, form.password, form.targetDb, form.sslmode, { ...ssh }], () => (test.value = null), { deep: true });

const ready = computed(
  () =>
    selected.value &&
    form.user.trim() &&
    form.password &&
    form.targetDb.trim() &&
    (ssh.enabled ? ssh.host.trim() && ssh.username.trim() && ssh.password : form.host.trim()),
);
const target = () =>
  ssh.enabled
    ? {
        host: ssh.host.trim(),
        port: Number(ssh.dbPort) || 5432,
        user: form.user.trim(),
        password: form.password,
        sslmode: form.sslmode,
        ssh: { ...ssh, host: ssh.host.trim(), username: ssh.username.trim(), port: Number(ssh.port) || 22, dbPort: Number(ssh.dbPort) || 5432 },
      }
    : { host: form.host.trim(), port: Number(form.port) || 5432, user: form.user.trim(), password: form.password, sslmode: form.sslmode };
/** How the target reads in messages. */
const where = () =>
  ssh.enabled ? `${form.user}@${ssh.host} (SSH tunnel as ${ssh.username} → ${ssh.dbHost}:${ssh.dbPort})` : `${form.user}@${form.host}:${form.port}`;

async function runTest() {
  testing.value = true;
  try {
    const r = await api.postgresTransferTest({ ...target(), targetDb: form.targetDb.trim() });
    const major = (v: string) => Number(v.split('.')[0]) || 0;
    const older = major(r.targetVersion) < major(r.sourceVersion);
    test.value = {
      ok: true,
      exists: r.exists,
      canCreateDb: r.canCreateDb,
      versions: `this server PostgreSQL ${r.sourceVersion.split(' ')[0]} → target ${r.targetVersion.split(' ')[0]}${older ? ' — the target is OLDER; restoring into an older version can fail' : ''}`,
      message: `Connected to ${where()}.`,
    };
  } catch (err) {
    test.value = { ok: false, message: (err as Error).message };
  } finally {
    testing.value = false;
  }
}

async function transfer() {
  if (!ready.value) return;
  const t = target();
  const replacing = test.value?.exists && form.ifExists === 'replace';
  const s = summary.value;
  const sure = confirm(
    `Copy "${selected.value}" to ${where()} as "${form.targetDb}"?\n\n` +
      (s ? `${s.tables} tables (~${s.rows.toLocaleString()} rows), ${s.functions + s.procedures} functions/procedures, ${s.indexes} indexes, ${s.views + s.matviews} views — ${formatSize(s.bytes)}\n\n` : '') +
      (replacing ? `"${form.targetDb}" ALREADY EXISTS there and will be DELETED first.\n\n` : '') +
      'This server is not changed.',
  );
  if (!sure) return;
  const title = `Transferring ${selected.value} → ${t.host} / ${form.targetDb}`;
  log.value = { title, steps: [], running: true, error: '' };
  try {
    const r = await api.postgresTransfer({ ...t, sourceDb: selected.value, targetDb: form.targetDb.trim(), ifExists: form.ifExists });
    log.value = { title: `${title} — done in ${r.seconds}s`, steps: r.log, running: false, error: '' };
    test.value = null;
  } catch (err) {
    const steps = err instanceof api.ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.value = { title, steps, running: false, error: (err as Error).message };
  }
}

const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Header -->
    <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
      <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" title="Back to PostgreSQL" @click="emit('navigate', 'postgres')">
        <v-icon name="fa-arrow-left" scale="0.8" />
      </button>
      <v-icon name="fa-database" scale="1.2" class="text-sky-300" />
      <div class="flex-1">
        <h1 class="text-base font-semibold text-white">Transfer a database</h1>
        <p class="text-xs text-slate-500">Copy a whole database — structure, data and code — to PostgreSQL on another server.</p>
      </div>
      <button class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh" @click="refresh">
        <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
      </button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <!-- Databases -->
      <aside class="shrink-0 overflow-auto border-slate-800 p-3 lg:w-80 lg:border-r">
        <p class="mb-2 px-1 text-[11px] font-medium text-slate-500">1. Pick a database on this server</p>
        <div v-if="loading && !databases.length" class="py-8 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
        <button
          v-for="d in databases"
          :key="d.name"
          class="mb-1.5 w-full rounded-xl border p-3 text-left transition"
          :class="selected === d.name ? 'border-sky-600 bg-sky-500/10' : 'border-slate-800 bg-slate-900/40 hover:border-slate-600'"
          @click="selected = d.name"
        >
          <div class="flex items-center gap-2">
            <v-icon name="fa-database" scale="0.75" :class="selected === d.name ? 'text-sky-300' : 'text-slate-500'" />
            <span class="flex-1 truncate font-mono text-sm text-white">{{ d.name }}</span>
            <span class="text-[11px] text-slate-400">{{ formatSize(d.bytes ?? 0) }}</span>
          </div>
          <p class="mt-1 text-[11px] text-slate-500">
            owner {{ d.owner }}
            <template v-if="summaries[d.name] && summaries[d.name] !== 'error'">
              · {{ (summaries[d.name] as DbSummary).tables }} tables · {{ (summaries[d.name] as DbSummary).functions + (summaries[d.name] as DbSummary).procedures }} functions
            </template>
            <template v-else-if="summaries[d.name] === 'error'"> · couldn't read its contents</template>
          </p>
        </button>
      </aside>

      <!-- What gets copied + where -->
      <div class="min-h-0 flex-1 overflow-auto p-5">
        <div v-if="selected" class="mx-auto max-w-3xl space-y-5">
          <section>
            <p class="mb-2 text-[11px] font-medium text-slate-500">What gets copied from <span class="font-mono text-slate-300">{{ selected }}</span></p>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div v-for="k in KINDS" :key="k.key" class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5" :class="summary && !summary[k.key] && 'opacity-40'">
                <p class="flex items-center gap-1.5 text-[10px] text-slate-500"><v-icon :name="k.icon" scale="0.55" /> {{ k.label }}</p>
                <p class="mt-0.5 text-lg font-semibold text-white tabular-nums">{{ summary ? summary[k.key].toLocaleString() : '…' }}</p>
              </div>
              <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
                <p class="text-[10px] text-slate-500">Size</p>
                <p class="mt-0.5 text-lg font-semibold text-white">{{ summary ? formatSize(summary.bytes) : '…' }}</p>
              </div>
            </div>
            <p class="mt-2 text-[11px] text-slate-500">
              Also copied: constraints (primary/foreign keys), defaults, column types, comments and sequence positions.
              Not copied: roles/users and their permissions — those belong to the server, not the database, so everything
              ends up owned by the target user.
            </p>
          </section>

          <section class="space-y-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <p class="text-[11px] font-medium text-slate-500">2. Where to</p>
            <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 px-3 py-2.5" :class="ssh.enabled && 'border-emerald-700/60 bg-emerald-950/20'">
              <input v-model="ssh.enabled" type="checkbox" class="mt-0.5 accent-emerald-500" />
              <span class="text-xs">
                <span class="font-medium text-white">Connect through an SSH tunnel</span>
                <span class="mt-0.5 block text-slate-400">
                  For a target whose PostgreSQL port is closed (listens on its own 127.0.0.1 only). SSHer logs in to the target over SSH and
                  carries the connection there — no firewall port or pg_hba change for this server's IP.
                </span>
              </span>
            </label>

            <p v-if="!ssh.enabled" class="rounded-lg border border-sky-900/50 bg-sky-950/20 px-3 py-2 text-xs leading-relaxed text-sky-200/90">
              <b>This server connects to the target</b>, so the target's PostgreSQL port must accept this server's IP (its
              firewall and pg_hba.conf) — not your browser's. If it doesn't, turn on the SSH tunnel above.
            </p>

            <template v-if="ssh.enabled">
              <p class="text-[11px] font-medium text-slate-500">SSH login to the target</p>
              <div class="grid grid-cols-[1fr_6rem] gap-3">
                <div>
                  <label :class="label">Target server IP / hostname</label>
                  <input v-model="ssh.host" placeholder="102.203.201.222" autocomplete="off" :class="[field, 'font-mono']" />
                </div>
                <div>
                  <label :class="label">SSH port</label>
                  <input v-model.number="ssh.port" type="number" min="1" max="65535" :class="field" />
                </div>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label :class="label">SSH username</label>
                  <input v-model="ssh.username" placeholder="your login on that server" autocomplete="off" :class="[field, 'font-mono']" />
                </div>
                <div>
                  <label :class="label">SSH password</label>
                  <div class="relative">
                    <input v-model="ssh.password" :type="showSshPassword ? 'text' : 'password'" autocomplete="new-password" :class="[field, 'pr-9']" />
                    <button type="button" tabindex="-1" class="absolute top-1/2 right-2 -translate-y-1/2 text-slate-500 hover:text-white" @click="showSshPassword = !showSshPassword">
                      <v-icon :name="showSshPassword ? 'fa-eye-slash' : 'fa-eye'" scale="0.75" />
                    </button>
                  </div>
                </div>
              </div>
              <div class="grid grid-cols-[1fr_6rem] gap-3">
                <div>
                  <label :class="label">PostgreSQL host, as seen from the target</label>
                  <input v-model="ssh.dbHost" autocomplete="off" :class="[field, 'font-mono']" />
                </div>
                <div>
                  <label :class="label">Its port</label>
                  <input v-model.number="ssh.dbPort" type="number" min="1" max="65535" :class="field" />
                </div>
              </div>
              <p class="-mt-2 text-[11px] text-slate-500">
                Normally 127.0.0.1 and 5432 — or 5433 for a second cluster (PostgreSQL → Logins on the target shows its port). The target's pg_hba
                needs <span class="font-mono">host … 127.0.0.1/32 scram-sha-256</span>, which Debian has by default.
              </p>
              <p class="text-[11px] font-medium text-slate-500">PostgreSQL login on the target</p>
            </template>

            <div v-if="!ssh.enabled" class="grid grid-cols-[1fr_6rem] gap-3">
              <div>
                <label :class="label">Target server IP / hostname</label>
                <input v-model="form.host" placeholder="203.0.113.10" autocomplete="off" :class="[field, 'font-mono']" />
              </div>
              <div>
                <label :class="label">Port</label>
                <input v-model.number="form.port" type="number" min="1" max="65535" :class="field" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label :class="label">PostgreSQL username there</label>
                <input v-model="form.user" autocomplete="off" :class="[field, 'font-mono']" />
              </div>
              <div>
                <label :class="label">Password</label>
                <div class="relative">
                  <input v-model="form.password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" :class="[field, 'pr-9']" />
                  <button type="button" tabindex="-1" class="absolute top-1/2 right-2 -translate-y-1/2 text-slate-500 hover:text-white" @click="showPassword = !showPassword">
                    <v-icon :name="showPassword ? 'fa-eye-slash' : 'fa-eye'" scale="0.75" />
                  </button>
                </div>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label :class="label">Name of the copy there</label>
                <input v-model="form.targetDb" :class="[field, 'font-mono']" />
              </div>
              <div>
                <label :class="label">Encryption (SSL)</label>
                <select v-model="form.sslmode" :class="field">
                  <option value="prefer">Use it if the target supports it</option>
                  <option value="require">Require it</option>
                  <option value="disable">Off</option>
                </select>
              </div>
            </div>
            <div>
              <label :class="label">If "{{ form.targetDb || 'that name' }}" already exists there</label>
              <div class="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 p-0.5 text-xs">
                <button type="button" class="rounded-md py-1.5" :class="form.ifExists === 'stop' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'" @click="form.ifExists = 'stop'">
                  Stop — don't touch it
                </button>
                <button type="button" class="rounded-md py-1.5" :class="form.ifExists === 'replace' ? 'bg-red-900/60 text-red-100' : 'text-slate-400 hover:text-white'" @click="form.ifExists = 'replace'">
                  Replace it (delete, then copy)
                </button>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button
                class="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 disabled:opacity-40"
                :disabled="!ready || testing"
                @click="runTest"
              >
                <v-icon :name="testing ? 'fa-spinner' : 'fa-plug'" :class="testing && 'animate-spin'" scale="0.65" /> Test connection
              </button>
              <button
                class="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
                :disabled="!ready || Boolean(log?.running)"
                @click="transfer"
              >
                <v-icon name="fa-arrow-right" scale="0.75" /> Transfer {{ selected }}
              </button>
            </div>

            <div
              v-if="test"
              class="rounded-lg border px-3 py-2 text-xs"
              :class="test.ok ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-red-900/60 bg-red-950/40 text-red-200'"
            >
              <p class="font-medium">{{ test.message }}</p>
              <template v-if="test.ok">
                <p class="mt-1 text-emerald-200/80">{{ test.versions }}</p>
                <p v-if="!test.canCreateDb" class="mt-1 text-amber-300">This user can't create databases there — ask for CREATEDB, or use a superuser.</p>
                <p v-if="test.exists" class="mt-1" :class="form.ifExists === 'replace' ? 'text-red-300' : 'text-amber-300'">
                  "{{ form.targetDb }}" already exists there — {{ form.ifExists === 'replace' ? 'it will be deleted and replaced' : 'the transfer will stop unless you choose "Replace it"' }}.
                </p>
              </template>
            </div>
          </section>

          <section class="rounded-xl border border-slate-800 p-4 text-[11px] leading-relaxed text-slate-500">
            <p class="mb-1 font-medium text-slate-300">How it works</p>
            <ol class="list-decimal space-y-0.5 pl-4">
              <li>Creates "{{ form.targetDb || selected }}" on the target (deleting it first only if you chose "Replace").</li>
              <li>Streams <code>pg_dump</code> from this server straight into <code>pg_restore</code> on the target, inside one transaction — if anything fails, nothing is left half-copied.</li>
              <li>Checks the result: exact row counts for every table, plus the number of schemas, tables, views, functions, procedures, triggers, indexes, sequences and extensions, on both servers.</li>
            </ol>
            <p class="mt-1">The password is used once, from a temporary file only PostgreSQL can read, then deleted — it never appears in a command or the activity log.</p>
          </section>
        </div>
      </div>
    </div>

    <StepLog v-if="log" :title="log.title" :steps="log.steps" :running="log.running" :error="log.error" @close="log = null" />
  </div>
</template>
