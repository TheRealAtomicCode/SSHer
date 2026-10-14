<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as api from '../api';
import type { SecurityFinding } from '../api';
import { formatSize } from '../files';
import type { DiskUsage, MonitorSample, Session, Shortcut, View } from '../types';

const props = defineProps<{ session: Session; shortcuts: Shortcut[] }>();
const emit = defineEmits<{ navigate: [View]; openShortcut: [Shortcut] }>();

/** Free space on each real filesystem — the first thing to check when things fail oddly. */
const disks = ref<DiskUsage[]>([]);
onMounted(async () => {
  disks.value = (await api.systemDisk().catch(() => ({ disks: [] }))).disks;
});
const usedPct = (d: DiskUsage) => (d.size ? Math.round((d.used / d.size) * 100) : 0);

// ------------------------------------------------------ live numbers (monitoring)

const sample = ref<MonitorSample | null>(null);
const live = ref<{ cpu: number; rx: number; tx: number } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

async function tick() {
  try {
    const s = await api.monitorSample();
    const p = sample.value;
    if (p && s.time > p.time) {
      const dt = (s.time - p.time) / 1000;
      const dTotal = s.cpu.total - p.cpu.total;
      // Real interfaces only — virtual ones (docker, veth…) would double-count.
      const sum = (x: MonitorSample, k: 'rx' | 'tx') => x.network.filter((n) => !n.virtual).reduce((a, n) => a + n[k], 0);
      live.value = {
        cpu: dTotal > 0 ? (1 - (s.cpu.idle - p.cpu.idle) / dTotal) * 100 : 0,
        rx: Math.max(0, (sum(s, 'rx') - sum(p, 'rx')) / dt),
        tx: Math.max(0, (sum(s, 'tx') - sum(p, 'tx')) / dt),
      };
    }
    sample.value = s;
  } catch {
    /* the numbers just pause */
  }
  if (!stopped) timer = setTimeout(tick, 3000);
}
onMounted(tick);
onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
});

