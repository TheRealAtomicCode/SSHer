<script setup lang="ts">
import CommandLogList from './CommandLogList.vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div
    v-if="open"
    class="fixed top-7 right-0 bottom-0 z-40 flex w-[32rem] max-w-[90vw] flex-col border-l border-slate-800 bg-slate-900 shadow-2xl"
  >
    <div class="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2.5">
      <v-icon name="fa-terminal" scale="0.85" class="text-emerald-400" />
      <h2 class="text-sm font-semibold text-white">Activity</h2>
      <div class="flex-1" />
      <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
        <v-icon name="fa-times" scale="0.8" />
      </button>
    </div>
    <CommandLogList :active="open" />
  </div>
</template>
