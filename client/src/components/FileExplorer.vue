<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import type { UploadItem } from '../api';
import { itemsFromDrop } from '../dnd';
import { appFor, archiveFormat, cdCommand, copyToClipboard, normalizePathInput, typeKey, typeLabel } from '../files';
import * as prefs from '../prefs';
import { fail, notify } from '../toast';
import { newTransferId, watchTransfer } from '../transferProgress';
import type {
  ArchiveSupport,
  Clipboard,
  CompressFormat,
  FileApp,
  Listing,
  RemoteFile,
  Session,
  UndoEntry,
  ViewMode,
} from '../types';
import CompressDialog from './CompressDialog.vue';
import ContextMenu from './ContextMenu.vue';
import FileList from './FileList.vue';
import ImageViewer from './ImageViewer.vue';
import PathBar from './PathBar.vue';
import PermissionsDialog from './PermissionsDialog.vue';
import PromptDialog from './PromptDialog.vue';
import ShortcutHelp from './ShortcutHelp.vue';
import TextEditor from './TextEditor.vue';
import UploadPanel from './UploadPanel.vue';

const props = defineProps<{ session: Session; active: boolean }>();
const emit = defineEmits<{
  addShortcut: [{ path: string; name: string; isDirectory: boolean }];
}>();

const cwd = ref('/');
const parent = ref<string | null>(null);
const files = ref<RemoteFile[]>([]);
const loading = ref(false);

const selectedPaths = ref<Set<string>>(new Set());
const anchor = ref(-1);

const clipboard = ref<Clipboard | null>(null);
const undoStack = ref<UndoEntry[]>([]);

const editorFile = ref<RemoteFile | null>(null);
const imageFile = ref<RemoteFile | null>(null);
const menu = ref<{ x: number; y: number; file: RemoteFile | null } | null>(null);
const helpOpen = ref(false);
const prompt = ref<{
  title: string;
  label: string;
  initial: string;
  confirmText: string;
  action: (value: string) => Promise<void>;
} | null>(null);

const uploadOpen = ref(false);
const uploadDest = ref('/');
const uploading = ref(false);
const progress = ref(0);
const uploadStage = ref('Uploading…');
const dragging = ref(false);

const archiveSupport = ref<ArchiveSupport | null>(null);
const compressDialog = ref<{ paths: string[]; initialName: string } | null>(null);
const permissionsFiles = ref<RemoteFile[] | null>(null);

let loadedOnce = false;
const pathBar = ref<{ startEdit: () => void } | null>(null);
const view = ref<ViewMode>(prefs.viewMode());
let dragDepth = 0;