const memUsed = computed(() => (sample.value ? sample.value.memory.total - sample.value.memory.available : 0));
const memPct = computed(() => (sample.value?.memory.total ? (memUsed.value / sample.value.memory.total) * 100 : 0));
const rate = (b: number) => `${formatSize(Math.round(b))}/s`;
const barTone = (pct: number) => (pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-sky-500');

// -------------------------------------------------------------- speed test

interface SpeedResult {
  latencyMs?: number;
  location?: string;
  down?: number;
  up?: number;
  /** Megabytes moved in total — the test isn't free on a metered link. */
  usedMb: number;
  time?: number;
}
/** Last result per server, kept across visits to the home page. */
const speedCache: Map<string, SpeedResult> = ((globalThis as Record<string, unknown>).__ssherSpeedCache ??= new Map()) as Map<string, SpeedResult>;
const serverKey = () => `${props.session.username}@${props.session.host}:${props.session.port}`;
const speed = ref<SpeedResult | null>(speedCache.get(serverKey()) ?? null);
const speedPhase = ref<'' | 'latency' | 'download' | 'upload'>('');
const speedError = ref('');

async function runSpeedTest() {
  speedError.value = '';
  const result: SpeedResult = { usedMb: 0 };
  speed.value = result;
  try {
    speedPhase.value = 'latency';
    Object.assign(result, await api.speedTest('latency'));
    speedPhase.value = 'download';
    const down = await api.speedTest('download');
    result.down = down.mbps;
    result.usedMb += down.bytes / 1e6;
    speedPhase.value = 'upload';
    const up = await api.speedTest('upload');
    result.up = up.mbps;
    result.usedMb += up.bytes / 1e6;
    result.time = Date.now();
    speedCache.set(serverKey(), { ...result });
  } catch (err) {
    speedError.value = (err as Error).message;
  } finally {
    speedPhase.value = '';
  }
}
const mbps = (v?: number) => (v === undefined ? '' : v >= 100 ? v.toFixed(0) : v.toFixed(1));

// ---------------------------------------------------------------- security

/** One scan per server per 5 minutes, kept across visits to the home page. */
const scanCache: Map<string, { time: number; findings: SecurityFinding[] }> = ((globalThis as Record<string, unknown>).__ssherScanCache ??= new Map()) as Map<string, { time: number; findings: SecurityFinding[] }>;
const findings = ref<SecurityFinding[] | null>(null);
const scanning = ref(false);
const scannedAt = ref<number | null>(null);

async function scan(force = false) {
  const key = `${props.session.username}@${props.session.host}:${props.session.port}`;
  const cached = scanCache.get(key);
  if (!force && cached && Date.now() - cached.time < 5 * 60_000) {
    findings.value = cached.findings;
    scannedAt.value = cached.time;
    return;
  }
  scanning.value = true;
  try {
    const r = await api.securityScan();
    scanCache.set(key, { time: r.time, findings: r.findings });
    findings.value = r.findings;
    scannedAt.value = r.time;
  } catch {
    findings.value = findings.value ?? [];
  } finally {
    scanning.value = false;
  }
}
onMounted(() => scan());

const SEV = [
  { key: 'critical', label: 'Critical', icon: 'fa-times-circle', color: '#d03b3b' },
  { key: 'high', label: 'High', icon: 'fa-exclamation-triangle', color: '#ec835a' },
  { key: 'medium', label: 'Medium', icon: 'fa-exclamation-triangle', color: '#fab219' },
  { key: 'low', label: 'Low', icon: 'fa-info-circle', color: '#94a3b8' },
] as const;
const count = (sev: string) => findings.value?.filter((f) => f.severity === sev).length ?? 0;
const worst = computed(() => (findings.value ?? []).filter((f) => f.severity === 'critical' || f.severity === 'high').slice(0, 4));

const TILES: { view: View; title: string; text: string; icon: string; tone: string }[] = [
  {
    view: 'files',
    title: 'File Explorer',
    text: 'Browse, edit, upload and move files over SFTP.',
    icon: 'fa-folder-open',
    tone: 'from-amber-500/20 text-amber-300 ring-amber-500/30',
  },
  {
    view: 'monitor',
    title: 'Monitoring',
    text: 'Live CPU, memory, disk and network — every second if you like — plus every connection and HTTP request.',
    icon: 'fa-chart-line',
    tone: 'from-sky-500/20 text-sky-300 ring-sky-500/30',
  },
  {
    view: 'security',
    title: 'Security',
    text: 'Scan for malware, exposed services and weak settings — and fix them, with optional tools like Lynis and ClamAV.',
    icon: 'fa-bug',
    tone: 'from-red-500/20 text-red-300 ring-red-500/30',
  },
  {
    view: 'links',
    title: 'Quick Links',
    text: 'nginx, Docker, firewall and PostgreSQL config files — plus start, stop and reload buttons.',
    icon: 'fa-link',
    tone: 'from-emerald-500/20 text-emerald-300 ring-emerald-500/30',
  },
  {
    view: 'users',
    title: 'Users',
    text: 'Accounts, groups and sudo access — plus file permissions and ACLs from the File Explorer.',
    icon: 'fa-users',
    tone: 'from-amber-500/20 text-amber-300 ring-amber-500/30',
  },
  {
    view: 'processes',
    title: 'Processes',
    text: 'Every running process, filterable — terminate or force-kill one.',
    icon: 'fa-microchip',
    tone: 'from-rose-500/20 text-rose-300 ring-rose-500/30',
  },
  {
    view: 'nginx',
    title: 'Nginx',
    text: 'Sites — enable, disable, edit — and add one by drag & drop, or for an app this page just noticed.',
    icon: 'fa-globe',
    tone: 'from-emerald-500/20 text-emerald-300 ring-emerald-500/30',
  },
  {
    view: 'dotnet',
    title: '.NET apps',
    text: 'Host-level .NET web apps as systemd services — drop a publish .zip, and it checks the runtime first.',
    icon: 'si-dotnet',
    tone: 'from-sky-500/20 text-sky-300 ring-sky-500/30',
  },
  {
    view: 'docker',
    title: 'Docker',
    text: 'Containers, logs, compose configs, updates — and deploy a new image by drag & drop.',
    icon: 'fa-docker',
    tone: 'from-sky-500/20 text-sky-300 ring-sky-500/30',
  },
  {
    view: 'ports',
    title: 'Ports & Firewall',
    text: 'What is listening, what is exposed to the internet, and the ufw rules.',
    icon: 'fa-shield-alt',
    tone: 'from-rose-500/20 text-rose-300 ring-rose-500/30',
  },
  {
    view: 'postgres',
    title: 'PostgreSQL',
    text: 'Roles, passwords, and who can SELECT/INSERT/UPDATE/DELETE on which tables.',
    icon: 'fa-database',
    tone: 'from-sky-500/20 text-sky-300 ring-sky-500/30',
  },
  {
    view: 'backups',
    title: 'Backups',
    text: 'pgBackRest: install, schedule backups to this server or another, and restore to any point in time.',
    icon: 'fa-save',
    tone: 'from-emerald-500/20 text-emerald-300 ring-emerald-500/30',
  },
];
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-5xl">
      <h1 class="text-xl font-semibold text-white">
        Connected to <span class="font-mono text-emerald-400">{{ session.host }}</span>
      </h1>
      <p class="text-sm text-slate-500">
        Logged in as {{ session.username }} · home {{ session.home }} · port {{ session.port }}
      </p>

      <div v-if="disks.length" class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="d in disks" :key="d.mount" class="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div class="flex items-baseline justify-between gap-2">
            <p class="truncate text-xs text-slate-400"><v-icon name="fa-hdd" scale="0.7" /> <span class="font-mono">{{ d.mount }}</span></p>
            <p class="text-[10px] text-slate-600">{{ d.fstype }}</p>
          </div>
          <p class="mt-1 text-lg font-semibold" :class="usedPct(d) > 90 ? 'text-red-300' : 'text-white'">
            {{ formatSize(d.avail) }} free <span class="text-xs font-normal text-slate-500">of {{ formatSize(d.size) }}</span>
          </p>
          <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              class="h-full rounded-full"
              :class="usedPct(d) > 90 ? 'bg-red-500' : usedPct(d) > 75 ? 'bg-amber-500' : 'bg-emerald-500'"
              :style="{ width: `${usedPct(d)}%` }"
            />
          </div>
          <p class="mt-1 text-[10px] text-slate-600">{{ usedPct(d) }}% used · {{ formatSize(d.used) }}</p>
        </div>
      </div>

      <div class="mt-5 grid gap-4 lg:grid-cols-[3fr_2fr]">
        <!-- Monitoring, live -->
        <button
          class="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 text-left transition hover:border-sky-700/60"
          title="Open Monitoring"
          @click="emit('navigate', 'monitor')"
        >
          <p class="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <v-icon name="fa-chart-line" scale="0.8" class="text-sky-300" /> Monitoring
            <span class="flex items-center gap-1 text-[10px] font-normal text-emerald-400"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live</span>
            <span class="ml-auto text-[11px] font-normal text-slate-500">Open →</span>
          </p>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <p class="text-[11px] text-slate-500">CPU</p>
              <p class="text-xl font-semibold text-white tabular-nums">{{ live ? `${live.cpu.toFixed(live.cpu < 10 ? 1 : 0)}%` : '…' }}</p>
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
                <div class="h-full rounded-full transition-all" :class="barTone(live?.cpu ?? 0)" :style="{ width: `${Math.min(100, live?.cpu ?? 0)}%` }" />
              </div>
              <p class="mt-1 text-[10px] text-slate-600">load {{ sample?.load[0].toFixed(2) ?? '…' }} · {{ sample?.cpu.cores ?? '?' }} cores</p>
            </div>
            <div>
              <p class="text-[11px] text-slate-500">Memory</p>
              <p class="text-xl font-semibold text-white tabular-nums">{{ sample ? formatSize(memUsed) : '…' }}</p>
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
                <div class="h-full rounded-full transition-all" :class="barTone(memPct)" :style="{ width: `${memPct}%` }" />
              </div>
              <p class="mt-1 text-[10px] text-slate-600">of {{ sample ? formatSize(sample.memory.total) : '…' }}</p>
            </div>
            <div>
              <p class="text-[11px] text-slate-500">Network</p>
              <p class="text-sm font-semibold text-white tabular-nums">↓ {{ live ? rate(live.rx) : '…' }}</p>
              <p class="text-sm text-slate-300 tabular-nums">↑ {{ live ? rate(live.tx) : '…' }}</p>
              <p class="mt-1 text-[10px] text-slate-600" title="SSHer itself fetches these numbers over SSH every 3 seconds, and any public server also gets a steady trickle of scans and login attempts — a few KB/s at idle is normal.">
                incl. SSHer's own updates
              </p>
            </div>
          </div>
        </button>

        <!-- Security summary -->
        <div class="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
          <p class="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <v-icon name="fa-bug" scale="0.8" class="text-red-300" /> Security
            <span v-if="scannedAt" class="text-[10px] font-normal text-slate-500">checked {{ new Date(scannedAt).toLocaleTimeString() }}</span>
            <button class="ml-auto text-[11px] font-normal text-slate-500 hover:text-white" :disabled="scanning" @click="scan(true)">
              <v-icon name="fa-sync-alt" scale="0.55" :class="scanning && 'animate-spin'" /> Rescan
            </button>
          </p>
          <p v-if="findings === null" class="py-4 text-center text-xs text-slate-500"><v-icon name="fa-spinner" class="animate-spin" /> Scanning…</p>
          <template v-else>
            <div class="flex flex-wrap gap-2">
              <span v-for="s in SEV" :key="s.key" class="flex items-center gap-1.5 rounded-md bg-slate-950/60 px-2 py-1 text-xs">
                <v-icon :name="s.icon" scale="0.6" :style="{ color: s.color }" />
                <span class="font-semibold text-white tabular-nums">{{ count(s.key) }}</span>
                <span class="text-slate-500">{{ s.label }}</span>
              </span>
            </div>
            <ul v-if="worst.length" class="mt-3 space-y-1">
              <li v-for="f in worst" :key="f.id" class="flex items-start gap-1.5 text-[11px] text-slate-300">
                <v-icon :name="f.severity === 'critical' ? 'fa-times-circle' : 'fa-exclamation-triangle'" scale="0.55" class="mt-0.5 shrink-0" :style="{ color: f.severity === 'critical' ? '#d03b3b' : '#ec835a' }" />
                <span class="line-clamp-1">{{ f.title }}</span>
              </li>
            </ul>
            <p v-else class="mt-3 text-[11px] text-emerald-300"><v-icon name="fa-check-circle" scale="0.6" /> Nothing serious found.</p>
            <button class="mt-3 text-[11px] text-sky-400 hover:text-sky-300" @click="emit('navigate', 'security')">Open Security →</button>
          </template>
        </div>
      </div>

      <!-- Speed test of the server's own internet connection -->
      <div class="mt-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <p class="flex items-center gap-2 text-sm font-semibold text-white">
            <v-icon name="fa-bolt" scale="0.8" class="text-amber-300" /> Server speed test
          </p>
          <span class="text-[11px] text-slate-500">
            The server's own internet connection, measured against Cloudflare<template v-if="speed?.location"> ({{ speed.location }})</template>
          </span>
          <button
            class="ml-auto flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
            :disabled="Boolean(speedPhase)"
            @click="runSpeedTest"
          >
            <v-icon :name="speedPhase ? 'fa-spinner' : 'fa-bolt'" scale="0.7" :class="speedPhase && 'animate-spin'" />
            {{ speedPhase ? 'Testing…' : speed ? 'Run again' : 'Run speed test' }}
          </button>
        </div>

        <div class="mt-3 grid grid-cols-3 gap-3">
          <div v-for="m in [
            { key: 'download', label: 'Download', icon: '↓', value: mbps(speed?.down), unit: 'Mbps' },
            { key: 'upload', label: 'Upload', icon: '↑', value: mbps(speed?.up), unit: 'Mbps' },
            { key: 'latency', label: 'Latency', icon: '', value: speed?.latencyMs?.toFixed(0) ?? '', unit: 'ms' },
          ]" :key="m.key" class="rounded-xl bg-slate-950/50 px-3 py-2.5">
            <p class="text-[11px] text-slate-500">{{ m.icon }} {{ m.label }}</p>
            <p class="text-xl font-semibold text-white tabular-nums">
              <v-icon v-if="speedPhase === m.key" name="fa-spinner" scale="0.8" class="animate-spin text-amber-300" />
              <template v-else-if="m.value">{{ m.value }} <span class="text-xs font-normal text-slate-500">{{ m.unit }}</span></template>
              <span v-else class="text-slate-600">—</span>
            </p>
          </div>
        </div>
        <p v-if="speedError" class="mt-2 text-[11px] text-red-400">{{ speedError }}</p>
        <p v-else class="mt-2 text-[10px] text-slate-600">
          <template v-if="speed?.time">Tested {{ new Date(speed.time).toLocaleTimeString() }} · used {{ speed.usedMb.toFixed(0) }} MB of data. </template>
          Takes about 20 seconds and moves up to a few hundred MB on a fast link.
        </p>
      </div>

      <div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="tile in TILES"
          :key="tile.view"
          class="group rounded-2xl border border-slate-800 bg-gradient-to-br to-slate-900/40 p-5 text-left transition hover:-translate-y-0.5 hover:border-slate-600"
          :class="tile.tone.split(' ')[0]"
          @click="emit('navigate', tile.view)"
        >
          <div
            class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-950/60 ring-1"
            :class="tile.tone.split(' ').slice(1)"
          >
            <v-icon :name="tile.icon" scale="1.4" />
          </div>
          <p class="flex items-center gap-2 font-semibold text-white">
            {{ tile.title }}
            <v-icon
              name="fa-arrow-right"
              scale="0.7"
              class="text-slate-500 transition group-hover:translate-x-1"
            />
          </p>
          <p class="mt-1 text-sm text-slate-400">{{ tile.text }}</p>
        </button>
      </div>

      <div class="mt-8">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <v-icon name="fa-star" scale="0.8" class="text-amber-300" /> Shortcuts
          </h2>
          <button class="text-xs text-slate-400 hover:text-white" @click="emit('navigate', 'shortcuts')">
            Manage →
          </button>
        </div>
        <p v-if="!shortcuts.length" class="text-sm text-slate-500">
          None yet. Right-click anything in the File Explorer → Add to shortcuts.
        </p>
        <div v-else class="flex flex-wrap gap-2">
          <button
            v-for="s in shortcuts"
            :key="s.id"
            :title="s.description || s.path"
            class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 transition hover:border-amber-400/40"
            @click="emit('openShortcut', s)"
          >
            <v-icon
              :name="s.isDirectory ? 'fa-folder' : 'fa-file-alt'"
              scale="0.75"
              :class="s.isDirectory ? 'text-amber-300' : 'text-sky-300'"
            />
            {{ s.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
