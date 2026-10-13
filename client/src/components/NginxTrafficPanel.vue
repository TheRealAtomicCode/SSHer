<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import type { NetConnection, NginxSite } from '../types';
import AccessLogViewer from './AccessLogViewer.vue';
import ConnectionsTable from './ConnectionsTable.vue';

const props = defineProps<{ site: NginxSite }>();
const emit = defineEmits<{ close: []; openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }] }>();

const logs = ref<{ access: string; error: string; ports: number[] } | null>(null);
const processes = ref<{ pid: number; cpuPct: number; memBytes: number; uptimeSeconds: number; command: string }[]>([]);
const conns = ref<NetConnection[]>([]);
let timer: ReturnType<typeof setInterval> | undefined;

async function loadStats() {
  try {
    const s = await api.nginxStats();
    processes.value = s.processes;
    conns.value = s.connections;
  } catch {
    /* the panel keeps the last numbers */
  }
}

onMounted(async () => {
  logs.value = await api.nginxSiteLogs(props.site.name).catch(() => null);
  await loadStats();
  timer = setInterval(loadStats, 3000);
});
onUnmounted(() => clearInterval(timer));

/** nginx holds sockets for every site at once; these are the ones on this site's ports. */
const siteConns = computed(() => {
  const ports = logs.value?.ports ?? [];
  return ports.length ? conns.value.filter((c) => ports.includes(c.localPort)) : conns.value;
});
const cpu = computed(() => processes.value.reduce((n, p) => n + p.cpuPct, 0));
const memory = computed(() => processes.value.reduce((n, p) => n + p.memBytes, 0));
const workers = computed(() => processes.value.filter((p) => p.command.includes('worker')).length);
</script>

<template>
  <div data-modal class="fixed inset-0 z-40 flex justify-end bg-slate-950/70 backdrop-blur-sm" @click.self="emit('close')">
    <aside class="flex h-full w-full max-w-5xl flex-col border-l border-slate-800 bg-slate-950" @keydown.esc="emit('close')">
      <div class="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
        <v-icon name="fa-chart-line" class="text-emerald-400" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-white">{{ site.name }} — traffic &amp; logs</p>
          <p class="truncate font-mono text-[11px] text-slate-500">{{ site.domains.join(', ') }}<template v-if="site.target"> → {{ site.target }}</template></p>
        </div>
        <button class="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:text-white" @click="emit('openPath', { path: site.path, isDirectory: false, reveal: true })">
          <v-icon name="fa-folder-open" scale="0.6" /> Config in folder
        </button>
        <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        <!-- nginx itself -->
        <div class="grid gap-3 sm:grid-cols-4">
          <div class="rounded-lg border border-slate-800 p-3">
            <p class="text-[11px] text-slate-500">nginx CPU (all sites)</p>
            <p class="text-lg font-semibold text-white tabular-nums">{{ cpu.toFixed(1) }}%</p>
          </div>
          <div class="rounded-lg border border-slate-800 p-3">
            <p class="text-[11px] text-slate-500">nginx memory</p>
            <p class="text-lg font-semibold text-white tabular-nums">{{ formatSize(memory) }}</p>
            <p class="text-[10px] text-slate-600">{{ workers }} worker process(es)</p>
          </div>
          <div class="rounded-lg border border-slate-800 p-3">
            <p class="text-[11px] text-slate-500">Open connections on {{ (logs?.ports ?? []).join(', ') || 'its ports' }}</p>
            <p class="text-lg font-semibold text-white tabular-nums">{{ siteConns.length }}</p>
          </div>
          <div class="rounded-lg border border-slate-800 p-3">
            <p class="text-[11px] text-slate-500">All nginx connections</p>
            <p class="text-lg font-semibold text-white tabular-nums">{{ conns.length }}</p>
            <p class="text-[10px] text-slate-600">refreshes every 3 s</p>
          </div>
        </div>
        <p class="text-[11px] text-slate-500">
          The kernel doesn't count bytes per program, so traffic per site comes from its access log below (bytes sent per request).
          Several sites can share port 80 — the connection list shows everything nginx holds on this site's ports.
        </p>

        <details class="rounded-lg border border-slate-800 p-3" open>
          <summary class="cursor-pointer text-xs font-semibold text-slate-300">Live connections</summary>
          <div class="mt-3"><ConnectionsTable :connections="siteConns" compact /></div>
        </details>

        <AccessLogViewer
          v-if="logs"
          :access-path="logs.access"
          :error-path="logs.error"
          @open-path="(p) => emit('openPath', p)"
        />
      </div>
    </aside>
  </div>
</template>
