<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { fail } from '../toast';
import type { Container } from '../types';
import LogViewer from './LogViewer.vue';

const props = defineProps<{ initial?: string }>();
const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean }] }>();

const containers = ref<Container[]>([]);
const loading = ref(true);
const available = ref(true);
const selected = ref(props.initial ?? '');

/** A restart policy keeps bringing a crashing container back — its logs say why it died. */
const crashing = (c: Container) => c.state === 'restarting' || (c.state === 'exited' && c.restartPolicy !== 'no');

const sorted = computed(() =>
  [...containers.value].sort(
    (a, b) => Number(crashing(b)) - Number(crashing(a)) || a.name.localeCompare(b.name),
  ),
);
const current = computed(() => containers.value.find((c) => c.name === selected.value) ?? null);

async function refresh() {
  loading.value = true;
  try {
    const res = await api.dockerContainers();
    available.value = res.available;
    containers.value = res.containers;
    if (!selected.value || !res.containers.some((c) => c.name === selected.value)) {
      // Start on the one most likely to need attention.
      selected.value = (res.containers.find(crashing) ?? res.containers[0])?.name ?? '';
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

function tone(c: Container) {
  if (crashing(c)) return 'bg-red-400 animate-pulse';
  if (c.running) return 'bg-emerald-400';
  return 'bg-slate-600';
}

onMounted(refresh);
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- Containers -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
      <div class="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <v-icon name="fa-terminal" class="text-sky-400" />
        <h1 class="flex-1 text-sm font-semibold text-white">Container logs</h1>
        <button class="rounded p-1 text-slate-400 hover:text-white" title="Refresh list" @click="refresh">
          <v-icon name="fa-sync-alt" scale="0.7" :class="loading && 'animate-spin'" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-2">
        <p v-if="!available" class="p-2 text-xs text-amber-300">Docker isn't available on this server.</p>
        <p v-else-if="!loading && !containers.length" class="p-2 text-xs text-slate-500">No containers.</p>
        <button
          v-for="c in sorted"
          :key="c.id"
          class="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition"
          :class="selected === c.name ? 'bg-sky-500/10' : 'hover:bg-slate-800'"
          @click="selected = c.name"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" :class="tone(c)" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm" :class="selected === c.name ? 'text-sky-200' : 'text-slate-200'">
              {{ c.compose?.service || c.name }}
            </span>
            <span class="block truncate text-[10px] text-slate-500">
              {{ c.compose?.project ?? 'standalone' }} · {{ c.state }}
            </span>
          </span>
          <span v-if="crashing(c)" class="rounded bg-red-900/60 px-1.5 text-[9px] font-semibold text-red-200">CRASHING</span>
        </button>
      </div>
    </aside>

    <!-- Logs -->
    <section class="flex min-w-0 flex-1 flex-col p-4">
      <template v-if="current">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <p class="font-mono text-sm text-white">{{ current.name }}</p>
          <span class="text-xs text-slate-500">{{ current.image }}</span>
        </div>

        <div
          v-if="crashing(current)"
          class="mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200"
        >
          <b>This container keeps crashing.</b> Its restart policy ({{ current.restartPolicy }}) starts it again
          every few seconds, so the same lines repeat. Read the last red line before each
          <span class="font-mono">Configuration complete</span> / startup message — that is why it died.
          Turn on <b>Problems</b> to see only those lines.
        </div>

        <LogViewer
          :key="current.name"
          :container="current.name"
          class="min-h-0 flex-1"
          @open-path="emit('openPath', $event)"
        />
      </template>
      <p v-else-if="!loading" class="m-auto text-sm text-slate-500">Pick a container on the left.</p>
    </section>
  </div>
</template>
