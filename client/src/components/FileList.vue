<script setup lang="ts">
import { formatDate, formatMode, formatSize, iconColor, iconFor } from '../files';
import type { RemoteFile, ViewMode } from '../types';

defineProps<{
  files: RemoteFile[];
  loading: boolean;
  selected: Set<string>;
  cutPaths: string[];
  view: ViewMode;
}>();

const emit = defineEmits<{
  select: [RemoteFile, MouseEvent];
  open: [RemoteFile];
  menu: [MouseEvent, RemoteFile];
}>();
</script>

<template>
  <div class="relative flex-1 overflow-auto">
    <div
      v-if="loading"
      class="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/60"
    >
      <v-icon name="fa-spinner" class="animate-spin text-emerald-400" scale="1.6" />
    </div>

    <div
      v-if="!files.length && !loading"
      class="flex h-full flex-col items-center justify-center text-slate-600"
    >
      <v-icon name="fa-folder-open" scale="2.4" class="mb-3" />
      <p class="text-sm">This folder is empty</p>
      <p class="mt-1 text-xs">Drop files anywhere to upload</p>
    </div>

    <!-- Grid -->
    <div
      v-else-if="view === 'grid'"
      class="grid grid-cols-[repeat(auto-fill,minmax(116px,1fr))] gap-1.5 p-3"
    >
      <div
        v-for="file in files"
        :key="file.path"
        :title="file.name"
        class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border px-2 py-4 transition select-none"
        :class="[
          selected.has(file.path)
            ? 'border-emerald-500/50 bg-emerald-500/10'
            : 'border-transparent hover:bg-slate-900',
          cutPaths.includes(file.path) ? 'opacity-40' : '',
        ]"
        @click="emit('select', file, $event)"
        @dblclick="emit('open', file)"
        @contextmenu.prevent.stop="emit('menu', $event, file)"
      >
        <v-icon :name="iconFor(file)" :class="iconColor(file)" scale="2.1" />
        <span class="w-full truncate text-center text-xs text-slate-300">{{ file.name }}</span>
        <span class="text-[10px] text-slate-600">
          {{ file.isDirectory ? '—' : formatSize(file.size) }}
        </span>
      </div>
    </div>

    <!-- List -->
    <table v-else class="w-full border-collapse text-sm">
      <thead class="sticky top-0 z-[1] bg-slate-900 text-xs text-slate-500">
        <tr class="border-b border-slate-800">
          <th class="px-3 py-2 text-left font-medium">Name</th>
          <th class="w-24 px-3 py-2 text-right font-medium">Size</th>
          <th class="hidden w-44 px-3 py-2 text-left font-medium md:table-cell">Modified</th>
          <th class="hidden w-28 px-3 py-2 text-left font-mono font-medium lg:table-cell">
            Perms
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="file in files"
          :key="file.path"
          class="cursor-pointer border-b border-slate-900 transition select-none"
          :class="[
            selected.has(file.path) ? 'bg-emerald-500/10' : 'hover:bg-slate-900',
            cutPaths.includes(file.path) ? 'opacity-40' : '',
          ]"
          @click="emit('select', file, $event)"
          @dblclick="emit('open', file)"
          @contextmenu.prevent.stop="emit('menu', $event, file)"
        >
          <td class="px-3 py-2">
            <div class="flex items-center gap-2.5">
              <v-icon :name="iconFor(file)" :class="iconColor(file)" scale="1.05" />
              <span class="truncate text-slate-200">{{ file.name }}</span>
              <span v-if="file.isSymlink" class="text-xs text-slate-500">↗</span>
            </div>
          </td>
          <td class="px-3 py-2 text-right text-slate-500 tabular-nums">
            {{ file.isDirectory ? '—' : formatSize(file.size) }}
          </td>
          <td class="hidden px-3 py-2 text-slate-500 md:table-cell">
            {{ formatDate(file.mtime) }}
          </td>
          <td class="hidden px-3 py-2 font-mono text-xs text-slate-600 lg:table-cell">
            {{ formatMode(file.mode) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