const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`;
const dirname = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const selectedFiles = computed(() => files.value.filter((f) => selectedPaths.value.has(f.path)));
const onlySelected = computed(() =>
  selectedFiles.value.length === 1 ? selectedFiles.value[0] : null,
);
const cutPaths = computed(() =>
  clipboard.value?.mode === 'cut' ? clipboard.value.files.map((f) => f.path) : [],
);
/** While any of these are up, the browser's own keys take over. */
const modalOpen = computed(() =>
  Boolean(editorFile.value || imageFile.value || prompt.value || uploadOpen.value || helpOpen.value),
);

/** Every remote call funnels through here so failures surface as one toast. */
async function run(action: () => Promise<void>, success?: string) {
  try {
    await action();
    if (success) notify(success);
  } catch (err) {
    fail(err);
  }
}

/** True once a real folder has been listed — until then `cwd` is a placeholder "/". */
const listed = ref(false);

function applyListing(listing: Listing) {
  listed.value = true;
  cwd.value = listing.path;
  parent.value = listing.parent;
  files.value = listing.files;
  selectedPaths.value = new Set();
  anchor.value = -1;
}

async function load(path: string) {
  loading.value = true;
  try {
    applyListing(await api.list(path));
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

/** The path box. Accepts a pasted `cd '…'` line or a `~` path, and if the path
 *  turns out to be a file, opens the folder holding it with the file selected.
 *  Resolves to the selected file, if it landed on one. */
async function goToPath(raw: string): Promise<RemoteFile | null> {
  const target = normalizePathInput(raw, props.session.home);
  if (target === cwd.value) return null;

  loading.value = true;
  try {
    applyListing(await api.list(target));
    return null;
  } catch (err) {
    const dir = dirname(target);
    const name = basename(target);
    const listing = dir === target ? null : await api.list(dir).catch(() => null);
    const hit = listing?.files.find((f) => f.name === name);

    // Only move if the file is really there — a typo must not silently land the
    // user in the parent directory of a path that does not exist.
    if (listing && hit) {
      applyListing(listing);
      selectedPaths.value = new Set([hit.path]);
      anchor.value = files.value.indexOf(hit);
      return hit;
    }
    fail(err);
    return null;
  } finally {
    loading.value = false;
  }
}

/** Used by shortcuts: folders open, files open in their default app. */
async function openPath(path: string, isDirectory: boolean) {
  loadedOnce = true;
  if (isDirectory) {
    await load(path);
    return;
  }
  const hit = await goToPath(path);
  if (hit) open(hit);
  else {
    // goToPath short-circuits when we are already in the target; find the file directly.
    const local = files.value.find((f) => f.path === path);
    if (local) open(local);
  }
}

/** "Open in folder": shows the folder holding `path` with it selected, file or folder. */
async function revealPath(path: string) {
  loadedOnce = true;
  const clean = path.replace(/(.)\/+$/, '$1');
  const dir = dirname(clean);
  if (dir === clean) {
    await load(clean);
    return;
  }
  loading.value = true;
  try {
    applyListing(await api.list(dir));
    const hit = files.value.find((f) => f.path === clean || f.name === basename(clean));
    if (hit) {
      selectedPaths.value = new Set([hit.path]);
      anchor.value = files.value.indexOf(hit);
    } else {
      notify(`${basename(clean)} isn't in ${dir} (it may have been removed)`, 'error');
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

defineExpose({ openPath, revealPath, cwd, listed });

// Uploads follow you around, defaulting to an `uploads` folder in the current
// directory. `immediate` matters: when the home directory is `/`, cwd never
// changes from its initial value and the destination would otherwise stay unset.
watch(
  cwd,
  (path) => {
    uploadDest.value = join(path, 'uploads');
  },
  { immediate: true },
);

// ---------------------------------------------------------------- selection

function onSelect(file: RemoteFile, event: MouseEvent) {
  const index = files.value.indexOf(file);
  const next = new Set(selectedPaths.value);

  if (event.ctrlKey || event.metaKey) {
    if (next.has(file.path)) next.delete(file.path);
    else next.add(file.path);
    anchor.value = index;
  } else if (event.shiftKey && anchor.value >= 0) {
    const [from, to] = [anchor.value, index].sort((a, b) => a - b);
    next.clear();
    for (const item of files.value.slice(from, to + 1)) next.add(item.path);
  } else {
    next.clear();
    next.add(file.path);
    anchor.value = index;
  }
  selectedPaths.value = next;
}

function selectAll() {
  selectedPaths.value = new Set(files.value.map((f) => f.path));
}

/** Arrow keys walk the listing, optionally extending the selection. */
function step(delta: number, extend: boolean) {
  if (!files.value.length) return;
  const current = onlySelected.value ? files.value.indexOf(onlySelected.value) : anchor.value;
  const index = Math.min(files.value.length - 1, Math.max(0, current + delta));
  const file = files.value[index];
  if (!file) return;

  if (extend) {
    const next = new Set(selectedPaths.value);
    next.add(file.path);
    selectedPaths.value = next;
  } else {
    selectedPaths.value = new Set([file.path]);
    anchor.value = index;
  }
}

// ------------------------------------------------------------------- undo

function pushUndo(entry: UndoEntry) {
  undoStack.value = [...undoStack.value.slice(-19), entry];
}

