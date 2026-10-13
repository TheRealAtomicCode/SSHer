<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { fail } from '../toast';
import LineChart from './LineChart.vue';
import { isMine, loadMyIps, privacy, setShowMyIp, showIp } from '../privacy';

const props = defineProps<{ accessPath: string; errorPath: string }>();
const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }] }>();

const which = ref<'access' | 'error'>('access');
const lines = ref<string[]>([]);
const exists = ref(true);
const size = ref(0);
const loading = ref(false);
const count = ref(1000);
const follow = ref(false);
const query = ref('');
const statusClass = ref('');
const method = ref('');
const ip = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
loadMyIps();

const path = computed(() => (which.value === 'access' ? props.accessPath : props.errorPath));

async function load() {
  if (!path.value) return;
  loading.value = true;
  try {
    const res = await api.logTail(path.value, count.value);
    exists.value = res.exists;
    size.value = res.size ?? 0;
    lines.value = res.lines;
  } catch (err) {
    fail(err);
    follow.value = false;
  } finally {
    loading.value = false;
  }
}

watch([path, count], load, { immediate: true });
watch(follow, (on) => {
  clearInterval(timer);
  if (on) timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));

// nginx's default "combined" format:
// $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"
const COMBINED = /^(\S+) \S+ (\S+) \[([^\]]+)\] "(\S+)(?: (\S+))?(?: (\S+))?" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/;
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

interface Request {
  raw: string;
  ip: string;
  time: number;
  method: string;
  path: string;
  status: number;
  bytes: number;
  referer: string;
  agent: string;
}

/** "12/Oct/2026:23:11:27 +0000" → epoch ms. */
function parseTime(t: string): number {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(t);
  return m ? Date.parse(`${m[3]}-${MONTHS[m[2]]}-${m[1]}T${m[4]}${m[5]}:${m[6]}`) : 0;
}

const requests = computed<Request[]>(() =>
  which.value !== 'access'
    ? []
    : lines.value
        .map((raw) => {
          const m = COMBINED.exec(raw);
          if (!m) return null;
          return {
            raw,
            ip: m[1],
            time: parseTime(m[3]),
            method: m[4],
            path: m[5] ?? '',
            status: Number(m[7]),
            bytes: m[8] === '-' ? 0 : Number(m[8]),
            referer: m[9],
            agent: m[10],
          };
        })
        .filter((r): r is Request => r !== null),
);
const unparsed = computed(() => (which.value === 'access' ? lines.value.length - requests.value.length : 0));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return requests.value.filter(
    (r) =>
      (!statusClass.value || String(r.status)[0] === statusClass.value) &&
      (!method.value || r.method === method.value) &&
      (!ip.value || r.ip === ip.value) &&
      (!q || r.raw.toLowerCase().includes(q)),
  );
});

const errorLines = computed(() => {
  const q = query.value.trim().toLowerCase();
  return which.value === 'error' ? lines.value.filter((l) => !q || l.toLowerCase().includes(q)) : [];
});

