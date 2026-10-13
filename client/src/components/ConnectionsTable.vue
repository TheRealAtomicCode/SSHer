<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { isMine, loadMyIps, privacy, setShowMyIp, showIp } from '../privacy';
import type { NetConnection } from '../types';

const props = defineProps<{ connections: NetConnection[]; compact?: boolean }>();

onMounted(loadMyIps);

const query = ref('');
const state = ref('');
const proc = ref('');
const grouped = ref(false);

const states = computed(() => [...new Set(props.connections.map((c) => c.state))].sort());
const processes = computed(() => [...new Set(props.connections.map((c) => c.process || '—'))].sort());

const KNOWN_PORTS: Record<number, string> = {
  22: 'ssh', 53: 'dns', 80: 'http', 443: 'https', 5432: 'postgres', 3306: 'mysql', 6379: 'redis', 51820: 'wireguard',
};

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.connections.filter((c) => {
    if (state.value && c.state !== state.value) return false;
    if (proc.value && (c.process || '—') !== proc.value) return false;
    if (!q) return true;
    return [c.local, c.peer, String(c.localPort), String(c.peerPort), c.process, c.state, c.proto].some((v) =>
      v.toLowerCase().includes(q),
    );
  });
});

/** One row per remote address — "who is talking to this server, and how much". */
const groups = computed(() => {
  const map = new Map<string, { peer: string; count: number; ports: Set<number>; processes: Set<string>; states: Set<string> }>();
  for (const c of filtered.value) {
    const g = map.get(c.peer) ?? { peer: c.peer, count: 0, ports: new Set(), processes: new Set(), states: new Set() };
    g.count++;
    g.ports.add(c.localPort);
    if (c.process) g.processes.add(c.process);
    g.states.add(c.state);
    map.set(c.peer, g);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
});

const stateTone = (s: string) =>
  s === 'ESTAB' ? 'text-emerald-300' : s.startsWith('TIME') || s.startsWith('CLOSE') || s.startsWith('FIN') ? 'text-slate-500' : 'text-amber-300';

const portLabel = (p: number) => (KNOWN_PORTS[p] ? `${p} ${KNOWN_PORTS[p]}` : String(p));
const isLocal = (a: string) => /^(127\.|::1$|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a);
const field = 'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 focus:border-sky-500 focus:outline-none';
</script>

<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <div class="relative min-w-40 flex-1">
        <v-icon name="fa-search" scale="0.55" class="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
        <input v-model="query" placeholder="Search IP, port, process…" :class="[field, 'w-full pl-6']" />
      </div>
      <select v-model="state" :class="field">
        <option value="">All states</option>
        <option v-for="s in states" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="proc" :class="field">
        <option value="">All programs</option>
        <option v-for="p in processes" :key="p" :value="p">{{ p }}</option>
      </select>
      <button :class="[field, grouped && 'border-sky-600 text-sky-300']" title="One row per remote address" @click="grouped = !grouped">
        Group by remote
      </button>
      <button
        v-if="privacy.myIps.length"
        :class="[field, privacy.show && 'border-amber-600 text-amber-300']"
        :title="privacy.show ? 'Your own IP is shown' : 'Your own public IP is replaced with “you (hidden)”'"
        @click="setShowMyIp(!privacy.show)"
      >
        <v-icon :name="privacy.show ? 'fa-eye' : 'fa-eye-slash'" scale="0.55" /> {{ privacy.show ? 'Hide my IP' : 'Show my IP' }}
      </button>
      <span class="text-[11px] text-slate-500">{{ filtered.length }} / {{ connections.length }}</span>
    </div>

    <div class="overflow-auto rounded-lg border border-slate-800" :class="compact ? 'max-h-64' : 'max-h-[28rem]'">
      <table class="w-full text-[11px]">
        <thead class="sticky top-0 bg-slate-900 text-left text-slate-500">
          <tr v-if="!grouped">
            <th class="px-2 py-1.5 font-medium">Remote</th>
            <th class="px-2 py-1.5 font-medium">→ Local port</th>
            <th class="px-2 py-1.5 font-medium">Program</th>
            <th class="px-2 py-1.5 font-medium">State</th>
            <th class="px-2 py-1.5 font-medium">Proto</th>
          </tr>
          <tr v-else>
            <th class="px-2 py-1.5 font-medium">Remote</th>
            <th class="px-2 py-1.5 font-medium">Connections</th>
            <th class="px-2 py-1.5 font-medium">To ports</th>
            <th class="px-2 py-1.5 font-medium">Programs</th>
          </tr>
        </thead>
        <tbody v-if="!grouped">
          <tr v-for="(c, i) in filtered.slice(0, 500)" :key="i" class="border-t border-slate-800/60 hover:bg-slate-900/60">
            <td class="px-2 py-1 font-mono" :class="isLocal(c.peer) ? 'text-slate-500' : 'text-slate-200'">
              <button class="hover:text-sky-300" :class="isMine(c.peer) && 'text-amber-300'" title="Filter by this address" @click="query = c.peer">{{ showIp(c.peer) }}</button><span class="text-slate-600">:{{ c.peerPort }}</span>
            </td>
            <td class="px-2 py-1 font-mono text-slate-300">{{ portLabel(c.localPort) }}</td>
            <td class="px-2 py-1 text-slate-300">{{ c.process || '—' }}<span v-if="c.pid" class="text-slate-600"> {{ c.pid }}</span></td>
            <td class="px-2 py-1" :class="stateTone(c.state)">{{ c.state }}</td>
            <td class="px-2 py-1 text-slate-500">{{ c.proto }}</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="g in groups.slice(0, 500)" :key="g.peer" class="border-t border-slate-800/60 hover:bg-slate-900/60">
            <td class="px-2 py-1 font-mono" :class="isLocal(g.peer) ? 'text-slate-500' : 'text-slate-200'">
              <button class="hover:text-sky-300" :class="isMine(g.peer) && 'text-amber-300'" @click="query = g.peer; grouped = false">{{ showIp(g.peer) }}</button>
            </td>
            <td class="px-2 py-1 text-slate-200 tabular-nums">{{ g.count }}</td>
            <td class="px-2 py-1 font-mono text-slate-400">{{ [...g.ports].map(portLabel).join(', ') }}</td>
            <td class="px-2 py-1 text-slate-400">{{ [...g.processes].join(', ') || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!filtered.length" class="px-3 py-4 text-center text-[11px] text-slate-500">No connections match.</p>
      <p v-else-if="filtered.length > 500" class="px-3 py-1.5 text-center text-[10px] text-slate-600">Showing the first 500 — narrow it with search.</p>
    </div>
    <p class="mt-1 text-[10px] text-slate-600">
      Grey addresses are local/private (this server, Docker, your LAN). TIME-WAIT rows are connections that just closed.
    </p>
  </div>
</template>
