<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail, notify } from '../toast';
import type { PgBackRestBackupEntry, PgBackRestContext, PgBackRestStats, StepResult } from '../types';
import DateTimePicker from './DateTimePicker.vue';
import StepLog from './StepLog.vue';

const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }] }>();

const loading = ref(true);
const context = ref<PgBackRestContext | null>(null);
const stats = ref<PgBackRestStats | null>(null);

const backupsLoading = ref(false);
const backups = ref<PgBackRestBackupEntry[]>([]);
const earliest = ref<number | null>(null);
const latest = ref<number | null>(null);
const sizes = ref<{ backupsBytes: number; walArchiveBytes: number } | null>(null);

/** Ticks once a minute so "x min ago" and the rewind window stay current. */
const now = ref(Date.now());
const ticker = setInterval(() => (now.value = Date.now()), 30_000);
onUnmounted(() => clearInterval(ticker));

type Log = { title: string; steps: StepResult[]; running: boolean; error: string };
const log = ref<Log | null>(null);

/** Runs a server operation that returns a step log, showing it as it goes. */
async function withLog(title: string, fn: () => Promise<{ log: StepResult[] }>): Promise<boolean> {
  log.value = { title, steps: [], running: true, error: '' };
  try {
    const res = await fn();
    log.value = { title, steps: res.log, running: false, error: '' };
    return true;
  } catch (err) {
    const steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.value = { title, steps, running: false, error: (err as Error).message };
    return false;
  }
}

async function refresh() {
  loading.value = true;
  try {
    const [ctx, st] = await Promise.all([api.pgbackrestContext(), api.pgbackrestStats().catch(() => null)]);
    context.value = ctx;
    stats.value = st;
    settings.retentionDays = ctx.retentionDays ?? ctx.retentionCount ?? 7;
    if (ctx.schedule) Object.assign(settings.schedule, ctx.schedule);
    if (ctx.configured && ctx.stanzaReady) await refreshBackups();
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
    sizes.value = res.sizes ?? null;
  } catch (err) {
    fail(err);
  } finally {
    backupsLoading.value = false;
  }
}

// ------------------------------------------------------------------ format

function sizeText(bytes: number | undefined | null): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function ago(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now.value - ms) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const when = (ms: number) => new Date(ms).toLocaleString();
const pct = (used: number, size: number) => (size ? Math.round((used / size) * 100) : 0);

// ------------------------------------------------------------------ health

const arch = computed(() => context.value?.archiving ?? null);
const lastArchivedMs = computed(() => (arch.value?.lastArchivedTime ? Date.parse(arch.value.lastArchivedTime) : null));
/** A failure newer than the last success means archiving is broken right now. */
const archivingFailing = computed(() => {
  const a = arch.value;
  if (!a?.lastFailedTime) return false;
  return !a.lastArchivedTime || Date.parse(a.lastFailedTime) > Date.parse(a.lastArchivedTime);
});
const archivingOk = computed(() => Boolean(arch.value?.usesPgBackRest && arch.value.mode === 'on' && !archivingFailing.value));

const dbTotal = computed(() => (stats.value?.databases ?? []).reduce((n, d) => n + d.bytes, 0));
const hasFull = computed(() => backups.value.some((b) => b.type === 'full'));

// ------------------------------------------------------------------ install / setup

async function installPgBackRest() {
  if (!confirm('Install pgBackRest on this server?\n\nRuns apt-get install pgbackrest.')) return;
  if (await withLog('Installing pgBackRest', api.pgbackrestInstall)) await refresh();
}

const form = reactive({ stanza: 'main', repo1Path: '/var/lib/pgbackrest', retentionDays: 7 });
const remoteEnabled = ref(false);
const remote = reactive({ host: '', port: 22, user: 'postgres', path: '/var/lib/pgbackrest' });
const publicKey = ref('');
const keyLoading = ref(false);

async function enableRemote() {
  remoteEnabled.value = true;
  if (publicKey.value || keyLoading.value) return;
  keyLoading.value = true;
  try {
    publicKey.value = (await api.pgbackrestSshKey()).publicKey;
  } catch (err) {
    fail(err);
  } finally {
    keyLoading.value = false;
  }
}

