<script setup lang="ts">
import type { StepResult } from '../types';

defineProps<{ title: string; steps: StepResult[]; running?: boolean; error?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    @click.self="!running && emit('close')"
  >
    <div class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
      <div class="flex items-center gap-2 border-b border-slate-800 px-5 py-3">
        <v-icon
          :name="running ? 'fa-spinner' : error ? 'fa-times-circle' : 'fa-check-circle'"
          :class="running ? 'animate-spin text-sky-400' : error ? 'text-red-400' : 'text-emerald-400'"
        />
        <h2 class="flex-1 font-semibold text-white">{{ title }}</h2>
        <button
          v-if="!running"
          class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          @click="emit('close')"
        >
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>
      <div class="min-h-0 flex-1 space-y-2 overflow-auto p-4">
        <p v-if="running && !steps.length" class="text-sm text-slate-400">
          Working on the server… this can take a minute when images are being pulled.
        </p>
        <details
          v-for="(step, i) in steps"
          :key="i"
          :open="!step.ok || i === steps.length - 1"
          class="rounded-lg border bg-slate-950/50"
          :class="step.ok ? 'border-slate-800' : 'border-red-900'"
        >
          <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <v-icon
              :name="step.ok ? 'fa-check' : 'fa-times'"
              scale="0.7"
              :class="step.ok ? 'text-emerald-400' : 'text-red-400'"
            />
            <span :class="step.ok ? 'text-slate-200' : 'text-red-300'">{{ step.title }}</span>
          </summary>
          <pre
            v-if="step.output"
            class="max-h-64 overflow-auto border-t border-slate-800 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400"
            >{{ step.output }}</pre
          >
        </details>
        <p
          v-if="error && !running"
          class="rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm whitespace-pre-wrap text-red-300"
        >
          {{ error }}
        </p>
        <slot />
      </div>
    </div>
  </div>
</template>
