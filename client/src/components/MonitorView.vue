<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { fail } from '../toast';
import type { MonitorSample, NetConnection, NginxSite } from '../types';
import AccessLogViewer from './AccessLogViewer.vue';
import ConnectionsTable from './ConnectionsTable.vue';
import LineChart from './LineChart.vue';

const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }] }>();

// ----------------------------------------------------------------- polling

const INTERVAL_KEY = 'ssh-fb.monitorInterval';
function savedInterval(): number {
  try {
    const n = Number(localStorage.getItem(INTERVAL_KEY));
    return n >= 1 && n <= 300 ? n : 2;
  } catch {
    return 2;
  }
}

/** Seconds between samples — editable, remembered. */
const interval = ref(savedInterval());
const paused = ref(false);
const POINTS = 150;

watch(interval, (n) => {
  try {
    localStorage.setItem(INTERVAL_KEY, String(n));
  } catch {
    /* private mode */
  }
  restart();
});

const last = ref<MonitorSample | null>(null);
const error = ref('');

/** Rolling history of derived rates — one entry per sample after the first. */
interface Point {
  time: number;
  cpu: number;
  iowait: number;
  memPct: number;
  rx: Record<string, number>;
  tx: Record<string, number>;
  diskRead: number;
  diskWrite: number;
}
const history = ref<Point[]>([]);

let timer: ReturnType<typeof setTimeout> | undefined;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await api.monitorSample();
    const prev = last.value;
    if (prev && s.time > prev.time) {
      const dt = (s.time - prev.time) / 1000;
      const dTotal = s.cpu.total - prev.cpu.total;
      const rx: Record<string, number> = {};
      const tx: Record<string, number> = {};
      for (const n of s.network) {
        const p = prev.network.find((x) => x.name === n.name);
        if (!p) continue;
        rx[n.name] = Math.max(0, (n.rx - p.rx) / dt);
        tx[n.name] = Math.max(0, (n.tx - p.tx) / dt);
      }
      const sum = (cur: MonitorSample['disks'], old: MonitorSample['disks'], key: 'readBytes' | 'writeBytes') =>
        cur.reduce((n, d) => n + Math.max(0, d[key] - (old.find((o) => o.name === d.name)?.[key] ?? d[key])), 0) / dt;
      history.value = [
        ...history.value.slice(-(POINTS - 1)),
        {
          time: s.time,
          cpu: dTotal > 0 ? (1 - (s.cpu.idle - prev.cpu.idle) / dTotal) * 100 : 0,
          iowait: dTotal > 0 ? ((s.cpu.iowait - prev.cpu.iowait) / dTotal) * 100 : 0,
          memPct: s.memory.total ? ((s.memory.total - s.memory.available) / s.memory.total) * 100 : 0,
          rx,
          tx,
          diskRead: sum(s.disks, prev.disks, 'readBytes'),
          diskWrite: sum(s.disks, prev.disks, 'writeBytes'),
        },
      ];
    }
    last.value = s;
    error.value = '';
    if (tab.value === 'connections' && liveConnections.value) await loadConnections();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy = false;
  }
}

function restart() {
  clearTimeout(timer);
  if (paused.value) return;
  const loop = async () => {
    await tick();
    if (!paused.value) timer = setTimeout(loop, interval.value * 1000);
  };
  loop();
}

watch(paused, restart);
onMounted(restart);
onUnmounted(() => clearTimeout(timer));

// --------------------------------------------------------------- derived

/** "All" sums the real interfaces; virtual ones (docker, veth, wg…) would double-count. */
const iface = ref('__all');
const interfaces = computed(() => last.value?.network.map((n) => n) ?? []);
const netValue = (p: Point, dir: 'rx' | 'tx') =>
  iface.value === '__all'
    ? Object.entries(p[dir]).reduce((n, [name, v]) => n + (last.value?.network.find((x) => x.name === name)?.virtual ? 0 : v), 0)
    : p[dir][iface.value] ?? 0;

const times = computed(() => history.value.map((p) => p.time));
const now = computed(() => history.value.at(-1) ?? null);
const mem = computed(() => last.value?.memory ?? null);
const memUsed = computed(() => (mem.value ? mem.value.total - mem.value.available : 0));
const swapUsed = computed(() => (mem.value ? mem.value.swapTotal - mem.value.swapFree : 0));
const loadPct = computed(() => (last.value ? (last.value.load[0] / last.value.cpu.cores) * 100 : 0));

const rate = (b: number) => `${formatSize(Math.round(b))}/s`;
const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;
const uptime = computed(() => {
  const s = last.value?.uptimeSeconds ?? 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
});

