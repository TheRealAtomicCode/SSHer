<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail, notify } from '../toast';
import { isCancelled, trackUpload } from '../backgroundTasks';
import { newTransferId } from '../transferProgress';
import type { ComposeInfo, ComposeOp, Container, DockerImage, Session, StackRef, StepResult } from '../types';
import DeployWizard from './DeployWizard.vue';
import ContainerConfig from './ContainerConfig.vue';
import ContainerLinks from './ContainerLinks.vue';
import ContainerNetwork from './ContainerNetwork.vue';
import LogViewer from './LogViewer.vue';
import StacksView from './StacksView.vue';
import StepLog from './StepLog.vue';

/** `route` is the container + tab from the URL (#/docker/<name>/<tab>); the page reports
 *  its own changes back through the `route` event so Back/Forward work. */
const props = defineProps<{ session: Session; route?: { container?: string; tab?: string } }>();
const emit = defineEmits<{
  openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }];
  openLogs: [string];
  route: [{ container?: string; tab?: string }];
}>();

const tab = ref<'containers' | 'images' | 'stacks'>('containers');
/** A dropped .yml, or a project to open, handed to the Stacks tab. */
const incomingYml = ref<{ name: string; content: string } | null>(null);
const stackToOpen = ref<StackRef | null>(null);

function openStack(compose: ComposeInfo) {
  stackToOpen.value = { dir: compose.workingDir, files: compose.configFiles, project: compose.project };
  tab.value = 'stacks';
}
const loading = ref(true);
const available = ref(true);
const unavailableReason = ref('');
const version = ref('');
const containers = ref<Container[]>([]);
const images = ref<DockerImage[]>([]);
const busy = ref<Set<string>>(new Set());
const query = ref('');

const TABS = ['overview', 'links', 'network', 'config', 'logs', 'inspect'] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  overview: 'Overview',
  links: 'Connects to',
  network: 'Network',
  config: 'Config',
  logs: 'Logs',
  inspect: 'Inspect',
};

const selected = ref<Container | null>(null);
const detailTab = ref<(typeof TABS)[number]>('overview');
const inspectJson = ref('');
const revealSecrets = ref(false);

const wizard = ref<{ image: string; source: 'loaded' | 'local' | '' } | null>(null);
const opLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

const updateChoice = ref<{ image: string; containers: Container[] } | null>(null);

async function applyUpdate(c: Container) {
  updateChoice.value = null;
  if (c.compose) await composeOp(c.compose, 'redeploy', c);
}

function deployInstead() {
  const image = updateChoice.value?.image ?? '';
  updateChoice.value = null;
  wizard.value = { image, source: 'loaded' };
}

const dropping = ref(false);
let dragDepth = 0;

// ------------------------------------------------------------------- data

