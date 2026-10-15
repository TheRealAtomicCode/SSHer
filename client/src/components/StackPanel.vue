<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail, notify } from '../toast';
import { newTransferId, watchTransfer } from '../transferProgress';
import type { StackCrash, StackDetail, StackOp, StackRef, StackSetting, StepResult } from '../types';
import StepLog from './StepLog.vue';

/** One compose project: its services and images, its settings as a form, and deploy. */
const props = defineProps<{ stack: StackRef }>();
const emit = defineEmits<{
  close: [];
  changed: [];
  openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }];
  openLogs: [string];
}>();

const detail = ref<StackDetail | null>(null);
const loading = ref(true);
const view = ref<'settings' | 'raw'>('settings');
const edits = reactive<Record<number, string>>({});
const revealed = reactive<Record<number, boolean>>({});
const filter = ref('');
const saving = ref(false);
const raw = ref('');
const rawDirty = ref(false);
const selected = ref<Set<string>>(new Set());
const opLog = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);
const crashed = ref<StackCrash[]>([]);
const upload = ref<{ service: string; stage: string; progress: number } | null>(null);

const ref_ = computed<StackRef>(() => ({
  dir: detail.value?.dir ?? props.stack.dir,
  files: detail.value?.files ?? props.stack.files,
  project: props.stack.project,
}));

async function load() {
  loading.value = true;
  try {
    const d = await api.stackDetail(props.stack);
    detail.value = d;
    raw.value = d.raw;
    rawDirty.value = false;
    for (const k of Object.keys(edits)) delete edits[Number(k)];
    // Default selection: everything that can actually start.
    if (!selected.value.size) selected.value = new Set(d.services.filter((s) => s.imagePresent || !isLocalImage(s.image)).map((s) => s.name));
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

/** `lptic/hr-api:prod` can't be pulled from anywhere — it only exists as a .tar. A
 *  registry-qualified or official image (`redis:7-alpine`, `cgr.dev/…`) can. */
function isLocalImage(image: string): boolean {
  const first = image.split('/')[0];
  const registry = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return image.includes('/') && !registry && !/^(library|bitnami|bitnamilegacy|minio|redis|postgres|nginx)$/.test(first);
}

// ----------------------------------------------------------------- settings

const value = (s: StackSetting) => (s.line in edits ? edits[s.line] : s.value);
const dirtyCount = computed(() => Object.keys(edits).length);
const openPlaceholders = computed(() => (detail.value?.settings ?? []).filter((s) => isPlaceholder(s, value(s))));

function isPlaceholder(s: StackSetting, v: string) {
  return /CHANGE_?ME/i.test(v) || (s.secret && v === '' && !/OPTIONS$/.test(s.key));
}

function setValue(s: StackSetting, v: string) {
  if (v === s.value) delete edits[s.line];
  else edits[s.line] = v;
}

const groups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const map = new Map<string, StackSetting[]>();
  for (const s of detail.value?.settings ?? []) {
    if (q && !`${s.key} ${s.comment} ${s.block}`.toLowerCase().includes(q)) continue;
    if (!map.has(s.block)) map.set(s.block, []);
    map.get(s.block)!.push(s);
  }
  return [...map.entries()];
});

/** 64 random bytes (86 base64url characters, 688 bits): enough for an HMAC-SHA512 signing key,
 *  which must be LONGER than 512 bits — and it never contains `$`, so compose cannot mangle it. */
