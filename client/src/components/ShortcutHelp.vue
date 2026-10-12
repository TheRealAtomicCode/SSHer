<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const emit = defineEmits<{ close: [] }>();

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: 'Selection',
    items: [
      ['Click', 'Select one'],
      ['Ctrl + Click', 'Add / remove one'],
      ['Shift + Click', 'Select a range'],
      ['Ctrl + A', 'Select everything'],
      ['↑ / ↓', 'Move selection'],
      ['Shift + ↑ / ↓', 'Extend selection'],
      ['Esc', 'Clear selection'],
    ],
  },
  {
    title: 'Files',
    items: [
      ['Ctrl + L', 'Go to a path'],
      ['Ctrl + C', 'Copy selection'],
      ['Ctrl + X', 'Cut selection'],
      ['Ctrl + V', 'Paste here'],
      ['Ctrl + Z', 'Undo last change'],
      ['F2', 'Rename'],
      ['Delete', 'Delete (not undoable)'],
      ['Enter / Double-click', 'Open'],
    ],
  },
  {
    title: 'Editor',
    items: [
      ['Ctrl + S', 'Save the file'],
      ['Tab', 'Indent'],
      ['Esc', 'Close'],
    ],
  },
];

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-base font-semibold text-white">
          <v-icon name="fa-keyboard" class="text-emerald-400" /> Keyboard shortcuts
        </h2>
        <button
          class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          @click="emit('close')"
        >
          <v-icon name="fa-times" scale="0.9" />
        </button>
      </div>

      <div class="grid gap-6 sm:grid-cols-3">
        <div v-for="group in GROUPS" :key="group.title">
          <h3 class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            {{ group.title }}
          </h3>
          <ul class="space-y-1.5">
            <li
              v-for="[keys, what] in group.items"
              :key="keys"
              class="flex items-baseline justify-between gap-2 text-xs"
            >
              <span class="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 font-mono text-slate-300">
                {{ keys }}
              </span>
              <span class="text-right text-slate-400">{{ what }}</span>
            </li>
          </ul>
        </div>
      </div>

      <p class="mt-5 border-t border-slate-800 pt-3 text-xs text-slate-600">
        Deleting shells out to <code class="font-mono text-slate-500">rm -rf</code> on the server,
        so it is the one action Ctrl+Z cannot take back.
      </p>
    </div>
  </div>
</template>
