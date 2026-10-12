<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { cdCommand } from '../files';

const props = defineProps<{ path: string; selectionCount: number }>();
const emit = defineEmits<{
  navigate: [string];
  go: [string];
  copyCd: [];
  copyPath: [];
}>();

const editing = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

/** "/var/log" -> [{label:'/', path:'/'}, {label:'var', path:'/var'}, …] */
const crumbs = computed(() => {
  const parts = props.path.split('/').filter(Boolean);
  const items = [{ label: '/', path: '/' }];
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    items.push({ label: part, path: current });
  }
  return items;
});

const command = computed(() => cdCommand(props.path));

async function startEdit() {
  draft.value = props.path;
  editing.value = true;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}

function submit() {
  const value = draft.value;
  editing.value = false;
  emit('go', value);
}

function cancel() {
  editing.value = false;
}

// App focuses the box on Ctrl+L, the way a browser address bar behaves.
defineExpose({ startEdit });

// With a selection, the copy button copies those paths; with none, this folder.
const pathLabel = computed(() =>
  props.selectionCount > 1 ? `Copy ${props.selectionCount} paths` : 'Copy path',
);

const pathTitle = computed(() =>
  props.selectionCount
    ? `Copy the selected item's path${props.selectionCount > 1 ? 's' : ''} to the clipboard`
    : `Copy “${props.path}” to the clipboard`,
);
</script>

<template>
  <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-900/50 px-3 py-2">
    <form v-if="editing" class="min-w-0 flex-1" @submit.prevent="submit">
      <input
        ref="input"
        v-model="draft"
        spellcheck="false"
        autocomplete="off"
        placeholder="Paste or type a path, then press Enter"
        class="w-full rounded-md border border-emerald-600 bg-slate-950 px-2.5 py-1 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
        @keydown.esc.prevent="cancel"
        @blur="cancel"
      />
    </form>

    <!-- Clicking the empty space past the crumbs opens the editor, as in a file manager. -->
    <div
      v-else
      class="flex min-w-0 flex-1 cursor-text items-center overflow-x-auto whitespace-nowrap"
      :title="'Click to edit the path (Ctrl+L)'"
      @click="startEdit"
    >
      <template v-for="(crumb, index) in crumbs" :key="crumb.path">
        <v-icon
          v-if="index > 0"
          name="fa-chevron-right"
          scale="0.5"
          class="mx-0.5 shrink-0 text-slate-600"
        />
        <button
          class="shrink-0 rounded px-1.5 py-1 text-sm transition hover:bg-slate-800"
          :class="index === crumbs.length - 1 ? 'font-medium text-emerald-400' : 'text-slate-400'"
          @click.stop="emit('navigate', crumb.path)"
        >
          <v-icon v-if="index === 0" name="fa-folder-open" scale="0.8" />
          <span v-else>{{ crumb.label }}</span>
        </button>
      </template>
      <span class="flex-1 pl-2 text-xs text-slate-700 select-none">click to edit</span>
    </div>

    <button
      v-if="!editing"
      title="Edit path (Ctrl+L)"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
      @click="startEdit"
    >
      <v-icon name="fa-edit" scale="0.8" />
      <span class="hidden sm:inline">Go to path</span>
    </button>

    <button
      :title="pathTitle"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs transition hover:border-emerald-600 hover:text-emerald-400"
      :class="selectionCount ? 'text-emerald-400' : 'text-slate-300'"
      @click="emit('copyPath')"
    >
      <v-icon name="fa-copy" scale="0.8" />
      <span class="hidden sm:inline">{{ pathLabel }}</span>
    </button>

    <button
      :title="`Copy “${command}” to clipboard`"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-600 hover:text-emerald-400"
      @click="emit('copyCd')"
    >
      <v-icon name="fa-clipboard" scale="0.8" />
      <span class="hidden sm:inline">Copy cd</span>
    </button>
  </div>
</template>