function generate(s: StackSetting) {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  setValue(s, btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  revealed[s.line] = true;
}

// ------------------------------------------------------- change a secret everywhere

const change = ref<{
  setting: StackSetting;
  plan: api.StackSecretPlan | null;
  value: string;
  reveal: boolean;
  busy: boolean;
} | null>(null);

async function startChange(s: StackSetting) {
  if (dirtyCount.value && !confirm(`You have ${dirtyCount.value} unsaved setting(s). Save or undo them first — Change works on the saved file.`)) return;
  change.value = { setting: s, plan: null, value: '', reveal: false, busy: false };
  try {
    change.value.plan = (await api.stackChangeSecret(ref_.value, s, '', true)).plan;
  } catch (err) {
    fail(err);
    change.value = null;
  }
}

function generateChange() {
  if (!change.value) return;
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  change.value.value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  change.value.reveal = true;
}

async function applyChange() {
  const c = change.value;
  if (!c || !c.value.trim()) return;
  c.busy = true;
  const log = reactive({ title: `Change ${c.setting.key} everywhere`, steps: [] as StepResult[], running: true, error: '' });
  opLog.value = log;
  try {
    const res = await api.stackChangeSecret(ref_.value, c.setting, c.value);
    log.steps = res.log ?? [];
    crashed.value = res.crashed ?? [];
    if (res.ok) notify(`${c.setting.key} changed everywhere`);
    else log.error = 'Changed, but something did not come back up — see below.';
    change.value = null;
    emit('changed');
    await load();
  } catch (err) {
    log.steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.error = (err as Error).message;
  } finally {
    log.running = false;
    if (change.value) change.value.busy = false;
  }
}

async function saveSettings() {
  if (!detail.value || !dirtyCount.value) return;
  saving.value = true;
  try {
    const list = detail.value.settings.filter((s) => s.line in edits).map((s) => ({ line: s.line, key: s.key, value: edits[s.line] }));
    await api.stackSaveSettings(ref_.value, list);
    notify(`Saved ${list.length} setting${list.length === 1 ? '' : 's'} to ${ref_.value.files[0]}`);
    await load();
  } catch (err) {
    fail(err);
  } finally {
    saving.value = false;
  }
}

async function saveRaw() {
  saving.value = true;
  try {
    await api.stackSaveRaw(ref_.value, raw.value);
    notify(`Saved ${ref_.value.files[0]}`);
    await load();
  } catch (err) {
    fail(err);
  } finally {
    saving.value = false;
  }
}

// ------------------------------------------------------------------ images

async function onTar(e: Event, service: string) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  upload.value = { service, stage: `Uploading ${file.name}`, progress: 0 };
  const transferId = newTransferId();
  let stopWatch = () => {};
  try {
    const res = await api.dockerLoad(
      file,
      (p) => {
        if (!upload.value) return;
        upload.value.progress = p;
        if (p >= 100 && upload.value.stage.startsWith('Uploading')) {
          upload.value.stage = 'Copying to the server…';
          stopWatch = watchTransfer(transferId, (state) => {
            if (!upload.value) return;
            if (state.done) upload.value.stage = 'Running docker load…';
            upload.value.progress = state.total ? Math.round((state.transferred / state.total) * 100) : 0;
          });
        }
      },
      transferId,
    );
    const want = detail.value?.services.find((s) => s.name === service)?.image;
    if (want && !res.images.includes(want)) {
      fail(new Error(`Loaded ${res.images.join(', ') || 'nothing'}, but ${service} wants ${want}. Retag it (docker tag) or change the image in the compose file.`));
    } else {
      notify(`Loaded ${res.images.join(', ')}`);
      selected.value = new Set([...selected.value, service]);
      // A new build of a service that already runs: switch it over now, same settings.
      if (detail.value?.services.find((s) => s.name === service)?.state) {
        upload.value = null;
        await updateServices([service]);
        return;
      }
    }
    await load();
  } catch (err) {
    fail(err);
  } finally {
    stopWatch();
    upload.value = null;
  }
}

/** Recreates services on the image just loaded — settings untouched, old build kept as :rollback. */
async function updateServices(services: string[]) {
  const log = reactive({ title: `Update ${services.join(', ')} to the new build`, steps: [] as StepResult[], running: true, error: '' });
  opLog.value = log;
  try {
    const res = await api.stackUpdateImages(ref_.value, services);
    log.steps = res.log;
    crashed.value = res.crashed;
    if (res.ok) {
      opLog.value = null;
      notify(`${services.join(', ')} updated — previous build kept as :rollback`);
    } else log.error = 'Updated, but it is not staying up — see below. Roll back puts the previous build back.';
    emit('changed');
  } catch (err) {
    log.steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.error = (err as Error).message;
  } finally {
    log.running = false;
    await load();
  }
}

