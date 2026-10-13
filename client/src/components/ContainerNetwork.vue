<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import type { Container, ContainerStat, NetConnection } from '../types';
import ConnectionsTable from './ConnectionsTable.vue';
import LineChart from './LineChart.vue';

const props = defineProps<{ container: Container }>();

const interval = ref(3);
const stat = ref<ContainerStat | null>(null);
const points = ref<{ time: number; rx: number; tx: number; cpu: number }[]>([]);
const conns = ref<NetConnection[]>([]);
let prev: { time: number; rx: number; tx: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

/** docker stats itself takes about a second, so the loop waits for each answer. */
async function tick() {
  try {
    const res = await api.dockerStats();
    const s = res.containers.find((c) => c.id === props.container.id || c.name === props.container.name) ?? null;
    stat.value = s;
    if (s) {
      if (prev && res.time > prev.time) {
        const dt = (res.time - prev.time) / 1000;
        points.value = [
          ...points.value.slice(-119),
          { time: res.time, rx: Math.max(0, (s.netRx - prev.rx) / dt), tx: Math.max(0, (s.netTx - prev.tx) / dt), cpu: s.cpuPct },
        ];
      }
      prev = { time: res.time, rx: s.netRx, tx: s.netTx };
    }
    if (props.container.pid) conns.value = (await api.dockerContainerConnections(props.container.pid)).connections;
  } catch {
    /* keep the last numbers; the container may be restarting */
  }
  if (!stopped) timer = setTimeout(tick, interval.value * 1000);
}

onMounted(tick);
onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
});
watch(interval, () => {
  clearTimeout(timer);
  tick();
});

const rate = (b: number) => `${formatSize(Math.round(b))}/s`;
const last = computed(() => points.value.at(-1) ?? null);
</script>

<template>
  <div class="space-y-4">
    <p v-if="!container.running" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
      The container isn't running, so there's no live traffic.
    </p>
    <template v-else>
      <div class="flex items-center gap-2 text-[11px] text-slate-500">
        Refresh every
        <select v-model.number="interval" class="rounded-md border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-slate-200">
          <option v-for="n in [2, 3, 5, 10]" :key="n" :value="n">{{ n }} s</option>
        </select>
      </div>

      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="rounded-lg border border-slate-800 p-2.5">
          <p class="text-[10px] text-slate-500">Download ↓</p>
          <p class="font-semibold text-white tabular-nums">{{ last ? rate(last.rx) : '…' }}</p>
          <p class="text-[10px] text-slate-600">{{ stat ? formatSize(stat.netRx) : '' }} since start</p>
        </div>
        <div class="rounded-lg border border-slate-800 p-2.5">
          <p class="text-[10px] text-slate-500">Upload ↑</p>
          <p class="font-semibold text-white tabular-nums">{{ last ? rate(last.tx) : '…' }}</p>
          <p class="text-[10px] text-slate-600">{{ stat ? formatSize(stat.netTx) : '' }} since start</p>
        </div>
        <div class="rounded-lg border border-slate-800 p-2.5">
          <p class="text-[10px] text-slate-500">CPU</p>
          <p class="font-semibold text-white tabular-nums">{{ stat ? `${stat.cpuPct.toFixed(1)}%` : '…' }}</p>
        </div>
        <div class="rounded-lg border border-slate-800 p-2.5">
          <p class="text-[10px] text-slate-500">Memory</p>
          <p class="font-semibold text-white tabular-nums">{{ stat?.memUsage ?? '…' }}</p>
          <p class="text-[10px] text-slate-600">{{ stat?.pids ?? '' }} processes</p>
        </div>
      </div>

      <div class="rounded-lg border border-slate-800 p-3">
        <LineChart
          v-if="points.length > 1"
          :series="[
            { name: 'Download ↓', values: points.map((p) => p.rx) },
            { name: 'Upload ↑', values: points.map((p) => p.tx) },
          ]"
          :times="points.map((p) => p.time)"
          :format="rate"
          :height="120"
        />
        <p v-else class="py-6 text-center text-[11px] text-slate-600">Measuring… the chart starts after two samples.</p>
      </div>

      <div>
        <p class="mb-1.5 text-xs font-medium text-slate-400">Connections inside this container</p>
        <ConnectionsTable :connections="conns" compact />
      </div>
    </template>
  </div>
</template>