// ------------------------------------------------------- connections / HTTP

const tab = ref<'connections' | 'http'>('connections');
const conns = ref<NetConnection[]>([]);
const liveConnections = ref(true);
let lastConnLoad = 0;

/** Connections refresh with the samples, but no faster than every 3 s — a busy
 *  server can have thousands of sockets. */
async function loadConnections(force = false) {
  if (!force && Date.now() - lastConnLoad < 3000) return;
  lastConnLoad = Date.now();
  try {
    conns.value = (await api.monitorConnections()).connections;
  } catch (err) {
    fail(err);
  }
}
watch(tab, (t) => t === 'connections' && loadConnections(true));
onMounted(() => loadConnections(true));

const stateCounts = computed(() => {
  const c: Record<string, number> = {};
  for (const x of conns.value) c[x.state] = (c[x.state] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
});

const sites = ref<NginxSite[]>([]);
const site = ref('');
const siteLogs = ref<{ access: string; error: string } | null>(null);
watch(tab, async (t) => {
  if (t !== 'http' || sites.value.length) return;
  sites.value = (await api.nginxSites().catch(() => ({ sites: [] }))).sites;
  // Start on a real site — one that's enabled and answers for a domain — not "default".
  site.value =
    sites.value.find((s) => s.enabled && s.domains.length && s.name !== 'default')?.name ??
    sites.value.find((s) => s.enabled)?.name ??
    sites.value[0]?.name ??
    '';
});
watch(site, async (name) => {
  siteLogs.value = name ? await api.nginxSiteLogs(name).catch(() => null) : null;
});

const INTERVALS = [1, 2, 3, 4, 5, 10, 30];
const card = 'rounded-xl border border-slate-800 bg-slate-900/40 p-4';
const field = 'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-sky-500 focus:outline-none';
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-5">
    <div class="mx-auto max-w-6xl space-y-5">
      <!-- Header + interval -->
      <div class="flex flex-wrap items-center gap-3">
        <v-icon name="fa-chart-line" scale="1.3" class="text-sky-300" />
        <div class="flex-1">
          <h1 class="text-base font-semibold text-white">Monitoring</h1>
          <p class="text-xs text-slate-500">
            <template v-if="last">{{ last.cpu.cores }} CPU cores · up {{ uptime }} · samples only while this page is open</template>
            <template v-else>Collecting the first sample…</template>
          </p>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-slate-400">
          Every
          <button
            v-for="n in INTERVALS"
            :key="n"
            class="rounded-md border px-2 py-1 tabular-nums"
            :class="interval === n ? 'border-sky-500 bg-sky-500/10 text-sky-200' : 'border-slate-700 hover:text-white'"
            @click="interval = n"
          >
            {{ n }}s
          </button>
          <input
            :value="interval"
            type="number"
            min="1"
            max="300"
            title="Any number of seconds"
            :class="[field, 'w-16']"
            @change="interval = Math.min(300, Math.max(1, Math.round(Number(($event.target as HTMLInputElement).value) || 2)))"
          />
          <button :class="[field, paused && 'border-amber-600 text-amber-300']" @click="paused = !paused">
            <v-icon :name="paused ? 'fa-play' : 'fa-stop'" scale="0.6" /> {{ paused ? 'Resume' : 'Pause' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">{{ error }}</p>

      <!-- Stat tiles -->
      <div v-if="last" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div :class="card">
          <p class="text-[11px] text-slate-500">CPU</p>
          <p class="mt-1 text-2xl font-semibold text-white tabular-nums">{{ now ? pct(now.cpu) : '…' }}</p>
          <p class="text-[11px] text-slate-500">
            load {{ last.load.map((l) => l.toFixed(2)).join(' · ') }}
            <span :class="loadPct > 100 ? 'text-amber-300' : ''">({{ Math.round(loadPct) }}% of {{ last.cpu.cores }} cores)</span>
          </p>
        </div>
        <div :class="card">
          <p class="text-[11px] text-slate-500">Memory</p>
          <p class="mt-1 text-2xl font-semibold text-white tabular-nums">{{ formatSize(memUsed) }}</p>
          <p class="text-[11px] text-slate-500">
            of {{ formatSize(mem!.total) }} · {{ formatSize(mem!.available) }} available
            <template v-if="mem!.swapTotal"> · swap {{ formatSize(swapUsed) }} / {{ formatSize(mem!.swapTotal) }}</template>
          </p>
        </div>
        <div :class="card">
          <p class="text-[11px] text-slate-500">Network {{ iface === '__all' ? '' : iface }}</p>
          <p class="mt-1 text-lg font-semibold text-white tabular-nums">
            ↓ {{ now ? rate(netValue(now, 'rx')) : '…' }}
          </p>
          <p class="text-sm text-slate-300 tabular-nums">↑ {{ now ? rate(netValue(now, 'tx')) : '…' }}</p>
        </div>
        <div v-for="f in last.filesystems" :key="f.mount" :class="card">
          <p class="text-[11px] text-slate-500">Disk <span class="font-mono">{{ f.mount }}</span></p>
          <p class="mt-1 text-lg font-semibold tabular-nums" :class="f.avail / f.size < 0.1 ? 'text-red-300' : 'text-white'">
            {{ formatSize(f.avail) }} free
          </p>
          <p class="text-[11px] text-slate-500">
            of {{ formatSize(f.size) }} · I/O {{ now ? `${rate(now.diskRead)} read, ${rate(now.diskWrite)} write` : '…' }}
          </p>
        </div>
      </div>

      <!-- Charts -->
      <div class="grid gap-4 lg:grid-cols-2">
        <section :class="card">
          <h2 class="mb-2 text-xs font-semibold text-slate-300">CPU used</h2>
          <LineChart :series="[{ name: 'CPU', values: history.map((p) => p.cpu) }]" :times="times" :format="pct" :max="100" />
        </section>
        <section :class="card">
          <h2 class="mb-2 text-xs font-semibold text-slate-300">Memory used</h2>
          <LineChart :series="[{ name: 'Memory', values: history.map((p) => p.memPct) }]" :times="times" :format="pct" :max="100" />
        </section>
        <section :class="card">
          <div class="mb-2 flex items-center gap-2">
            <h2 class="flex-1 text-xs font-semibold text-slate-300">Network</h2>
            <select v-model="iface" :class="field">
              <option value="__all">All real interfaces</option>
              <option v-for="n in interfaces" :key="n.name" :value="n.name">{{ n.name }}{{ n.virtual ? ' (virtual)' : '' }}</option>
            </select>
          </div>
          <LineChart
            :series="[
              { name: 'Download ↓', values: history.map((p) => netValue(p, 'rx')) },
              { name: 'Upload ↑', values: history.map((p) => netValue(p, 'tx')) },
            ]"
            :times="times"
            :format="rate"
          />
        </section>
        <section :class="card">
          <h2 class="mb-2 text-xs font-semibold text-slate-300">Disk I/O</h2>
          <LineChart
            :series="[
              { name: 'Read', values: history.map((p) => p.diskRead) },
              { name: 'Write', values: history.map((p) => p.diskWrite) },
            ]"
            :times="times"
            :format="rate"
          />
        </section>
      </div>
      <p v-if="history.length < 2" class="text-center text-[11px] text-slate-600">Charts fill in from the second sample on.</p>

      <!-- Network requests -->
      <section :class="card">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <div class="flex rounded-md border border-slate-700 p-0.5 text-xs">
            <button class="rounded px-3 py-1" :class="tab === 'connections' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'" @click="tab = 'connections'">
              Connections <span class="text-slate-500">{{ conns.length }}</span>
            </button>
            <button class="rounded px-3 py-1" :class="tab === 'http' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'" @click="tab = 'http'">
              HTTP requests (nginx)
            </button>
          </div>
          <template v-if="tab === 'connections'">
            <span v-for="[s, n] in stateCounts.slice(0, 4)" :key="s" class="text-[11px] text-slate-500">{{ s }} {{ n }}</span>
            <div class="flex-1" />
            <label class="flex items-center gap-1.5 text-[11px] text-slate-400">
              <input v-model="liveConnections" type="checkbox" class="accent-sky-500" /> Live
            </label>
            <button :class="field" @click="loadConnections(true)"><v-icon name="fa-sync-alt" scale="0.55" /></button>
          </template>
          <template v-else>
            <div class="flex-1" />
            <select v-model="site" :class="field">
              <option v-for="s in sites" :key="s.name" :value="s.name">{{ s.name }}{{ s.enabled ? '' : ' (disabled)' }}</option>
            </select>
          </template>
        </div>

        <ConnectionsTable v-if="tab === 'connections'" :connections="conns" />
        <template v-else>
          <AccessLogViewer
            v-if="siteLogs"
            :key="site"
            :access-path="siteLogs.access"
            :error-path="siteLogs.error"
            @open-path="(p) => emit('openPath', p)"
          />
          <p v-else class="py-6 text-center text-xs text-slate-500">{{ sites.length ? 'Pick a site.' : 'No nginx sites on this server.' }}</p>
        </template>
      </section>
    </div>
  </div>
</template>
