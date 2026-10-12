<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail } from '../toast';
import type { DotnetApp, DotnetContext, DotnetDeploySpec, DotnetInspectResult, StepResult } from '../types';

const props = defineProps<{ inspect: DotnetInspectResult }>();
const emit = defineEmits<{ close: []; deployed: [] }>();

const STEPS = ['Runtime', 'Basics', 'Network', 'Review'] as const;
const step = ref(0);
const ctx = ref<DotnetContext | null>(null);
const existingApps = ref<DotnetApp[]>([]);
const installing = ref(false);
const installOutput = ref('');
const installedNow = ref(false);
const deploying = ref(false);
const result = ref<{ log: StepResult[]; error: string; url: string; done: boolean } | null>(null);

const spec = reactive<DotnetDeploySpec>({
  stagingDir: props.inspect.stagingDir,
  mainDll: props.inspect.mainDll,
  name: props.inspect.suggestedName,
  port: null,
  env: [],
  domain: '',
  maxBody: '100m',
  overwrite: false,
});

function freePort(from: number): number {
  const used = new Set(ctx.value?.usedPorts ?? []);
  let p = from;
  while (used.has(p) && p < 65535) p++;
  return p;
}

const portInUse = computed(() => spec.port !== null && (ctx.value?.usedPorts ?? []).includes(spec.port));
const nameExists = computed(() => existingApps.value.some((a) => a.name === spec.name));
const runtimeOk = computed(() => props.inspect.selfContained || !props.inspect.required || props.inspect.compatible || installedNow.value);

const canNext = computed(() => {
  if (step.value === 0) return runtimeOk.value;
  if (step.value === 1) return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(spec.name) && Boolean(spec.port) && !portInUse.value;
  return true;
});

function next() {
  if (!canNext.value) return;
  step.value++;
}

async function installRuntime() {
  if (!props.inspect.required) return;
  installing.value = true;
  installOutput.value = '';
  try {
    const res = await api.dotnetInstallRuntime(props.inspect.required.name, props.inspect.required.version);
    installOutput.value = res.output;
    installedNow.value = true;
  } catch (err) {
    installOutput.value = (err as Error).message;
  } finally {
    installing.value = false;
  }
}

function addEnv() {
  spec.env.push({ key: '', value: '' });
}

async function deploy() {
  if (result.value?.error) spec.overwrite = true;
  deploying.value = true;
  result.value = { log: [], error: '', url: '', done: false };
  try {
    const res = await api.dotnetDeploy(spec);
    result.value = { log: res.log, error: '', url: res.url, done: true };
    emit('deployed');
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    result.value = { log, error: (err as Error).message, url: '', done: false };
  } finally {
    deploying.value = false;
  }
}

onMounted(async () => {
  try {
    const [c, apps] = await Promise.all([api.dotnetContext(), api.dotnetApps()]);
    ctx.value = c;
    existingApps.value = apps.apps;
    spec.port = freePort(5000);
  } catch (err) {
    fail(err);
  }
});

