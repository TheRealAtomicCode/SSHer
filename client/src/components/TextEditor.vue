<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { LANG_LABEL, highlight, languageOf } from '../highlight';
import { highlightEnabled, setHighlightEnabled } from '../prefs';
import type { RemoteFile } from '../types';

const props = defineProps<{ file: RemoteFile }>();
const emit = defineEmits<{ close: []; saved: []; download: [RemoteFile] }>();

const loading = ref(true);
const error = ref('');
const content = ref('');
const original = ref('');
const truncated = ref(false);
const binary = ref(false);
const saving = ref(false);
const showHighlight = ref(highlightEnabled());

const editor = ref<HTMLTextAreaElement | null>(null);
const overlay = ref<HTMLPreElement | null>(null);

const lang = computed(() => languageOf(props.file.name));
const dirty = computed(() => content.value !== original.value);

// Highlighting a huge file on every keystroke would stutter, so it is capped.
const TOO_BIG_TO_HIGHLIGHT = 400_000;
const highlightable = computed(() => content.value.length <= TOO_BIG_TO_HIGHLIGHT);
const painted = computed(() =>
  showHighlight.value && highlightable.value ? highlight(content.value, lang.value) : '',
);

/** Saving a partially-read file would truncate the rest of it on the server. */
const readOnly = computed(() => truncated.value || binary.value);

const lineCount = computed(() => content.value.split('\n').length);

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  try {
    const result = await api.readText(props.file.path);
    content.value = result.content;
    original.value = result.content;
    truncated.value = result.truncated;
    binary.value = result.binary;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => window.removeEventListener('keydown', onKey));

function onKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
    return;
  }
  if (event.key === 'Escape') close();
}

function toggleHighlight() {
  showHighlight.value = !showHighlight.value;
  setHighlightEnabled(showHighlight.value);
}

/** The overlay sits behind the textarea; it has to scroll with it. */
function syncScroll() {
  if (!editor.value || !overlay.value) return;
  overlay.value.scrollTop = editor.value.scrollTop;
  overlay.value.scrollLeft = editor.value.scrollLeft;
}

/** Tab should indent, not tab away to the next control. */
function onTab(event: KeyboardEvent) {
  const area = editor.value;
  if (!area) return;
  event.preventDefault();
  const { selectionStart: start, selectionEnd: end } = area;
  content.value = `${content.value.slice(0, start)}  ${content.value.slice(end)}`;
  requestAnimationFrame(() => area.setSelectionRange(start + 2, start + 2));
}

async function save() {
  if (readOnly.value || !dirty.value || saving.value) return;
  saving.value = true;
  try {
    await api.saveText(props.file.path, content.value);
    original.value = content.value;
    emit('saved');
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

function close() {
  if (dirty.value && !confirm('Discard unsaved changes?')) return;
  emit('close');
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex flex-col bg-slate-950">
    <header
      class="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5"
    >
      <v-icon name="fa-file-code" class="text-emerald-400" />
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-2 truncate text-sm font-medium text-white">
          {{ file.name }}
          <span v-if="dirty" class="text-xs font-normal text-amber-400">• unsaved</span>
        </p>
        <p class="truncate font-mono text-xs text-slate-500">{{ file.path }}</p>
      </div>

      <span class="hidden text-xs text-slate-500 lg:block">
        {{ lineCount }} lines · {{ formatSize(file.size) }}
      </span>

      <button
        :title="highlightable ? 'Toggle syntax highlighting' : 'File is too large to highlight'"
        :disabled="!highlightable"
        class="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          showHighlight && highlightable
            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-400'
            : 'border-slate-700 text-slate-400 hover:text-white'
        "
        @click="toggleHighlight"
      >
        <span
          class="relative h-3.5 w-6 rounded-full transition"
          :class="showHighlight && highlightable ? 'bg-emerald-500' : 'bg-slate-600'"
        >
          <span
            class="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all"
            :class="showHighlight && highlightable ? 'left-3' : 'left-0.5'"
          />
        </span>
        Highlight
        <span class="hidden font-mono text-slate-500 xl:inline">{{ LANG_LABEL[lang] }}</span>
      </button>

      <button
        :disabled="!dirty || saving || readOnly"
        class="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        @click="save"
      >
        <v-icon v-if="saving" name="fa-spinner" class="animate-spin" scale="0.8" />
        <v-icon v-else name="fa-check" scale="0.8" />
        {{ saving ? 'Saving…' : 'Save' }}
      </button>

      <button
        title="Download"
        class="rounded-md p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="emit('download', file)"
      >
        <v-icon name="fa-download" scale="0.9" />
      </button>
      <button
        title="Close (Esc)"
        class="rounded-md p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="close"
      >
        <v-icon name="fa-times" scale="0.9" />
      </button>
    </header>

    <p
      v-if="readOnly && !loading"
      class="flex shrink-0 items-center gap-2 border-b border-amber-900/50 bg-amber-950/40 px-4 py-2 text-xs text-amber-300"
    >
      <v-icon name="fa-exclamation-triangle" scale="0.75" />
      <span v-if="binary">
        This looks like a binary file. It is shown read-only so saving cannot corrupt it.
      </span>
      <span v-else>
        Only the first 2 MB of this file was read, so it is read-only — saving would truncate
        the rest.
      </span>
    </p>

    <p
      v-if="error"
      class="flex shrink-0 items-center gap-2 border-b border-red-900/50 bg-red-950/50 px-4 py-2 text-xs text-red-300"
    >
      <v-icon name="fa-exclamation-triangle" scale="0.75" /> {{ error }}
    </p>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <v-icon name="fa-spinner" class="animate-spin text-emerald-400" scale="1.6" />
    </div>

    <!-- The <pre> paints the colours; the transparent <textarea> on top takes the
         typing. Both must share font, padding and wrapping or they drift apart. -->
    <div v-else class="relative min-h-0 flex-1">
      <pre
        v-if="painted"
        ref="overlay"
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 overflow-hidden p-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap"
        v-html="painted"
      />
      <textarea
        ref="editor"
        v-model="content"
        :readonly="readOnly"
        spellcheck="false"
        wrap="soft"
        class="absolute inset-0 h-full w-full resize-none bg-transparent p-4 font-mono text-xs leading-5 break-words whitespace-pre-wrap caret-emerald-400 outline-none"
        :class="painted ? 'text-transparent' : 'text-slate-200'"
        @scroll="syncScroll"
        @keydown.tab="onTab"
      />
    </div>

    <footer
      class="flex shrink-0 items-center justify-between border-t border-slate-800 bg-slate-900 px-4 py-1.5 text-xs text-slate-500"
    >
      <span>{{ readOnly ? 'Read-only' : 'Ctrl+S to save · Esc to close' }}</span>
      <span class="font-mono">{{ lang }}</span>
    </footer>
  </div>
</template>