async function rollback(service: string) {
  if (!confirm(`Put ${service} back on the build it ran before its last update?`)) return;
  const log = reactive({ title: `Roll back ${service}`, steps: [] as StepResult[], running: true, error: '' });
  opLog.value = log;
  try {
    const res = await api.stackRollback(ref_.value, service);
    log.steps = res.log;
    crashed.value = res.crashed;
    if (res.ok) notify(`${service} rolled back`);
    emit('changed');
  } catch (err) {
    log.steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.error = (err as Error).message;
  } finally {
    log.running = false;
    await load();
  }
}

// --------------------------------------------------------------------- ops

const OP_TITLES: Record<StackOp, string> = {
  up: 'Deploy',
  validate: 'Validate',
  pull: 'Pull images',
  restart: 'Restart',
  stop: 'Stop',
  down: 'Stop & remove containers',
};

async function op(o: StackOp) {
  if (!detail.value) return;
  if (dirtyCount.value && !confirm(`You have ${dirtyCount.value} unsaved setting(s). Continue without them?`)) return;
  const services = o === 'down' || o === 'validate' ? [] : [...selected.value];
  const all = services.length === detail.value.services.length;
  let force = false;
  if (o === 'up' && openPlaceholders.value.length) {
    if (!confirm(`${openPlaceholders.value.length} setting(s) still need a value:\n\n${openPlaceholders.value.map((s) => `• ${s.key}`).slice(0, 12).join('\n')}\n\nDeploy anyway? (the app will likely crash)`)) return;
    force = true;
  }
  if (o === 'down' && !confirm(`Stop and remove every container in ${detail.value.project}?\n\nVolumes (data) are kept. Deploy brings it back.`)) return;
  crashed.value = [];
  const log = reactive({ title: `${OP_TITLES[o]} — ${detail.value.project}${all || !services.length ? '' : ` (${services.join(', ')})`}`, steps: [] as StepResult[], running: true, error: '' });
  opLog.value = log;
  try {
    const res = await api.stackOp(ref_.value, o, { services: all ? [] : services, force });
    log.steps = res.log;
    crashed.value = res.crashed;
    if (o === 'up') {
      if (res.ok) {
        opLog.value = null;
        notify(`${detail.value.project} is up and stayed up`);
      } else log.error = 'Deployed, but some containers are not staying up — their logs are below.';
    }
    emit('changed');
    await load();
  } catch (err) {
    log.steps = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.error = (err as Error).message;
  } finally {
    log.running = false;
  }
}

