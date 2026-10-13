<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { fail, notify } from '../toast';
import type { LocalApp, NginxSite, NginxSiteSpec, RemoteFile } from '../types';
import NginxSiteDialog from './NginxSiteDialog.vue';
import NginxTrafficPanel from './NginxTrafficPanel.vue';
import TextEditor from './TextEditor.vue';

const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }] }>();

/** The site whose traffic/logs panel is open. */
const traffic = ref<NginxSite | null>(null);

const loading = ref(true);
const sites = ref<NginxSite[]>([]);
const apps = ref<LocalApp[]>([]);
const busy = ref<Set<string>>(new Set());

const dialog = ref<{ prefill: Partial<NginxSiteSpec>; rawPreview?: string } | null>(null);
const editing = ref<RemoteFile | null>(null);

const dropping = ref(false);
const uploading = ref(false);
let dragDepth = 0;

async function refresh() {
  loading.value = true;
  try {
    const [s, a] = await Promise.all([api.nginxSites(), api.localApps().catch(() => ({ apps: [] }))]);
    sites.value = s.sites;
    apps.value = a.apps;
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const enabledCount = computed(() => sites.value.filter((s) => s.enabled).length);

function setBusy(name: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(name);
  else next.delete(name);
  busy.value = next;
}

async function toggleEnabled(site: NginxSite) {
  setBusy(site.name, true);
  try {
    await api.nginxSetEnabled(site.name, !site.enabled);
    notify(`${site.enabled ? 'Disabled' : 'Enabled'} ${site.name}`);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    setBusy(site.name, false);
  }
}

async function removeSite(site: NginxSite) {
  if (!confirm(`Remove the site "${site.name}"?\n\nDeletes its config file and disables it. This cannot be undone.`)) return;
  setBusy(site.name, true);
  try {
    await api.nginxDeleteSite(site.name);
    notify(`Removed ${site.name}`);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    setBusy(site.name, false);
  }
}

function asFile(path: string): RemoteFile {
  return { name: path.split('/').pop() ?? path, path, isDirectory: false, isSymlink: false, size: 0, mtime: 0, mode: 0 };
}

function editSite(site: NginxSite) {
  editing.value = asFile(site.path);
}

async function onSaved() {
  const file = editing.value;
  notify(`Saved ${file?.name}`);
  if (confirm('Saved. Test & reload nginx now so the change takes effect?')) {
    try {
      await api.serviceAction('nginx', 'reload');
      notify('nginx reloaded');
    } catch (err) {
      fail(err);
    }
  }
  editing.value = null;
  await refresh();
}

function download(file: RemoteFile) {
  const link = document.createElement('a');
  link.href = api.fileUrl(file.path);
  link.download = file.name;
  link.click();
}

function addSiteFor(app: LocalApp) {
  dialog.value = {
    prefill: {
      name: app.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40),
      target: app.target,
    },
  };
}

function onCreated() {
  notify('Site created');
  dialog.value = null;
  refresh();
}

// --------------------------------------------------------- drop to add a site

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropping.value = true;
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropping.value = false;
}

async function onDrop(e: DragEvent) {
  dragDepth = 0;
  dropping.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) await loadDroppedFile(file);
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await loadDroppedFile(file);
}

async function loadDroppedFile(file: File) {
  uploading.value = true;
  try {
    const res = await api.nginxUploadSite(file);
    dialog.value = {
      prefill: { name: res.suggestedName, domain: res.domain, target: res.target, maxBody: res.maxBody },
      rawPreview: res.raw,
    };
  } catch (err) {
    fail(err);
  } finally {
    uploading.value = false;
  }
}

onMounted(refresh);

const btn = 'rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-30';
</script>

