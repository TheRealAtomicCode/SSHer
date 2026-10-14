<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { formatSize } from '../files';
import { fail, notify } from '../toast';
import type { Container, ContainerConfigFile, ContainerConfigInfo, RemoteFile, StepResult } from '../types';
import StepLog from './StepLog.vue';
import TextEditor from './TextEditor.vue';

const props = defineProps<{ container: Container }>();
const emit = defineEmits<{
  openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }];
  /** After a save: `up` re-applies the compose project, `restart` restarts this container. */
  apply: ['up' | 'restart'];
  changed: [];
}>();

const loading = ref(true);
const info = ref<ContainerConfigInfo | null>(null);
const editing = ref<{ file: RemoteFile; kind: ContainerConfigFile['kind'] } | null>(null);
const working = ref('');
const extractLog = ref<{ steps: StepResult[]; running: boolean; error: string } | null>(null);

async function load() {
  loading.value = true;
  try {
    info.value = await api.dockerConfigFiles(props.container.id);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const files = computed(() => info.value?.files ?? []);
/** An env file that is both --env-file and env_file: (the usual single-.env setup) is listed once. */
const serviceEnvPaths = computed(() => new Set(files.value.filter((f) => f.kind === 'service-env').map((f) => f.path)));
const projectEnvPaths = computed(() => new Set(files.value.filter((f) => f.kind === 'project-env').map((f) => f.path)));

const sections = computed(() =>
  [
    {
      title: 'Loaded into the container',
      hint: 'The env files compose passes in as environment variables, and the app\'s appsettings. This is what the app reads.',
      items: files.value.filter((f) => f.kind === 'service-env' || f.kind === 'appsettings'),
    },
    {
      title: 'Compose files',
      hint: '',
      items: files.value.filter((f) => f.kind === 'compose'),
    },
    {
      title: 'Fills in ${…} in the compose files',
      hint: 'Passed as --env-file. Its values are NOT given to the container unless the compose file uses them.',
      items: files.value.filter((f) => f.kind === 'project-env' && !serviceEnvPaths.value.has(f.path)),
    },
  ].filter((s) => s.items.length),
);

const missing = computed(() => files.value.filter((f) => f.location === 'host' && !f.exists && f.required && f.kind !== 'compose'));

function asFile(path: string, size = 0): RemoteFile {
  return { name: path.split('/').pop() ?? path, path, isDirectory: false, isSymlink: false, size, mtime: 0, mode: 0 };
}

function edit(f: ContainerConfigFile) {
  editing.value = { file: asFile(f.path, f.size), kind: f.kind };
}

async function create(f: ContainerConfigFile) {
  working.value = f.path;
  try {
    await api.dockerConfigCreate(props.container.id, f.path);
    notify(`Created ${f.path} — fill it in or upload it, then save`);
    await load();
    edit({ ...f, exists: true });
  } catch (err) {
    fail(err);
  } finally {
    working.value = '';
  }
}

async function makeEditable(f: ContainerConfigFile) {
  const service = info.value?.compose?.service;
  if (!service) return;
  const dest = `${info.value!.compose!.workingDir}/ssher-config/${service}/${f.path.split('/').pop()}`;
  if (
    !confirm(
      `Make ${f.containerPath} editable?\n\n` +
        `• it is copied out of the container to ${dest}\n` +
        `• mounted back over ${f.containerPath} (through ssher.override.yml)\n` +
        `• ${service} is recreated (a few seconds of downtime)\n\n` +
        `From then on that file wins over the one in the image — including after you load a new build. ` +
        `Remove its line from ssher.override.yml to go back to the image's copy.`,
    )
  )
    return;
  working.value = f.path;
  extractLog.value = { steps: [], running: true, error: '' };
  try {
    const res = await api.dockerConfigExtract(props.container.id, f.containerPath);
    extractLog.value = { steps: res.log, running: false, error: '' };
    notify(`${f.containerPath} is now editable`);
    emit('changed');
    await load();
  } catch (err) {
    extractLog.value = {
      steps: err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [],
      running: false,
      error: (err as Error).message,
    };
  } finally {
    working.value = '';
  }
}

function onSaved() {
  const e = editing.value;
  if (!e) return;
  notify(`Saved ${e.file.name}`);
  void load();
  if (e.kind === 'appsettings') {
    if (confirm(`Saved. Restart ${props.container.name} now so the app reads it?`)) {
      editing.value = null;
      emit('apply', 'restart');
    }
  } else if (info.value?.compose) {
    if (
      confirm(
        `Saved. Apply the change now?\n\nRuns docker compose up -d for ${info.value.compose.project} — containers whose configuration changed are recreated.`,
      )
    ) {
      editing.value = null;
      emit('apply', 'up');
    }
  }
}

function download(file: RemoteFile) {
  const link = document.createElement('a');
  link.href = api.fileUrl(file.path);
  link.download = file.name;
  link.click();
}

const isEnv = (f: ContainerConfigFile) => f.kind === 'service-env' || f.kind === 'project-env';

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start gap-2">
      <p class="flex-1 text-xs text-slate-400">
        Every file this container takes its configuration from. Open one to edit it, or use <b class="text-slate-300">Upload</b>
        in the editor to replace it with a file from your computer. Saving offers to apply the change.
      </p>
      <button class="shrink-0 rounded-md p-1 text-slate-500 hover:text-white" title="Reload" @click="load">
        <v-icon name="fa-sync-alt" scale="0.7" :class="loading && 'animate-spin'" />
      </button>
    </div>

    <div v-if="loading && !info" class="py-8 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>

    <template v-else-if="info">
      <!-- The usual reason a container crash-loops on start -->
      <div v-if="missing.length" class="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2.5 text-[11px] text-red-200">
        <p class="font-medium">
          <v-icon name="fa-exclamation-triangle" scale="0.65" />
          {{ missing.length === 1 ? 'A file this container needs is missing' : 'Files this container needs are missing' }}
        </p>
        <p v-for="f in missing" :key="f.path" class="mt-1 font-mono text-red-300">{{ f.path }}</p>
        <p class="mt-1 text-red-300/80">Create it below, then fill it in or upload it, save, and apply.</p>
      </div>
      <details v-if="info.configError" class="text-[11px] text-slate-500">
        <summary class="cursor-pointer hover:text-slate-300">docker compose config reported an error</summary>
        <pre class="mt-1 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-400">{{ info.configError }}</pre>
      </details>

      <div v-for="s in sections" :key="s.title">
        <p class="mb-0.5 text-xs font-medium text-slate-400">{{ s.title }}</p>
        <p v-if="s.hint" class="mb-1.5 text-[11px] text-slate-500">{{ s.hint }}</p>
        <div
          v-for="f in s.items"
          :key="f.kind + f.path"
          class="mb-1.5 flex items-center gap-2 rounded-lg border bg-slate-950 px-3 py-2"
          :class="!f.exists ? 'border-red-900/70' : 'border-slate-800'"
        >
          <v-icon
            :name="isEnv(f) ? 'fa-lock' : f.kind === 'appsettings' ? 'fa-cog' : 'fa-file-code'"
            scale="0.75"
            class="shrink-0"
            :class="isEnv(f) ? 'text-amber-300' : f.kind === 'appsettings' ? 'text-violet-300' : 'text-sky-300'"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs text-slate-200" :title="f.path">{{ f.path }}</p>
            <p class="flex flex-wrap gap-x-2 text-[10px] text-slate-500">
              <span v-if="!f.exists" class="text-red-400">missing{{ f.required ? '' : ' (optional)' }}</span>
              <span v-else-if="f.location === 'host'">{{ formatSize(f.size) }}</span>
              <span v-if="f.location === 'image'" class="text-amber-400" title="Inside the image: an edit there would be lost on the next recreate">
                inside the image only
              </span>
              <span v-else-if="f.kind === 'appsettings'">mounted at {{ f.containerPath }}</span>
              <span v-if="f.kind === 'service-env' && projectEnvPaths.has(f.path)">also fills in ${…} in the compose files</span>
            </p>
          </div>
          <button
            v-if="f.location === 'host' && f.exists"
            class="flex shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500 hover:text-white"
            @click="edit(f)"
          >
            <v-icon name="fa-pen" scale="0.55" /> Edit
          </button>
          <button
            v-else-if="f.location === 'host' && isEnv(f)"
            class="flex shrink-0 items-center gap-1 rounded-md bg-red-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-40"
            :disabled="!!working"
            @click="create(f)"
          >
            <v-icon :name="working === f.path ? 'fa-spinner' : 'fa-plus'" scale="0.55" :class="working === f.path && 'animate-spin'" /> Create
          </button>
          <button
            v-else-if="f.location === 'image' && info.compose?.service"
            class="flex shrink-0 items-center gap-1 rounded-md border border-amber-700 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
            :disabled="!!working"
            title="Copy it out to the server, mount it back, and recreate the container"
            @click="makeEditable(f)"
          >
            <v-icon :name="working === f.path ? 'fa-spinner' : 'fa-unlock'" scale="0.55" :class="working === f.path && 'animate-spin'" />
            Make editable
          </button>
          <span v-else-if="f.location === 'image'" class="shrink-0 text-[10px] text-slate-500" title="Not started by docker compose: nowhere to keep a mount">
            read-only
          </span>
        </div>
      </div>

      <p v-if="files.some((f) => isEnv(f))" class="text-[11px] text-slate-500">
        Changing a VITE_* value only takes effect after the image is rebuilt — it is compiled into the bundle.
      </p>

      <p v-if="!sections.length" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
        No config files found. This container wasn't started by docker compose and has no appsettings*.json, so its
        settings live in the container itself (see Inspect). To manage it with a file, redeploy it through
        <b>Deploy new</b>.
      </p>

      <button
        v-if="info.compose"
        class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white"
        @click="emit('openPath', { path: info.compose.workingDir, isDirectory: true })"
      >
        <v-icon name="fa-folder-open" scale="0.7" /> Browse {{ info.compose.workingDir }}
      </button>
    </template>

    <TextEditor v-if="editing" :file="editing.file" @close="editing = null" @saved="onSaved" @download="download" />

    <StepLog
      v-if="extractLog"
      title="Make appsettings editable"
      :steps="extractLog.steps"
      :running="extractLog.running"
      :error="extractLog.error"
      @close="extractLog = null"
    />
  </div>
</template>
