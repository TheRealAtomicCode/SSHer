<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as api from '../api';
import { QUICK_GROUPS, ALL_QUICK_PATHS, type QuickGroup, type QuickLink, type ServiceControl } from '../quicklinks';
import { fail, notify } from '../toast';
import type { RemoteFile } from '../types';
import TextEditor from './TextEditor.vue';

const emit = defineEmits<{ openPath: [{ path: string; isDirectory: boolean }] }>();

const status = ref<Record<string, string>>({});
const found = ref<Record<string, 'file' | 'dir'> | null>(null);
const running = ref('');
const output = ref<{ group: string; title: string; text: string; ok: boolean } | null>(null);
const editing = ref<{ file: RemoteFile; group: QuickGroup } | null>(null);

// Full class strings — Tailwind cannot see classes assembled at runtime.
const ACCENT: Record<string, { icon: string; ring: string; btn: string }> = {
  emerald: { icon: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30', ring: 'hover:border-emerald-600/60', btn: 'bg-emerald-600 hover:bg-emerald-500' },
  sky: { icon: 'bg-sky-500/10 text-sky-300 ring-sky-500/30', ring: 'hover:border-sky-600/60', btn: 'bg-sky-600 hover:bg-sky-500' },
  rose: { icon: 'bg-rose-500/10 text-rose-300 ring-rose-500/30', ring: 'hover:border-rose-600/60', btn: 'bg-rose-600 hover:bg-rose-500' },
  amber: { icon: 'bg-amber-500/10 text-amber-300 ring-amber-500/30', ring: 'hover:border-amber-600/60', btn: 'bg-amber-600 hover:bg-amber-500' },
};

const STATE: Record<string, { label: string; tone: string }> = {
  active: { label: 'Running', tone: 'bg-emerald-500/15 text-emerald-300' },
  inactive: { label: 'Stopped', tone: 'bg-slate-500/20 text-slate-300' },
  failed: { label: 'Failed', tone: 'bg-red-500/20 text-red-300' },
  activating: { label: 'Starting…', tone: 'bg-amber-500/20 text-amber-300' },
  deactivating: { label: 'Stopping…', tone: 'bg-amber-500/20 text-amber-300' },
  missing: { label: 'Not installed', tone: 'bg-slate-800 text-slate-500' },
  unknown: { label: 'Not installed', tone: 'bg-slate-800 text-slate-500' },
};

const stateOf = (id: string) => STATE[status.value[id] ?? ''] ?? { label: status.value[id] ?? '…', tone: 'bg-slate-800 text-slate-400' };

async function refreshStatus() {
  try {
    status.value = (await api.services()).status;
  } catch (err) {
    fail(err);
  }
}

async function control(group: QuickGroup, c: ServiceControl) {
  if (c.confirm && !confirm(c.confirm)) return;
  await runAction(group, c.action, `${group.title}: ${c.label}`);
}

async function runAction(group: QuickGroup, action: string, title: string) {
  running.value = `${group.id}:${action}`;
  try {
    const res = await api.serviceAction(group.id, action);
    output.value = { group: group.id, title, text: res.output, ok: true };
    notify(`${title} — done`);
  } catch (err) {
    const payload = err instanceof api.ApiError ? (err.payload.output as string) : '';
    output.value = { group: group.id, title, text: payload || (err as Error).message, ok: false };
    fail(new Error(`${title} failed`));
  } finally {
    running.value = '';
    await refreshStatus();
  }
}

function open(group: QuickGroup, link: QuickLink) {
  const kind = found.value?.[link.path];
  if (found.value && !kind) {
    notify(`${link.path} does not exist on this server`, 'error');
    return;
  }
  if (link.dir || kind === 'dir') {
    emit('openPath', { path: link.path, isDirectory: true });
    return;
  }
  editing.value = {
    group,
    file: { name: link.path.split('/').pop()!, path: link.path, isDirectory: false, isSymlink: false, size: 0, mtime: 0, mode: 0 },
  };
}

async function onSaved() {
  const current = editing.value;
  if (!current) return;
  notify(`Saved ${current.file.name}`);
  const after = current.group.afterSave;
  if (after && confirm(`Saved. ${after.label} now so the change takes effect?`)) {
    editing.value = null;
    await runAction(current.group, after.action, after.label);
  }
}

function download(file: RemoteFile) {
  const link = document.createElement('a');
  link.href = api.fileUrl(file.path);
  link.download = file.name;
  link.click();
}

onMounted(async () => {
  refreshStatus();
  try {
    found.value = (await api.exists(ALL_QUICK_PATHS)).found;
  } catch (err) {
    fail(err);
  }
});
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-6xl">
      <div class="mb-6 flex flex-wrap items-end gap-3">
        <div class="flex-1">
          <h1 class="flex items-center gap-2 text-xl font-semibold text-white">
            <v-icon name="fa-link" class="text-emerald-400" /> Quick Links
          </h1>
          <p class="text-sm text-slate-500">
            The config files that matter on this server, what each one does, and the controls for its service.
            Click a file to edit it; folders open in the File Explorer.
          </p>
        </div>
        <button class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh status" @click="refreshStatus">
          <v-icon name="fa-sync-alt" scale="0.85" />
        </button>
      </div>

      <div class="grid gap-5 lg:grid-cols-2">
        <section
          v-for="g in QUICK_GROUPS"
          :key="g.id"
          class="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50"
        >
          <!-- Service header + controls -->
          <div class="border-b border-slate-800 bg-slate-900 px-4 py-3">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 items-center justify-center rounded-lg ring-1" :class="ACCENT[g.accent].icon">
                <v-icon :name="g.icon" scale="0.95" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-semibold text-white">
                  {{ g.title }}
                  <span class="rounded-full px-2 py-0.5 text-[10px] font-medium" :class="stateOf(g.id).tone">
                    {{ stateOf(g.id).label }}
                  </span>
                </p>
                <p class="text-xs text-slate-500">{{ g.blurb }}</p>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <button
                v-for="c in g.controls"
                :key="c.action"
                :disabled="Boolean(running)"
                class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40"
                :class="
                  c.tone === 'danger'
                    ? 'border border-red-900 text-red-300 hover:bg-red-950'
                    : c.tone === 'primary'
                      ? ['text-white', ACCENT[g.accent].btn]
                      : 'border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
                "
                @click="control(g, c)"
              >
                <v-icon
                  :name="running === `${g.id}:${c.action}` ? 'fa-spinner' : c.icon"
                  :class="running === `${g.id}:${c.action}` && 'animate-spin'"
                  scale="0.65"
                />
                {{ c.label }}
              </button>
            </div>
            <div
              v-if="output?.group === g.id"
              class="mt-3 rounded-lg border px-3 py-2"
              :class="output.ok ? 'border-slate-800 bg-slate-950' : 'border-red-900/60 bg-red-950/30'"
            >
              <div class="mb-1 flex items-center gap-2 text-[11px]">
                <v-icon :name="output.ok ? 'fa-check' : 'fa-times'" scale="0.6" :class="output.ok ? 'text-emerald-400' : 'text-red-400'" />
                <span class="flex-1 text-slate-400">{{ output.title }}</span>
                <button class="text-slate-600 hover:text-white" @click="output = null"><v-icon name="fa-times" scale="0.55" /></button>
              </div>
              <pre class="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-slate-300">{{ output.text }}</pre>
            </div>
          </div>

          <!-- Config files -->
          <div class="flex-1 divide-y divide-slate-800/70">
            <button
              v-for="l in g.links"
              :key="l.path"
              class="group flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-slate-900"
              :class="found && !found[l.path] && 'opacity-40'"
              @click="open(g, l)"
            >
              <v-icon
                :name="l.dir ? 'fa-folder' : 'fa-file-code'"
                scale="0.8"
                class="mt-0.5 shrink-0"
                :class="l.dir ? 'text-amber-300' : 'text-slate-400 group-hover:text-white'"
              />
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-x-2 text-sm text-slate-100">
                  {{ l.title }}
                  <span class="font-mono text-[11px] text-slate-500">{{ l.path }}</span>
                  <span v-if="found && !found[l.path]" class="text-[10px] text-slate-500">not on this server</span>
                </p>
                <p class="text-xs leading-snug text-slate-400">{{ l.what }}</p>
                <p v-if="l.caution" class="mt-0.5 flex items-center gap-1 text-[11px] text-amber-400/90">
                  <v-icon name="fa-exclamation-triangle" scale="0.5" /> {{ l.caution }}
                </p>
              </div>
              <v-icon
                :name="l.dir ? 'fa-arrow-right' : 'fa-pen'"
                scale="0.6"
                class="mt-1 shrink-0 text-slate-600 opacity-0 transition group-hover:opacity-100"
              />
            </button>
          </div>
        </section>
      </div>
    </div>

    <TextEditor
      v-if="editing"
      :file="editing.file"
      @close="editing = null"
      @saved="onSaved"
      @download="download"
    />
  </div>
</template>
