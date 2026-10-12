<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { copyToClipboard } from '../files';
import { fail, notify } from '../toast';

const props = defineProps<{ container: string; compact?: boolean }>();

const raw = ref('');
const loading = ref(false);
const tail = ref(300);
const follow = ref(false);
const query = ref('');
const problemsOnly = ref(false);
const wrap = ref(true);
const box = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

// What a line's severity looks like across nginx, .NET, Node and most other servers.
const ERROR = /\b(emerg|alert|crit|error|err|fatal|panic|fail(ed|ure)?|exception|unhandled|refused|denied|not found|cannot|can't)\b|\[(emerg|error|crit)\]|^\s*at\s+\S+\(/i;
const WARN = /\b(warn(ing)?|deprecated|retry(ing)?|timeout|timed out)\b/i;

/** The same command, so it can be pasted into an SSH terminal. */
const command = computed(() => `docker logs --tail ${tail.value} --timestamps ${props.container}`);

const lines = computed(() =>
  raw.value
    .split('\n')
    .filter((l) => l.length)
    .map((l) => {
      // --timestamps prefixes RFC3339 time; split it off so it can be dimmed.
      const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z?\s(.*)$/.exec(l);
      const text = m ? m[3] : l;
      const level = ERROR.test(text) ? 'error' : WARN.test(text) ? 'warn' : '';
      return { time: m ? m[1].replace('T', ' ') : '', text, level };
    }),
);

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return lines.value.filter(
    (l) => (!problemsOnly.value || l.level) && (!q || l.text.toLowerCase().includes(q)),
  );
});

const problemCount = computed(() => lines.value.filter((l) => l.level === 'error').length);

async function load() {
  if (!props.container) return;
  loading.value = true;
  const atBottom = box.value
    ? box.value.scrollHeight - box.value.scrollTop - box.value.clientHeight < 40
    : true;
  try {
    raw.value = (await api.dockerLogs(props.container, tail.value)).logs;
    // Keep the newest line in view, unless the user has scrolled up to read.
    if (atBottom) {
      await nextTick();
      if (box.value) box.value.scrollTop = box.value.scrollHeight;
    }
  } catch (err) {
    fail(err);
    follow.value = false;
  } finally {
    loading.value = false;
  }
}

async function copyCommand() {
  await copyToClipboard(command.value);
  notify('Command copied — paste it in an SSH terminal on the server');
}

async function copyLogs() {
  await copyToClipboard(visible.value.map((l) => `${l.time} ${l.text}`.trim()).join('\n'));
  notify(`Copied ${visible.value.length} lines`);
}

watch(
  () => props.container,
  () => {
    raw.value = '';
    load();
  },
  { immediate: true },
);
watch(tail, load);
watch(follow, (on) => {
  clearInterval(timer);
  if (on) timer = setInterval(load, 3000);
});
onUnmounted(() => clearInterval(timer));

const ctl = 'rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500 hover:text-white';
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <button :class="ctl" title="Reload" @click="load">
        <v-icon name="fa-sync-alt" scale="0.6" :class="loading && 'animate-spin'" /> Reload
      </button>
      <label :class="[ctl, 'flex cursor-pointer items-center gap-1.5', follow && 'border-sky-600 text-sky-300']">
        <input v-model="follow" type="checkbox" class="accent-sky-500" /> Follow
      </label>
      <select v-model.number="tail" :class="[ctl, 'bg-slate-900']" title="How many of the newest lines to fetch">
        <option :value="100">last 100</option>
        <option :value="300">last 300</option>
        <option :value="1000">last 1000</option>
        <option :value="5000">last 5000</option>
      </select>
      <button
        :class="[ctl, problemsOnly && 'border-red-700 text-red-300']"
        title="Show only lines that look like errors or warnings"
        @click="problemsOnly = !problemsOnly"
      >
        <v-icon name="fa-exclamation-triangle" scale="0.55" /> Problems
        <span v-if="problemCount" class="ml-0.5 rounded-full bg-red-900/70 px-1.5 text-red-200">{{ problemCount }}</span>
      </button>
      <button :class="[ctl, !wrap && 'border-slate-500']" title="Wrap long lines" @click="wrap = !wrap">
        {{ wrap ? 'Wrap' : 'No wrap' }}
      </button>
      <div class="relative min-w-32 flex-1">
        <v-icon name="fa-search" scale="0.55" class="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
        <input
          v-model="query"
          placeholder="Search logs…"
          class="w-full rounded-md border border-slate-700 bg-slate-950 py-1 pr-2 pl-6 text-[11px] text-slate-100 focus:border-sky-500 focus:outline-none"
        />
      </div>
      <button :class="ctl" title="Copy the visible lines" @click="copyLogs">
        <v-icon name="fa-copy" scale="0.6" />
      </button>
    </div>

    <!-- The command, so the same check can be done by hand in a terminal. -->
    <button
      v-if="!compact"
      class="mb-2 flex items-center gap-2 self-start rounded-md bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-400 hover:text-white"
      title="Copy this command"
      @click="copyCommand"
    >
      <span class="text-emerald-500">$</span> {{ command }}
      <v-icon name="fa-clipboard" scale="0.55" />
    </button>

    <div
      ref="box"
      class="min-h-0 flex-1 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[11px] leading-relaxed"
    >
      <p v-if="!lines.length" class="p-2 text-slate-600">{{ loading ? 'Loading…' : 'No output yet.' }}</p>
      <p v-else-if="!visible.length" class="p-2 text-slate-600">No lines match.</p>
      <div
        v-for="(l, i) in visible"
        :key="i"
        class="flex gap-3 rounded px-1"
        :class="[
          l.level === 'error' ? 'bg-red-950/40 text-red-300' : l.level === 'warn' ? 'text-amber-300' : 'text-slate-300',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
        ]"
      >
        <span v-if="l.time" class="shrink-0 text-slate-600 select-none">{{ l.time.slice(11) }}</span>
        <span>{{ l.text }}</span>
      </div>
    </div>
  </div>
</template>
