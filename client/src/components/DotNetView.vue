<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { fail, notify } from '../toast';
import { newTransferId, watchTransfer } from '../transferProgress';
import type { DotnetApp, DotnetContext, DotnetInspectResult } from '../types';
import DotnetDeployWizard from './DotnetDeployWizard.vue';

const loading = ref(true);
const apps = ref<DotnetApp[]>([]);
const busy = ref<Set<string>>(new Set());

const dotnetContext = ref<DotnetContext | null>(null);
const installChannel = ref('8.0');
const installingRuntime = ref(false);
const installOutput = ref('');

async function installDotnet() {
  installingRuntime.value = true;
  installOutput.value = '';
  try {
    const res = await api.dotnetInstallRuntime('Microsoft.AspNetCore.App', `${installChannel.value}.0`);
    installOutput.value = res.output;
    notify('.NET installed');
    dotnetContext.value = await api.dotnetContext().catch(() => dotnetContext.value);
  } catch (err) {
    installOutput.value = (err as Error).message;
  } finally {
    installingRuntime.value = false;
  }
}

const dropping = ref(false);
const inspecting = ref(false);
const inspectProgress = ref<number | null>(null);
const inspectStage = ref('Uploading…');
let dragDepth = 0;

/** Set when a drop/pick is meant to replace an existing app rather than create a new one. */
const redeployTarget = ref('');
const wizard = ref<DotnetInspectResult | null>(null);