function toggle(name: string) {
  const next = new Set(selected.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selected.value = next;
}

function stateTone(state: string | null) {
  if (state === 'running') return 'bg-emerald-400';
  if (state === 'restarting') return 'bg-amber-400 animate-pulse';
  if (state) return 'bg-red-400';
  return 'bg-slate-600';
}

onMounted(load);

const field =
  'w-full rounded-md border bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:ring-1 focus:outline-none';
const ghost = 'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-sky-500 hover:text-white disabled:opacity-40';
</script>

<template>
  <div data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
    <div class="flex h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <!-- Header -->
      <div class="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
        <v-icon name="fa-cubes" scale="1.1" class="text-sky-400" />
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-base font-semibold text-white">{{ detail?.project || stack.project || stack.dir }}</h2>
          <p class="truncate font-mono text-[11px] text-slate-500">
            {{ (detail?.files ?? stack.files).join(' + ') }}
            <span v-if="detail?.mode" :class="detail.mode.startsWith('600') ? 'text-slate-600' : 'text-amber-400'">· mode {{ detail.mode }}</span>
          </p>
        </div>
        <button :class="ghost" title="Show the compose file in the File Explorer" @click="emit('openPath', { path: ref_.files[0], isDirectory: false, reveal: true })">
          <v-icon name="fa-folder-open" scale="0.7" /> Show file
        </button>
        <button :class="ghost" title="Reload" @click="load"><v-icon name="fa-sync-alt" scale="0.7" :class="loading && 'animate-spin'" /></button>
        <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>

      <div v-if="!detail" class="flex flex-1 items-center justify-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" />
      </div>

      <div v-else class="min-h-0 flex-1 overflow-auto px-5 py-4">
        <p v-if="detail.error" class="mb-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-red-300">{{ detail.error }}</p>
        <p v-if="detail.mode && !detail.mode.startsWith('600') && detail.settings.some((s) => s.secret)" class="mb-4 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          This file holds secrets but is mode {{ detail.mode.split(' ')[0] }} — readable by other users on the server. <code>chmod 600 {{ ref_.files[0] }}</code> is advised.
        </p>

        <!-- Services -->
        <section class="mb-5">
          <h3 class="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Services</h3>
          <div class="overflow-hidden rounded-xl border border-slate-800">
            <div
              v-for="s in detail.services"
              :key="s.name"
              class="flex flex-wrap items-center gap-3 border-b border-slate-800/70 px-4 py-2.5 last:border-b-0"
            >
              <input type="checkbox" class="accent-sky-500" :checked="selected.has(s.name)" title="Include in Deploy / Restart / Stop" @change="toggle(s.name)" />
              <span class="h-2 w-2 shrink-0 rounded-full" :class="stateTone(s.state)" :title="s.state ?? 'not created'" />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-white">
                  {{ s.name }}
                  <span class="ml-1 text-xs font-normal text-slate-500">{{ s.state ?? 'not created yet' }}</span>
                </p>
                <p class="truncate font-mono text-[11px] text-slate-500">{{ s.image || '(built from source)' }}</p>
              </div>
              <span v-for="p in s.ports" :key="p" class="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{{ p }}</span>
              <span v-if="s.imagePresent" class="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300" title="The image is on the server">image ✓</span>
              <template v-else>
                <span
                  class="rounded px-1.5 py-0.5 text-[10px]"
                  :class="isLocalImage(s.image) ? 'bg-red-950 text-red-300' : 'bg-slate-800 text-slate-400'"
                  :title="isLocalImage(s.image) ? 'Not on the server and not in any public registry — upload its .tar' : 'Will be pulled from its registry on deploy'"
                >
                  {{ isLocalImage(s.image) ? 'image missing' : 'pulled on deploy' }}
                </span>
                <label class="cursor-pointer rounded-md border border-sky-700 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-500/10">
                  <v-icon name="fa-file-upload" scale="0.6" /> Upload .tar
                  <input type="file" accept=".tar,.gz,.tgz,.xz,.zst" class="hidden" :disabled="Boolean(upload)" @change="onTar($event, s.name)" />
                </label>
              </template>
              <label
                v-if="s.imagePresent && s.state"
                class="cursor-pointer rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500 hover:text-white"
                title="Upload a new build of this image (.tar / .tar.gz): it is loaded and this service switches to it, same settings"
              >
                <v-icon name="fa-file-upload" scale="0.6" /> New build
                <input type="file" accept=".tar,.gz,.tgz,.xz,.zst" class="hidden" :disabled="Boolean(upload)" @change="onTar($event, s.name)" />
              </label>
              <button v-if="s.state" class="rounded p-1 text-slate-500 hover:text-amber-300" title="Roll back to the build before the last update" @click="rollback(s.name)">
                <v-icon name="fa-history" scale="0.7" />
              </button>
              <button v-if="s.container" class="rounded p-1 text-slate-500 hover:text-white" title="Logs" @click="emit('openLogs', s.container)">
                <v-icon name="fa-terminal" scale="0.7" />
              </button>
            </div>
          </div>
          <div v-if="upload" class="mt-2 rounded-lg border border-slate-800 bg-slate-950 p-2">
            <div class="mb-1 flex justify-between text-[11px] text-slate-400">
              <span>{{ upload.service }}: {{ upload.stage }}</span><span class="tabular-nums">{{ upload.progress }}%</span>
            </div>
            <div class="h-1 overflow-hidden rounded-full bg-slate-800">
              <div class="h-full bg-sky-500 transition-all" :style="{ width: `${upload.progress}%` }" />
            </div>
          </div>
        </section>

        <!-- Crashes from the last deploy -->
        <section v-if="crashed.length" class="mb-5 space-y-2">
          <h3 class="text-xs font-semibold tracking-wide text-red-300 uppercase">Not staying up</h3>
          <details v-for="c in crashed" :key="c.container" open class="rounded-xl border border-red-900/60 bg-red-950/20">
            <summary class="cursor-pointer px-3 py-2 text-sm text-red-200">
              {{ c.service }} — {{ c.state }}, restarted {{ c.restarts }}×, exit code {{ c.exitCode }}
            </summary>
            <pre class="max-h-64 overflow-auto border-t border-red-900/40 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-slate-300">{{ c.logs || '(no output)' }}</pre>
          </details>
        </section>

        <!-- Settings / raw -->
        <section>
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <div class="flex rounded-lg border border-slate-700 p-0.5 text-xs">
              <button
                v-for="v in [['settings', 'Settings'], ['raw', 'Edit file']] as const"
                :key="v[0]"
                class="rounded-md px-3 py-1 transition"
                :class="view === v[0] ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
                @click="view = v[0]"
              >
                {{ v[1] }}
              </button>
            </div>
            <span v-if="view === 'settings' && openPlaceholders.length" class="rounded bg-amber-900/50 px-2 py-0.5 text-[11px] text-amber-200">
              {{ openPlaceholders.length }} still need a value
            </span>
            <span v-else-if="view === 'settings' && detail.settings.length" class="rounded bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300">all filled in</span>
            <div class="flex-1" />
            <input v-if="view === 'settings'" v-model="filter" placeholder="Filter settings…" class="w-48 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-100 focus:border-sky-500 focus:outline-none" />
          </div>

          <template v-if="view === 'settings'">
            <p v-if="!detail.settings.length" class="rounded-xl border border-slate-800 p-4 text-xs text-slate-400">
              No settings found. The form shows every <code>KEY: value</code> under an <code>environment:</code> block or a top-level
              <code>x-…:</code> block — use <b>Edit file</b> to add some.
            </p>
            <div v-for="[block, items] in groups" :key="block" class="mb-4 overflow-hidden rounded-xl border border-slate-800">
              <p class="border-b border-slate-800 bg-slate-950/60 px-4 py-1.5 font-mono text-[11px] text-sky-300">
                {{ block.startsWith('x-') ? block : `${block} → environment` }}
              </p>
              <p v-if="block === 'x-secrets'" class="border-b border-slate-800 bg-amber-950/10 px-4 py-1.5 text-[11px] leading-snug text-slate-400">
                Filling these in for the first time? Type them and <b>Save</b>. Changing one on a stack that is already running?
                Use <b class="text-amber-300">Change</b> — it also changes the password in the database / Redis / MinIO and restarts
                what uses it, so nothing ends up with the old one.
              </p>
              <div
                v-for="s in items"
                :key="s.line"
                class="grid grid-cols-[minmax(10rem,16rem)_1fr_auto] items-start gap-3 border-b border-slate-800/60 px-4 py-2 last:border-b-0"
                :class="s.line in edits && 'bg-sky-500/5'"
              >
                <div class="min-w-0 pt-1">
                  <p class="truncate font-mono text-xs text-slate-200" :title="s.key">{{ s.key }}</p>
                  <p v-if="s.comment" class="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-500" :title="s.comment">{{ s.comment }}</p>
                </div>
                <input
                  :type="s.secret && !revealed[s.line] ? 'password' : 'text'"
                  :value="value(s)"
                  autocomplete="off"
                  spellcheck="false"
                  :class="[field, isPlaceholder(s, value(s)) ? 'border-amber-600 focus:border-amber-500 focus:ring-amber-500' : 'border-slate-700 focus:border-sky-500 focus:ring-sky-500']"
                  @input="setValue(s, ($event.target as HTMLInputElement).value)"
                />
                <div class="flex items-center gap-0.5 pt-0.5">
                  <button v-if="s.secret" class="rounded p-1 text-slate-500 hover:text-white" :title="revealed[s.line] ? 'Hide' : 'Show'" @click="revealed[s.line] = !revealed[s.line]">
                    <v-icon :name="revealed[s.line] ? 'fa-eye-slash' : 'fa-eye'" scale="0.65" />
                  </button>
                  <button v-if="s.secret" class="rounded p-1 text-slate-500 hover:text-sky-300" title="Generate a random value" @click="generate(s)">
                    <v-icon name="fa-dice" scale="0.65" />
                  </button>
                  <button v-if="s.line in edits" class="rounded p-1 text-slate-500 hover:text-amber-300" title="Undo" @click="delete edits[s.line]">
                    <v-icon name="fa-undo" scale="0.6" />
                  </button>
                  <button
                    v-if="s.block === 'x-secrets'"
                    class="ml-1 rounded border border-amber-800/70 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-500/10"
                    title="Change it everywhere it is used: the file, the database / Redis / MinIO, and the running containers"
                    @click="startChange(s)"
                  >
                    Change
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <textarea
              v-model="raw"
              spellcheck="false"
              class="h-[50vh] w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-[12px] leading-relaxed text-slate-200 focus:border-sky-500 focus:outline-none"
              @input="rawDirty = true"
            />
            <p class="mt-1 text-[11px] text-slate-500">Checked with <code>docker compose config</code> before it is saved — an invalid file is never written.</p>
          </template>
        </section>
      </div>

      <!-- Footer -->
      <div v-if="detail" class="flex flex-wrap items-center gap-2 border-t border-slate-800 px-5 py-3">
        <button
          v-if="view === 'settings'"
          :disabled="!dirtyCount || saving"
          class="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
          @click="saveSettings"
        >
          {{ saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}` : 'Saved' }}
        </button>
        <button
          v-else
          :disabled="!rawDirty || saving"
          class="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
          @click="saveRaw"
        >
          {{ saving ? 'Saving…' : 'Save file' }}
        </button>
        <span class="text-[11px] text-slate-500">{{ selected.size }}/{{ detail.services.length }} services selected</span>
        <div class="flex-1" />
        <button :class="ghost" @click="op('validate')">Validate</button>
        <button :class="ghost" :disabled="!selected.size" @click="op('restart')">Restart</button>
        <button :class="ghost" :disabled="!selected.size" @click="op('stop')">Stop</button>
        <button :class="ghost" class="!text-red-300" @click="op('down')">Remove containers</button>
        <button
          :disabled="!selected.size || Boolean(opLog?.running)"
          class="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          title="docker compose up -d, then checks every container is still running a few seconds later"
          @click="op('up')"
        >
          <v-icon name="fa-rocket" scale="0.7" /> Deploy
        </button>
      </div>
    </div>

    <!-- Change a secret everywhere -->
    <div v-if="change" data-modal class="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div class="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h3 class="flex items-center gap-2 font-semibold text-white">
          <v-icon name="fa-key" class="text-amber-300" /> Change <span class="font-mono">{{ change.setting.key }}</span>
        </h3>
        <div v-if="!change.plan" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
        <template v-else>
          <p class="mt-2 text-xs text-slate-400">
            Used by <span class="font-mono text-slate-200">{{ change.plan.uses.filter((u) => u !== change!.setting.key).join(', ') || 'only itself' }}</span>.
            This will:
          </p>
          <ol class="mt-1.5 list-decimal space-y-0.5 pl-5 text-xs text-slate-300">
            <li v-for="a in change.plan.actions" :key="a">{{ a }}</li>
          </ol>
          <p v-for="w in change.plan.warnings" :key="w" class="mt-2 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200">{{ w }}</p>
          <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">New value</label>
          <div class="flex gap-1.5">
            <input
              v-model="change.value"
              :type="change.reveal ? 'text' : 'password'"
              autocomplete="new-password"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
            />
            <button class="rounded-lg border border-slate-700 px-2.5 text-slate-400 hover:text-white" :title="change.reveal ? 'Hide' : 'Show'" @click="change.reveal = !change.reveal">
              <v-icon :name="change.reveal ? 'fa-eye-slash' : 'fa-eye'" scale="0.7" />
            </button>
            <button class="rounded-lg border border-slate-700 px-2.5 text-slate-400 hover:text-sky-300" title="Generate a random value" @click="generateChange">
              <v-icon name="fa-dice" scale="0.7" />
            </button>
          </div>
          <p class="mt-1 text-[11px] text-slate-500">Copy it somewhere safe if you need it outside this server — it is only kept in the compose file.</p>
        </template>
        <div class="mt-5 flex justify-end gap-2">
          <button class="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800" :disabled="change.busy" @click="change = null">Cancel</button>
          <button
            :disabled="!change.plan || !change.value.trim() || change.busy"
            class="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40"
            @click="applyChange"
          >
            {{ change.busy ? 'Changing…' : 'Change everywhere' }}
          </button>
        </div>
      </div>
    </div>

    <StepLog v-if="opLog" :title="opLog.title" :steps="opLog.steps" :running="opLog.running" :error="opLog.error" @close="opLog = null" />
  </div>
</template>