<template>
  <div
    class="relative flex min-h-0 flex-1 flex-col"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- Header -->
    <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
      <v-icon name="fa-globe" scale="1.3" class="text-emerald-400" />
      <div>
        <h1 class="text-base font-semibold text-white">Nginx</h1>
        <p class="text-xs text-slate-500">{{ enabledCount }}/{{ sites.length }} sites enabled</p>
      </div>
      <div class="flex-1" />
      <button :class="btn" title="Refresh" @click="refresh">
        <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
        @click="dialog = { prefill: {} }"
      >
        <v-icon name="fa-plus" scale="0.75" /> Add site
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <!-- Detected apps with no site yet -->
      <div v-if="apps.length" class="mb-5 space-y-2">
        <p class="text-xs font-medium text-slate-400">Running, but not behind nginx yet</p>
        <div
          v-for="app in apps"
          :key="app.name + app.target"
          class="flex items-center gap-3 rounded-xl border border-sky-800/40 bg-sky-500/5 px-4 py-2.5"
        >
          <v-icon :name="app.kind === 'docker' ? 'fa-docker' : 'si-dotnet'" scale="1.1" class="text-sky-300" />
          <div class="min-w-0 flex-1">
            <p class="text-sm text-white">
              <span class="font-medium">{{ app.name }}</span>
              <span class="ml-1 text-xs text-slate-500">{{ app.kind === 'docker' ? 'Docker container' : '.NET app' }}</span>
            </p>
            <p class="font-mono text-[11px] text-slate-500">{{ app.target }}</p>
          </div>
          <button
            class="shrink-0 rounded-lg border border-sky-700/60 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/10"
            @click="addSiteFor(app)"
          >
            Add nginx site
          </button>
        </div>
      </div>

      <!-- Drop zone -->
      <label
        class="mb-5 flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/40 px-5 py-4 transition hover:border-emerald-600 hover:bg-emerald-500/5"
      >
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/30">
          <v-icon :name="uploading ? 'fa-spinner' : 'fa-file-upload'" :class="uploading && 'animate-spin'" class="text-emerald-300" scale="1.1" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-white">Drag & drop an nginx site config here to add it</p>
          <p class="text-xs text-slate-500">
            Its domain and proxy target are read from the file and shown for confirmation — nothing is written
            until you approve it, and it is checked with <code class="text-slate-400">nginx -t</code> before going live.
          </p>
        </div>
        <span class="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Choose file</span>
        <input type="file" class="hidden" @change="onPick" />
      </label>

      <div v-if="loading && !sites.length" class="py-16 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-emerald-400" />
      </div>
      <p v-else-if="!sites.length" class="py-10 text-center text-sm text-slate-500">
        No sites in /etc/nginx/sites-available yet.
      </p>

      <div v-else class="overflow-hidden rounded-xl border border-slate-800">
        <div
          v-for="site in sites"
          :key="site.name"
          class="flex flex-wrap items-center gap-3 border-b border-slate-800/70 bg-slate-950/40 px-4 py-3 last:border-b-0 hover:bg-slate-900/60"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" :class="site.enabled ? 'bg-emerald-400' : 'bg-slate-600'" :title="site.enabled ? 'Enabled' : 'Disabled'" />
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
              {{ site.name }}
              <span v-if="!site.managed" class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-400" title="Written by hand, not by SSHer — only viewable/enable-disable here">
                hand-written
              </span>
            </p>
            <p class="truncate font-mono text-[11px] text-slate-500">
              {{ site.domains.join(', ') || '(no server_name found)' }}
              <template v-if="site.target"> → {{ site.target }}</template>
            </p>
          </div>
          <div class="flex items-center gap-1">
            <v-icon v-if="busy.has(site.name)" name="fa-spinner" scale="0.8" class="mx-2 animate-spin text-emerald-400" />
            <button :class="btn" :title="site.enabled ? 'Disable' : 'Enable'" :disabled="busy.has(site.name)" @click="toggleEnabled(site)">
              <v-icon :name="site.enabled ? 'fa-toggle-on' : 'fa-toggle-off'" scale="1.1" :class="site.enabled ? 'text-emerald-400' : 'text-slate-500'" />
            </button>
            <button :class="btn" title="Traffic, connections & logs" @click="traffic = site">
              <v-icon name="fa-chart-line" scale="0.8" class="text-emerald-300" />
            </button>
            <button :class="btn" title="Open in folder" @click="emit('openPath', { path: site.path, isDirectory: false, reveal: true })">
              <v-icon name="fa-folder-open" scale="0.8" />
            </button>
            <button :class="btn" title="Edit" @click="editSite(site)">
              <v-icon name="fa-pen" scale="0.8" />
            </button>
            <button
              v-if="site.managed"
              :class="btn"
              title="Remove"
              :disabled="busy.has(site.name)"
              @click="removeSite(site)"
            >
              <v-icon name="fa-trash-alt" scale="0.8" class="text-red-400" />
            </button>
          </div>
        </div>
      </div>

      <button
        class="mt-4 flex items-center gap-1.5 text-xs text-slate-400 hover:text-white"
        @click="emit('openPath', { path: '/etc/nginx/sites-available', isDirectory: true })"
      >
        <v-icon name="fa-folder-open" scale="0.7" /> Browse /etc/nginx/sites-available
      </button>
    </div>

    <!-- Overlays -->
    <div
      v-if="dropping"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-emerald-500/10 backdrop-blur-sm"
    >
      <div class="rounded-2xl border-2 border-dashed border-emerald-400 bg-slate-900/90 px-10 py-8 text-center">
        <v-icon name="fa-globe" scale="3" class="text-emerald-400" />
        <p class="mt-3 text-base font-semibold text-white">Drop the config to add it as a site</p>
      </div>
    </div>

    <NginxTrafficPanel
      v-if="traffic"
      :site="traffic"
      @close="traffic = null"
      @open-path="(p) => { traffic = null; emit('openPath', p); }"
    />

    <NginxSiteDialog
      v-if="dialog"
      :prefill="dialog.prefill"
      :raw-preview="dialog.rawPreview"
      @close="dialog = null"
      @created="onCreated"
    />

    <TextEditor
      v-if="editing"
      :file="editing"
      @close="editing = null"
      @saved="onSaved"
      @download="download"
    />
  </div>
</template>
