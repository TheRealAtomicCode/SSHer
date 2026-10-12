<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail, notify } from '../toast';
import type { PgBackRestBackupEntry, PgBackRestContext, PostgresDatabase, StepResult } from '../types';
import StepLog from './StepLog.vue';

const loading = ref(true);
const context = ref<PgBackRestContext | null>(null);
const databases = ref<PostgresDatabase[]>([]);
/** Purely informational — pgBackRest restores the whole cluster, never one
 *  database. This is here so the restore section can show what's in the
 *  cluster you're about to roll back, not to scope anything. */
const contextDb = ref('');

const backupsLoading = ref(false);
const backups = ref<PgBackRestBackupEntry[]>([]);
const earliest = ref<number | null>(null);
const latest = ref<number | null>(null);

async function refresh() {
  loading.value = true;
  try {
    context.value = await api.pgbackrestContext();
    databases.value = (await api.postgresDatabases().catch(() => ({ databases: [] }))).databases;
    if (context.value.configured) await refreshBackups();
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

async function refreshBackups() {
  backupsLoading.value = true;
  try {
    const res = await api.pgbackrestBackups();
    backups.value = res.backups;
    earliest.value = res.earliest;
    latest.value = res.latest;
  } catch (err) {
    fail(err);
  } finally {
    backupsLoading.value = false;
  }
}

// ---------------------------------------------------------------- install

const installing = ref(false);
const installLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

async function installPgBackRest() {
  if (!confirm('Install pgBackRest on this server?\n\nRuns apt-get install pgbackrest.')) return;
  installing.value = true;
  installLog.value = { title: 'Installing pgBackRest', steps: [], running: true, error: '' };
  try {
    const res = await api.pgbackrestInstall();
    installLog.value = { title: 'Installing pgBackRest', steps: res.log, running: false, error: '' };
    await refresh();
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    installLog.value = { title: 'Installing pgBackRest', steps: log, running: false, error: (err as Error).message };
  } finally {
    installing.value = false;
  }
}

// -------------------------------------------------------------- configure

const CONFIG_DEFAULTS = { stanza: 'main', repo1Path: '/var/lib/pgbackrest' };
const form = reactive({ ...CONFIG_DEFAULTS });
const remoteEnabled = ref(false);
const remote = reactive({ host: '', port: 22, user: 'postgres', path: '/var/lib/pgbackrest' });

const publicKey = ref('');
const keyLoading = ref(false);

async function fetchKey() {
  if (publicKey.value || keyLoading.value) return;
  keyLoading.value = true;
  try {
    const res = await api.pgbackrestSshKey();
    publicKey.value = res.publicKey;
  } catch (err) {
    fail(err);
  } finally {
    keyLoading.value = false;
  }
}

function enableRemote() {
  remoteEnabled.value = true;
  fetchKey();
}

async function copyKey() {
  await navigator.clipboard.writeText(publicKey.value);
  notify('Public key copied');
}

const configuring = ref(false);
const configureLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

async function configure() {
  if (
    !confirm(
      `Enable backups with stanza "${form.stanza}"?\n\nThis turns on WAL archiving (archive_mode = on) in postgresql.conf and restarts PostgreSQL — any connections in flight at that moment are dropped.`,
    )
  )
    return;
  configuring.value = true;
  configureLog.value = { title: 'Enabling backups', steps: [], running: true, error: '' };
  try {
    const res = await api.pgbackrestConfigure({
      stanza: form.stanza,
      repo1Path: form.repo1Path,
      remote: remoteEnabled.value && remote.host ? { ...remote } : undefined,
    });
    configureLog.value = { title: 'Enabling backups', steps: res.log, running: false, error: '' };
    await refresh();
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    configureLog.value = { title: 'Enabling backups', steps: log, running: false, error: (err as Error).message };
  } finally {
    configuring.value = false;
  }
}

// ----------------------------------------------------------------- backup

const backingUp = ref<'full' | 'diff' | 'incr' | ''>('');
const hasAnyBackup = computed(() => backups.value.length > 0);

async function runBackup(type: 'full' | 'diff' | 'incr', repo?: 1 | 2) {
  backingUp.value = type;
  try {
    await api.pgbackrestBackup(type, repo);
    notify(`${type === 'full' ? 'Full' : type === 'diff' ? 'Differential' : 'Incremental'} backup started and finished`);
    await refreshBackups();
  } catch (err) {
    fail(err);
  } finally {
    backingUp.value = '';
  }
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------- restore

/** Times are kept and shown in UTC — the restore point is sent with an
 *  explicit +00 offset, so there is no guessing at the server's own
 *  timezone setting the way a plain local-time string would need. */
function toUtcInputValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

const restoreTarget = ref('');
const restoreRepo = ref<1 | 2 | ''>('');
const restoring = ref(false);
const restoreLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

const restoreMin = computed(() => (earliest.value ? toUtcInputValue(earliest.value) : ''));
const restoreMax = computed(() => (latest.value ? toUtcInputValue(latest.value) : ''));

async function doRestore() {
  if (!restoreTarget.value) return;
  const sure = confirm(
    `Restore to ${restoreTarget.value} UTC?\n\n` +
      'This STOPS PostgreSQL, REPLACES THE ENTIRE CLUSTER’S DATA with this point in time, ' +
      'and CANNOT BE UNDONE. Every database on this server goes back to that instant, not just one. ' +
      'Make sure anyone depending on current data knows first.',
  );
  if (!sure) return;
  restoring.value = true;
  restoreLog.value = { title: `Restoring to ${restoreTarget.value} UTC`, steps: [], running: true, error: '' };
  try {
    const res = await api.pgbackrestRestore(`${restoreTarget.value.replace('T', ' ')}+00`, restoreRepo.value || undefined);
    restoreLog.value = { title: `Restoring to ${restoreTarget.value} UTC`, steps: res.log, running: false, error: '' };
    notify('Restore complete');
    await refresh();
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    restoreLog.value = { title: `Restoring to ${restoreTarget.value} UTC`, steps: log, running: false, error: (err as Error).message };
  } finally {
    restoring.value = false;
  }
}

onMounted(refresh);

const btn = 'flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40';
const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
const note = 'rounded-lg border border-sky-900/50 bg-sky-950/20 px-3 py-2 text-xs text-sky-200/90';
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
      <v-icon name="fa-save" scale="1.3" class="text-sky-300" />
      <div>
        <h1 class="text-base font-semibold text-white">Backups</h1>
        <p class="text-xs text-slate-500">
          <template v-if="context?.configured">pgBackRest · stanza {{ context.stanza }} · {{ backups.length }} backup(s)</template>
          <template v-else-if="context?.installed">pgBackRest installed, not yet configured</template>
          <template v-else>pgBackRest (PostgreSQL backup & point-in-time restore)</template>
        </p>
      </div>
      <div class="flex-1" />
      <button class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh" @click="refresh">
        <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <div v-if="loading && !context" class="py-16 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" />
      </div>

      <!-- Not installed -->
      <div v-else-if="!context?.installed" class="mx-auto max-w-xl space-y-4">
        <p :class="note">
          pgBackRest takes backups of a PostgreSQL cluster and can restore it to any point in time
          covered by your backups and archived WAL — not just back to the last backup itself.
        </p>
        <div class="rounded-xl border border-amber-800/50 bg-amber-950/30 p-6 text-sm text-amber-200">
          <p class="font-medium">pgBackRest isn't installed on this server.</p>
          <button
            class="mt-3 flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
            :disabled="installing"
            @click="installPgBackRest"
          >
            <v-icon :name="installing ? 'fa-spinner' : 'fa-cloud-download-alt'" :class="installing && 'animate-spin'" scale="0.8" />
            {{ installing ? 'Installing…' : 'Install pgBackRest' }}
          </button>
        </div>
      </div>

      <!-- Not configured -->
      <div v-else-if="!context.configured" class="mx-auto max-w-xl space-y-4">
        <p :class="note">
          This sets up WAL archiving and a stanza (pgBackRest's name for one PostgreSQL cluster) so
          backups and point-in-time restore become possible. It edits postgresql.conf and restarts
          PostgreSQL once.
        </p>
        <p v-if="!context.dataDir" class="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          Could not detect the PostgreSQL data directory — is PostgreSQL installed and running?
        </p>

        <div>
          <label :class="label">Stanza name</label>
          <input v-model="form.stanza" :class="[field, 'font-mono']" placeholder="main" />
        </div>

        <div>
          <label :class="label">Local backup repo path</label>
          <input v-model="form.repo1Path" :class="[field, 'font-mono']" placeholder="/var/lib/pgbackrest" />
          <p class="mt-1 text-[11px] text-slate-500">Created on this server if it doesn't already exist.</p>
        </div>

        <div class="rounded-xl border border-slate-800 p-4">
          <label class="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" class="accent-sky-500" :checked="remoteEnabled" @change="($event.target as HTMLInputElement).checked ? enableRemote() : (remoteEnabled = false)" />
            Also send backups to another server
          </label>

          <template v-if="remoteEnabled">
            <p class="mt-3 text-xs text-slate-500">
              pgBackRest reaches a remote repo over plain SSH as the server's own postgres user — that
              server has to already trust the key below. Nothing here opens a second connection from
              SSHer itself.
            </p>
            <div class="mt-3 grid grid-cols-[1fr_6rem] gap-2">
              <div>
                <label :class="label">Host</label>
                <input v-model="remote.host" :class="field" placeholder="backup.example.com" />
              </div>
              <div>
                <label :class="label">Port</label>
                <input v-model.number="remote.port" type="number" :class="field" />
              </div>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label :class="label">User</label>
                <input v-model="remote.user" :class="[field, 'font-mono']" />
              </div>
              <div>
                <label :class="label">Path on that server</label>
                <input v-model="remote.path" :class="[field, 'font-mono']" />
              </div>
            </div>

            <div class="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <p class="mb-2 text-xs text-slate-400">
                Add this key to <span class="font-mono text-slate-300">{{ remote.user || 'postgres' }}@{{ remote.host || '<host>' }}</span>:
              </p>
              <div v-if="keyLoading" class="py-2 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
              <template v-else-if="publicKey">
                <pre class="max-h-24 overflow-auto rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-slate-300">{{ publicKey }}</pre>
                <div class="mt-2 flex items-center gap-2">
                  <button :class="btn" @click="copyKey"><v-icon name="fa-copy" scale="0.7" /> Copy key</button>
                  <code class="truncate text-[10px] text-slate-500">echo '{{ publicKey.slice(0, 20) }}…' &gt;&gt; ~{{ remote.user ? `${remote.user}` : 'postgres' }}/.ssh/authorized_keys</code>
                </div>
              </template>
            </div>
          </template>
        </div>

        <button
          class="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          :disabled="configuring || !form.stanza || !form.repo1Path"
          @click="configure"
        >
          <v-icon :name="configuring ? 'fa-spinner' : 'fa-check'" :class="configuring && 'animate-spin'" scale="0.8" />
          {{ configuring ? 'Enabling…' : 'Enable backups' }}
        </button>
      </div>

      <!-- Configured -->
      <div v-else class="mx-auto max-w-3xl space-y-6">
        <div class="rounded-xl border border-slate-800 p-4 text-xs text-slate-400">
          <p><span class="text-slate-500">Stanza</span> <span class="font-mono text-slate-200">{{ context.stanza }}</span></p>
          <p class="mt-1"><span class="text-slate-500">Data directory</span> <span class="font-mono text-slate-200">{{ context.dataDir }}</span></p>
          <p class="mt-1"><span class="text-slate-500">Local repo</span> <span class="font-mono text-slate-200">{{ context.repo1?.path }}</span></p>
          <p v-if="context.repo2" class="mt-1">
            <span class="text-slate-500">Remote repo</span>
            <span class="font-mono text-slate-200">{{ context.repo2.user }}@{{ context.repo2.host }}:{{ context.repo2.path }}</span>
          </p>
          <div class="mt-2">
            <label :class="[label, 'mb-1 inline-block']">For context, what's in this cluster</label>
            <select v-model="contextDb" :class="[field, 'inline-block w-auto']">
              <option value="">Pick a database…</option>
              <option v-for="d in databases" :key="d.name" :value="d.name">{{ d.name }} (owner: {{ d.owner }})</option>
            </select>
            <p class="mt-1 text-[11px] text-slate-500">
              This is informational only — a restore always covers the whole cluster, every database on it, not just this one.
            </p>
          </div>
        </div>

        <!-- Take a backup -->
        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-white">Take a backup</h2>
          <p :class="note">
            Full copies everything; differential and incremental only copy what changed since the
            last full backup (faster, smaller) — but need one to already exist.
          </p>
          <div class="flex flex-wrap gap-2">
            <button :class="btn" :disabled="!!backingUp" @click="runBackup('full', context.repo2 ? 1 : undefined)">
              <v-icon :name="backingUp === 'full' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'full' && 'animate-spin'" scale="0.75" /> Full backup
            </button>
            <button :class="btn" :disabled="!!backingUp || !hasAnyBackup" @click="runBackup('diff', context.repo2 ? 1 : undefined)">
              <v-icon :name="backingUp === 'diff' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'diff' && 'animate-spin'" scale="0.75" /> Differential
            </button>
            <button :class="btn" :disabled="!!backingUp || !hasAnyBackup" @click="runBackup('incr', context.repo2 ? 1 : undefined)">
              <v-icon :name="backingUp === 'incr' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'incr' && 'animate-spin'" scale="0.75" /> Incremental
            </button>
            <template v-if="context.repo2">
              <span class="self-center text-xs text-slate-600">|</span>
              <button :class="btn" :disabled="!!backingUp" @click="runBackup('full', 2)">
                <v-icon :name="backingUp === 'full' ? 'fa-spinner' : 'fa-cloud-upload-alt'" :class="backingUp === 'full' && 'animate-spin'" scale="0.75" /> Full to remote
              </button>
            </template>
          </div>
        </section>

        <!-- Backup history -->
        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-white">Backup history</h2>
          <div v-if="backupsLoading" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
          <p v-else-if="!backups.length" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
            No backups yet — take a full backup above to get started.
          </p>
          <div v-else class="overflow-hidden rounded-xl border border-slate-800">
            <table class="w-full text-xs">
              <thead class="bg-slate-900/60 text-slate-500">
                <tr>
                  <th class="px-3 py-2 text-left font-medium">Label</th>
                  <th class="px-3 py-2 text-left font-medium">Type</th>
                  <th class="px-3 py-2 text-left font-medium">Finished</th>
                  <th class="px-3 py-2 text-left font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in backups" :key="b.label" class="border-t border-slate-800/70">
                  <td class="px-3 py-1.5 font-mono text-slate-200">{{ b.label }}</td>
                  <td class="px-3 py-1.5 text-slate-400 capitalize">{{ b.type }}</td>
                  <td class="px-3 py-1.5 text-slate-400">{{ b.stopTime ? new Date(b.stopTime).toLocaleString() : '—' }}</td>
                  <td class="px-3 py-1.5 text-slate-400">{{ sizeText(b.sizeBytes) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Restore -->
        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-white">Restore to a point in time</h2>
          <p :class="note">
            Picks an instant and rebuilds the <strong>entire cluster</strong> — every database on it —
            to exactly how it looked then. There is no per-database restore with pgBackRest; the
            write-ahead log this relies on doesn't work that way.
          </p>
          <p v-if="!hasAnyBackup" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
            Take a backup first — there's nothing to restore to yet.
          </p>
          <template v-else>
            <div>
              <label :class="label">Restore point (UTC)</label>
              <input v-model="restoreTarget" type="datetime-local" step="1" :min="restoreMin" :max="restoreMax" :class="[field, 'font-mono']" />
              <p class="mt-1 text-[11px] text-slate-500">
                Recoverable window: {{ restoreMin || '—' }} to {{ restoreMax || '—' }} (UTC).
              </p>
            </div>
            <div v-if="context.repo2">
              <label :class="label">Restore from</label>
              <select v-model="restoreRepo" :class="field">
                <option value="">Default repo</option>
                <option value="1">Local repo</option>
                <option value="2">Remote repo</option>
              </select>
            </div>
            <button
              class="flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
              :disabled="restoring || !restoreTarget"
              @click="doRestore"
            >
              <v-icon :name="restoring ? 'fa-spinner' : 'fa-history'" :class="restoring && 'animate-spin'" scale="0.8" />
              {{ restoring ? 'Restoring…' : 'Restore' }}
            </button>
          </template>
        </section>
      </div>
    </div>

    <StepLog v-if="installLog" :title="installLog.title" :steps="installLog.steps" :running="installLog.running" :error="installLog.error" @close="installLog = null" />
    <StepLog v-if="configureLog" :title="configureLog.title" :steps="configureLog.steps" :running="configureLog.running" :error="configureLog.error" @close="configureLog = null" />
    <StepLog v-if="restoreLog" :title="restoreLog.title" :steps="restoreLog.steps" :running="restoreLog.running" :error="restoreLog.error" @close="restoreLog = null" />
  </div>
</template>