const methods = computed(() => [...new Set(requests.value.map((r) => r.method))].sort());
const statusCounts = computed(() => {
  const c: Record<string, number> = { '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of filtered.value) c[String(r.status)[0]] = (c[String(r.status)[0]] ?? 0) + 1;
  return c;
});
const bytes = computed(() => filtered.value.reduce((n, r) => n + r.bytes, 0));
const span = computed(() => {
  const t = filtered.value.map((r) => r.time).filter(Boolean);
  return t.length ? { from: Math.min(...t), to: Math.max(...t) } : null;
});
const top = (key: 'ip' | 'path') =>
  computed(() => {
    const m = new Map<string, number>();
    for (const r of filtered.value) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  });
const topIps = top('ip');
const topPaths = top('path');

/** Requests per minute across the window, for the chart. Empty minutes count as 0. */
const perMinute = computed(() => {
  if (!span.value) return { times: [] as number[], values: [] as number[] };
  const start = Math.floor(span.value.from / 60000);
  const end = Math.floor(span.value.to / 60000);
  const buckets = Math.min(240, end - start + 1);
  const first = end - buckets + 1;
  const values = new Array(buckets).fill(0);
  for (const r of filtered.value) {
    const b = Math.floor(r.time / 60000) - first;
    if (b >= 0 && b < buckets) values[b]++;
  }
  return { times: values.map((_, i) => (first + i) * 60000), values };
});

const statusTone = (s: number) =>
  s >= 500 ? 'text-red-300' : s >= 400 ? 'text-amber-300' : s >= 300 ? 'text-sky-300' : 'text-emerald-300';
const errorTone = (l: string) =>
  /\[(emerg|alert|crit|error)\]/.test(l) ? 'text-red-300' : /\[warn\]/.test(l) ? 'text-amber-300' : 'text-slate-400';

function clearFilters() {
  query.value = '';
  statusClass.value = '';
  method.value = '';
  ip.value = '';
}

const chip = 'rounded-md border px-2 py-0.5 text-[11px] transition';
const field = 'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:border-sky-500 focus:outline-none';
</script>

<template>
  <div class="space-y-3">
    <!-- Which log + file actions -->
    <div class="flex flex-wrap items-center gap-1.5">
      <div class="flex rounded-md border border-slate-700 p-0.5 text-[11px]">
        <button
          v-for="w in (['access', 'error'] as const)"
          :key="w"
          class="rounded px-2.5 py-1 capitalize"
          :class="which === w ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
          @click="which = w"
        >
          {{ w }} log
        </button>
      </div>
      <span class="truncate font-mono text-[11px] text-slate-500" :title="path">{{ path }}</span>
      <span v-if="exists" class="text-[10px] text-slate-600">{{ formatSize(size) }}</span>
      <div class="flex-1" />
      <button :class="field" :disabled="!exists" title="Open the log in the editor" @click="emit('openPath', { path, isDirectory: false })">
        <v-icon name="fa-file-alt" scale="0.6" /> Open file
      </button>
      <button :class="field" title="Show it in the File Explorer" @click="emit('openPath', { path, isDirectory: false, reveal: true })">
        <v-icon name="fa-folder-open" scale="0.6" /> Open in folder
      </button>
    </div>

    <p v-if="!exists" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
      {{ path }} doesn't exist yet — nginx creates it on the first request (or the site logs elsewhere).
    </p>

    <template v-else>
      <!-- Controls -->
      <div class="flex flex-wrap items-center gap-1.5">
        <div class="relative min-w-40 flex-1">
          <v-icon name="fa-search" scale="0.55" class="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
          <input v-model="query" placeholder="Search path, IP, user agent…" :class="[field, 'w-full pl-6']" />
        </div>
        <template v-if="which === 'access'">
          <button
            v-for="s in ['2', '3', '4', '5']"
            :key="s"
            :class="[chip, statusClass === s ? 'border-sky-500 bg-sky-500/10 text-sky-200' : 'border-slate-700 text-slate-400 hover:text-white']"
            @click="statusClass = statusClass === s ? '' : s"
          >
            {{ s }}xx <span class="text-slate-500">{{ statusCounts[s] }}</span>
          </button>
          <select v-model="method" :class="field">
            <option value="">Any method</option>
            <option v-for="m in methods" :key="m" :value="m">{{ m }}</option>
          </select>
        </template>
        <select v-model.number="count" :class="field" title="How many of the newest lines to read">
          <option :value="500">last 500</option>
          <option :value="1000">last 1000</option>
          <option :value="5000">last 5000</option>
          <option :value="20000">last 20000</option>
        </select>
        <label :class="[field, 'flex cursor-pointer items-center gap-1', follow && 'border-sky-600 text-sky-300']">
          <input v-model="follow" type="checkbox" class="accent-sky-500" /> Follow
        </label>
        <button v-if="privacy.myIps.length" :class="[field, privacy.show && 'border-amber-600 text-amber-300']" @click="setShowMyIp(!privacy.show)">
          <v-icon :name="privacy.show ? 'fa-eye' : 'fa-eye-slash'" scale="0.55" /> {{ privacy.show ? 'Hide my IP' : 'Show my IP' }}
        </button>
        <button :class="field" @click="load"><v-icon name="fa-sync-alt" scale="0.55" :class="loading && 'animate-spin'" /></button>
      </div>
      <p v-if="ip" class="text-[11px] text-slate-400">
        Only requests from <span class="font-mono text-sky-300">{{ showIp(ip) }}</span>
        <button class="ml-1 text-slate-500 hover:text-white" @click="ip = ''">× clear</button>
      </p>

      <!-- Access log: traffic summary + requests -->
      <template v-if="which === 'access'">
        <div class="grid gap-3 lg:grid-cols-[2fr_1fr_1fr]">
          <div class="rounded-lg border border-slate-800 p-3">
            <p class="mb-1 text-[11px] text-slate-500">
              Requests per minute
              <span v-if="span"> · {{ filtered.length }} requests, {{ formatSize(bytes) }} sent, {{ new Date(span.from).toLocaleString() }} → {{ new Date(span.to).toLocaleTimeString() }}</span>
            </p>
            <LineChart
              v-if="perMinute.values.length > 1"
              :series="[{ name: 'requests/min', values: perMinute.values }]"
              :times="perMinute.times"
              :format="(v) => String(Math.round(v))"
              :height="110"
            />
            <p v-else class="py-6 text-center text-[11px] text-slate-600">Not enough requests in this window to chart.</p>
          </div>
          <div class="rounded-lg border border-slate-800 p-3 text-[11px]">
            <p class="mb-1.5 text-slate-500">Top IPs</p>
            <button v-for="[k, n] in topIps" :key="k" class="flex w-full justify-between gap-2 py-0.5 text-left hover:text-sky-300" @click="ip = k">
              <span class="truncate font-mono" :class="isMine(k) ? 'text-amber-300' : 'text-slate-300'">{{ showIp(k) }}</span><span class="text-slate-500 tabular-nums">{{ n }}</span>
            </button>
          </div>
          <div class="rounded-lg border border-slate-800 p-3 text-[11px]">
            <p class="mb-1.5 text-slate-500">Top paths</p>
            <button v-for="[k, n] in topPaths" :key="k" class="flex w-full justify-between gap-2 py-0.5 text-left hover:text-sky-300" @click="query = k">
              <span class="truncate font-mono text-slate-300">{{ k }}</span><span class="text-slate-500 tabular-nums">{{ n }}</span>
            </button>
          </div>
        </div>

        <div class="max-h-[26rem] overflow-auto rounded-lg border border-slate-800">
          <table class="w-full text-[11px]">
            <thead class="sticky top-0 bg-slate-900 text-left text-slate-500">
              <tr>
                <th class="px-2 py-1.5 font-medium">Time</th>
                <th class="px-2 py-1.5 font-medium">IP</th>
                <th class="px-2 py-1.5 font-medium">Request</th>
                <th class="px-2 py-1.5 font-medium">Status</th>
                <th class="px-2 py-1.5 font-medium">Size</th>
                <th class="px-2 py-1.5 font-medium">Client</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in [...filtered].reverse().slice(0, 1000)" :key="i" class="border-t border-slate-800/60 align-top hover:bg-slate-900/60" :title="r.raw">
                <td class="px-2 py-1 whitespace-nowrap text-slate-500">{{ r.time ? new Date(r.time).toLocaleTimeString() : '' }}</td>
                <td class="px-2 py-1 font-mono"><button class="hover:text-sky-300" :class="isMine(r.ip) ? 'text-amber-300' : 'text-slate-300'" @click="ip = r.ip">{{ showIp(r.ip) }}</button></td>
                <td class="max-w-md px-2 py-1 font-mono break-all text-slate-200"><span class="text-slate-500">{{ r.method }}</span> {{ r.path }}</td>
                <td class="px-2 py-1 font-semibold" :class="statusTone(r.status)">{{ r.status }}</td>
                <td class="px-2 py-1 text-slate-500 tabular-nums">{{ formatSize(r.bytes) }}</td>
                <td class="max-w-xs truncate px-2 py-1 text-slate-500" :title="r.agent">{{ r.agent }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!filtered.length" class="px-3 py-4 text-center text-[11px] text-slate-500">
            No requests match. <button class="text-sky-400" @click="clearFilters">Clear filters</button>
          </p>
        </div>
        <p v-if="unparsed" class="text-[10px] text-slate-600">
          {{ unparsed }} line(s) aren't in nginx's default format and are left out — search the raw file with "Open file".
        </p>
      </template>

      <!-- Error log -->
      <div v-else class="max-h-[30rem] overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[11px] leading-relaxed">
        <p v-for="(l, i) in [...errorLines].reverse()" :key="i" class="break-all" :class="errorTone(l)">{{ l }}</p>
        <p v-if="!errorLines.length" class="p-2 text-slate-600">{{ lines.length ? 'No lines match.' : 'The error log is empty — good.' }}</p>
      </div>
    </template>
  </div>
</template>