async function copyKey() {
  await navigator.clipboard.writeText(publicKey.value);
  notify('Public key copied');
}

async function configure() {
  const dbs = (stats.value?.databases ?? []).map((d) => d.name).join(', ');
  if (
    !confirm(
      `Enable backups (stanza "${form.stanza}")?\n\n` +
        `• Backs up EVERY database on this PostgreSQL server${dbs ? `: ${dbs}` : ''}\n` +
        `• Turns on WAL archiving in postgresql.conf (archive_mode, archive_timeout = 60 s)\n` +
        '• Restarts PostgreSQL once — connections in flight at that moment are dropped',
    )
  )
    return;
  const ok = await withLog('Enabling backups', () =>
    api.pgbackrestConfigure({
      stanza: form.stanza,
      repo1Path: form.repo1Path,
      retentionDays: form.retentionDays,
      remote: remoteEnabled.value && remote.host ? { ...remote } : undefined,
    }),
  );
  if (ok) await refresh();
}

async function finishSetup() {
  if (!confirm('Finish setting up backups?\n\nTurns WAL archiving on if it is off (restarting PostgreSQL), creates the stanza and checks archiving works.')) return;
  if (await withLog('Finishing setup', api.pgbackrestFinishSetup)) await refresh();
}

// ------------------------------------------------------------------ backup

const backingUp = ref<'full' | 'diff' | 'incr' | ''>('');
const TYPE_NAME = { full: 'Full', diff: 'Differential', incr: 'Incremental' } as const;

async function runBackup(type: 'full' | 'diff' | 'incr', repo?: 1 | 2) {
  backingUp.value = type;
  try {
    await api.pgbackrestBackup(type, repo);
    notify(`${TYPE_NAME[type]} backup finished`);
    await Promise.all([refreshBackups(), api.pgbackrestStats().then((s) => (stats.value = s)).catch(() => {})]);
  } catch (err) {
    fail(err);
  } finally {
    backingUp.value = '';
  }
}

// ------------------------------------------------------------------ how far back

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const settings = reactive({ retentionDays: 7, schedule: { enabled: false, fullDay: 0, hour: 2 } });

async function saveSettings() {
  const ok = await withLog('Saving backup settings', () =>
    api.pgbackrestSettings({ retentionDays: settings.retentionDays, schedule: { ...settings.schedule } }),
  );
  if (ok) await refresh();
}

// ------------------------------------------------------------------ rewind

/** The newest point is "now": a rewind archives the current WAL before it starts. */
const windowEnd = computed(() => (archivingOk.value && earliest.value ? now.value : latest.value));
const canRewind = computed(() => Boolean(earliest.value && windowEnd.value));

const PRESETS = [
  { label: '1 min ago', ms: 60_000 },
  { label: '5 min ago', ms: 5 * 60_000 },
  { label: '15 min ago', ms: 15 * 60_000 },
  { label: '1 hour ago', ms: 3_600_000 },
  { label: '6 hours ago', ms: 6 * 3_600_000 },
  { label: '1 day ago', ms: 86_400_000 },
];
const presetReachable = (ms: number) => Boolean(earliest.value && now.value - ms >= earliest.value);

/** The chosen instant, as epoch ms. Set by a preset or the exact-time box. */
const target = ref<number | null>(null);
const pickedPreset = ref('');

function pickPreset(p: { label: string; ms: number }) {
  target.value = Math.floor((now.value - p.ms) / 1000) * 1000;
  pickedPreset.value = p.label;
}

const targetProblem = computed(() => {
  if (!target.value) return '';
  if (earliest.value && target.value < earliest.value)
    return `Too far back: the oldest backup finished ${when(earliest.value)}. You can't rewind past it.`;
  if (target.value > now.value) return 'That time is in the future.';
  if (!archivingOk.value && latest.value && target.value > latest.value)
    return `WAL archiving isn't working, so nothing after ${when(latest.value)} can be replayed.`;
  return '';
});

const confirmRewind = ref(false);
const rewindRepo = ref<1 | 2 | ''>('');

/** pgBackRest wants "YYYY-MM-DD HH:MM:SS+00" — the ISO "T…Z" form defeats its
 *  automatic choice of which backup to start from. */
