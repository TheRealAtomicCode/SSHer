<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail } from '../toast';
import type { DeploySpec, DockerContext, ImageInfo, StepResult } from '../types';

const props = defineProps<{ image: string; source?: 'loaded' | 'local' | '' }>();
const emit = defineEmits<{ close: []; deployed: [] }>();

type Exposure = 'nginx' | 'local' | 'public';
const STEPS = ['Image', 'Basics', 'Network', 'Environment', 'Review'] as const;

const step = ref(0);
const ctx = ref<DockerContext | null>(null);
const info = ref<ImageInfo | null>(null);
const imageRef = ref(props.image);
const checking = ref(false);
const pulling = ref(false);
const pullOutput = ref('');
const exposure = ref<Exposure>('nginx');
const plan = ref<{ files: { path: string; content: string }[]; steps: { title: string; command: string }[] } | null>(null);
const planError = ref('');
const deploying = ref(false);
const result = ref<{ log: StepResult[]; error: string; url: string; done: boolean } | null>(null);
const nameTouched = ref(false);

const spec = reactive<DeploySpec>({
  name: '',
  image: props.image,
  containerPort: null,
  hostPort: null,
  bindAddr: '127.0.0.1',
  restart: 'unless-stopped',
  env: [],
  volumes: [],
  hostGateway: false,
  envFile: '',
  dir: '',
  domain: '',
  maxBody: '100m',
  firewall: false,
  overwrite: false,
});

/** `ghcr.io/acme/billing-api:prod` -> `billing-api`. */
function nameFromImage(image: string): string {
  const last = image.split('/').pop() ?? '';
  return (last.split(/[:@]/)[0] || 'app').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
}

function freePort(from: number): number {
  const used = new Set(ctx.value?.usedPorts ?? []);
  let p = from;
  while (used.has(p) && p < 65535) p++;
  return p;
}

const portInUse = computed(
  () => spec.hostPort !== null && (ctx.value?.usedPorts ?? []).includes(spec.hostPort),
);
const nameExists = computed(() => (ctx.value?.optDirs ?? []).includes(spec.name) && spec.dir === `/opt/${spec.name}`);
const exposedPorts = computed(() => (info.value?.exposedPorts ?? []).map((p) => Number(p.split('/')[0])));
const imageEnv = computed(() =>
  (info.value?.env ?? [])
    .map((e) => {
      const i = e.indexOf('=');
      return { key: e.slice(0, i), value: e.slice(i + 1) };
    })
    .filter((e) => e.key !== 'PATH'),
);

async function inspectImage() {
  const image = imageRef.value.trim();
  if (!image) return;
  checking.value = true;
  try {
    info.value = await api.dockerImageInfo(image);
    if (info.value.found) applyImage(image);
  } catch (err) {
    fail(err);
  } finally {
    checking.value = false;
  }
}

async function pull() {
  const image = imageRef.value.trim();
  if (!image) return;
  pulling.value = true;
  pullOutput.value = '';
  try {
    pullOutput.value = (await api.dockerPull(image)).output;
    await inspectImage();
  } catch (err) {
    pullOutput.value = (err as Error).message;
  } finally {
    pulling.value = false;
  }
}

/** Fill every field we can guess from what the image declares. */
function applyImage(image: string) {
  spec.image = image;
  // An image can suggest its own deploy settings (see client/src/links.ts for io.ssher.link.*).
  const labels = info.value?.labels ?? {};
  if (!nameTouched.value) {
    spec.name = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(labels['io.ssher.name'] ?? '') ? labels['io.ssher.name'] : nameFromImage(image);
    spec.dir = `/opt/${spec.name}`;
  }
  if (labels['io.ssher.host-gateway'] === 'true') spec.hostGateway = true;
  const first = exposedPorts.value[0];
  spec.containerPort = first ?? spec.containerPort ?? 80;
  if (!spec.hostPort) spec.hostPort = freePort(first && first >= 1024 && first !== 8080 ? first : 3002);
  spec.volumes = (info.value?.volumes ?? []).map((container) => ({
    host: `./data/${container.split('/').filter(Boolean).pop() ?? 'data'}`,
    container,
  }));
}