function undoLabel(entry: UndoEntry): string {
  switch (entry.type) {
    case 'rename':
      return `Renamed back to ${basename(entry.from)}`;
    case 'move':
      return `Moved ${entry.moves.length} item(s) back`;
    case 'copy':
      return `Removed ${entry.created.length} copied item(s)`;
    case 'mkdir':
      return `Removed folder ${basename(entry.path)}`;
  }
}

async function undo() {
  const entry = undoStack.value.at(-1);
  if (!entry) {
    notify('Nothing to undo');
    return;
  }

  try {
    if (entry.type === 'rename') {
      await api.rename(entry.to, basename(entry.from));
    } else if (entry.type === 'copy') {
      // `created` holds only paths the paste brought into being, never one it
      // overwrote, so undoing a copy can't destroy a pre-existing file.
      if (entry.created.length) await api.remove(entry.created);
    } else if (entry.type === 'mkdir') {
      await api.remove([entry.path], false);
    } else {
      const groups = new Map<string, string[]>();
      for (const move of entry.moves) {
        const dir = dirname(move.from);
        groups.set(dir, [...(groups.get(dir) ?? []), move.to]);
      }
      for (const [dir, paths] of groups) await api.paste(paths, dir, 'cut');
    }

    undoStack.value = undoStack.value.slice(0, -1); // only on success
    notify(undoLabel(entry));
    await load(cwd.value);
  } catch (err) {
    fail(err);
  }
}

// ------------------------------------------------------------ file actions

function open(file: RemoteFile) {
  if (file.isDirectory) {
    load(file.path);
    return;
  }
  openWith(file, appFor(file));
}

/** `remember` persists the choice for this file type in localStorage. */
function openWith(file: RemoteFile, app: FileApp, remember = false) {
  if (remember) {
    prefs.rememberOpenWith(typeKey(file), app);
    notify(`${typeLabel(file)} files now open in ${APP_NAMES[app]}`);
  }
  imageFile.value = null;
  editorFile.value = null;

  if (app === 'image') imageFile.value = file;
  else if (app === 'editor') editorFile.value = file;
  else download(file);
}

const APP_NAMES: Record<FileApp, string> = {
  editor: 'the text editor',
  image: 'the image viewer',
  download: 'downloads',
};

function download(file: RemoteFile) {
  const link = document.createElement('a');
  link.href = api.fileUrl(file.path);
  link.download = file.name;
  link.click();
}

function askRename(file: RemoteFile) {
  prompt.value = {
    title: 'Rename',
    label: 'New name',
    initial: file.name,
    confirmText: 'Rename',
    action: (name) =>
      run(async () => {
        const to = join(dirname(file.path), name);
        await api.rename(file.path, name);
        pushUndo({ type: 'rename', from: file.path, to });
        await load(cwd.value);
      }, `Renamed to ${name}`),
  };
}

function askNewFolder() {
  prompt.value = {
    title: 'New folder',
    label: 'Folder name',
    initial: 'new-folder',
    confirmText: 'Create',
    action: (name) =>
      run(async () => {
        const path = join(cwd.value, name);
        await api.mkdir(path);
        pushUndo({ type: 'mkdir', path });
        await load(cwd.value);
      }, `Created ${name}`),
  };
}

async function onPromptSubmit(value: string) {
  const action = prompt.value?.action;
  prompt.value = null;
  await action?.(value);
}

