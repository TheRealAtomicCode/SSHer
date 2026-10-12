<script setup lang="ts">
import { ref } from 'vue';
import type { UploadItem } from '../api';
import { itemsFromDrop, itemsFromInput } from '../dnd';

defineProps<{ dest: string; busy: boolean; progress: number }>();

const emit = defineEmits<{
  close: [];
  'update:dest': [string];
  upload: [UploadItem[]];
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const hovering = ref(false);

async function onDrop(event: DragEvent) {
  hovering.value = false;
  if (!event.dataTransfer) return;
  emit('upload', await itemsFromDrop(event.dataTransfer));
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) emit('upload', itemsFromInput(input.files));
  input.value = '';
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-base font-semibold text-white">
          <v-icon name="fa-cloud-upload-alt" class="text-emerald-400" /> Upload
        </h2>
        <button
          class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          @click="emit('close')"
        >
          <v-icon name="fa-times" scale="0.9" />
        </button>
      </div>

      <label class="mb-1.5 block text-xs font-medium text-slate-400">Upload directory</label>
      <input
        :value="dest"
        class="mb-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
        @input="emit('update:dest', ($event.target as HTMLInputElement).value)"
      />

      <div
        class="rounded-xl border-2 border-dashed p-8 text-center transition"
        :class="hovering ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-700'"
        @dragover.prevent="hovering = true"
        @dragleave.prevent="hovering = false"
        @drop.prevent="onDrop"
      >
        <v-icon
          name="fa-cloud-upload-alt"
          scale="2"
          :class="hovering ? 'text-emerald-400' : 'text-slate-600'"
        />
        <p class="mt-3 text-sm text-slate-300">Drag & drop files or folders here</p>
        <p class="mt-1 text-xs text-slate-500">Folder structure is preserved.</p>

        <div class="mt-4 flex justify-center gap-2">
          <button
            class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
            @click="fileInput?.click()"
          >
            Choose files
          </button>
          <button
            class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
            @click="folderInput?.click()"
          >
            Choose folder
          </button>
        </div>

        <input ref="fileInput" type="file" multiple class="hidden" @change="onPick" />
        <!-- webkitdirectory is not in the HTML type defs but is supported everywhere -->
        <input
          ref="folderInput"
          type="file"
          webkitdirectory
          multiple
          class="hidden"
          @change="onPick"
        />
      </div>

      <div v-if="busy" class="mt-4">
        <div class="mb-1.5 flex justify-between text-xs text-slate-400">
          <span>Uploading…</span>
          <span class="tabular-nums">{{ progress }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div
            class="h-full rounded-full bg-emerald-500 transition-all duration-200"
            :style="{ width: `${progress}%` }"
          />
        </div>
      </div>
    </div>
  </div>
</template>