async function refresh() {
  loading.value = true;
  try {
    apps.value = (await api.dotnetApps()).apps;
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const runningCount = computed(() => apps.value.filter((a) => a.state === 'active').length);

function setBusy(name: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(name);
  else next.delete(name);
  busy.value = next;
}

async function action(a: DotnetApp, act: 'start' | 'stop' | 'restart' | 'remove') {
  const verbs = { start: 'Start', stop: 'Stop', restart: 'Restart', remove: 'Remove' };
  if (act === 'remove' && !confirm(`Remove ${a.name}?\n\nStops and disables the service, deletes its unit file and ${a.dir}. This cannot be undone.`)) return;
  setBusy(a.name, true);
  try {
    await api.dotnetAction(a.name, act);
    notify(`${verbs[act]}ed ${a.name}`.replace('Stoped', 'Stopped').replace('Removeed', 'Removed'));
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    setBusy(a.name, false);
  }
}

function isZip(name: string) {
  return /\.zip$/i.test(name);
}

async function inspectFile(file: File) {
  if (!isZip(file.name)) {
    fail(new Error(`${file.name} is not a .zip. Drop the output of: dotnet publish -c Release -o out  (then zip the out/ folder)`));
    return;
  }
  const redeployName = redeployTarget.value;
  redeployTarget.value = '';
  inspecting.value = true;
  inspectProgress.value = 0;
  inspectStage.value = 'Uploading…';
  const transferId = newTransferId();
  let watching = false;
  let stopWatch = () => {};
  try {
    const res = await api.dotnetInspect(
      file,
      (p) => {
        inspectProgress.value = p;
        // Browser progress only covers getting the zip to this server — the
        // relay on to the actual remote target afterward was previously
        // invisible.
        if (p >= 100 && !watching) {
          watching = true;
          inspectStage.value = 'Copying to the server…';
          inspectProgress.value = 0;
          stopWatch = watchTransfer(transferId, (state) => {
            inspectProgress.value = state.total ? Math.round((state.transferred / state.total) * 100) : 0;
          });
        }
      },
      transferId,
    );
    wizard.value = redeployName ? { ...res, suggestedName: redeployName } : res;
  } catch (err) {
    fail(err);
  } finally {
    stopWatch();
    inspecting.value = false;
    inspectProgress.value = null;
  }
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
  if (file) await inspectFile(file);
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await inspectFile(file);
}

const redeployPicker = ref<HTMLInputElement | null>(null);

function redeploy(a: DotnetApp) {
  redeployTarget.value = a.name;
  redeployPicker.value?.click();
}

function onWizardDeployed() {
  wizard.value = null;
  refresh();
}

onMounted(async () => {
  await refresh();
  dotnetContext.value = await api.dotnetContext().catch(() => null);
});

const btn = 'rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-30';
const STATE_TONE: Record<string, string> = {
  active: 'bg-emerald-400',
  failed: 'bg-red-400',
  activating: 'bg-amber-400 animate-pulse',
};
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
      <v-icon name="si-dotnet" scale="1.3" class="text-sky-400" />
      <div>
        <h1 class="text-base font-semibold text-white">.NET apps</h1>
        <p class="text-xs text-slate-500">{{ runningCount }}/{{ apps.length }} running</p>
      </div>
      <div class="flex-1" />
      <button :class="btn" title="Refresh" @click="refresh">
        <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <!-- Not installed -->
      <div v-if="dotnetContext && !dotnetContext.available" class="mb-5 rounded-xl border border-amber-800/50 bg-amber-950/30 p-4 text-sm text-amber-200">
        <p class="font-medium">.NET isn't installed on this server.</p>
        <p class="mt-1 text-xs text-amber-300/80">
          Installs the ASP.NET Core runtime via Microsoft's official script (not a guessed distro package name,
          which varies and often lags behind). Pick the version your app targets — 8.0 is the current LTS.
        </p>
        <div class="mt-3 flex items-center gap-2">
          <select v-model="installChannel" class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none">
            <option value="6.0">6.0 (old LTS)</option>
            <option value="8.0">8.0 (LTS)</option>
            <option value="9.0">9.0</option>
          </select>
          <button
            class="flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-60"
            :disabled="installingRuntime"
            @click="installDotnet"
          >
            <v-icon :name="installingRuntime ? 'fa-spinner' : 'fa-cloud-download-alt'" :class="installingRuntime && 'animate-spin'" scale="0.75" />
            {{ installingRuntime ? 'Installing…' : 'Install .NET' }}
          </button>
        </div>
        <pre v-if="installOutput" class="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950/60 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-amber-100/70">{{ installOutput }}</pre>
      </div>

      <!-- Drop zone -->
      <label
        class="mb-5 flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed border-slate-700 bg-slate-900/40 px-5 py-4 transition hover:border-sky-600 hover:bg-sky-500/5"
      >
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 ring-1 ring-sky-500/30">
          <v-icon :name="inspecting ? 'fa-spinner' : 'fa-file-upload'" :class="inspecting && 'animate-spin'" class="text-sky-300" scale="1.1" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-white">Drag & drop a .NET publish output here to deploy it</p>
          <p class="text-xs text-slate-500">
            A .zip of <code class="text-slate-400">dotnet publish -c Release -o out</code>'s <code class="text-slate-400">out/</code>
            folder — the required runtime is checked, and you'll be told if it needs installing first.
          </p>
        </div>
        <span class="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Choose file</span>
        <input type="file" accept=".zip" class="hidden" @change="onPick" />
      </label>
      <input ref="redeployPicker" type="file" accept=".zip" class="hidden" @change="onPick" />

      <div v-if="loading && !apps.length" class="py-16 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" />
      </div>
      <p v-else-if="!apps.length" class="py-10 text-center text-sm text-slate-500">
        No .NET apps deployed yet. Drop a publish .zip above.
      </p>

      <div v-else class="overflow-hidden rounded-xl border border-slate-800">
        <div
          v-for="a in apps"
          :key="a.name"
          class="flex flex-wrap items-center gap-3 border-b border-slate-800/70 bg-slate-950/40 px-4 py-3 last:border-b-0 hover:bg-slate-900/60"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" :class="STATE_TONE[a.state] ?? 'bg-slate-600'" :title="a.state" />
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium text-white">
              {{ a.name }}
              <span class="ml-1 text-xs font-normal text-slate-500">{{ a.state }}</span>
            </p>
            <p class="truncate font-mono text-[11px] text-slate-500">127.0.0.1:{{ a.port }} · {{ a.dir }}</p>
          </div>
          <div class="flex items-center">
            <v-icon v-if="busy.has(a.name)" name="fa-spinner" scale="0.8" class="mx-2 animate-spin text-sky-400" />
            <button v-if="a.state !== 'active'" :class="btn" title="Start" @click="action(a, 'start')">
              <v-icon name="fa-play" scale="0.75" class="text-emerald-400" />
            </button>
            <button v-else :class="btn" title="Stop" @click="action(a, 'stop')">
              <v-icon name="fa-stop" scale="0.75" />
            </button>
            <button :class="btn" title="Restart" :disabled="busy.has(a.name)" @click="action(a, 'restart')">
              <v-icon name="fa-redo" scale="0.75" />
            </button>
            <button :class="btn" title="Redeploy from a new publish .zip" @click="redeploy(a)">
              <v-icon name="fa-cloud-upload-alt" scale="0.8" />
            </button>
            <button :class="btn" title="Remove" :disabled="busy.has(a.name)" @click="action(a, 'remove')">
              <v-icon name="fa-trash-alt" scale="0.75" class="text-red-400" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Overlays -->
    <div
      v-if="dropping"
      class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-sky-500/10 backdrop-blur-sm"
    >
      <div class="rounded-2xl border-2 border-dashed border-sky-400 bg-slate-900/90 px-10 py-8 text-center">
        <v-icon name="si-dotnet" scale="3" class="text-sky-400" />
        <p class="mt-3 text-base font-semibold text-white">Drop the publish .zip to deploy it</p>
      </div>
    </div>

    <div
      v-if="inspectProgress !== null"
      class="fixed bottom-4 left-1/2 z-40 w-96 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
    >
      <div class="mb-1.5 flex justify-between gap-2 text-xs text-slate-400">
        <span>{{ inspectStage }}</span>
        <span class="tabular-nums">{{ inspectProgress }}%</span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div class="h-full rounded-full bg-sky-500 transition-all duration-200" :style="{ width: `${inspectProgress}%` }" />
      </div>
    </div>

    <DotnetDeployWizard
      v-if="wizard"
      :inspect="wizard"
      @close="wizard = null"
      @deployed="onWizardDeployed"
    />
  </div>
</template>
