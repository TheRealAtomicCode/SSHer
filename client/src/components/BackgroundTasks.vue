<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { activeCount, cancel, dismiss, isActive, tasks, type Task } from '../backgroundTasks';

const collapsed = ref(false);
const cancelling = ref<Set<string>>(new Set());

// Ticks the elapsed-time labels.
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => clearInterval(tick));

function elapsed(task: Task): string {
  const s = Math.max(0, Math.round((now.value - task.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function stageText(task: Task): string {
  switch (task.stage) {
    case 'uploading':
      return 'Uploading to SSHer';
    case 'waiting':
      return 'Sent — waiting for it to reach SSHer';
    case 'copying':
      return 'Copying to the server';
    case 'processing':
      return `Running ${task.processing || 'on the server'}`;
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return task.error || 'Failed';
  }
}

async function stop(task: Task) {
  const what = task.stage === 'processing' ? `stop ${task.processing || 'it'} on the server` : 'stop the upload';
  if (!confirm(`Cancel "${task.label}"?\n\nThis will ${what}. Temporary files are removed.`)) return;
  cancelling.value = new Set(cancelling.value).add(task.id);
  try {
    await cancel(task.id);
  } finally {
    const next = new Set(cancelling.value);
    next.delete(task.id);
    cancelling.value = next;
  }
}
</script>

<template>
  <div v-if="tasks.length" class="fixed bottom-4 left-4 z-[55] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
    <button class="flex w-full items-center gap-2 border-b border-slate-800 px-3 py-2 text-left text-xs font-medium text-slate-300 hover:bg-slate-800" @click="collapsed = !collapsed">
      <v-icon :name="activeCount ? 'fa-spinner' : 'fa-check'" scale="0.7" :class="activeCount ? 'animate-spin text-emerald-400' : 'text-emerald-400'" />
      <span class="flex-1">
        {{ activeCount ? `${activeCount} task${activeCount === 1 ? '' : 's'} running` : 'Background tasks' }}
      </span>
      <v-icon name="fa-chevron-right" scale="0.6" class="transition-transform" :class="!collapsed && 'rotate-90'" />
    </button>

    <ul v-if="!collapsed" class="max-h-72 divide-y divide-slate-800 overflow-auto">
      <li v-for="task in tasks" :key="task.id" class="px-3 py-2.5">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-white" :title="task.label">{{ task.label }}</p>
            <p
              class="truncate text-[11px]"
              :class="{
                'text-slate-400': isActive(task),
                'text-emerald-400': task.stage === 'done',
                'text-amber-300': task.stage === 'cancelled',
                'text-red-400': task.stage === 'error',
              }"
              :title="stageText(task)"
            >
              {{ stageText(task) }}<template v-if="isActive(task)"> · {{ elapsed(task) }}</template>
            </p>
          </div>
          <span v-if="isActive(task) && task.percent !== null" class="mt-0.5 text-[11px] text-slate-400 tabular-nums">{{ task.percent }}%</span>
          <button
            v-if="isActive(task)"
            class="rounded-md p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
            title="Cancel — stops it on the server too"
            :disabled="cancelling.has(task.id)"
            @click="stop(task)"
          >
            <v-icon :name="cancelling.has(task.id) ? 'fa-spinner' : 'fa-times'" scale="0.75" :class="cancelling.has(task.id) && 'animate-spin'" />
          </button>
          <button v-else class="rounded-md p-1 text-slate-500 hover:bg-slate-800 hover:text-white" title="Dismiss" @click="dismiss(task.id)">
            <v-icon name="fa-times" scale="0.7" />
          </button>
        </div>
        <div v-if="isActive(task)" class="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
          <div
            class="h-full rounded-full bg-emerald-500 transition-all"
            :class="task.percent === null && 'w-full animate-pulse opacity-60'"
            :style="task.percent !== null ? { width: `${task.percent}%` } : undefined"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
