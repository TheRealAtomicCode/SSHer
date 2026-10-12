<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { copyToClipboard } from '../files';
import { notify } from '../toast';
import type { CommandLogEntry } from '../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const entries = ref<CommandLogEntry[]>([]);
const loading = ref(false);
const follow = ref(true);
const query = ref('');
const box = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

const newestFirst = computed(() => [...entries.value].reverse());
const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? newestFirst.value.filter((e) => e.command.toLowerCase().includes(q)) : newestFirst.value;
});

async function load() {
  loading.value = true;
  try {
    entries.value = (await api.commandLog()).entries;
  } catch {
    // Quiet — this is a convenience panel, not a page of its own.
  } finally {
    loading.value = false;
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

async function copyCommand(entry: CommandLogEntry) {
  await copyToClipboard(entry.command);
  notify('Copied');
}

function syncPolling() {
  clearInterval(timer);
  if (props.open && follow.value) timer = setInterval(load, 2000);
}

watch(
  () => props.open,
  (open) => {
    if (open) load();
    syncPolling();
  },
  { immediate: true },
);
watch(follow, syncPolling);
onUnmounted(() => clearInterval(timer));

const ctl = 'rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500 hover:text-white';
</script>

<template>
  <div
    v-if="open"
    class="fixed top-7 right-0 bottom-0 z-40 flex w-[32rem] max-w-[90vw] flex-col border-l border-slate-800 bg-slate-900 shadow-2xl"
  >
    <div class="flex items-center gap-2 border-b border-slate-800 px-3 py-2.5">
      <v-icon name="fa-terminal" scale="0.85" class="text-emerald-400" />
      <h2 class="text-sm font-semibold text-white">Activity</h2>
      <span class="text-xs text-slate-500">{{ entries.length }} commands this session</span>
      <div class="flex-1" />
      <label :class="[ctl, 'flex cursor-pointer items-center gap-1.5', follow && 'border-emerald-600 text-emerald-300']">
        <input v-model="follow" type="checkbox" class="accent-emerald-500" /> Follow
      </label>
      <button :class="ctl" title="Refresh" @click="load">
        <v-icon name="fa-sync-alt" scale="0.6" :class="loading && 'animate-spin'" />
      </button>
      <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
        <v-icon name="fa-times" scale="0.8" />
      </button>
    </div>

    <div class="border-b border-slate-800 px-3 py-2">
      <div class="relative">
        <v-icon name="fa-search" scale="0.55" class="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
        <input
          v-model="query"
          placeholder="Filter commands…"
          class="w-full rounded-md border border-slate-700 bg-slate-950 py-1.5 pr-2 pl-6 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
        />
      </div>
    </div>

    <div ref="box" class="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
      <p v-if="!entries.length && !loading" class="p-3 text-slate-600">
        Nothing yet — every shell command any button here runs will show up live.
      </p>
      <p v-else-if="!visible.length" class="p-3 text-slate-600">No commands match.</p>
      <div
        v-for="e in visible"
        :key="e.id"
        class="group flex items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-950/60"
      >
        <span class="shrink-0 text-slate-600 select-none">{{ formatTime(e.time) }}</span>
        <span
          class="shrink-0 rounded px-1 text-center select-none"
          :class="e.code === null ? 'bg-slate-800 text-slate-400' : e.code === 0 ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/50 text-red-300'"
          :title="e.code === null ? 'No exit code (connection error)' : `exit ${e.code}`"
        >
          {{ e.code === null ? '?' : e.code }}
        </span>
        <span class="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap text-slate-300">{{ e.command }}</span>
        <button
          class="shrink-0 text-slate-600 opacity-0 group-hover:opacity-100 hover:text-white"
          title="Copy this command"
          @click="copyCommand(e)"
        >
          <v-icon name="fa-copy" scale="0.6" />
        </button>
      </div>
    </div>
  </div>
</template>
