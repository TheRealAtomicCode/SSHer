<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { CompressFormat } from '../types';

const props = defineProps<{
  initialName: string;
  /** Which formats the connected server can actually produce. */
  support: Record<CompressFormat, boolean>;
}>();

const emit = defineEmits<{ submit: [string, CompressFormat]; close: [] }>();

const FORMATS: { format: CompressFormat; label: string; hint: string }[] = [
  { format: 'zip', label: '.zip', hint: 'Opens anywhere — Windows, Mac, Linux' },
  { format: 'tar.gz', label: '.tar.gz', hint: 'Smallest, the Linux/Mac default' },
  { format: 'tar.bz2', label: '.tar.bz2', hint: 'Slower, slightly smaller' },
  { format: 'tar.xz', label: '.tar.xz', hint: 'Slowest, smallest' },
];

const available = FORMATS.filter((f) => props.support[f.format]);

const name = ref(props.initialName);
const format = ref<CompressFormat>(available[0]?.format ?? 'zip');
const input = ref<HTMLInputElement | null>(null);

onMounted(() => input.value?.focus());

function submit() {
  const value = name.value.trim();
  if (value) emit('submit', value, format.value);
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <form
      class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      @submit.prevent="submit"
      @keydown.esc="emit('close')"
    >
      <h2 class="mb-4 flex items-center gap-2 text-base font-semibold text-white">
        <v-icon name="fa-archive" scale="0.85" class="text-amber-300" /> Compress
      </h2>

      <label class="mb-1.5 block text-xs font-medium text-slate-400">Archive name</label>
      <input
        ref="input"
        v-model="name"
        required
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
      />

      <p v-if="!available.length" class="mt-4 text-xs text-amber-300">
        No archive tool (zip/tar) found on this server.
      </p>
      <template v-else>
        <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">Format</label>
        <div class="space-y-1.5">
          <label
            v-for="f in available"
            :key="f.format"
            class="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition"
            :class="format === f.format ? 'border-emerald-600 bg-emerald-500/10 text-white' : 'border-slate-800 text-slate-300 hover:border-slate-600'"
          >
            <input v-model="format" type="radio" :value="f.format" class="accent-emerald-500" />
            <span class="font-mono">{{ f.label }}</span>
            <span class="text-xs text-slate-500">{{ f.hint }}</span>
          </label>
        </div>
      </template>

      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-white"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="submit"
          :disabled="!available.length"
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Compress
        </button>
      </div>
    </form>
  </div>
</template>
