<script setup lang="ts">
import { onMounted, ref } from 'vue';

const props = defineProps<{
  title: string;
  label: string;
  initial: string;
  confirmText: string;
}>();

const emit = defineEmits<{ submit: [string]; close: [] }>();

const value = ref(props.initial);
const input = ref<HTMLInputElement | null>(null);

onMounted(() => {
  input.value?.focus();
  // Preselect the basename so a rename does not clobber the extension.
  const dot = props.initial.lastIndexOf('.');
  input.value?.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
});

function submit() {
  const next = value.value.trim();
  if (next) emit('submit', next);
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
      <h2 class="mb-4 text-base font-semibold text-white">{{ title }}</h2>
      <label class="mb-1.5 block text-xs font-medium text-slate-400">{{ label }}</label>
      <input
        ref="input"
        v-model="value"
        required
        class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
      />
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
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
        >
          {{ confirmText }}
        </button>
      </div>
    </form>
  </div>
</template>