const field =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
const hint = 'mt-1 text-[11px] text-slate-500';
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
  >
    <div class="flex max-h-[92vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <div class="border-b border-slate-800 px-6 pt-4 pb-3">
        <div class="mb-3 flex items-center gap-2">
          <v-icon name="si-dotnet" class="text-sky-400" />
          <h2 class="flex-1 text-base font-semibold text-white">Deploy a .NET app</h2>
          <button v-if="!deploying" class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
            <v-icon name="fa-times" scale="0.85" />
          </button>
        </div>
        <ol class="flex gap-1">
          <li v-for="(s, i) in STEPS" :key="s" class="flex-1">
            <button :disabled="i > step || Boolean(result)" class="w-full text-left" @click="step = i">
              <div class="h-1 rounded-full" :class="i <= step ? 'bg-sky-500' : 'bg-slate-800'" />
              <p class="mt-1.5 text-[11px]" :class="i === step ? 'text-sky-300' : 'text-slate-500'">{{ i + 1 }}. {{ s }}</p>
            </button>
          </li>
        </ol>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
        <!-- 1. Runtime -->
        <section v-if="step === 0" class="space-y-4">
          <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm">
            <p class="font-mono text-xs text-slate-500">{{ inspect.mainDll }}</p>
            <p v-if="inspect.selfContained" class="mt-2 flex items-center gap-2 text-emerald-300">
              <v-icon name="fa-check-circle" scale="0.8" /> Self-contained — bundles its own runtime, nothing to check.
            </p>
            <template v-else-if="inspect.required">
              <p class="mt-2 text-slate-300">
                Needs <span class="font-mono text-white">{{ inspect.required.name }} {{ inspect.required.version }}</span>
              </p>
              <p v-if="runtimeOk" class="mt-2 flex items-center gap-2 text-emerald-300">
                <v-icon name="fa-check-circle" scale="0.8" /> Found on the server.
              </p>
              <div v-else class="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-amber-200">
                <p>Not installed on this server yet.</p>
                <p v-if="inspect.installedRuntimes.length" class="mt-1 text-xs text-amber-300/80">
                  Installed: {{ inspect.installedRuntimes.map((r) => `${r.name} ${r.version}`).join(', ') }}
                </p>
                <button
                  class="mt-3 flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
                  :disabled="installing"
                  @click="installRuntime"
                >
                  <v-icon :name="installing ? 'fa-spinner' : 'fa-cloud-download-alt'" :class="installing && 'animate-spin'" scale="0.8" />
                  {{ installing ? 'Installing…' : `Install ${inspect.required.name}` }}
                </button>
                <pre v-if="installOutput" class="mt-3 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-amber-100/80">{{ installOutput }}</pre>
              </div>
            </template>
            <p v-else class="mt-2 text-slate-400">No shared framework declared — nothing external needed.</p>
          </div>
        </section>

        <!-- 2. Basics -->
        <section v-else-if="step === 1" class="space-y-4">
          <div>
            <label :class="label">What should it be called?</label>
            <input v-model="spec.name" :class="[field, 'font-mono']" />
            <p :class="hint">Runs as the systemd service {{ spec.name }}, files live in /opt/{{ spec.name }}.</p>
            <label v-if="nameExists" class="mt-2 flex items-center gap-2 text-xs text-amber-300">
              <input v-model="spec.overwrite" type="checkbox" class="accent-amber-500" />
              {{ spec.name }} already exists — overwrite it
            </label>
          </div>
          <div>
            <label :class="label">Port (127.0.0.1 only — nginx fronts it for the outside world)</label>
            <div class="flex gap-2">
              <input v-model.number="spec.port" type="number" min="1" max="65535" :class="[field, portInUse && 'border-red-600']" />
              <button
                class="shrink-0 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:border-sky-500"
                @click="spec.port = freePort((spec.port ?? 5000) + (portInUse ? 1 : 0))"
              >
                Next free
              </button>
            </div>
            <p v-if="portInUse" class="mt-1 text-[11px] text-red-400">Already in use on this server.</p>
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-xs font-medium text-slate-400">Environment variables</label>
              <button class="text-xs text-sky-400 hover:text-sky-300" @click="addEnv">+ Add</button>
            </div>
            <div v-for="(e, i) in spec.env" :key="i" class="mb-2 flex gap-2">
              <input v-model="e.key" placeholder="KEY" :class="[field, 'w-2/5 font-mono']" />
              <input v-model="e.value" placeholder="value" :class="[field, 'font-mono']" />
              <button class="rounded-lg px-2 text-slate-500 hover:text-red-400" @click="spec.env.splice(i, 1)">
                <v-icon name="fa-times" scale="0.75" />
              </button>
            </div>
            <p v-if="!spec.env.length" class="text-xs text-slate-500">
              None yet. ASPNETCORE_ENVIRONMENT, connection strings, API keys…
            </p>
          </div>
        </section>

        <!-- 3. Network -->
        <section v-else-if="step === 2" class="space-y-4">
          <div>
            <label :class="label">Domain name(s) <span class="text-slate-600">(optional)</span></label>
            <input v-model="spec.domain" placeholder="app.example.com" :class="[field, 'font-mono']" />
            <p :class="hint">
              Point its DNS at this server first. Leave blank to deploy without an nginx site — add one later from
              the Nginx page, where this app will show up as "running, but not behind nginx yet".
            </p>
          </div>
          <div v-if="spec.domain.trim()">
            <label :class="label">Max upload</label>
            <input v-model="spec.maxBody" placeholder="100m" :class="[field, 'w-32 font-mono']" />
          </div>
        </section>

        <!-- 4. Review -->
        <section v-else class="space-y-4">
          <template v-if="!result">
            <p class="text-sm text-slate-300">This will run on the server:</p>
            <ol class="space-y-1 text-sm text-slate-400">
              <li>1. Move the app into <span class="font-mono text-slate-200">/opt/{{ spec.name }}</span></li>
              <li>2. Write and enable the systemd service <span class="font-mono text-slate-200">{{ spec.name }}</span>, listening on <span class="font-mono text-slate-200">127.0.0.1:{{ spec.port }}</span></li>
              <li v-if="spec.domain.trim()">3. Add an nginx site for <span class="font-mono text-slate-200">{{ spec.domain }}</span></li>
            </ol>
          </template>
          <template v-else>
            <p v-if="deploying" class="flex items-center gap-2 text-sm text-sky-300">
              <v-icon name="fa-spinner" class="animate-spin" /> Deploying…
            </p>
            <details
              v-for="(s, i) in result.log"
              :key="i"
              :open="!s.ok || i === result.log.length - 1"
              class="rounded-lg border bg-slate-950/50"
              :class="s.ok ? 'border-slate-800' : 'border-red-900'"
            >
              <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <v-icon :name="s.ok ? 'fa-check' : 'fa-times'" scale="0.7" :class="s.ok ? 'text-emerald-400' : 'text-red-400'" />
                {{ s.title }}
              </summary>
              <pre v-if="s.output" class="max-h-48 overflow-auto border-t border-slate-800 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ s.output }}</pre>
            </details>
            <p v-if="result.error" class="rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {{ result.error }} — fix the setting and press Deploy again.
            </p>
            <div v-if="result.done" class="rounded-xl border border-emerald-800/50 bg-emerald-950/30 p-4 text-sm text-emerald-200">
              <p class="flex items-center gap-2 font-medium"><v-icon name="fa-check-circle" /> {{ spec.name }} is running.</p>
              <p v-if="result.url" class="mt-1">Once DNS points here: <span class="font-mono text-white">{{ result.url }}</span></p>
              <p v-else class="mt-1 font-mono text-white">http://127.0.0.1:{{ spec.port }} (server-local — add an nginx site when ready)</p>
            </div>
          </template>
        </section>
      </div>

      <div class="flex items-center gap-2 border-t border-slate-800 px-6 py-3">
        <button
          v-if="step > 0 && !deploying && !result?.done"
          class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
          @click="result = null; step--"
        >
          Back
        </button>
        <div class="flex-1" />
        <button
          v-if="step < STEPS.length - 1"
          :disabled="!canNext"
          class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="next"
        >
          Next
        </button>
        <button
          v-else-if="!result?.done"
          :disabled="deploying"
          class="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="deploy"
        >
          <v-icon :name="deploying ? 'fa-spinner' : 'fa-rocket'" :class="deploying && 'animate-spin'" scale="0.8" />
          {{ deploying ? 'Deploying…' : result?.error ? 'Retry deploy' : 'Deploy' }}
        </button>
        <button v-else class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600" @click="emit('close')">
          Done
        </button>
      </div>
    </div>
  </div>
</template>