watch(
  () => spec.name,
  (name, old) => {
    if (!spec.dir || spec.dir === `/opt/${old}`) spec.dir = `/opt/${name}`;
  },
);

watch(exposure, (mode) => {
  spec.bindAddr = mode === 'public' ? '0.0.0.0' : '127.0.0.1';
  if (mode !== 'nginx') spec.domain = '';
  if (mode !== 'public') spec.firewall = false;
});

const canNext = computed(() => {
  if (step.value === 0) return Boolean(info.value?.found);
  if (step.value === 1) return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(spec.name) && spec.dir.startsWith('/');
  if (step.value === 2) {
    if (!spec.containerPort || !spec.hostPort || portInUse.value) return false;
    if (exposure.value === 'nginx' && !spec.domain.trim()) return false;
    return true;
  }
  return true;
});

async function next() {
  if (!canNext.value) return;
  step.value++;
  if (step.value === STEPS.length - 1) await loadPlan();
}

async function loadPlan() {
  plan.value = null;
  planError.value = '';
  try {
    plan.value = await api.dockerDeployPlan(spec);
  } catch (err) {
    planError.value = (err as Error).message;
  }
}

async function deploy() {
  // A failed attempt may already have written the compose file; a retry replaces it.
  if (result.value?.error) spec.overwrite = true;
  deploying.value = true;
  result.value = { log: [], error: '', url: '', done: false };
  try {
    const res = await api.dockerDeploy(spec);
    result.value = { log: res.log, error: '', url: res.url, done: true };
    emit('deployed');
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    result.value = { log, error: (err as Error).message, url: '', done: false };
  } finally {
    deploying.value = false;
  }
}

function addEnv(key = '', value = '') {
  spec.env.push({ key, value });
}

const pasting = ref(false);
const pasted = ref('');

/** Bulk import: `.env` lines (KEY=value) or compose environment lines (KEY: "value").
 *  A key already in the list is updated rather than added twice. */
function importPasted() {
  let added = 0;
  for (const raw of pasted.value.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '').replace(/^-\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|:\s)\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    const existing = spec.env.find((e) => e.key === m[1]);
    if (existing) existing.value = value;
    else spec.env.push({ key: m[1], value });
    added++;
  }
  pasted.value = '';
  pasting.value = false;
  if (!added) fail(new Error('No KEY=value or KEY: value lines found'));
}

/** Nothing configured at all — the usual reason an app restarts forever right after deploy. */
const noSettings = computed(() => !spec.env.some((e) => e.key) && !spec.envFile.trim());

