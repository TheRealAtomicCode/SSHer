<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { QuickLink } from '../quicklinks';

const props = defineProps<{
  x: number;
  y: number;
  link: QuickLink;
  /** Whether the server actually has this path — an unknown link can still be renamed. */
  isDir: boolean;
}>();

const emit = defineEmits<{
  close: [];
  open: [QuickLink];
  rename: [QuickLink];
  openInLocation: [QuickLink];
  copyPath: [QuickLink];
  download: [QuickLink];
}>();

const menu = ref<HTMLElement | null>(null);
const size = ref({ w: 208, h: 220 });

onMounted(() => {
  if (menu.value) size.value = { w: menu.value.offsetWidth, h: menu.value.offsetHeight };
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

function onOutside(event: MouseEvent) {
  if (menu.value?.contains(event.target as Node)) return;
  close();
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}

const position = computed(() => ({
  left: `${Math.min(props.x, window.innerWidth - size.value.w - 8)}px`,
  top: `${Math.min(props.y, window.innerHeight - size.value.h - 8)}px`,
}));

const item =
  'flex w-full items-center gap-2.5 px-3 py-1.5 text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';
</script>

<template>
  <div
    ref="menu"
    class="fixed z-50 w-52 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 text-sm shadow-2xl"
    :style="position"
    @click.stop
    @contextmenu.prevent.stop
  >
    <button :class="item" @click="emit('open', link); close()">
      <v-icon :name="isDir ? 'fa-folder-open' : 'fa-file-alt'" scale="0.8" />
      {{ isDir ? 'Open' : 'Open / edit' }}
    </button>
    <button v-if="!isDir" :class="item" @click="emit('download', link); close()">
      <v-icon name="fa-download" scale="0.8" /> Download
    </button>

    <div class="my-1 border-t border-slate-800" />

    <button :class="item" @click="emit('rename', link); close()">
      <v-icon name="fa-edit" scale="0.8" /> Rename
    </button>
    <button :class="item" @click="emit('openInLocation', link); close()">
      <v-icon name="fa-folder-open" scale="0.8" /> Open in File Explorer
    </button>
    <button :class="item" @click="emit('copyPath', link); close()">
      <v-icon name="fa-clipboard" scale="0.8" /> Copy path
    </button>
  </div>
</template>
