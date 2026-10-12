<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { appFor, typeLabel } from '../files';
import type { FileApp, RemoteFile } from '../types';

const props = defineProps<{
  x: number;
  y: number;
  file: RemoteFile | null;
  count: number;
  canPaste: boolean;
  /** Whether the single selected file is an archive this server can extract. */
  canExtract: boolean;
}>();

const emit = defineEmits<{
  close: [];
  open: [RemoteFile];
  openWith: [RemoteFile, FileApp];
  copy: [];
  cut: [];
  paste: [];
  rename: [RemoteFile];
  download: [RemoteFile];
  copyPath: [RemoteFile];
  remove: [];
  newFolder: [];
  upload: [];
  shortcut: [RemoteFile | null];
  compress: [];
  extract: [RemoteFile];
}>();

const menu = ref<HTMLElement | null>(null);
const size = ref({ w: 224, h: 360 });
const openWithShown = ref(false);

onMounted(() => {
  if (menu.value) size.value = { w: menu.value.offsetWidth, h: menu.value.offsetHeight };
  // Capture, so that a right-click elsewhere closes this menu *before* the row
  // handler opens the next one — otherwise the two would race and cancel out.
  window.addEventListener('click', onOutside, true);
  window.addEventListener('contextmenu', onOutside, true);
  window.addEventListener('keydown', onKey);
});

onUnmounted(() => {
  window.removeEventListener('click', onOutside, true);
  window.removeEventListener('contextmenu', onOutside, true);
  window.removeEventListener('keydown', onKey);
});

function close() {
  emit('close');
}

/** Clicks inside the menu are handled by the items themselves, which close it. */
function onOutside(event: MouseEvent) {
  if (menu.value?.contains(event.target as Node)) return;
  close();
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}

// Keep the menu inside the viewport when opened near an edge.
const position = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - size.value.w - 8)}px`,
  top: `${Math.min(props.y, window.innerHeight - size.value.h - 8)}px`,
}));

const isFile = computed(() => Boolean(props.file && !props.file.isDirectory));
const many = computed(() => props.count > 1);
const current = computed<FileApp | null>(() => (props.file ? appFor(props.file) : null));

const APPS: { app: FileApp; label: string; icon: string }[] = [
  { app: 'editor', label: 'Text editor', icon: 'fa-file-alt' },
  { app: 'image', label: 'Image viewer', icon: 'fa-file-image' },
  { app: 'download', label: 'Download', icon: 'fa-download' },
];

const item =
  'flex w-full items-center gap-2.5 px-3 py-1.5 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';
</script>

<template>
  <div
    ref="menu"
    class="fixed z-50 w-56 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 text-sm shadow-2xl"
    :style="position"
    @click.stop
    @contextmenu.prevent.stop
  >
    <template v-if="file">
      <p v-if="many" class="px-3 py-1.5 text-xs text-slate-500">{{ count }} items selected</p>

      <button v-if="!many" :class="item" @click="emit('open', file); close()">
        <v-icon :name="file.isDirectory ? 'fa-folder-open' : 'fa-file-alt'" scale="0.8" />
        {{ file.isDirectory ? 'Open' : 'Open' }}
      </button>

      <template v-if="isFile && !many">
        <button :class="item" @click="openWithShown = !openWithShown">
          <v-icon name="fa-file" scale="0.8" />
          <span class="flex-1 text-left">Open with</span>
          <v-icon
            name="fa-chevron-right"
            scale="0.6"
            class="transition-transform"
            :class="openWithShown ? 'rotate-90' : ''"
          />
        </button>

        <div v-if="openWithShown" class="border-y border-slate-800 bg-slate-950/60 py-1">
          <button
            v-for="option in APPS"
            :key="option.app"
            class="flex w-full items-center gap-2.5 py-1.5 pr-3 pl-6 text-slate-300 hover:bg-slate-800"
            @click="emit('openWith', file, option.app); close()"
          >
            <v-icon :name="option.icon" scale="0.75" />
            <span class="flex-1 text-left">{{ option.label }}</span>
            <v-icon
              v-if="current === option.app"
              name="fa-check"
              scale="0.65"
              class="text-emerald-400"
            />
          </button>
          <p class="px-6 pt-1 text-[11px] leading-snug text-slate-600">
            Remembers your choice for {{ typeLabel(file) }} files.
          </p>
        </div>
      </template>

      <div class="my-1 border-t border-slate-800" />

      <button :class="item" @click="emit('copy'); close()">
        <v-icon name="fa-copy" scale="0.8" /> Copy{{ many ? ` ${count} items` : '' }}
        <span class="ml-auto text-xs text-slate-600">Ctrl+C</span>
      </button>
      <button :class="item" @click="emit('cut'); close()">
        <v-icon name="fa-cut" scale="0.8" /> Cut{{ many ? ` ${count} items` : '' }}
        <span class="ml-auto text-xs text-slate-600">Ctrl+X</span>
      </button>
      <button :class="item" :disabled="!canPaste" @click="emit('paste'); close()">
        <v-icon name="fa-paste" scale="0.8" /> Paste
        <span class="ml-auto text-xs text-slate-600">Ctrl+V</span>
      </button>

      <div class="my-1 border-t border-slate-800" />

      <button :class="item" @click="emit('compress'); close()">
        <v-icon name="fa-archive" scale="0.8" /> Compress…{{ many ? ` ${count} items` : '' }}
      </button>
      <button v-if="!many && isFile && canExtract" :class="item" @click="emit('extract', file); close()">
        <v-icon name="fa-box-open" scale="0.8" /> Extract here
      </button>

      <div class="my-1 border-t border-slate-800" />

      <button v-if="!many" :class="item" @click="emit('rename', file); close()">
        <v-icon name="fa-edit" scale="0.8" /> Rename
        <span class="ml-auto text-xs text-slate-600">F2</span>
      </button>
      <button v-if="isFile && !many" :class="item" @click="emit('download', file); close()">
        <v-icon name="fa-download" scale="0.8" /> Download
      </button>
      <button v-if="!many" :class="item" @click="emit('copyPath', file); close()">
        <v-icon name="fa-clipboard" scale="0.8" /> Copy path
      </button>
      <button v-if="!many" :class="item" @click="emit('shortcut', file); close()">
        <v-icon name="fa-star" scale="0.8" class="text-amber-300" /> Add to shortcuts
        <span class="ml-auto text-xs text-slate-600">Ctrl+D</span>
      </button>

      <div class="my-1 border-t border-slate-800" />

      <button
        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-red-400 hover:bg-red-950/50"
        @click="emit('remove'); close()"
      >
        <v-icon name="fa-trash-alt" scale="0.8" /> Delete{{ many ? ` ${count} items` : '' }}
        <span class="ml-auto text-xs text-slate-600">Del</span>
      </button>
    </template>

    <template v-else>
      <button :class="item" :disabled="!canPaste" @click="emit('paste'); close()">
        <v-icon name="fa-paste" scale="0.8" /> Paste
        <span class="ml-auto text-xs text-slate-600">Ctrl+V</span>
      </button>
      <button :class="item" @click="emit('newFolder'); close()">
        <v-icon name="fa-plus" scale="0.8" /> New folder
      </button>
      <button :class="item" @click="emit('upload'); close()">
        <v-icon name="fa-upload" scale="0.8" /> Upload files
      </button>
      <button :class="item" @click="emit('shortcut', null); close()">
        <v-icon name="fa-star" scale="0.8" class="text-amber-300" /> Add this folder to shortcuts
      </button>
    </template>
  </div>
</template>