const targetForServer = computed(() =>
  target.value ? `${new Date(target.value).toISOString().slice(0, 19).replace('T', ' ')}+00` : '',
);

async function doRewind() {
  if (!target.value || targetProblem.value || !confirmRewind.value) return;
  const ok = await withLog(`Rewinding to ${when(target.value)}`, () =>
    api.pgbackrestRestore(targetForServer.value, rewindRepo.value || undefined),
  );
  confirmRewind.value = false;
  if (ok) {
    notify('Rewind complete — PostgreSQL is back up');
    target.value = null;
    await refresh();
  }
}

onMounted(refresh);

const btn = 'flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-sky-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';
const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
const note = 'rounded-lg border border-sky-900/50 bg-sky-950/20 px-3 py-2 text-xs leading-relaxed text-sky-200/90';
const card = 'rounded-xl border border-slate-800 bg-slate-900/40 p-4';
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
      <v-icon name="fa-save" scale="1.3" class="text-sky-300" />
      <div>
        <h1 class="text-base font-semibold text-white">Backups &amp; rewind</h1>
        <p class="text-xs text-slate-500">
          <template v-if="context?.configured && context.stanzaReady">pgBackRest · stanza {{ context.stanza }} · {{ backups.length }} backup(s)</template>
          <template v-else-if="context?.configured">pgBackRest · setup not finished</template>
          <template v-else-if="context?.installed">pgBackRest installed, not yet set up</template>
          <template v-else>pgBackRest — PostgreSQL backups and point-in-time rewind</template>
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

      <div v-else class="mx-auto max-w-4xl space-y-6">
        <!-- ============================================== stats -->
        <section v-if="stats" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div v-for="d in stats.disks" :key="d.mount" :class="card">
            <p class="text-[11px] text-slate-500">
              Free disk · <span class="font-mono">{{ d.mount }}</span>
            </p>
            <p class="mt-1 text-lg font-semibold" :class="d.avail / d.size < 0.1 ? 'text-red-300' : 'text-white'">
              {{ sizeText(d.avail) }} <span class="text-xs font-normal text-slate-500">of {{ sizeText(d.size) }}</span>
            </p>
            <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div class="h-full rounded-full" :class="pct(d.used, d.size) > 90 ? 'bg-red-500' : pct(d.used, d.size) > 75 ? 'bg-amber-500' : 'bg-sky-500'" :style="{ width: `${pct(d.used, d.size)}%` }" />
            </div>
            <p class="mt-1 text-[10px] text-slate-600">
              {{ pct(d.used, d.size) }}% used · holds {{ (d.holds ?? []).map((h) => (h === stats!.dataDir ? 'database' : h === stats!.repoPath ? 'backups' : h)).join(', ') }}
            </p>
          </div>
          <div :class="card">
            <p class="text-[11px] text-slate-500">Databases (live)</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ sizeText(dbTotal) }}</p>
            <p class="text-[10px] text-slate-600">{{ stats.databases.length }} database(s) — see below</p>
          </div>
          <div v-if="sizes" :class="card">
            <p class="text-[11px] text-slate-500">Backups</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ sizeText(sizes.backupsBytes) }}</p>
            <p class="text-[10px] text-slate-600">{{ backups.length }} backup(s), compressed</p>
          </div>
          <div v-if="sizes" :class="card">
            <p class="text-[11px] text-slate-500">WAL archive</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ sizeText(sizes.walArchiveBytes) }}</p>
            <p class="text-[10px] text-slate-600">change log that makes rewind possible · {{ sizeText(stats.walLocalBytes) }} still in pg_wal</p>
          </div>
        </section>

        <!-- ============================================== not installed -->
        <div v-if="!context?.installed" class="space-y-4">
          <p :class="note">
            pgBackRest takes backups of PostgreSQL and lets you rewind it to any second covered by those
            backups and the archived write-ahead log — e.g. "the state 5 minutes ago, before that bad INSERT".
          </p>
          <div class="rounded-xl border border-amber-800/50 bg-amber-950/30 p-6 text-sm text-amber-200">
            <p class="font-medium">pgBackRest isn't installed on this server.</p>
            <button class="mt-3 flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500" @click="installPgBackRest">
              <v-icon name="fa-cloud-download-alt" scale="0.8" /> Install pgBackRest
            </button>
          </div>
        </div>

        <!-- ============================================== not configured -->
        <div v-else-if="!context.configured" class="space-y-4">
          <p :class="note">
            <b>What gets backed up:</b> the whole PostgreSQL server — every database on it, not one you pick.
            Backups and the write-ahead log (WAL) cover all of them together, and a rewind takes them all back
            together; PostgreSQL has no per-database version of either.
          </p>
          <div v-if="stats?.databases.length" :class="card">
            <p class="mb-2 text-xs text-slate-400">Databases that will be included:</p>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="d in stats.databases" :key="d.name" class="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                {{ d.name }} <span class="text-slate-500">{{ sizeText(d.bytes) }}</span>
              </span>
            </div>
          </div>
          <p v-if="!context.dataDir" class="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            Could not detect the PostgreSQL data directory — is PostgreSQL installed and running?
          </p>

          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label :class="label">Stanza name</label>
              <input v-model="form.stanza" :class="[field, 'font-mono']" placeholder="main" />
              <p class="mt-1 text-[11px] text-slate-500">pgBackRest's name for this PostgreSQL server.</p>
            </div>
            <div>
              <label :class="label">How far back should you be able to rewind?</label>
              <div class="flex items-center gap-2">
                <input v-model.number="form.retentionDays" type="number" min="1" max="3650" :class="[field, 'w-24']" />
                <span class="text-sm text-slate-400">days</span>
              </div>
              <p class="mt-1 text-[11px] text-slate-500">Older backups and WAL are deleted automatically.</p>
            </div>
          </div>

          <div>
            <label :class="label">Where to keep backups on this server</label>
            <input v-model="form.repo1Path" :class="[field, 'font-mono']" placeholder="/var/lib/pgbackrest" />
            <p class="mt-1 text-[11px] text-slate-500">
              Created if missing. Needs room for at least one full copy of the databases ({{ sizeText(dbTotal) }} now) plus the WAL.
            </p>
          </div>

          <div class="rounded-xl border border-slate-800 p-4">
            <label class="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" class="accent-sky-500" :checked="remoteEnabled" @change="($event.target as HTMLInputElement).checked ? enableRemote() : (remoteEnabled = false)" />
              Also send backups to another server
            </label>
            <template v-if="remoteEnabled">
              <p class="mt-3 text-xs text-slate-500">
                pgBackRest reaches a remote repo over SSH as this server's postgres user — that server has to
                trust the key below first.
              </p>
              <div class="mt-3 grid grid-cols-[1fr_6rem] gap-2">
                <div><label :class="label">Host</label><input v-model="remote.host" :class="field" placeholder="backup.example.com" /></div>
                <div><label :class="label">Port</label><input v-model.number="remote.port" type="number" :class="field" /></div>
              </div>
              <div class="mt-2 grid grid-cols-2 gap-2">
                <div><label :class="label">User</label><input v-model="remote.user" :class="[field, 'font-mono']" /></div>
                <div><label :class="label">Path on that server</label><input v-model="remote.path" :class="[field, 'font-mono']" /></div>
              </div>
              <div class="mt-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p class="mb-2 text-xs text-slate-400">
                  Add this key to <span class="font-mono text-slate-300">{{ remote.user || 'postgres' }}@{{ remote.host || '&lt;host&gt;' }}</span>'s ~/.ssh/authorized_keys:
                </p>
                <div v-if="keyLoading" class="py-2 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
                <template v-else-if="publicKey">
                  <pre class="max-h-24 overflow-auto rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-slate-300">{{ publicKey }}</pre>
                  <button :class="[btn, 'mt-2']" @click="copyKey"><v-icon name="fa-copy" scale="0.7" /> Copy key</button>
                </template>
              </div>
            </template>
          </div>

          <button
            class="flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
            :disabled="Boolean(log?.running) || !form.stanza || !form.repo1Path"
            @click="configure"
          >
            <v-icon name="fa-check" scale="0.8" /> Enable backups
          </button>
        </div>

        <!-- ============================================== half set up -->
        <div v-else-if="!context.stanzaReady" class="rounded-xl border border-amber-800/60 bg-amber-950/30 p-5 text-sm text-amber-100">
          <p class="flex items-center gap-2 font-semibold"><v-icon name="fa-exclamation-triangle" /> Setup didn't finish</p>
          <p class="mt-2 text-amber-200/90">
            Stanza <span class="font-mono">{{ context.stanza }}</span> is in the config file, but pgBackRest never created it
            (<code class="text-xs">stanza-create</code>), so no backup can run yet.
          </p>
          <p v-if="context.stanzaStatus" class="mt-2 font-mono text-xs text-amber-300/80">pgBackRest says: {{ context.stanzaStatus }}</p>
          <p class="mt-2 text-xs text-amber-200/80">
            WAL archiving:
            <b>{{ context.archiving?.mode === 'on' && context.archiving.usesPgBackRest ? 'on' : 'not set up' }}</b>
          </p>
          <button class="mt-4 flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500" @click="finishSetup">
            <v-icon name="fa-wrench" scale="0.8" /> Finish setup
          </button>
        </div>

        <!-- ============================================== ready -->
        <template v-else>
          <!-- Health -->
          <section :class="card" class="space-y-2 text-xs">
            <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
              <p>
                <span class="text-slate-500">WAL archiving</span>
                <span class="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold" :class="archivingOk ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/20 text-red-300'">
                  {{ archivingOk ? 'WORKING' : archivingFailing ? 'FAILING' : 'OFF' }}
                </span>
              </p>
              <p><span class="text-slate-500">Last WAL archived</span> <span class="ml-1 text-slate-200">{{ ago(lastArchivedMs) }}</span></p>
              <p><span class="text-slate-500">Shipped at least every</span> <span class="ml-1 text-slate-200">{{ arch?.timeout || '—' }}</span></p>
              <p><span class="text-slate-500">Keeps</span> <span class="ml-1 text-slate-200">{{ context.retentionDays ? `${context.retentionDays} day(s)` : context.retentionCount ? `${context.retentionCount} full backup(s)` : '—' }}</span></p>
            </div>
            <p v-if="archivingFailing" class="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-200">
              Archiving has been failing since {{ ago(Date.parse(arch!.lastFailedTime!)) }} (segment {{ arch?.lastFailedWal }}).
              Until it's fixed you can only rewind to {{ latest ? when(latest) : 'the last backup' }}. Try <b>Finish setup</b> again or check
              the PostgreSQL log.
              <button :class="[btn, 'mt-2']" @click="finishSetup"><v-icon name="fa-wrench" scale="0.7" /> Finish setup</button>
            </p>
            <p class="text-slate-500">
              Data <span class="font-mono text-slate-300">{{ context.dataDir }}</span> · Backups
              <span class="font-mono text-slate-300">{{ context.repo1?.path }}</span>
              <template v-if="context.repo2"> · Remote <span class="font-mono text-slate-300">{{ context.repo2.user }}@{{ context.repo2.host }}:{{ context.repo2.path }}</span></template>
            </p>
          </section>

          <!-- Rewind -->
          <section class="space-y-3">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-white"><v-icon name="fa-history" class="text-red-300" /> Rewind the database</h2>

            <div v-if="!canRewind" class="rounded-lg border border-slate-800 px-4 py-5 text-center text-xs text-slate-400">
              Take a <b>full backup</b> first. A rewind starts from a backup taken <i>before</i> the point you go back to,
              then replays the change log up to it — so the earliest you can ever rewind to is when your first full
              backup finished.
            </div>

            <template v-else>
              <!-- Window bar -->
              <div :class="card">
                <div class="flex justify-between text-[11px] text-slate-400">
                  <span>{{ when(earliest!) }}<br /><span class="text-slate-600">oldest point (first backup finished)</span></span>
                  <span class="text-right">{{ archivingOk ? 'now' : when(windowEnd!) }}<br /><span class="text-slate-600">{{ archivingOk ? 'latest changes are archived first' : 'archiving is off — last backup' }}</span></span>
                </div>
                <div class="relative mt-2 h-2 rounded-full bg-gradient-to-r from-sky-900 to-sky-500">
                  <div
                    v-if="target && !targetProblem"
                    class="absolute -top-1 h-4 w-1 rounded bg-red-400"
                    :style="{ left: `${Math.min(100, Math.max(0, ((target - earliest!) / (windowEnd! - earliest!)) * 100))}%` }"
                  />
                </div>
                <p class="mt-2 text-[11px] text-slate-500">
                  You can go back {{ ago(earliest).replace(' ago', '') }} right now. Keep backups for longer under <b>How far back</b> below.
                </p>
              </div>

              <div class="flex flex-wrap gap-2">
                <button
                  v-for="p in PRESETS"
                  :key="p.label"
                  :disabled="!presetReachable(p.ms)"
                  :title="presetReachable(p.ms) ? '' : 'Before your oldest backup — out of reach'"
                  class="rounded-lg border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-30"
                  :class="pickedPreset === p.label ? 'border-red-500 bg-red-500/10 text-red-200' : 'border-slate-700 text-slate-300 hover:border-red-500'"
                  @click="pickPreset(p)"
                >
                  {{ p.label }}
                </button>
              </div>

              <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div>
                  <label :class="label">…or an exact date and time (your local time)</label>
                  <DateTimePicker
                    :model-value="target"
                    :min="earliest"
                    :max="now"
                    @update:model-value="(v) => { target = v; pickedPreset = ''; }"
                  />
                </div>
                <div v-if="context.repo2">
                  <label :class="label">From</label>
                  <select v-model="rewindRepo" :class="field">
                    <option value="">Default repo</option>
                    <option :value="1">This server</option>
                    <option :value="2">Remote server</option>
                  </select>
                </div>
              </div>

              <p v-if="targetProblem" class="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{{ targetProblem }}</p>

              <div v-else-if="target" class="space-y-3 rounded-xl border border-red-900/70 bg-red-950/20 p-4 text-sm">
                <p class="text-red-100">
                  Rewind to <b>{{ when(target) }}</b><span v-if="pickedPreset"> ({{ pickedPreset }})</span>.
                  Everything written after that — inserts, updates, deletes — is <b>gone for good</b>.
                </p>
                <div v-if="stats?.databases.length" class="text-xs text-red-200/90">
                  <p class="mb-1">This rewinds <b>every database on this server</b>, not just one:</p>
                  <div class="flex flex-wrap gap-1.5">
                    <span v-for="d in stats.databases" :key="d.name" class="rounded bg-red-950/60 px-2 py-0.5 font-mono text-[11px]">{{ d.name }}</span>
                  </div>
                </div>
                <p class="text-xs text-red-200/80">
                  PostgreSQL is stopped for the restore (usually a minute or two — longer for big databases) and every
                  app using it is offline meanwhile.
                </p>
                <label class="flex items-start gap-2 text-xs text-red-100">
                  <input v-model="confirmRewind" type="checkbox" class="mt-0.5 accent-red-500" />
                  I understand all of these databases go back to {{ when(target) }}, and this can't be undone.
                </label>
                <button
                  class="flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40"
                  :disabled="!confirmRewind || Boolean(log?.running)"
                  @click="doRewind"
                >
                  <v-icon name="fa-history" scale="0.8" /> Rewind now
                </button>
              </div>
            </template>
          </section>

          <!-- Take a backup -->
          <section class="space-y-2">
            <h2 class="text-sm font-semibold text-white">Take a backup now</h2>
            <p :class="note">
              <b>Full</b> copies everything and is what every other backup builds on.
              <b>Differential</b> copies what changed since the last full; <b>incremental</b>, since the last backup of any kind.
              Both need a full backup to exist first.
            </p>
            <div class="flex flex-wrap gap-2">
              <button :class="btn" :disabled="!!backingUp" @click="runBackup('full', context.repo2 ? 1 : undefined)">
                <v-icon :name="backingUp === 'full' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'full' && 'animate-spin'" scale="0.75" /> Full
              </button>
              <button :class="btn" :disabled="!!backingUp || !hasFull" :title="hasFull ? '' : 'Needs a full backup first'" @click="runBackup('diff', context.repo2 ? 1 : undefined)">
                <v-icon :name="backingUp === 'diff' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'diff' && 'animate-spin'" scale="0.75" /> Differential
              </button>
              <button :class="btn" :disabled="!!backingUp || !hasFull" :title="hasFull ? '' : 'Needs a full backup first'" @click="runBackup('incr', context.repo2 ? 1 : undefined)">
                <v-icon :name="backingUp === 'incr' ? 'fa-spinner' : 'fa-save'" :class="backingUp === 'incr' && 'animate-spin'" scale="0.75" /> Incremental
              </button>
              <button v-if="context.repo2" :class="btn" :disabled="!!backingUp" @click="runBackup('full', 2)">
                <v-icon name="fa-cloud-upload-alt" scale="0.75" /> Full to remote
              </button>
              <span v-if="!hasFull" class="self-center text-[11px] text-slate-500">Differential and incremental unlock after the first full backup.</span>
            </div>
          </section>

          <!-- How far back -->
          <section :class="card" class="space-y-3">
            <h2 class="text-sm font-semibold text-white">How far back</h2>

            <div class="rounded-lg bg-slate-950/60 p-3 text-xs leading-relaxed text-slate-300">
              <p class="mb-1 font-medium text-white">How it works</p>
              <ol class="list-decimal space-y-1 pl-4 text-slate-400">
                <li>
                  Every rewind starts from a <b class="text-slate-200">full backup</b> taken before the time you pick, then
                  replays the change log (WAL) up to that second. So how far back you can go = how old your oldest kept full
                  backup is.
                </li>
                <li>
                  "Keep <b class="text-slate-200">{{ settings.retentionDays }}</b> day(s)" means pgBackRest keeps whichever full
                  backups are needed so you can always rewind <i>at least</i> that far. Anything older — backups and the WAL
                  only they need — is deleted after each backup.
                </li>
                <li>
                  Example with a weekly full on {{ DAYS[settings.schedule.fullDay] }}: on any day you'll still have the last
                  {{ DAYS[settings.schedule.fullDay] }}'s full plus the differentials since, so you can often go back further
                  than {{ settings.retentionDays }} day(s) — up to the previous {{ DAYS[settings.schedule.fullDay] }} — but
                  never less.
                </li>
              </ol>
              <p class="mt-2 text-slate-400">
                <b class="text-slate-200">Right now:</b>{{ " " }}
                <template v-if="earliest">you can rewind to {{ when(earliest) }} ({{ ago(earliest) }}).</template>
                <template v-else>no full backup yet, so nothing to rewind to.</template>
                Backups + WAL use {{ sizeText((sizes?.backupsBytes ?? 0) + (sizes?.walArchiveBytes ?? 0)) }}.
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span class="text-slate-500">See the files:</span>
              <button
                v-if="context.repo1"
                :class="btn"
                @click="emit('openPath', { path: `${context.repo1.path}/backup/${context.stanza}`, isDirectory: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> Backups
              </button>
              <button
                v-if="context.repo1"
                :class="btn"
                title="The archived WAL — the change log replayed during a rewind"
                @click="emit('openPath', { path: `${context.repo1.path}/archive/${context.stanza}`, isDirectory: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> WAL archive
              </button>
              <button :class="btn" title="Holds the retention setting" @click="emit('openPath', { path: '/etc/pgbackrest/pgbackrest.conf', isDirectory: false, reveal: true })">
                <v-icon name="fa-folder-open" scale="0.6" /> pgbackrest.conf
              </button>
              <button
                v-if="context.schedule?.enabled"
                :class="btn"
                title="The cron schedule"
                @click="emit('openPath', { path: '/etc/cron.d/ssher-pgbackrest', isDirectory: false, reveal: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> Schedule (cron)
              </button>
              <button v-if="stats?.repoPath" :class="btn" title="Where every repo lives" @click="emit('openPath', { path: stats.repoPath, isDirectory: true })">
                <v-icon name="fa-folder-open" scale="0.6" /> {{ stats.repoPath }}
              </button>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label :class="label">Always be able to rewind at least</label>
                <div class="flex items-center gap-2">
                  <input v-model.number="settings.retentionDays" type="number" min="1" max="3650" :class="[field, 'w-24']" />
                  <span class="text-sm text-slate-400">days back</span>
                </div>
                <p class="mt-1 text-[11px] text-slate-500">
                  More days = more disk: roughly one full copy of the databases per week kept ({{ sizeText(dbTotal) }} now),
                  plus the WAL.
                </p>
              </div>
              <div>
                <label class="flex items-center gap-2 text-xs font-medium text-slate-300">
                  <input v-model="settings.schedule.enabled" type="checkbox" class="accent-sky-500" /> Back up automatically
                </label>
                <div v-if="settings.schedule.enabled" class="mt-2 space-y-2 text-xs text-slate-400">
                  <div class="flex flex-wrap items-center gap-2">
                    Full backup every
                    <select v-model.number="settings.schedule.fullDay" :class="[field, 'w-auto py-1']">
                      <option v-for="(d, i) in DAYS" :key="d" :value="i">{{ d }}</option>
                    </select>
                    at
                    <select v-model.number="settings.schedule.hour" :class="[field, 'w-auto py-1']">
                      <option v-for="h in 24" :key="h" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option>
                    </select>
                  </div>
                  <p>Differential on every other day at the same time (server time).</p>
                </div>
                <p v-else class="mt-1 text-[11px] text-amber-300/80">
                  Without a schedule, the window only moves forward when you take backups by hand — and old ones still expire.
                </p>
              </div>
            </div>
            <button :class="btn" :disabled="Boolean(log?.running)" @click="saveSettings"><v-icon name="fa-check" scale="0.7" /> Save</button>
          </section>

          <!-- Per-database size -->
          <section v-if="stats?.databases.length" class="space-y-2">
            <h2 class="text-sm font-semibold text-white">What's in the backups</h2>
            <div class="overflow-hidden rounded-xl border border-slate-800">
              <table class="w-full text-xs">
                <thead class="bg-slate-900/60 text-slate-500">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Database</th>
                    <th class="px-3 py-2 text-left font-medium">Size now</th>
                    <th class="px-3 py-2 text-left font-medium">Share of each full backup</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="d in stats.databases" :key="d.name" class="border-t border-slate-800/70">
                    <td class="px-3 py-1.5 font-mono text-slate-200">{{ d.name }}</td>
                    <td class="px-3 py-1.5 text-slate-300">{{ sizeText(d.bytes) }}</td>
                    <td class="px-3 py-1.5">
                      <div class="flex items-center gap-2">
                        <div class="h-1.5 w-32 overflow-hidden rounded-full bg-slate-800">
                          <div class="h-full bg-sky-500" :style="{ width: `${pct(d.bytes, dbTotal)}%` }" />
                        </div>
                        <span class="text-slate-500">{{ pct(d.bytes, dbTotal) }}%</span>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="text-[11px] text-slate-500">
              Backups and WAL are stored for the whole server, not per database, so the backup and WAL totals above
              can't be split exactly. The share column is each database's portion of the data that gets backed up.
            </p>
          </section>

          <!-- History -->
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
                    <th class="px-3 py-2 text-left font-medium">Finished</th>
                    <th class="px-3 py-2 text-left font-medium">Type</th>
                    <th class="px-3 py-2 text-left font-medium">Database size then</th>
                    <th class="px-3 py-2 text-left font-medium">Space it takes</th>
                    <th class="px-3 py-2 text-left font-medium">Label</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="b in [...backups].reverse()" :key="b.label" class="border-t border-slate-800/70">
                    <td class="px-3 py-1.5 text-slate-300">{{ b.stopTime ? when(b.stopTime) : '—' }} <span class="text-slate-600">{{ ago(b.stopTime) }}</span></td>
                    <td class="px-3 py-1.5 text-slate-400">{{ TYPE_NAME[b.type as 'full'] ?? b.type }}</td>
                    <td class="px-3 py-1.5 text-slate-400">{{ sizeText(b.sizeBytes) }}</td>
                    <td class="px-3 py-1.5 text-slate-400">{{ sizeText(b.repoBytes) }}</td>
                    <td class="px-3 py-1.5 font-mono text-[10px] text-slate-600">{{ b.label }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
      </div>
    </div>

    <StepLog v-if="log" :title="log.title" :steps="log.steps" :running="log.running" :error="log.error" @close="log = null" />
  </div>
</template>