async function refresh() {
  loading.value = true;
  try {
    const [c, i] = await Promise.all([api.dockerContainers(), api.dockerImages().catch(() => ({ images: [] }))]);
    available.value = c.available;
    unavailableReason.value = c.error ?? '';
    version.value = c.version ?? '';
    containers.value = c.containers;
    images.value = i.images;
    // A recreated container has a new id, so fall back to its name to keep the panel open.
    if (selected.value) {
      const was = selected.value;
      selected.value = c.containers.find((x) => x.id === was.id) ?? c.containers.find((x) => x.name === was.name) ?? null;
    }
    applyRoute();
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

// ----------------------------------------------------------------- routing

/** Open (or close) the container panel the URL names. */
function applyRoute() {
  const want = props.route?.container;
  if (!want) {
    if (selected.value) selected.value = null;
    return;
  }
  const c = containers.value.find((x) => x.name === want);
  if (!c) return; // not loaded yet, or gone
  const tab = (TABS as readonly string[]).includes(props.route?.tab ?? '') ? (props.route!.tab as (typeof TABS)[number]) : 'overview';
  if (selected.value?.name !== c.name) openDetail(c, tab);
  else if (detailTab.value !== tab) detailTab.value = tab;
}

watch(() => [props.route?.container, props.route?.tab], applyRoute);
watch([() => selected.value?.name, detailTab], ([name, t]) => {
  emit('route', name ? { container: name, tab: t } : {});
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q
    ? containers.value.filter((c) => [c.name, c.image, c.compose?.project ?? ''].some((v) => v.toLowerCase().includes(q)))
    : containers.value;
});

/** Containers grouped by compose project; standalone ones go last. */
const groups = computed(() => {
  const map = new Map<string, { compose: ComposeInfo | null; items: Container[] }>();
  for (const c of filtered.value) {
    const key = c.compose?.project ?? '';
    if (!map.has(key)) map.set(key, { compose: c.compose, items: [] });
    map.get(key)!.items.push(c);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([key, g]) => ({ key, ...g }));
});

const runningCount = computed(() => containers.value.filter((c) => c.running).length);
const inUseImages = computed(() => new Set(containers.value.map((c) => c.image)));

/** Images have no folder of their own (they live inside Docker's store), so "open in
 *  folder" goes to where they're used: the compose project, else a running container's files. */
function imageFolder(img: DockerImage): string | null {
  const users = containers.value.filter((c) => c.image === img.ref);
  const composed = users.find((c) => c.compose?.workingDir);
  if (composed) return composed.compose!.workingDir;
  const running = users.find((c) => c.pid);
  return running ? `/proc/${running.pid}/root` : null;
}

// ---------------------------------------------------------------- actions

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function action(c: Container, act: 'start' | 'stop' | 'restart' | 'remove') {
  const verbs = { start: 'Start', stop: 'Stop', restart: 'Restart', remove: 'Remove' };
  if (act === 'stop' || act === 'remove') {
    const extra = act === 'remove' ? '\n\nThe container is deleted (volumes are kept).' : '';
    if (!confirm(`${verbs[act]} ${c.name}?${extra}`)) return;
  }
  setBusy(c.id, true);
  try {
    await api.dockerAction(c.id, act);
    notify(`${verbs[act]}ed ${c.name}`.replace('Stoped', 'Stopped').replace('Removeed', 'Removed'));
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    setBusy(c.id, false);
  }
}

const OP_TITLES: Record<ComposeOp, string> = {
  up: 'Apply compose changes',
  recreate: 'Recreate',
  restart: 'Restart',
  pull: 'Pull images',
  down: 'Stop & remove project',
  config: 'Validate compose files',
  update: 'Update to the latest image',
  rollback: 'Roll back to the previous image',
  destroy: 'Remove app',
  redeploy: 'Update to the new build',
};

/** Projects made by the deploy wizard have one compose file named docker-compose.yml (plus,
 *  once a connection was changed, SSHer's own ssher.override.yml). */
const isWizardProject = (c: ComposeInfo) => {
  const files = c.configFiles.filter((f) => f !== `${c.workingDir}/ssher.override.yml`);
  return files.length === 1 && files[0] === `${c.workingDir}/docker-compose.yml`;
};

async function composeOp(compose: ComposeInfo, op: ComposeOp, c?: Container) {
  const target = c ? `${compose.project} / ${compose.service}` : compose.project;
  const warn: Partial<Record<ComposeOp, string>> = {
    update: `Update ${target}?\n\nThe running image is tagged :rollback first, then the latest is pulled and the container is recreated (a few seconds of downtime).`,
    rollback: `Roll ${target} back to the :rollback image and recreate it?`,
    redeploy: `Switch ${target} to the build you just dropped?\n\nThe running version is kept as :rollback first (Roll back undoes this). A few seconds of downtime.`,
    down: `Stop and remove every container in ${compose.project}?\n\nVolumes are kept.`,
    recreate: `Recreate ${target}? (brief downtime)`,
    destroy:
      `Remove the app "${compose.project}" completely?\n\n` +
      `• stops and deletes its containers, network and volumes\n` +
      `• deletes its image (kept if another container uses it)\n` +
      `• removes its nginx site and ufw rules, if the wizard made any\n` +
      `• deletes ${compose.workingDir}\n\nThis cannot be undone.`,
  };
  if (warn[op] && !confirm(warn[op])) return;

  opLog.value = { title: `${OP_TITLES[op]} — ${target}`, steps: [], running: true, error: '' };
  if (c) setBusy(c.id, true);
  try {
    const res = await api.dockerCompose(
      compose,
      op,
      c ? { service: compose.service, image: c.image, imageId: c.imageId } : {},
    );
    opLog.value.steps = res.log;
    if (res.rollbackTag) notify(`Previous image kept as ${res.rollbackTag}`);
    await refresh();
  } catch (err) {
    opLog.value.steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    opLog.value.error = (err as Error).message;
  } finally {
    opLog.value.running = false;
    if (c) setBusy(c.id, false);
  }
}

async function removeImage(img: DockerImage) {
  if (!confirm(`Delete image ${img.ref}?`)) return;
  try {
    await api.dockerRemoveImage(img.ref);
    notify(`Deleted ${img.ref}`);
    await refresh();
  } catch (err) {
    fail(err);
  }
}

// ----------------------------------------------------------------- detail

function openDetail(c: Container, tabName: typeof detailTab.value = 'overview') {
  selected.value = c;
  detailTab.value = tabName;
  inspectJson.value = '';
  revealSecrets.value = false;
}

async function loadInspect() {
  if (!selected.value) return;
  try {
    inspectJson.value = JSON.stringify((await api.dockerInspect(selected.value.id)).inspect, null, 2);
  } catch (err) {
    fail(err);
  }
}

watch([detailTab, selected], ([t, sel], [oldT, oldSel]) => {
  if (!sel) return;
  const changed = t !== oldT || sel.id !== oldSel?.id;
  if (!changed) return;
  if (t === 'inspect') loadInspect();
});

const SECRET = /pass|secret|key|token|pwd|connectionstring/i;

/** Env from inspect, with secrets masked until revealed. */
const envList = computed(() => {
  if (!inspectJson.value) return [];
  const env = ((JSON.parse(inspectJson.value) as { Config?: { Env?: string[] } }).Config?.Env ?? []).map((e) => {
    const i = e.indexOf('=');
    return { key: e.slice(0, i), value: e.slice(i + 1) };
  });
  return env.map((e) => ({ ...e, masked: !revealSecrets.value && SECRET.test(e.key) }));
});

watch(detailTab, (t) => {
  if (t === 'overview' && !inspectJson.value) loadInspect();
});
watch(selected, (s) => {
  if (s && detailTab.value === 'overview') loadInspect();
});

/** After a file was saved in the Config tab. */
function onConfigApply(how: 'up' | 'restart') {
  const c = selected.value;
  if (!c) return;
  if (how === 'up' && c.compose) composeOp(c.compose, 'up');
  else action(c, 'restart');
}

// --------------------------------------------------------- drop to deploy

function isTar(name: string) {
  return /\.(tar|tar\.gz|tgz|tar\.xz|tar\.zst)$/i.test(name);
}

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
  if (file) await loadFile(file);
}

/** A compose file starts a new stack; anything else is treated as an image archive. */
async function loadFile(file: File) {
  if (/\.(ya?ml)$/i.test(file.name)) {
    incomingYml.value = { name: file.name, content: await file.text() };
    tab.value = 'stacks';
    return;
  }
  await loadImageFile(file);
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await loadFile(file);
}

async function loadImageFile(file: File) {
  if (!isTar(file.name)) {
    fail(new Error(`${file.name} is not an image archive. Drop the .tar (or .tar.gz) made by: docker save -o app.tar your-image:tag`));
    return;
  }
  const transferId = newTransferId();
  // Progress (and the cancel button) live in the background-tasks tray, which also
  // picks the job up again if the page is reloaded mid-way.
  const task = trackUpload(transferId, file.name, 'docker load');
  try {
    const res = await api.dockerLoad(file, task.progress, transferId, task.signal);
    task.settle();
    if (!res.images.length) throw new Error(`docker load did not report an image:\n${res.output}`);
    notify(`Loaded ${res.images.join(', ')}`);
    await refresh();
    // A new build of an image that is already running is an update, not a new app.
    const running = containers.value.filter((c) => c.compose && res.images.includes(c.image));
    if (running.length) updateChoice.value = { image: res.images[0], containers: running };
    else wizard.value = { image: res.images[0], source: 'loaded' };
  } catch (err) {
    task.settle(err);
    if (isCancelled(err)) notify(`Cancelled ${file.name}`);
    else fail(err);
  }
}

// ------------------------------------------------------------------ misc

function since(iso: string): string {
  const t = Date.parse(iso);
  if (!t || t < 0) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function stateTone(c: Container) {
  if (c.running) return c.health === 'unhealthy' ? 'bg-amber-400' : 'bg-emerald-400';
  if (c.state === 'restarting') return 'bg-amber-400 animate-pulse';
  return 'bg-slate-600';
}

function portLabel(p: Container['ports'][number]) {
  if (!p.hostPort) return `${p.containerPort}/${p.proto}`;
  const ip = p.hostIp === '0.0.0.0' || p.hostIp === '::' ? '' : `${p.hostIp}:`;
  return `${ip}${p.hostPort}→${p.containerPort}`;
}

onMounted(refresh);


const btn = 'rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-30';
</script>

<template>
  <div
    class="relative flex min-h-0 flex-1"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Header -->
      <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
        <v-icon name="fa-docker" scale="1.3" class="text-sky-400" />
        <div>
          <h1 class="text-base font-semibold text-white">Docker</h1>
          <p class="text-xs text-slate-500">
            <template v-if="available">
              Engine {{ version }} · {{ runningCount }}/{{ containers.length }} running · {{ images.length }} images
            </template>
            <template v-else>Not available</template>
          </p>
        </div>
        <div class="ml-4 flex rounded-lg border border-slate-700 p-0.5 text-xs">
          <button
            v-for="t in ['containers', 'stacks', 'images'] as const"
            :key="t"
            class="rounded-md px-3 py-1 capitalize transition"
            :class="tab === t ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
            @click="tab = t"
          >
            {{ t }}
          </button>
        </div>
        <div class="flex-1" />
        <div class="relative">
          <v-icon name="fa-search" scale="0.65" class="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-500" />
          <input
            v-model="query"
            placeholder="Filter…"
            class="w-44 rounded-lg border border-slate-700 bg-slate-900 py-1.5 pr-2 pl-7 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
          />
        </div>
        <button :class="btn" title="Refresh" @click="refresh">
          <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
          :disabled="!available"
          @click="wizard = { image: '', source: '' }"
        >
          <v-icon name="fa-rocket" scale="0.75" /> Deploy new
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-5">
        <div v-if="!available && !loading" class="rounded-xl border border-amber-800/50 bg-amber-950/30 p-6 text-sm text-amber-200">
          <p class="font-medium">Docker isn't usable on this server.</p>
          <pre class="mt-2 font-mono text-xs whitespace-pre-wrap text-amber-100/70">{{ unavailableReason }}</pre>
          <p class="mt-3 text-xs">Install it with <code class="rounded bg-slate-900 px-1">curl -fsSL https://get.docker.com | sh</code>.</p>
        </div>

        <template v-else>
          <!-- Drop zone -->
          <label
            class="mb-5 flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/40 px-5 py-4 transition hover:border-sky-600 hover:bg-sky-500/5"
          >
            <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 ring-1 ring-sky-500/30">
              <v-icon name="fa-file-upload" class="text-sky-300" scale="1.1" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-white">Drag & drop a Docker image (.tar) or a compose file (.yml) here</p>
              <p class="text-xs text-slate-500">
                A .tar from <code class="text-slate-400">docker save -o app.tar my-app:latest</code> — it's uploaded,
                loaded with docker load, then the wizard asks the port, domain and storage.
              </p>
            </div>
            <span class="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Choose file</span>
            <input type="file" accept=".tar,.gz,.tgz,.xz,.zst,.yml,.yaml" class="hidden" @change="onPick" />
          </label>

          <!-- Containers -->
          <template v-if="tab === 'containers'">
            <div v-if="loading && !containers.length" class="py-16 text-center">
              <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" />
            </div>
            <p v-else-if="!containers.length" class="py-10 text-center text-sm text-slate-500">
              No containers yet. Drop an image above or press Deploy new.
            </p>

            <div v-for="g in groups" :key="g.key" class="mb-5 overflow-hidden rounded-xl border border-slate-800">
              <div class="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
                <v-icon :name="g.compose ? 'fa-cubes' : 'fa-cube'" scale="0.85" class="text-sky-400" />
                <span class="text-sm font-semibold text-white">{{ g.compose ? g.compose.project : 'Standalone containers' }}</span>
                <span v-if="g.compose" class="truncate font-mono text-[11px] text-slate-500">{{ g.compose.workingDir }}</span>
                <div class="flex-1" />
                <template v-if="g.compose">
                  <button
                    class="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
                    title="Open the project folder in the File Explorer"
                    @click="emit('openPath', { path: g.compose.workingDir, isDirectory: true })"
                  >
                    <v-icon name="fa-folder-open" scale="0.7" /> Folder
                  </button>
                  <button
                    class="rounded-md px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/10"
                    title="Its settings as a form, its images, and deploy"
                    @click="openStack(g.compose)"
                  >
                    <v-icon name="fa-sliders-h" scale="0.7" /> Settings
                  </button>
                  <button class="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white" @click="composeOp(g.compose, 'config')">
                    <v-icon name="fa-check" scale="0.7" /> Validate
                  </button>
                  <button class="rounded-md px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/10" @click="composeOp(g.compose, 'up')">
                    <v-icon name="fa-play" scale="0.7" /> Apply (up -d)
                  </button>
                  <button
                    v-if="isWizardProject(g.compose)"
                    class="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                    title="Delete this app and everything the deploy wizard created for it"
                    @click="composeOp(g.compose, 'destroy')"
                  >
                    <v-icon name="fa-trash-alt" scale="0.7" /> Remove app
                  </button>
                </template>
              </div>

              <div
                v-for="c in g.items"
                :key="c.id"
                class="flex flex-wrap items-center gap-3 border-b border-slate-800/70 bg-slate-950/40 px-4 py-2.5 last:border-b-0 hover:bg-slate-900/60"
                :class="selected?.id === c.id && 'bg-sky-500/5'"
              >
                <span class="h-2 w-2 shrink-0 rounded-full" :class="stateTone(c)" :title="c.state" />
                <button class="min-w-0 flex-1 text-left" @click="openDetail(c)">
                  <p class="truncate text-sm font-medium text-white">
                    {{ c.compose?.service || c.name }}
                    <span class="ml-1 text-xs font-normal text-slate-500">{{ c.running ? `up ${since(c.startedAt)}` : c.state }}</span>
                    <span
                      v-if="c.state === 'restarting'"
                      class="ml-2 cursor-pointer rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] font-semibold text-red-200 hover:bg-red-800"
                      title="It keeps crashing — open its logs to see why"
                      @click.stop="emit('openLogs', c.name)"
                    >
                      CRASHING · see logs
                    </span>
                  </p>
                  <p class="truncate font-mono text-[11px] text-slate-500">{{ c.image }}</p>
                </button>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="(p, i) in c.ports"
                    :key="i"
                    class="rounded px-1.5 py-0.5 font-mono text-[10px]"
                    :class="p.hostIp === '127.0.0.1' ? 'bg-slate-800 text-slate-300' : p.hostPort ? 'bg-amber-900/50 text-amber-200' : 'bg-slate-900 text-slate-500'"
                    :title="p.hostIp === '127.0.0.1' ? 'Local only (behind nginx)' : p.hostPort ? 'Published on all interfaces' : 'Not published'"
                  >
                    {{ portLabel(p) }}
                  </span>
                </div>
                <div class="flex items-center">
                  <v-icon v-if="busy.has(c.id)" name="fa-spinner" scale="0.8" class="mx-2 animate-spin text-sky-400" />
                  <button v-if="!c.running" :class="btn" title="Start" @click="action(c, 'start')">
                    <v-icon name="fa-play" scale="0.75" class="text-emerald-400" />
                  </button>
                  <button v-else :class="btn" title="Stop" @click="action(c, 'stop')">
                    <v-icon name="fa-stop" scale="0.75" />
                  </button>
                  <button :class="btn" title="Restart" :disabled="busy.has(c.id)" @click="action(c, 'restart')">
                    <v-icon name="fa-redo" scale="0.75" />
                  </button>
                  <button :class="btn" title="Logs" @click="openDetail(c, 'logs')">
                    <v-icon name="fa-terminal" scale="0.75" />
                  </button>
                  <button :class="btn" title="Config files" @click="openDetail(c, 'config')">
                    <v-icon name="fa-cog" scale="0.75" />
                  </button>
                  <span
                    v-if="c.compose && c.imageLocal"
                    class="ml-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
                    title="This image came from a file. To update it, drop the new .tar file on this page."
                  >
                    from file
                  </span>
                  <button
                    v-else-if="c.compose"
                    :class="btn"
                    title="Update: tag current image as :rollback, pull latest, recreate"
                    :disabled="busy.has(c.id)"
                    @click="composeOp(c.compose, 'update', c)"
                  >
                    <v-icon name="fa-cloud-download-alt" scale="0.8" class="text-sky-300" />
                  </button>
                </div>
              </div>
            </div>
          </template>

          <StacksView
            v-else-if="tab === 'stacks'"
            :query="query"
            :incoming="incomingYml"
            :open-ref="stackToOpen"
            @consumed="incomingYml = null; stackToOpen = null"
            @changed="refresh"
            @open-path="emit('openPath', $event)"
            @open-logs="emit('openLogs', $event)"
          />

          <!-- Images -->
          <div v-else class="overflow-hidden rounded-xl border border-slate-800">
            <table class="w-full text-sm">
              <thead class="bg-slate-900 text-left text-xs text-slate-500">
                <tr>
                  <th class="px-4 py-2 font-medium">Image</th>
                  <th class="px-4 py-2 font-medium">Size</th>
                  <th class="px-4 py-2 font-medium">Created</th>
                  <th class="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="img in images.filter((i) => !query || i.ref.toLowerCase().includes(query.toLowerCase()))"
                  :key="img.id + img.tag"
                  class="border-t border-slate-800/70 hover:bg-slate-900/60"
                >
                  <td class="px-4 py-2">
                    <p class="font-mono text-xs text-slate-200">{{ img.repository }}<span class="text-sky-300">:{{ img.tag }}</span></p>
                    <p class="font-mono text-[10px] text-slate-600">
                      {{ img.id }}
                      <span v-if="inUseImages.has(img.ref)" class="ml-1 text-emerald-500">● in use</span>
                      <span v-if="img.tag.startsWith('rollback')" class="ml-1 text-amber-500">rollback copy</span>
                    </p>
                  </td>
                  <td class="px-4 py-2 text-xs text-slate-400">{{ img.size }}</td>
                  <td class="px-4 py-2 text-xs text-slate-400">{{ img.created }}</td>
                  <td class="px-4 py-2 text-right whitespace-nowrap">
                    <button class="rounded-md px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/10" @click="wizard = { image: img.ref, source: 'local' }">
                      <v-icon name="fa-rocket" scale="0.65" /> Deploy
                    </button>
                    <button
                      :class="btn"
                      :disabled="!imageFolder(img)"
                      :title="imageFolder(img) ? `Open ${imageFolder(img)}` : 'No folder: images live inside Docker\'s store. Open a container made from it to browse its files.'"
                      @click="imageFolder(img) && emit('openPath', { path: imageFolder(img)!, isDirectory: true })"
                    >
                      <v-icon name="fa-folder-open" scale="0.7" />
                    </button>
                    <button :class="btn" title="Delete image" @click="removeImage(img)">
                      <v-icon name="fa-trash-alt" scale="0.7" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <!-- Detail drawer -->
    <aside v-if="selected" class="flex w-[30rem] max-w-[50vw] shrink-0 flex-col border-l border-slate-800 bg-slate-900">
      <div class="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span class="h-2 w-2 rounded-full" :class="stateTone(selected)" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-white">{{ selected.name }}</p>
          <p class="truncate font-mono text-[11px] text-slate-500">{{ selected.image }}</p>
        </div>
        <button :class="btn" @click="selected = null"><v-icon name="fa-times" scale="0.8" /></button>
      </div>
      <div class="flex gap-0.5 overflow-x-auto border-b border-slate-800 px-3 pt-2 text-xs">
        <button
          v-for="t in TABS"
          :key="t"
          class="rounded-t-md border-b-2 px-2.5 py-1.5 whitespace-nowrap transition"
          :class="detailTab === t ? 'border-sky-400 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'"
          @click="detailTab = t"
        >
          {{ TAB_LABELS[t] }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-4 text-sm">
        <!-- Overview -->
        <div v-if="detailTab === 'overview'" class="space-y-4">
          <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt class="text-slate-500">State</dt>
            <dd class="text-slate-200">{{ selected.state }}<span v-if="selected.health"> · {{ selected.health }}</span></dd>
            <dt class="text-slate-500">Started</dt>
            <dd class="text-slate-200">{{ new Date(selected.startedAt).toLocaleString() }}</dd>
            <dt class="text-slate-500">Restart policy</dt>
            <dd class="text-slate-200">{{ selected.restartPolicy }}</dd>
            <dt class="text-slate-500">Networks</dt>
            <dd class="font-mono text-slate-200">{{ selected.networks.join(', ') }}</dd>
            <dt class="text-slate-500">Ports</dt>
            <dd class="font-mono text-slate-200">{{ selected.ports.map(portLabel).join(', ') || '—' }}</dd>
            <template v-if="selected.compose">
              <dt class="text-slate-500">Compose</dt>
              <dd class="text-slate-200">{{ selected.compose.project }} / {{ selected.compose.service }}</dd>
            </template>
          </dl>

          <div v-if="selected.mounts.length">
            <p class="mb-1.5 text-xs font-medium text-slate-400">Mounts</p>
            <div v-for="m in selected.mounts" :key="m.destination" class="mb-1 flex items-center gap-2 font-mono text-[11px]">
              <button
                class="truncate text-sky-300 hover:underline"
                :title="`Open ${m.source} in the File Explorer`"
                @click="emit('openPath', { path: m.source, isDirectory: true })"
              >
                {{ m.source }}
              </button>
              <v-icon name="fa-arrow-right" scale="0.55" class="shrink-0 text-slate-600" />
              <span class="truncate text-slate-300">{{ m.destination }}</span>
              <span v-if="!m.rw" class="text-slate-500">ro</span>
            </div>
          </div>

          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <p class="text-xs font-medium text-slate-400">Environment</p>
              <button class="text-[11px] text-slate-500 hover:text-white" @click="revealSecrets = !revealSecrets">
                <v-icon :name="revealSecrets ? 'fa-eye-slash' : 'fa-eye'" scale="0.6" />
                {{ revealSecrets ? 'Hide secrets' : 'Show secrets' }}
              </button>
            </div>
            <div class="space-y-0.5 rounded-lg bg-slate-950 p-2 font-mono text-[11px]">
              <p v-for="e in envList" :key="e.key" class="break-all">
                <span class="text-sky-300">{{ e.key }}</span><span class="text-slate-600">=</span>
                <span :class="e.masked ? 'text-slate-600' : 'text-slate-300'">{{ e.masked ? '••••••••' : e.value }}</span>
              </p>
              <p v-if="!envList.length" class="text-slate-600">Loading…</p>
            </div>
          </div>

          <div>
            <p class="mb-1.5 text-xs font-medium text-slate-400">Open in folder</p>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-if="selected.pid"
                class="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-sky-500"
                title="Browse the running container's own filesystem (/proc/<pid>/root)"
                @click="emit('openPath', { path: `/proc/${selected.pid}/root`, isDirectory: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> Container's files
              </button>
              <button
                v-if="selected.compose"
                class="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-sky-500"
                @click="emit('openPath', { path: selected.compose.workingDir, isDirectory: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> Compose project
              </button>
              <button
                v-if="selected.logPath"
                class="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-sky-500"
                :title="selected.logPath"
                @click="emit('openPath', { path: selected.logPath, isDirectory: false, reveal: true })"
              >
                <v-icon name="fa-folder-open" scale="0.6" /> Log file
              </button>
            </div>
          </div>

          <div class="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
            <template v-if="selected.compose">
              <button class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500" @click="composeOp(selected.compose, 'recreate', selected)">
                <v-icon name="fa-redo" scale="0.65" /> Recreate
              </button>
              <button
                v-if="!selected.imageLocal"
                class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500"
                @click="composeOp(selected.compose, 'update', selected)"
              >
                <v-icon name="fa-cloud-download-alt" scale="0.65" /> Update image
              </button>
              <button class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-amber-300 hover:border-amber-500" @click="composeOp(selected.compose, 'rollback', selected)">
                <v-icon name="fa-history" scale="0.65" /> Roll back
              </button>
            </template>
            <button class="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950" @click="action(selected, 'remove')">
              <v-icon name="fa-trash-alt" scale="0.65" /> Remove container
            </button>
          </div>
        </div>

        <!-- What it connects to -->
        <ContainerLinks v-else-if="detailTab === 'links'" :key="selected.id" :container="selected" @changed="refresh" />

        <!-- Network -->
        <ContainerNetwork v-else-if="detailTab === 'network'" :key="selected.id" :container="selected" />

        <!-- Config files -->
        <div v-else-if="detailTab === 'config'" class="space-y-3">
          <div v-if="selected.compose" class="flex flex-wrap gap-1.5">
            <button
              class="flex items-center gap-1.5 rounded-lg border border-sky-800 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/10"
              title="Every setting in its compose file as a form, its images, and deploy"
              @click="openStack(selected.compose)"
            >
              <v-icon name="fa-sliders-h" scale="0.7" /> Edit its settings as a form
            </button>
            <button
              v-for="f in selected.compose.configFiles"
              :key="f"
              class="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500"
              :title="`Show ${f} in the File Explorer`"
              @click="emit('openPath', { path: f, isDirectory: false, reveal: true })"
            >
              <v-icon name="fa-folder-open" scale="0.65" /> <span class="truncate font-mono">{{ f.split('/').pop() }}</span>
            </button>
          </div>
          <ContainerConfig
            :key="selected.id"
            :container="selected"
            @open-path="emit('openPath', $event)"
            @apply="onConfigApply"
            @changed="refresh"
          />
        </div>

        <!-- Logs -->
        <div v-else-if="detailTab === 'logs'" class="flex h-full flex-col">
          <LogViewer
            :key="selected.name"
            :container="selected.name"
            compact
            class="min-h-0 flex-1"
            @open-path="emit('openPath', $event)"
          />
          <button class="mt-2 self-start text-[11px] text-sky-400 hover:text-sky-300" @click="emit('openLogs', selected.name)">
            Open in the Logs page →
          </button>
        </div>

        <!-- Inspect -->
        <pre v-else class="overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300">{{ inspectJson || 'Loading…' }}</pre>
      </div>
    </aside>

    <!-- Overlays -->
    <div
      v-if="dropping"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm"
    >
      <div class="rounded-2xl border-2 border-dashed border-sky-400 bg-slate-900/90 px-10 py-8 text-center">
        <v-icon name="fa-docker" scale="3" class="text-sky-400" />
        <p class="mt-3 text-base font-semibold text-white">Drop the image to deploy it</p>
        <p class="mt-1 text-xs text-slate-400">.tar / .tar.gz from docker save</p>
      </div>
    </div>

    <!-- A dropped build that matches a running app -->
    <div
      v-if="updateChoice"
      data-modal
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      @click.self="updateChoice = null"
    >
      <div class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="flex items-center gap-2 font-semibold text-white">
          <v-icon name="fa-cloud-download-alt" class="text-sky-400" /> New build loaded
        </h2>
        <p class="mt-1 text-sm text-slate-400">
          <span class="font-mono text-slate-200">{{ updateChoice.image }}</span> is already running. Update it to
          this build?
        </p>
        <div class="mt-4 space-y-2">
          <button
            v-for="c in updateChoice.containers"
            :key="c.id"
            class="flex w-full items-center gap-3 rounded-lg border border-sky-700/60 bg-sky-500/10 px-3 py-2.5 text-left hover:bg-sky-500/20"
            @click="applyUpdate(c)"
          >
            <v-icon name="fa-redo" scale="0.8" class="text-sky-300" />
            <span class="flex-1">
              <span class="block text-sm font-medium text-white">Update {{ c.compose?.project }}</span>
              <span class="block text-[11px] text-slate-400">Keeps the current version as :rollback</span>
            </span>
          </button>
        </div>
        <div class="mt-4 flex justify-between">
          <button class="text-xs text-slate-400 hover:text-white" @click="deployInstead">Deploy as a new app instead</button>
          <button class="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800" @click="updateChoice = null">Cancel</button>
        </div>
      </div>
    </div>

    <DeployWizard
      v-if="wizard"
      :image="wizard.image"
      :source="wizard.source"
      @close="wizard = null"
      @deployed="refresh"
    />

    <StepLog
      v-if="opLog"
      :title="opLog.title"
      :steps="opLog.steps"
      :running="opLog.running"
      :error="opLog.error"
      @close="opLog = null"
    />

  </div>
</template>
