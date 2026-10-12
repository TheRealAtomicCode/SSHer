<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as api from '../api';
import { fail, notify } from '../toast';
import type { ProcessInfo, Signal } from '../types';

const loading = ref(true);
const all = ref<ProcessInfo[]>([]);
const query = ref('');
const follow = ref(false);
const busy = ref<Set<number>>(new Set());

type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'etime' | 'command';
const sortKey = ref<SortKey>('cpu');
const sortDesc = ref(true);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  loading.value = true;
  try {
    all.value = (await api.processes()).processes;
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

function sortBy(key: SortKey) {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value;
  else {
    sortKey.value = key;
    sortDesc.value = key === 'cpu' || key === 'mem';
  }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const rows = q
    ? all.value.filter(
        (p) => p.command.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q),
      )
    : all.value;
  const dir = sortDesc.value ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey.value];
    const bv = b[sortKey.value];
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

function setBusy(pid: number, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(pid);
  else next.delete(pid);
  busy.value = next;
}

async function signal(p: ProcessInfo, sig: Signal) {
  const verb = sig === 'KILL' ? 'Force-kill' : 'Terminate';
  let msg = `${verb} pid ${p.pid} (${p.command.slice(0, 60)})?`;
  if (/\bssh d?\b|\bsshd\b/i.test(p.command)) msg += '\n\nThis looks like an SSH server process — killing the wrong one could disconnect you or someone else.';
  if (!confirm(msg)) return;
  setBusy(p.pid, true);
  try {
    await api.signalProcess(p.pid, sig);
    notify(`Sent SIG${sig} to ${p.pid}`);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    setBusy(p.pid, false);
  }
}

function toggleFollow() {
  follow.value = !follow.value;
  clearInterval(timer);
  if (follow.value) timer = setInterval(refresh, 3000);
}

onMounted(refresh);
onUnmounted(() => clearInterval(timer));

const th = 'cursor-pointer px-3 py-2 text-left font-medium select-none hover:text-white';
const btn = 'rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-30';
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-5">
    <div class="mx-auto max-w-6xl">
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <v-icon name="fa-microchip" scale="1.3" class="text-rose-300" />
        <div>
          <h1 class="text-base font-semibold text-white">Processes</h1>
          <p class="text-xs text-slate-500">{{ all.length }} running · showing {{ filtered.length }}</p>
        </div>
        <div class="flex-1" />
        <div class="relative">
          <v-icon name="fa-search" scale="0.65" class="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <input
            v-model="query"
            placeholder="Filter by user, pid or command…"
            class="w-64 rounded-lg border border-slate-700 bg-slate-900 py-1.5 pr-2 pl-7 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
          />
        </div>
        <label class="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs" :class="follow ? 'border-emerald-600 text-emerald-300' : 'text-slate-400'">
          <input :checked="follow" type="checkbox" class="accent-emerald-500" @change="toggleFollow" /> Auto-refresh
        </label>
        <button :class="btn" title="Refresh" @click="refresh">
          <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
        </button>
      </div>

      <div v-if="loading && !all.length" class="py-16 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-rose-300" />
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-slate-800">
        <table class="w-full text-xs">
          <thead class="bg-slate-900 text-slate-500">
            <tr>
              <th :class="th" @click="sortBy('pid')">PID</th>
              <th :class="th" @click="sortBy('user')">User</th>
              <th :class="th" @click="sortBy('cpu')">CPU%</th>
              <th :class="th" @click="sortBy('mem')">MEM%</th>
              <th :class="th" @click="sortBy('etime')">Time</th>
              <th class="px-3 py-2 text-left font-medium">Stat</th>
              <th :class="th" @click="sortBy('command')">Command</th>
              <th class="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filtered" :key="p.pid" class="border-t border-slate-800/70 hover:bg-slate-900/60">
              <td class="px-3 py-1.5 font-mono text-slate-400">{{ p.pid }}</td>
              <td class="px-3 py-1.5 text-slate-300">{{ p.user }}</td>
              <td class="px-3 py-1.5 font-mono text-slate-300 tabular-nums">{{ p.cpu.toFixed(1) }}</td>
              <td class="px-3 py-1.5 font-mono text-slate-300 tabular-nums">{{ p.mem.toFixed(1) }}</td>
              <td class="px-3 py-1.5 font-mono text-slate-500">{{ p.etime }}</td>
              <td class="px-3 py-1.5 font-mono text-slate-500">{{ p.stat }}</td>
              <td class="max-w-md truncate px-3 py-1.5 font-mono text-slate-200" :title="p.command">{{ p.command }}</td>
              <td class="px-3 py-1.5 text-right whitespace-nowrap">
                <v-icon v-if="busy.has(p.pid)" name="fa-spinner" scale="0.75" class="mx-1.5 animate-spin text-rose-300" />
                <template v-else>
                  <button :class="btn" title="Terminate (SIGTERM)" @click="signal(p, 'TERM')">
                    <v-icon name="fa-stop" scale="0.7" />
                  </button>
                  <button :class="btn" title="Force kill (SIGKILL)" @click="signal(p, 'KILL')">
                    <v-icon name="fa-skull-crossbones" scale="0.7" class="text-red-400" />
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!filtered.length" class="py-8 text-center text-sm text-slate-500">No processes match.</p>
      </div>
    </div>
  </div>
</template>
