<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Shortcut } from '../types';

const props = defineProps<{ draft: Partial<Shortcut> }>();
const emit = defineEmits<{ save: [Shortcut]; close: [] }>();

const name = ref(props.draft.name ?? '');
const path = ref(props.draft.path ?? '');
const description = ref(props.draft.description ?? '');
const isDirectory = ref(props.draft.isDirectory ?? true);
const nameInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  nameInput.value?.focus();
  nameInput.value?.select();
});

function submit() {
  const cleanPath = path.value.trim().replace(/(.)\/+$/, '$1');
  if (!name.value.trim() || !cleanPath) return;
  emit('save', {
    // Not crypto.randomUUID: that is missing when the app is served over plain http.
    id: props.draft.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: props.draft.createdAt ?? Date.now(),
    name: name.value.trim(),
    path: cleanPath,
    description: description.value.trim(),
    isDirectory: isDirectory.value,
  });
}

const field =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none';
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <form
      class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
      @submit.prevent="submit"
      @keydown.esc="emit('close')"
    >
      <h2 class="mb-4 flex items-center gap-2 text-base font-semibold text-white">
        <v-icon name="fa-star" class="text-amber-300" />
        {{ draft.id ? 'Edit shortcut' : 'New shortcut' }}
      </h2>

      <div class="space-y-4">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-slate-400">Name</label>
          <input ref="nameInput" v-model="name" required placeholder="nginx config" :class="field" />
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-slate-400">Path on the server</label>
          <input v-model="path" required placeholder="/etc/nginx/sites-enabled" :class="[field, 'font-mono']" />
          <div class="mt-2 flex gap-1 rounded-lg border border-slate-800 p-0.5 text-xs">
            <button
              type="button"
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition"
              :class="isDirectory ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
              @click="isDirectory = true"
            >
              <v-icon name="fa-folder" scale="0.7" /> Folder
            </button>
            <button
              type="button"
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition"
              :class="!isDirectory ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
              @click="isDirectory = false"
            >
              <v-icon name="fa-file-alt" scale="0.7" /> File
            </button>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-slate-400">
            Description <span class="text-slate-600">(optional)</span>
          </label>
          <textarea
            v-model="description"
            rows="3"
            placeholder="What is here and why you come back to it"
            :class="[field, 'resize-none']"
          />
        </div>
      </div>

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
          {{ draft.id ? 'Save' : 'Add shortcut' }}
        </button>
      </div>
    </form>
  </div>
</template>