onMounted(async () => {
  try {
    ctx.value = await api.dockerContext();
  } catch (err) {
    fail(err);
  }
  if (props.image) await inspectImage();
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
    <div class="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <!-- Header + stepper -->
      <div class="border-b border-slate-800 px-6 pt-4 pb-3">
        <div class="mb-3 flex items-center gap-2">
          <v-icon name="fa-rocket" class="text-sky-400" />
          <h2 class="flex-1 text-base font-semibold text-white">Deploy a container</h2>
          <button
            v-if="!deploying"
            class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            @click="emit('close')"
          >
            <v-icon name="fa-times" scale="0.85" />
          </button>
        </div>
        <ol class="flex gap-1">
          <li v-for="(s, i) in STEPS" :key="s" class="flex-1">
            <button
              :disabled="i > step || Boolean(result)"
              class="w-full text-left"
              @click="step = i"
            >
              <div class="h-1 rounded-full" :class="i <= step ? 'bg-sky-500' : 'bg-slate-800'" />
              <p class="mt-1.5 text-[11px]" :class="i === step ? 'text-sky-300' : 'text-slate-500'">
                {{ i + 1 }}. {{ s }}
              </p>
            </button>
          </li>
        </ol>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
        <!-- 1. Image -->
        <section v-if="step === 0" class="space-y-4">
          <div>
            <label :class="label">Which image?</label>
            <div class="flex gap-2">
              <input
                v-model="imageRef"
                placeholder="nginx:alpine   or   ghcr.io/you/app:prod"
                :class="[field, 'font-mono']"
                @keydown.enter.prevent="inspectImage"
              />
              <button
                class="shrink-0 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:border-sky-500 hover:text-sky-300"
                :disabled="checking"
                @click="inspectImage"
              >
                <v-icon v-if="checking" name="fa-spinner" class="animate-spin" scale="0.8" />
                <span v-else>Check</span>
              </button>
            </div>
            <p :class="hint">
              Dropped a .tar? It is already loaded and filled in. Otherwise type any image from Docker
              Hub or a registry the server is logged into (this server is logged into ghcr.io).
            </p>
          </div>

          <div
            v-if="info && !info.found"
            class="rounded-xl border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-200"
          >
            <p>
              <b>{{ imageRef }}</b> is not on the server yet. Pull it now?
            </p>
            <button
              class="mt-3 flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
              :disabled="pulling"
              @click="pull"
            >
              <v-icon :name="pulling ? 'fa-spinner' : 'fa-cloud-download-alt'" :class="pulling && 'animate-spin'" scale="0.8" />
              {{ pulling ? 'Pulling…' : 'Pull image' }}
            </button>
            <pre v-if="pullOutput" class="mt-3 font-mono text-[11px] whitespace-pre-wrap text-amber-100/80">{{ pullOutput }}</pre>
          </div>

          <div v-if="info?.found" class="rounded-xl border border-emerald-800/50 bg-emerald-950/20 p-4">
            <p class="flex items-center gap-2 text-sm font-medium text-emerald-300">
              <v-icon name="fa-check-circle" scale="0.8" /> Image found on the server
              <span v-if="source === 'loaded'" class="text-xs text-emerald-500">(just loaded from your file)</span>
            </p>
            <dl class="mt-3 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt class="text-slate-500">Exposes</dt>
              <dd class="font-mono text-slate-200">{{ info.exposedPorts?.join(', ') || 'no ports declared' }}</dd>
              <dt class="text-slate-500">Volumes</dt>
              <dd class="font-mono text-slate-200">{{ info.volumes?.join(', ') || 'none declared' }}</dd>
              <dt class="text-slate-500">Runs</dt>
              <dd class="truncate font-mono text-slate-200" :title="info.cmd">{{ info.cmd || '—' }}</dd>
              <dt class="text-slate-500">Size</dt>
              <dd class="text-slate-200">{{ ((info.size ?? 0) / 1e6).toFixed(0) }} MB</dd>
            </dl>
          </div>
        </section>

        <!-- 2. Basics -->
        <section v-else-if="step === 1" class="space-y-4">
          <div>
            <label :class="label">What should it be called?</label>
            <input v-model="spec.name" :class="[field, 'font-mono']" @input="nameTouched = true" />
            <p :class="hint">Becomes the compose project name and the container name ({{ spec.name }}-{{ spec.name }}-1).</p>
          </div>
          <div>
            <label :class="label">Where should its docker-compose.yml live?</label>
            <input v-model="spec.dir" :class="[field, 'font-mono']" />
            <p :class="hint">Same layout as DeviseHR in /opt/DeviseHR — you can edit the file later from the container's Config tab.</p>
            <label v-if="nameExists" class="mt-2 flex items-center gap-2 text-xs text-amber-300">
              <input v-model="spec.overwrite" type="checkbox" class="accent-amber-500" />
              /opt/{{ spec.name }} already exists — overwrite its docker-compose.yml
            </label>
          </div>
          <div>
            <label :class="label">If it crashes or the server reboots…</label>
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                v-for="opt in [
                  { v: 'unless-stopped', t: 'Restart', d: 'unless you stop it' },
                  { v: 'always', t: 'Always', d: 'restart' },
                  { v: 'on-failure', t: 'On failure', d: 'only on errors' },
                  { v: 'no', t: 'Never', d: 'restart' },
                ]"
                :key="opt.v"
                class="rounded-lg border p-2 text-left text-xs transition"
                :class="spec.restart === opt.v ? 'border-sky-500 bg-sky-500/10 text-sky-200' : 'border-slate-700 text-slate-400 hover:border-slate-500'"
                @click="spec.restart = opt.v"
              >
                <p class="font-medium">{{ opt.t }}</p>
                <p class="text-slate-500">{{ opt.d }}</p>
              </button>
            </div>
          </div>
        </section>

        <!-- 3. Network -->
        <section v-else-if="step === 2" class="space-y-5">
          <div>
            <label :class="label">How should people reach it?</label>
            <div class="grid gap-2 sm:grid-cols-3">
              <button
                v-for="opt in [
                  { v: 'nginx', icon: 'fa-globe', t: 'Domain via nginx', d: 'Recommended. Port stays on 127.0.0.1; nginx proxies a hostname to it — how DeviseHR runs.' },
                  { v: 'local', icon: 'fa-lock', t: 'Server only', d: 'Bound to 127.0.0.1. Reachable from the server itself or an SSH tunnel.' },
                  { v: 'public', icon: 'fa-lock-open', t: 'Public port', d: 'Bound to 0.0.0.0 — anyone can hit server-ip:port.' },
                ] as const"
                :key="opt.v"
                :disabled="opt.v === 'nginx' && ctx !== null && !ctx.nginx"
                class="rounded-xl border p-3 text-left transition disabled:opacity-40"
                :class="exposure === opt.v ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'"
                @click="exposure = opt.v"
              >
                <v-icon :name="opt.icon" :class="exposure === opt.v ? 'text-sky-300' : 'text-slate-500'" />
                <p class="mt-1.5 text-sm font-medium text-white">{{ opt.t }}</p>
                <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ opt.d }}</p>
              </button>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label :class="label">Port inside the container</label>
              <input v-model.number="spec.containerPort" type="number" min="1" max="65535" :class="field" />
              <div v-if="exposedPorts.length" class="mt-1.5 flex flex-wrap gap-1">
                <button
                  v-for="p in exposedPorts"
                  :key="p"
                  class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300 hover:bg-sky-900"
                  @click="spec.containerPort = p"
                >
                  {{ p }}
                </button>
                <span class="text-[11px] text-slate-500">declared by the image</span>
              </div>
              <p v-else :class="hint">The image declares no port — check its docs (web apps are often 80, 3000 or 8080).</p>
            </div>
            <div>
              <label :class="label">Port on the server</label>
              <div class="flex gap-2">
                <input
                  v-model.number="spec.hostPort"
                  type="number"
                  min="1"
                  max="65535"
                  :class="[field, portInUse && 'border-red-600']"
                />
                <button
                  class="shrink-0 rounded-lg border border-slate-700 px-2.5 text-xs text-slate-300 hover:border-sky-500"
                  title="Find the next free port"
                  @click="spec.hostPort = freePort((spec.hostPort ?? 3000) + (portInUse ? 1 : 0))"
                >
                  Next free
                </button>
              </div>
              <p v-if="portInUse" class="mt-1 text-[11px] text-red-400">Already in use on this server.</p>
              <p v-else :class="hint">
                Taken: {{ (ctx?.usedPorts ?? []).filter((p) => p > 1000 && p < 20000).join(', ') || '—' }}
              </p>
            </div>
          </div>

          <div v-if="exposure === 'nginx'" class="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div>
              <label :class="label">Domain name(s)</label>
              <input v-model="spec.domain" placeholder="app.example.com" :class="[field, 'font-mono']" />
              <p :class="hint">
                Point its DNS (Cloudflare A record, proxied) at this server first. Space-separate several
                names. nginx listens on :80; Cloudflare provides https.
              </p>
            </div>
            <div>
              <label :class="label">Max upload</label>
              <input v-model="spec.maxBody" placeholder="100m" :class="[field, 'font-mono']" />
            </div>
          </div>

          <div
            v-if="exposure === 'public'"
            class="space-y-2 rounded-xl border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-200"
          >
            <p>
              <v-icon name="fa-exclamation-triangle" scale="0.7" /> Docker publishes ports by writing its
              own iptables rules, which bypass ufw — the port is open to the internet even if ufw says deny.
            </p>
            <label v-if="ctx?.ufwActive" class="flex items-center gap-2">
              <input v-model="spec.firewall" type="checkbox" class="accent-amber-500" />
              Also add a ufw allow rule for {{ spec.hostPort }}/tcp (keeps the firewall list accurate)
            </label>
          </div>
        </section>

        <!-- 4. Environment & storage -->
        <section v-else-if="step === 3" class="space-y-5">
          <div>
            <label :class="label">Load variables from a file on the server <span class="text-slate-600">(optional)</span></label>
            <input v-model="spec.envFile" placeholder="/opt/DeviseHR/.env.prod" :class="[field, 'font-mono']" />
            <p :class="hint">
              Reuses an existing env file (secrets stay on the server). Variables you add below override keys
              from the file.
            </p>
          </div>
          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-xs font-medium text-slate-400">Environment variables</label>
              <span class="flex gap-3">
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="pasting = !pasting">Paste .env / YAML</button>
                <button class="text-xs text-sky-400 hover:text-sky-300" @click="addEnv()">+ Add</button>
              </span>
            </div>
            <div v-if="pasting" class="mb-3">
              <textarea
                v-model="pasted"
                spellcheck="false"
                placeholder="DB_PASSWORD=…&#10;token__SecretKey: &quot;…&quot;"
                class="h-32 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] text-slate-200 focus:border-sky-500 focus:outline-none"
              />
              <button class="mt-1 rounded-lg bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500" @click="importPasted">Import</button>
              <span class="ml-2 text-[11px] text-slate-500">For a multi-service app with many settings, a <b>stack</b> (Stacks tab) is easier to manage.</span>
            </div>
            <div v-for="(e, i) in spec.env" :key="i" class="mb-2 flex gap-2">
              <input v-model="e.key" placeholder="KEY" :class="[field, 'w-2/5 font-mono']" />
              <input v-model="e.value" placeholder="value" :class="[field, 'font-mono']" />
              <button class="rounded-lg px-2 text-slate-500 hover:text-red-400" @click="spec.env.splice(i, 1)">
                <v-icon name="fa-times" scale="0.75" />
              </button>
            </div>
            <p v-if="!spec.env.length" class="text-xs text-slate-500">None. Connection strings, API keys, NODE_ENV…</p>
            <div v-if="imageEnv.length" class="mt-2">
              <p class="mb-1 text-[11px] text-slate-500">Set by the image (click to override):</p>
              <div class="flex flex-wrap gap-1">
                <button
                  v-for="e in imageEnv"
                  :key="e.key"
                  class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400 hover:bg-sky-900 hover:text-white"
                  @click="addEnv(e.key, e.value)"
                >
                  {{ e.key }}={{ e.value.length > 24 ? e.value.slice(0, 24) + '…' : e.value }}
                </button>
              </div>
            </div>
          </div>

          <div>
            <div class="mb-1.5 flex items-center justify-between">
              <label class="text-xs font-medium text-slate-400">Persistent storage</label>
              <button class="text-xs text-sky-400 hover:text-sky-300" @click="spec.volumes.push({ host: './data', container: '/data' })">
                + Add
              </button>
            </div>
            <div v-for="(v, i) in spec.volumes" :key="i" class="mb-2 flex items-center gap-2">
              <input v-model="v.host" placeholder="./data  or  my-volume" :class="[field, 'font-mono']" />
              <v-icon name="fa-arrow-right" scale="0.7" class="shrink-0 text-slate-600" />
              <input v-model="v.container" placeholder="/data" :class="[field, 'font-mono']" />
              <button class="rounded-lg px-2 text-slate-500 hover:text-red-400" @click="spec.volumes.splice(i, 1)">
                <v-icon name="fa-times" scale="0.75" />
              </button>
            </div>
            <p :class="hint">
              Anything the app writes outside a volume is lost when the container is recreated or updated.
              ./paths live inside {{ spec.dir }}.
            </p>
          </div>

          <label class="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-800 p-3 text-sm text-slate-300">
            <input v-model="spec.hostGateway" type="checkbox" class="mt-0.5 accent-sky-500" />
            <span>
              Needs a database or service running on the host?
              <span class="block text-xs text-slate-500">
                Adds host.docker.internal → host, like DeviseHR uses to reach PostgreSQL on :5432.
              </span>
            </span>
          </label>
        </section>

        <!-- 5. Review -->
        <section v-else class="space-y-4">
          <template v-if="!result">
            <p v-if="planError" class="rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {{ planError }}
            </p>
            <div v-else-if="!plan" class="py-10 text-center">
              <v-icon name="fa-spinner" class="animate-spin text-sky-400" scale="1.4" />
            </div>
            <template v-else>
              <p v-if="noSettings" class="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <v-icon name="fa-exclamation-triangle" scale="0.65" /> No environment variables and no env file. An app that needs settings
                (database, secrets, URLs) will exit and restart forever. Go back to <b>Environment</b> to add them — or deploy anyway; the last
                step checks it stays up and shows its logs if not.
              </p>
              <div>
                <p class="mb-2 text-xs font-medium text-slate-400">The site will run these steps on the server:</p>
                <ol class="space-y-1">
                  <li v-for="(s, i) in plan.steps" :key="i" class="flex gap-2 text-sm text-slate-300">
                    <span class="w-5 shrink-0 text-right text-slate-600">{{ i + 1 }}.</span>{{ s.title }}
                  </li>
                </ol>
              </div>
              <details v-for="f in plan.files" :key="f.path" class="rounded-lg border border-slate-800" open>
                <summary class="cursor-pointer px-3 py-2 font-mono text-xs text-sky-300">{{ f.path }}</summary>
                <pre class="max-h-72 overflow-auto border-t border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300">{{ f.content }}</pre>
              </details>
            </template>
          </template>

          <template v-else>
            <p v-if="deploying" class="flex items-center gap-2 text-sm text-sky-300">
              <v-icon name="fa-spinner" class="animate-spin" /> Deploying… pulling and starting can take a minute.
            </p>
            <details
              v-for="(s, i) in result.log"
              :key="i"
              :open="!s.ok"
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
              <p class="flex items-center gap-2 font-medium">
                <v-icon name="fa-check-circle" /> {{ spec.name }} is running.
              </p>
              <p v-if="result.url" class="mt-1">
                Once DNS points here: <span class="font-mono text-white">{{ result.url }}</span>
              </p>
              <p v-else-if="spec.bindAddr === '0.0.0.0'" class="mt-1 font-mono text-white">
                http://&lt;server-ip&gt;:{{ spec.hostPort }}
              </p>
              <p class="mt-1 text-xs text-emerald-400/80">Config: {{ spec.dir }}/docker-compose.yml</p>
            </div>
          </template>
        </section>
      </div>

      <!-- Footer -->
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
          :disabled="!plan || deploying"
          class="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          @click="deploy"
        >
          <v-icon :name="deploying ? 'fa-spinner' : 'fa-rocket'" :class="deploying && 'animate-spin'" scale="0.8" />
          {{ deploying ? 'Deploying…' : result?.error ? 'Retry deploy' : 'Deploy' }}
        </button>
        <button
          v-else
          class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600"
          @click="emit('close')"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>
