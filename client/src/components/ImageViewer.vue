<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import type { RemoteFile } from '../types';

const props = defineProps<{ file: RemoteFile }>();
const emit = defineEmits<{
  close: [];
  download: [RemoteFile];
  openAsText: [RemoteFile];
}>();

const error = ref('');
const src = api.fileUrl(props.file.path, true);

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex flex-col bg-slate-950/90 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <header
      class="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5"
    >
      <v-icon name="fa-file-image" class="text-purple-400" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-white">{{ file.name }}</p>
        <p class="truncate font-mono text-xs text-slate-500">{{ file.path }}</p>
      </div>
      <span class="hidden text-xs text-slate-500 sm:block">{{ formatSize(file.size) }}</span>

      <button
        class="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
        @click="emit('openAsText', file)"
      >
        <v-icon name="fa-file-alt" scale="0.8" /> Open as text
      </button>
      <button
        class="flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
        @click="emit('download', file)"
      >
        <v-icon name="fa-download" scale="0.8" /> Download
      </button>
      <button
        title="Close (Esc)"
        class="rounded-md p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="emit('close')"
      >
        <v-icon name="fa-times" scale="0.9" />
      </button>
    </header>

    <div class="flex flex-1 overflow-auto p-4" @click.self="emit('close')">
      <p
        v-if="error"
        class="m-auto rounded-lg border border-red-900/50 bg-red-950/50 px-4 py-3 text-sm text-red-300"
      >
        {{ error }}
      </p>
      <img
        v-else
        :src="src"
        :alt="file.name"
        class="m-auto max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        @error="error = 'Could not load this image.'"
      />
    </div>
  </div>
</template>
