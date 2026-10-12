<script setup lang="ts">
import { ref, watch } from 'vue';
import CommandLogList from './CommandLogList.vue';
import TerminalPane from './TerminalPane.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// Created the first time the dock is opened, then left alone — closing the
// dock only hides it (v-show below), it doesn't kill the shell, the same way
// minimizing a terminal app doesn't end your session.
const everOpened = ref(false);
watch(() => props.open, (open) => { if (open) everOpened.value = true; }, { immediate: true });
</script>

<template>
  <div
    v-show="open"
    class="fixed inset-x-0 bottom-0 z-40 flex h-[40vh] flex-col border-t border-slate-800 bg-slate-950 shadow-2xl"
  >
    <div class="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-1.5">
      <v-icon name="fa-terminal" scale="0.8" class="text-emerald-400" />
      <h2 class="text-xs font-semibold text-white">Terminal</h2>
      <div class="flex-1" />
      <button class="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white" title="Hide (keeps the shell running)" @click="emit('close')">
        <v-icon name="fa-times" scale="0.75" />
      </button>
    </div>
    <div class="grid min-h-0 flex-1 grid-cols-2 divide-x divide-slate-800">
      <template v-if="everOpened">
        <TerminalPane />
        <CommandLogList :active="open" />
      </template>
    </div>
  </div>
</template>
