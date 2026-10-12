<script setup lang="ts">
import { computed, ref } from 'vue';
import { copyToClipboard } from '../files';
import { notify } from '../toast';
import type { Shortcut } from '../types';

const props = defineProps<{ shortcuts: Shortcut[] }>();
const emit = defineEmits<{
  open: [Shortcut];
  edit: [Shortcut];
  remove: [Shortcut];
  add: [];
  reorder: [Shortcut[]];
}>();

const query = ref('');
const dragId = ref<string | null>(null);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.shortcuts;
  return props.shortcuts.filter((s) =>
    [s.name, s.path, s.description].some((v) => v.toLowerCase().includes(q)),
  );
});

async function copy(s: Shortcut) {
  await copyToClipboard(s.path);
  notify(`Copied “${s.path}”`);
}

/** Drag a card onto another to reorder. */
function dropOn(target: Shortcut) {
  const from = props.shortcuts.findIndex((s) => s.id === dragId.value);
  const to = props.shortcuts.findIndex((s) => s.id === target.id);
  dragId.value = null;
  if (from < 0 || to < 0 || from === to) return;
  const next = [...props.shortcuts];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  emit('reorder', next);
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-5xl">
      <div class="mb-6 flex flex-wrap items-end gap-3">
        <div class="flex-1">
          <h1 class="flex items-center gap-2 text-xl font-semibold text-white">
            <v-icon name="fa-star" class="text-amber-300" /> Shortcuts
          </h1>
          <p class="text-sm text-slate-500">
            Jump straight to files and folders you use often. Saved per server in this browser.
          </p>
        </div>
        <div class="relative">
          <v-icon
            name="fa-search"
            scale="0.7"
            class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
          />
          <input
            v-model="query"
            placeholder="Filter…"
            class="w-56 rounded-lg border border-slate-700 bg-slate-900 py-2 pr-3 pl-8 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
        </div>
        <button
          class="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
          @click="emit('add')"
        >
          <v-icon name="fa-plus" scale="0.75" /> New shortcut
        </button>
      </div>

      <div
        v-if="!shortcuts.length"
        class="rounded-2xl border border-dashed border-slate-800 p-12 text-center"
      >
        <v-icon name="fa-star" scale="2" class="text-slate-700" />
        <p class="mt-3 text-sm text-slate-300">No shortcuts yet</p>
        <p class="mt-1 text-xs text-slate-500">
          In the File Explorer, right-click a file or folder → <b>Add to shortcuts</b>, or press
          <kbd class="rounded bg-slate-800 px-1">Ctrl+D</kbd>.
        </p>
      </div>

      <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="s in filtered"
          :key="s.id"
          draggable="true"
          class="group relative flex cursor-pointer flex-col rounded-xl border bg-slate-900/60 p-4 transition hover:bg-slate-900"
          :class="dragId === s.id ? 'border-emerald-500 opacity-50' : 'border-slate-800 hover:border-amber-400/40'"
          @click="emit('open', s)"
          @dragstart="dragId = s.id"
          @dragend="dragId = null"
          @dragover.prevent
          @drop.prevent="dropOn(s)"
        >
          <div class="flex items-start gap-3">
            <div
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
              :class="s.isDirectory ? 'bg-amber-500/10 text-amber-300' : 'bg-sky-500/10 text-sky-300'"
            >
              <v-icon :name="s.isDirectory ? 'fa-folder' : 'fa-file-alt'" />
            </div>
            <div class="min-w-0 flex-1 pr-14">
              <p class="truncate font-medium text-white">{{ s.name }}</p>
              <p class="truncate font-mono text-xs text-slate-500" :title="s.path">{{ s.path }}</p>
            </div>
          </div>
          <p v-if="s.description" class="mt-3 line-clamp-3 text-xs leading-relaxed text-slate-400">
            {{ s.description }}
          </p>

          <div
            class="absolute top-2 right-2 flex gap-0.5 opacity-0 transition group-hover:opacity-100"
            @click.stop
          >
            <button
              title="Copy path"
              class="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
              @click="copy(s)"
            >
              <v-icon name="fa-clipboard" scale="0.65" />
            </button>
            <button
              title="Edit"
              class="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
              @click="emit('edit', s)"
            >
              <v-icon name="fa-pen" scale="0.65" />
            </button>
            <button
              title="Remove"
              class="rounded p-1.5 text-slate-500 hover:bg-red-950 hover:text-red-400"
              @click="emit('remove', s)"
            >
              <v-icon name="fa-trash-alt" scale="0.65" />
            </button>
          </div>
        </div>
      </div>
      <p v-if="shortcuts.length > 1" class="mt-4 text-center text-xs text-slate-600">
        Drag cards to reorder.
      </p>
    </div>
  </div>
</template>