function removeSelection() {
  const targets = selectedFiles.value;
  if (!targets.length) return;

  const what = targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} items`;
  if (!confirm(`Delete ${what}?\n\nThis runs rm -rf on the server and cannot be undone.`)) return;

  run(async () => {
    await api.remove(targets.map((f) => f.path));
    await load(cwd.value);
  }, `Deleted ${what}`);
}

function copySelection(mode: 'copy' | 'cut') {
  const targets = selectedFiles.value;
  if (!targets.length) return;
  clipboard.value = { mode, files: [...targets] };
  notify(`${mode === 'cut' ? 'Cut' : 'Copied'} ${targets.length} item(s)`);
}

async function paste() {
  const board = clipboard.value;
  if (!board?.files.length) return;
  const dest = cwd.value;

  await run(async () => {
    // Note which names already exist, so undoing a copy only removes what the
    // paste actually created rather than anything it overwrote.
    const before = await api.list(dest);
    const existing = new Set(before.files.map((f) => f.name));

    await api.paste(
      board.files.map((f) => f.path),
      dest,
      board.mode,
    );

    if (board.mode === 'cut') {
      pushUndo({
        type: 'move',
        moves: board.files.map((f) => ({ from: f.path, to: join(dest, f.name) })),
      });
      clipboard.value = null;
    } else {
      const created = board.files
        .filter((f) => !existing.has(f.name))
        .map((f) => join(dest, f.name));
      pushUndo({ type: 'copy', created });
    }
    await load(dest);
  }, board.mode === 'cut' ? 'Moved' : 'Copied');
}

async function copyCd() {
  await copyToClipboard(cdCommand(cwd.value));
  notify(`Copied “${cdCommand(cwd.value)}”`);
}

async function copyPath(file: RemoteFile) {
  await copyToClipboard(file.path);
  notify('Path copied');
}

/** The path-bar button: the selected paths if there are any, else the folder itself. */
async function copyCurrentPath() {
  const targets = selectedFiles.value;
  if (!targets.length) {
    await copyToClipboard(cwd.value);
    notify(`Copied “${cwd.value}”`);
    return;
  }
  await copyToClipboard(targets.map((f) => f.path).join('\n'));
  notify(
    targets.length === 1 ? `Copied “${targets[0].path}”` : `Copied ${targets.length} paths`,
  );
}

// --------------------------------------------------------------- archives

const canExtractSelected = computed(() => {
  const file = onlySelected.value;
  if (!file || file.isDirectory || !archiveSupport.value) return false;
  const format = archiveFormat(file.name);
  return Boolean(format && archiveSupport.value.extract[format]);
});

function askCompress() {
  const targets = selectedFiles.value;
  if (!targets.length) return;
  const initialName = targets.length === 1 ? targets[0].name.replace(/\.[^.]+$/, '') : basename(cwd.value) || 'Archive';
  compressDialog.value = { paths: targets.map((f) => f.path), initialName };
}

async function onCompressSubmit(name: string, format: CompressFormat) {
  const paths = compressDialog.value?.paths ?? [];
  compressDialog.value = null;
  if (!paths.length) return;
  await run(async () => {
    await api.compress(paths, name, format);
    await load(cwd.value);
  }, `Compressed ${paths.length} item${paths.length === 1 ? '' : 's'} to ${name}`);
}

async function doExtract(file: RemoteFile) {
  await run(async () => {
    const res = await api.extract(file.path);
    await load(cwd.value);
    notify(`Extracted to ${res.path}`);
  });
}

function openPermissions() {
  const targets = selectedFiles.value;
  if (targets.length) permissionsFiles.value = targets;
}

const COMPRESS_EXT: Record<CompressFormat, string> = {
  zip: '.zip',
  'tar.gz': '.tar.gz',
  'tar.bz2': '.tar.bz2',
  'tar.xz': '.tar.xz',
};

/** Picks whichever archive format the connected server can actually produce,
 *  preferring .zip since it opens natively on Windows/Mac/Linux alike. */
function bestCompressFormat(): CompressFormat | null {
  const support = archiveSupport.value?.compress;
  if (!support) return null;
  return (['zip', 'tar.gz', 'tar.bz2', 'tar.xz'] as const).find((f) => support[f]) ?? null;
}

/** Drag a file or folder out of the browser window onto the desktop — see
 *  `server/archive.ts`'s `/api/archive/download-zip` for how a multi-selection or a
 *  folder is zipped on the fly. Chromium/WebKit only; Firefox has no equivalent. */
function onFileDragStart(event: DragEvent, file: RemoteFile) {
  if (!event.dataTransfer) return;
  const dragWholeSelection = selectedPaths.value.has(file.path) && selectedPaths.value.size > 1;
  const targets = dragWholeSelection ? selectedFiles.value : [file];
  event.dataTransfer.effectAllowed = 'copy';

  if (targets.length === 1 && !targets[0].isDirectory) {
    const url = `${location.origin}${api.fileUrl(targets[0].path)}`;
    event.dataTransfer.setData('DownloadURL', `application/octet-stream:${targets[0].name}:${url}`);
    return;
  }

  const format = bestCompressFormat();
  if (!format) return; // No zip/tar on the server — nothing sensible to offer.
  const name = (targets.length === 1 ? targets[0].name : basename(cwd.value) || 'files') + COMPRESS_EXT[format];
  const url = `${location.origin}${api.zipDownloadUrl(targets.map((f) => f.path), name, format)}`;
  const mime = format === 'zip' ? 'application/zip' : 'application/gzip';
  event.dataTransfer.setData('DownloadURL', `${mime}:${name}:${url}`);
}

function setView(mode: ViewMode) {
  view.value = mode;
  prefs.setViewMode(mode);
}

function shortcutFor(file: RemoteFile | null) {
  if (file) emit('addShortcut', { path: file.path, name: file.name, isDirectory: file.isDirectory });
  else
    emit('addShortcut', {
      path: cwd.value,
      name: cwd.value === '/' ? 'Root' : basename(cwd.value),
      isDirectory: true,
    });
}

// ----------------------------------------------------------------- uploads

async function doUpload(items: UploadItem[]) {
  if (!items.length) return;
  uploading.value = true;
  progress.value = 0;
  uploadStage.value = 'Uploading…';
  const dest = uploadDest.value;
  const transferId = newTransferId();
  let watching = false;
  let stopWatch = () => {};
  await run(async () => {
    await api.upload(
      items,
      dest,
      (percent) => {
        progress.value = percent;
        // The browser's own progress event only covers getting the file to
        // this server — once that hits 100%, switch to polling the part that
        // was previously invisible: relaying it on to the actual remote target.
        if (percent >= 100 && !watching) {
          watching = true;
          uploadStage.value = 'Copying to the server…';
          progress.value = 0;
          stopWatch = watchTransfer(transferId, (state) => {
            progress.value = state.total ? Math.round((state.transferred / state.total) * 100) : 100;
          });
        }
      },
      transferId,
    );
    if (cwd.value === dest || dest.startsWith(cwd.value)) await load(cwd.value);
  }, `Uploaded ${items.length} file${items.length === 1 ? '' : 's'} to ${dest}`);
  stopWatch();
  uploading.value = false;
  uploadOpen.value = false;
}

// Drag counting: dragleave fires for every child element, so a naive
// boolean flickers the overlay away as the cursor crosses rows.
function onDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dragging.value = true;
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging.value = false;
}

async function onDrop(event: DragEvent) {
  dragDepth = 0;
  dragging.value = false;
  if (!event.dataTransfer) return;
  await doUpload(await itemsFromDrop(event.dataTransfer));
}

// --------------------------------------------------------------- shortcuts

function onKeydown(event: KeyboardEvent) {
  if (!props.active || modalOpen.value) return;

  // Never steal keys from a field the user is typing into.
  const target = event.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
    return;
  }
  // Another view's dialog (e.g. the shortcut editor) may be open on top.
  if (document.querySelector('[data-modal]')) return;

  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (ctrl && key === 'l') {
    event.preventDefault();
    pathBar.value?.startEdit();
  } else if (ctrl && key === 'a') {
    event.preventDefault();
    selectAll();
  } else if (ctrl && key === 'c') {
    event.preventDefault();
    copySelection('copy');
  } else if (ctrl && key === 'x') {
    event.preventDefault();
    copySelection('cut');
  } else if (ctrl && key === 'v') {
    event.preventDefault();
    paste();
  } else if (ctrl && key === 'z') {
    event.preventDefault();
    undo();
  } else if (ctrl && key === 'd') {
    event.preventDefault();
    shortcutFor(onlySelected.value);
  } else if (event.key === 'Delete') {
    event.preventDefault();
    removeSelection();
  } else if (event.key === 'F2') {
    event.preventDefault();
    if (onlySelected.value) askRename(onlySelected.value);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (onlySelected.value) open(onlySelected.value);
  } else if (event.key === 'Escape') {
    if (menu.value) menu.value = null;
    else selectedPaths.value = new Set();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    step(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
  } else if (event.key === '?') {
    helpOpen.value = true;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  api.archiveSupport().then((s) => (archiveSupport.value = s)).catch(() => {});
});

// Load the home folder the first time the explorer is shown, unless a shortcut
// already navigated somewhere.
watch(
  () => props.active,
  (active) => {
    if (active && !loadedOnce) {
      loadedOnce = true;
      if (!files.value.length && !loading.value) load(props.session.home);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    class="relative flex min-h-0 flex-1 flex-col"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div
      class="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-900/50 px-2 py-1.5"
    >
      <button
        :disabled="!parent"
        title="Up one level"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        @click="parent && load(parent)"
      >
        <v-icon name="fa-level-up-alt" scale="0.85" />
      </button>
      <button
        title="Home"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="load(session.home)"
      >
        <v-icon name="fa-home" scale="0.85" />
      </button>
      <button
        :disabled="!undoStack.length"
        title="Undo (Ctrl+Z)"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        @click="undo"
      >
        <v-icon name="fa-undo" scale="0.85" />
      </button>
      <button
        title="Refresh"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="load(cwd)"
      >
        <v-icon name="fa-sync-alt" scale="0.85" />
      </button>

      <button
        v-if="clipboard"
        class="ml-1 flex items-center gap-1.5 rounded-md border border-emerald-700/50 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400 transition hover:bg-emerald-500/20"
        @click="paste"
      >
        <v-icon name="fa-paste" scale="0.75" />
        Paste {{ clipboard.files.length }} item{{ clipboard.files.length === 1 ? '' : 's' }}
        ({{ clipboard.mode }})
      </button>

      <span v-if="selectedPaths.size" class="ml-2 text-xs text-emerald-400">
        {{ selectedPaths.size }} selected
      </span>
      <span class="ml-2 text-xs text-slate-600">
        {{ files.length }} item{{ files.length === 1 ? '' : 's' }}
      </span>

      <div class="flex-1" />

      <button
        title="Add a shortcut to the selection, or to this folder (Ctrl+D)"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-amber-300/90 transition hover:bg-amber-500/10"
        @click="shortcutFor(onlySelected)"
      >
        <v-icon name="fa-star" scale="0.75" />
        {{ onlySelected ? 'Shortcut to selection' : 'Shortcut to folder' }}
      </button>

      <div class="mx-1 flex items-center rounded-md border border-slate-700 p-0.5">
        <button
          title="List view"
          class="rounded p-1.5 transition"
          :class="view === 'list' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
          @click="setView('list')"
        >
          <v-icon name="fa-list-ul" scale="0.75" />
        </button>
        <button
          title="Grid view"
          class="rounded p-1.5 transition"
          :class="view === 'grid' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
          @click="setView('grid')"
        >
          <v-icon name="fa-th" scale="0.75" />
        </button>
      </div>

      <button
        title="New folder"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="askNewFolder"
      >
        <v-icon name="fa-plus" scale="0.85" />
      </button>
      <button
        title="Keyboard shortcuts (?)"
        class="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
        @click="helpOpen = true"
      >
        <v-icon name="fa-keyboard" scale="0.85" />
      </button>
      <button
        class="ml-1 flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
        @click="uploadOpen = true"
      >
        <v-icon name="fa-upload" scale="0.75" /> Upload
      </button>
    </div>

    <PathBar
      ref="pathBar"
      :path="cwd"
      :selection-count="selectedPaths.size"
      @navigate="load"
      @go="(p: string) => goToPath(p).then((hit) => hit && notify(`Selected ${hit.name}`))"
      @copy-cd="copyCd"
      @copy-path="copyCurrentPath"
    />

    <div
      class="flex min-h-0 flex-1 flex-col"
      @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, file: null }"
    >
      <FileList
        :files="files"
        :loading="loading"
        :selected="selectedPaths"
        :cut-paths="cutPaths"
        :view="view"
        @select="onSelect"
        @open="open"
        @menu="
          (event, file) => {
            if (!selectedPaths.has(file.path)) {
              selectedPaths = new Set([file.path]);
              anchor = files.indexOf(file);
            }
            menu = { x: event.clientX, y: event.clientY, file };
          }
        "
        @dragstart="onFileDragStart"
      />
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :file="menu.file"
      :count="selectedPaths.size"
      :can-paste="Boolean(clipboard)"
      :can-extract="canExtractSelected"
      @close="menu = null"
      @open="open"
      @open-with="(file, app) => openWith(file, app, true)"
      @copy="copySelection('copy')"
      @cut="copySelection('cut')"
      @paste="paste"
      @rename="askRename"
      @download="download"
      @copy-path="copyPath"
      @remove="removeSelection"
      @new-folder="askNewFolder"
      @upload="uploadOpen = true"
      @shortcut="shortcutFor"
      @compress="askCompress"
      @extract="doExtract"
      @permissions="openPermissions"
    />

    <TextEditor
      v-if="editorFile"
      :file="editorFile"
      @close="editorFile = null"
      @saved="
        notify(`Saved ${editorFile?.name}`);
        load(cwd);
      "
      @download="download"
    />

    <ImageViewer
      v-if="imageFile"
      :file="imageFile"
      @close="imageFile = null"
      @download="download"
      @open-as-text="(file) => openWith(file, 'editor')"
    />

    <PromptDialog
      v-if="prompt"
      :title="prompt.title"
      :label="prompt.label"
      :initial="prompt.initial"
      :confirm-text="prompt.confirmText"
      @submit="onPromptSubmit"
      @close="prompt = null"
    />

    <UploadPanel
      v-if="uploadOpen"
      v-model:dest="uploadDest"
      :busy="uploading"
      :progress="progress"
      :stage="uploadStage"
      @close="uploadOpen = false"
      @upload="doUpload"
    />

    <ShortcutHelp v-if="helpOpen" @close="helpOpen = false" />

    <CompressDialog
      v-if="compressDialog && archiveSupport"
      :initial-name="compressDialog.initialName"
      :support="archiveSupport.compress"
      @submit="onCompressSubmit"
      @close="compressDialog = null"
    />

    <PermissionsDialog
      v-if="permissionsFiles"
      :files="permissionsFiles"
      @close="permissionsFiles = null"
      @changed="load(cwd)"
    />

    <!-- Drop anywhere in the explorer, not just inside the upload dialog. -->
    <div
      v-if="dragging"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-emerald-500/10 backdrop-blur-sm"
    >
      <div
        class="rounded-2xl border-2 border-dashed border-emerald-400 bg-slate-900/90 px-10 py-8 text-center"
      >
        <v-icon name="fa-cloud-upload-alt" scale="2.5" class="text-emerald-400" />
        <p class="mt-3 text-base font-semibold text-white">Drop to upload</p>
        <p class="mt-1 font-mono text-xs text-slate-400">{{ uploadDest }}</p>
      </div>
    </div>

    <div
      v-if="uploading && !uploadOpen"
      class="fixed bottom-4 left-1/2 z-40 w-80 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
    >
      <div class="mb-1.5 flex justify-between text-xs text-slate-400">
        <span>{{ uploadStage }}</span>
        <span class="tabular-nums">{{ progress }}%</span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          class="h-full rounded-full bg-emerald-500 transition-all duration-200"
          :style="{ width: `${progress}%` }"
        />
      </div>
    </div>
  </div>
</template>
