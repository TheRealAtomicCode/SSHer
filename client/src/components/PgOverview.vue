<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { fail } from '../toast';
import type { PgBackRestStats, PgDump, PgOverview } from '../types';

/** PostgreSQL at a glance: the server, its connections, and where the disk space goes. */
const emit = defineEmits<{ go: ['databases' | 'users' | 'connections' | 'performance'] }>();

const info = ref<PgOverview | null>(null);
const stats = ref<PgBackRestStats | null>(null);
const serverBackups = ref<{ backupsBytes: number; walArchiveBytes: number; count: number } | null>(null);
const dumps = ref<PgDump[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const [o, s, d] = await Promise.all([
      api.postgresOverview(),
      api.pgbackrestStats().catch(() => null),
      api.postgresDumps().catch(() => ({ dumps: [] as PgDump[] })),
    ]);
    info.value = o;
    stats.value = s;
    dumps.value = d.dumps;
    // pgBackRest sizes only when it is set up; its absence is normal, not an error.
    const ctx = await api.pgbackrestContext().catch(() => null);
    if (ctx?.configured && ctx.stanzaReady) {
      const b = await api.pgbackrestBackups().catch(() => null);
      if (b?.sizes) serverBackups.value = { backupsBytes: b.sizes.backupsBytes, walArchiveBytes: b.sizes.walArchiveBytes, count: b.backups.length };
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const dbTotal = computed(() => (stats.value?.databases ?? []).reduce((n, d) => n + d.bytes, 0));
const dumpTotal = computed(() => dumps.value.reduce((n, d) => n + d.bytes, 0));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function since(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

function duration(sec: number) {
  if (sec < 1) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

onMounted(load);
defineExpose({ load });

const card = 'rounded-xl border border-slate-800 bg-slate-900/60 p-4';
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6">
    <div v-if="loading && !info" class="py-16 text-center"><v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" /></div>

    <template v-if="info">
      <!-- Server -->
      <section>
        <h2 class="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Server</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div :class="card">
            <p class="text-[11px] text-slate-500">Version</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ info.version.split(' ')[0] }}</p>
            <p class="text-[11px] text-slate-500">up {{ since(info.startedAt) }}</p>
          </div>
          <button :class="[card, 'text-left hover:border-sky-700']" @click="emit('go', 'connections')">
            <p class="text-[11px] text-slate-500">Listening</p>
            <p class="mt-1 text-lg font-semibold text-white">port {{ info.port }}</p>
            <p class="truncate font-mono text-[11px] text-slate-500" :title="info.listen">{{ info.listen }}</p>
          </button>
          <button :class="[card, 'text-left hover:border-sky-700']" @click="emit('go', 'performance')">
            <p class="text-[11px] text-slate-500">Connections</p>
            <p class="mt-1 text-lg font-semibold text-white">
              {{ info.connections }} <span class="text-xs font-normal text-slate-500">of {{ info.maxConnections }}</span>
            </p>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div class="h-full rounded-full bg-sky-500" :style="{ width: `${pct(info.connections, info.maxConnections)}%` }" />
            </div>
            <p class="mt-1 text-[11px] text-slate-500">
              {{ info.active }} running now<template v-if="info.idleInTransaction"> · <span class="text-amber-300">{{ info.idleInTransaction }} stuck in a transaction</span></template>
            </p>
          </button>
          <button :class="[card, 'text-left hover:border-sky-700']" @click="emit('go', 'performance')">
            <p class="text-[11px] text-slate-500">Longest query running now</p>
            <p class="mt-1 text-lg font-semibold" :class="info.longestSeconds > 60 ? 'text-amber-300' : 'text-white'">{{ duration(info.longestSeconds) }}</p>
            <p class="text-[11px] text-slate-500">
              cache hit {{ info.cacheHitPct ?? '—' }}%<template v-if="(info.cacheHitPct ?? 100) < 95"> <span class="text-amber-300">(low — more RAM helps)</span></template>
            </p>
          </button>
        </div>
      </section>

      <!-- Storage -->
      <section v-if="stats">
        <h2 class="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Storage</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div v-for="d in stats.disks" :key="d.mount" :class="card">
            <p class="text-[11px] text-slate-500">Free disk · <span class="font-mono">{{ d.mount }}</span></p>
            <p class="mt-1 text-lg font-semibold" :class="d.avail / d.size < 0.1 ? 'text-red-300' : 'text-white'">
              {{ formatSize(d.avail) }} <span class="text-xs font-normal text-slate-500">of {{ formatSize(d.size) }}</span>
            </p>
            <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div
                class="h-full rounded-full"
                :class="pct(d.used, d.size) > 90 ? 'bg-red-500' : pct(d.used, d.size) > 75 ? 'bg-amber-500' : 'bg-sky-500'"
                :style="{ width: `${pct(d.used, d.size)}%` }"
              />
            </div>
            <p class="mt-1 text-[11px] text-slate-500">
              {{ pct(d.used, d.size) }}% used · holds
              {{ (d.holds ?? []).map((h) => (h === stats!.dataDir ? 'database' : h === stats!.repoPath ? 'backups' : h)).join(', ') }}
            </p>
          </div>
          <button :class="[card, 'text-left hover:border-sky-700']" @click="emit('go', 'databases')">
            <p class="text-[11px] text-slate-500">Databases (live)</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ formatSize(dbTotal) }}</p>
            <p class="text-[11px] text-slate-500">{{ stats.databases.length }} database(s)</p>
          </button>
          <button :class="[card, 'text-left hover:border-sky-700']" @click="emit('go', 'databases')">
            <p class="text-[11px] text-slate-500">Database backups</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ formatSize(dumpTotal) }}</p>
            <p class="text-[11px] text-slate-500">{{ dumps.length }} saved, per database</p>
          </button>
          <div v-if="serverBackups" :class="card">
            <p class="text-[11px] text-slate-500">Whole-server backups</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ formatSize(serverBackups.backupsBytes) }}</p>
            <p class="text-[11px] text-slate-500">{{ serverBackups.count }} pgBackRest backup(s), compressed</p>
          </div>
          <div v-if="serverBackups" :class="card">
            <p class="text-[11px] text-slate-500">WAL archive</p>
            <p class="mt-1 text-lg font-semibold text-white">{{ formatSize(serverBackups.walArchiveBytes) }}</p>
            <p class="text-[11px] text-slate-500">makes rewind possible · {{ formatSize(stats.walLocalBytes) }} still in pg_wal</p>
          </div>
        </div>
      </section>

      <!-- Biggest databases -->
      <section v-if="stats?.databases.length">
        <h2 class="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Databases by size</h2>
        <div class="space-y-1.5 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div v-for="d in stats.databases" :key="d.name" class="flex items-center gap-3 text-xs">
            <span class="w-40 truncate font-mono text-slate-200">{{ d.name }}</span>
            <div class="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
              <div class="h-full rounded-full bg-sky-600" :style="{ width: `${pct(d.bytes, dbTotal)}%` }" />
            </div>
            <span class="w-16 text-right text-slate-400">{{ formatSize(d.bytes) }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
