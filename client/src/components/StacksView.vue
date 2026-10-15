<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import * as api from '../api';
import { STACK_TEMPLATES } from '../stackTemplates';
import { fail, notify } from '../toast';
import type { StackRef, StackSummary } from '../types';
import StackPanel from './StackPanel.vue';

/** The Docker page's "Stacks" tab: every compose project on the server, and a way to
 *  bring a new one — upload, paste or template — then fill in its settings and deploy. */
const props = defineProps<{ query: string; incoming?: { name: string; content: string } | null; openRef?: StackRef | null }>();
const emit = defineEmits<{
  openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }];
  openLogs: [string];
  changed: [];
  consumed: [];
}>();

const list = ref<StackSummary[]>([]);
const loading = ref(true);
const open = ref<StackRef | null>(null);

// ------------------------------------------------------------- new stack
const creating = ref(false);
const draft = ref({ name: '', dir: '', content: '', overwrite: false, source: 'upload' as 'upload' | 'paste' | 'template', template: '' });
const dirTouched = ref(false);
const submitting = ref(false);

async function load() {
  loading.value = true;
  try {
    list.value = (await api.stacks()).stacks;
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => {
  const q = props.query.trim().toLowerCase();
  return q ? list.value.filter((s) => `${s.project} ${s.dir} ${s.services.map((x) => `${x.name} ${x.image}`).join(' ')}`.toLowerCase().includes(q)) : list.value;
});

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function startNew(prefill?: { name: string; content: string }) {
  const name = prefill ? slug(prefill.name.replace(/\.(ya?ml)$/i, '').replace(/^docker-compose\.?|^compose\.?/i, '')) || 'app' : '';
  draft.value = { name, dir: name ? `/opt/${name}` : '', content: prefill?.content ?? '', overwrite: false, source: prefill ? 'upload' : 'upload', template: '' };
  // A compose file's own `name:` is the better project name.
  const own = /^name:\s*["']?([a-z0-9][a-z0-9_-]*)/m.exec(prefill?.content ?? '')?.[1];
  if (own) {
    draft.value.name = own;
    draft.value.dir = `/opt/${own}`;
  }
  dirTouched.value = false;
  creating.value = true;
}

watch(
  () => draft.value.name,
  (name) => {
    if (!dirTouched.value) draft.value.dir = name ? `/opt/${slug(name)}` : '';
  },
);

function useTemplate(id: string) {
  const t = STACK_TEMPLATES.find((x) => x.id === id);
  if (!t) return;
  draft.value.template = id;
  draft.value.content = t.content(slug(draft.value.name) || 'myapp');
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 512 * 1024) {
    fail(new Error(`${file.name} is too large to be a compose file`));
    return;
  }
  const content = await file.text();
  const keepName = draft.value.name;
  startNew({ name: keepName || file.name, content });
  if (keepName) draft.value.name = keepName;
}

async function create() {
  submitting.value = true;
  try {
    const res = await api.stackCreate({ dir: draft.value.dir, content: draft.value.content, overwrite: draft.value.overwrite });
    notify(
      `Created ${res.files[0]}` +
        (res.stripped?.length ? ` — removed build: from ${res.stripped.join(', ')} (no source on this server; their images come from .tar files)` : ''),
    );
    creating.value = false;
    await load();
    open.value = { dir: res.dir, files: res.files, project: '' };
  } catch (err) {
    fail(err);
  } finally {
    submitting.value = false;
  }
}

function stateSummary(s: StackSummary) {
  if (!s.services.length) return 'no services';
  if (!s.running) return s.services.some((x) => x.state) ? 'stopped' : 'not deployed yet';
  return `${s.running}/${s.services.length} running`;
}

// ------------------------------------------- a dropped file for an EXISTING stack

const merging = ref<{
  stack: StackSummary;
  name: string;
  content: string;
  report: api.StackMergeReport | null;
  busy: boolean;
} | null>(null);

/** A dropped/uploaded compose file whose `name:` (or /opt/<name>) matches a stack already on
 *  the server is offered as an UPDATE of that stack — the new layout with today's values —
 *  rather than a second stack that would fight the first one for its ports. */
async function routeIncoming(inc: { name: string; content: string }) {
  if (!list.value.length) await load();
  const own = /^name:\s*["']?([a-z0-9][a-z0-9_-]*)/m.exec(inc.content)?.[1];
  const base = slug(inc.name.replace(/\.(ya?ml)$/i, '').replace(/^docker-compose\.?|^compose\.?/i, ''));
  const stack = list.value.find((s) => (own && (s.project === own || s.dir === `/opt/${own}`)) || (!own && base && s.dir === `/opt/${base}`));
  if (!stack) {
    startNew(inc);
    return;
  }
  merging.value = { stack, name: inc.name, content: inc.content, report: null, busy: false };
  try {
    merging.value.report = await api.stackMerge({ dir: stack.dir, files: stack.files, project: stack.project }, inc.content, true);
  } catch (err) {
    fail(err);
    merging.value = null;
  }
}

async function applyMerge() {
  const m = merging.value;
  if (!m) return;
  m.busy = true;
  try {
    const ref: StackRef = { dir: m.stack.dir, files: m.stack.files, project: m.stack.project };
    await api.stackMerge(ref, m.content);
    notify(`${m.stack.project}: compose file updated, your values kept (old file saved beside it)`);
    merging.value = null;
    await load();
    open.value = ref;
  } catch (err) {
    fail(err);
    m.busy = false;
  }
}

function mergeAsNew() {
  const m = merging.value;
  merging.value = null;
  if (m) startNew({ name: m.name, content: m.content });
}

// The Docker page hands over a dropped .yml, or a project to open, through props.
watch(
  () => props.incoming,
  (inc) => {
    if (inc) {
      routeIncoming(inc);
      emit('consumed');
    }
  },
  { immediate: true },
);
watch(
  () => props.openRef,
  (r) => {
    if (r) {
      open.value = r;
      emit('consumed');
    }
  },
  { immediate: true },
);

onMounted(load);
defineExpose({ load, startNew });

const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <v-icon name="fa-layer-group" class="text-sky-300" />
      <p class="min-w-0 flex-1 text-xs text-slate-400">
        A <b class="text-slate-200">stack</b> is a docker compose file with one or more services — API, front end, Redis, MinIO —
        deployed together. Its settings live in the file, and you edit them here as a form.
      </p>
      <button class="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500" @click="startNew()">
        <v-icon name="fa-plus" scale="0.7" /> New stack
      </button>
    </div>

    <div v-if="loading && !list.length" class="py-16 text-center"><v-icon name="fa-spinner" scale="1.5" class="animate-spin text-sky-400" /></div>
    <p v-else-if="!filtered.length" class="py-10 text-center text-sm text-slate-500">
      No stacks yet. Press <b>New stack</b>, or drop a .yml file on this page.
    </p>

    <div class="grid gap-3 lg:grid-cols-2">
      <button
        v-for="s in filtered"
        :key="s.files[0]"
        class="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-left transition hover:border-sky-700 hover:bg-slate-900/60"
        @click="open = { dir: s.dir, files: s.files, project: s.project }"
      >
        <div class="flex items-center gap-2">
          <span
            class="h-2 w-2 rounded-full"
            :class="s.running === s.services.length && s.running ? 'bg-emerald-400' : s.running ? 'bg-amber-400' : 'bg-slate-600'"
          />
          <p class="flex-1 truncate text-sm font-semibold text-white">{{ s.project || s.dir }}</p>
          <span class="text-[11px] text-slate-500">{{ stateSummary(s) }}</span>
        </div>
        <p class="mt-0.5 truncate font-mono text-[11px] text-slate-500">{{ s.files.join(' + ') }}</p>
        <div class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="x in s.services"
            :key="x.name"
            class="rounded px-1.5 py-0.5 font-mono text-[10px]"
            :class="x.state === 'running' ? 'bg-emerald-950 text-emerald-300' : x.state === 'restarting' ? 'bg-red-950 text-red-300' : 'bg-slate-800 text-slate-400'"
            :title="`${x.image}${x.imagePresent ? '' : ' — image not on the server'}`"
          >
            {{ x.name }}<span v-if="!x.imagePresent" class="text-amber-400"> ⚠</span>
          </span>
        </div>
        <p v-if="s.placeholders" class="mt-2 text-[11px] text-amber-300">
          <v-icon name="fa-exclamation-triangle" scale="0.55" /> {{ s.placeholders }} setting(s) still say CHANGE_ME
        </p>
        <p v-if="s.error" class="mt-2 line-clamp-2 font-mono text-[11px] text-red-400">{{ s.error }}</p>
      </button>
    </div>

    <!-- Update an existing stack from a dropped file -->
    <div v-if="merging" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div class="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div class="border-b border-slate-800 px-6 py-4">
          <h2 class="text-base font-semibold text-white">Update {{ merging.stack.project }}?</h2>
          <p class="mt-0.5 text-xs text-slate-400">
            <span class="font-mono">{{ merging.name }}</span> is for the stack already at
            <span class="font-mono">{{ merging.stack.files[0] }}</span>. Use its new layout and keep every value you set there?
          </p>
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-auto px-6 py-4 text-xs">
          <div v-if="!merging.report" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
          <template v-else>
            <p class="text-emerald-300"><v-icon name="fa-check-circle" scale="0.65" /> {{ merging.report.kept.length }} value(s) carried over from the current file.</p>
            <div v-if="merging.report.needsValue.length" class="rounded-lg border border-amber-800/50 bg-amber-950/30 p-3 text-amber-200">
              <p class="font-medium">Still need a value ({{ merging.report.needsValue.length }}) — fill them in on the stack's Settings after this:</p>
              <p class="mt-1 font-mono text-[11px] text-amber-100/80">{{ merging.report.needsValue.join(' · ') }}</p>
            </div>
            <div v-if="merging.report.added.length">
              <p class="font-medium text-slate-300">New in this file</p>
              <p class="font-mono text-[11px] text-slate-400">{{ merging.report.added.join(' · ') }}</p>
            </div>
            <div v-if="merging.report.dropped.length">
              <p class="font-medium text-slate-300">No longer in the file (their values go)</p>
              <p class="font-mono text-[11px] text-slate-400">{{ merging.report.dropped.join(' · ') }}</p>
            </div>
            <p v-if="merging.report.stripped.length" class="text-slate-400">
              <code>build:</code> removed from {{ merging.report.stripped.join(', ') }} — no source on this server; their images come from .tar files.
            </p>
            <p class="text-slate-500">The current file is saved beside it as <span class="font-mono">…yml.before-&lt;date&gt;</span>. Nothing is restarted — Deploy when ready.</p>
          </template>
        </div>
        <div class="flex items-center gap-2 border-t border-slate-800 px-6 py-3">
          <button class="text-xs text-slate-400 hover:text-white" :disabled="merging.busy" @click="mergeAsNew">Create a separate stack instead</button>
          <div class="flex-1" />
          <button class="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800" :disabled="merging.busy" @click="merging = null">Cancel</button>
          <button
            :disabled="!merging.report || merging.busy"
            class="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
            @click="applyMerge"
          >
            {{ merging.busy ? 'Updating…' : 'Update, keep my values' }}
          </button>
        </div>
      </div>
    </div>

    <!-- New stack -->
    <div v-if="creating" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div class="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div class="flex items-center gap-2 border-b border-slate-800 px-6 py-4">
          <v-icon name="fa-layer-group" class="text-sky-400" />
          <h2 class="flex-1 text-base font-semibold text-white">New stack</h2>
          <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="creating = false"><v-icon name="fa-times" scale="0.85" /></button>
        </div>

        <div class="min-h-0 flex-1 space-y-4 overflow-auto px-6 py-5">
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label :class="label">Name</label>
              <input v-model="draft.name" placeholder="devisehr" :class="[field, 'font-mono']" />
            </div>
            <div>
              <label :class="label">Folder on the server</label>
              <input v-model="draft.dir" placeholder="/opt/devisehr" :class="[field, 'font-mono']" @input="dirTouched = true" />
            </div>
          </div>

          <div>
            <label :class="label">Where does the compose file come from?</label>
            <div class="grid gap-2 sm:grid-cols-3">
              <button
                v-for="o in [
                  { v: 'upload', icon: 'fa-file-upload', t: 'Upload a file', d: 'e.g. docker-compose.prod.yml from the repo' },
                  { v: 'paste', icon: 'fa-paste', t: 'Paste it', d: 'Copy the YAML from anywhere' },
                  { v: 'template', icon: 'fa-file-code', t: 'Start from a template', d: 'A commented starting point' },
                ] as const"
                :key="o.v"
                class="rounded-xl border p-3 text-left transition"
                :class="draft.source === o.v ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'"
                @click="draft.source = o.v"
              >
                <v-icon :name="o.icon" :class="draft.source === o.v ? 'text-sky-300' : 'text-slate-500'" />
                <p class="mt-1.5 text-sm font-medium text-white">{{ o.t }}</p>
                <p class="mt-0.5 text-[11px] leading-snug text-slate-400">{{ o.d }}</p>
              </button>
            </div>
          </div>

          <label v-if="draft.source === 'upload'" class="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-slate-700 px-4 py-3 hover:border-sky-600">
            <v-icon name="fa-file-upload" class="text-sky-300" />
            <span class="flex-1 text-sm text-slate-300">{{ draft.content ? 'Loaded — review it below, or choose another file' : 'Choose a .yml / .yaml file' }}</span>
            <input type="file" accept=".yml,.yaml" class="hidden" @change="onFile" />
          </label>

          <div v-if="draft.source === 'template'" class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="t in STACK_TEMPLATES"
              :key="t.id"
              class="rounded-lg border p-2.5 text-left text-xs transition"
              :class="draft.template === t.id ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:border-slate-500'"
              @click="useTemplate(t.id)"
            >
              <p class="font-medium text-white">{{ t.title }}</p>
              <p class="mt-0.5 text-slate-400">{{ t.description }}</p>
            </button>
          </div>

          <div v-if="draft.content || draft.source === 'paste'">
            <label :class="label">docker-compose.yml <span class="text-slate-600">— edit freely; the settings form comes next</span></label>
            <textarea
              v-model="draft.content"
              spellcheck="false"
              placeholder="services:&#10;  app:&#10;    image: …"
              class="h-72 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-[12px] leading-relaxed text-slate-200 focus:border-sky-500 focus:outline-none"
            />
            <p class="mt-1 text-[11px] text-slate-500">
              Saved as {{ draft.dir || '/opt/…' }}/docker-compose.yml, mode 600 (it will hold secrets). Nothing starts yet: you fill in the
              settings and upload any missing images first.
            </p>
          </div>

          <label class="flex items-center gap-2 text-xs text-slate-400">
            <input v-model="draft.overwrite" type="checkbox" class="accent-amber-500" /> Replace the file if the folder already has one
          </label>
        </div>

        <div class="flex items-center gap-2 border-t border-slate-800 px-6 py-3">
          <div class="flex-1" />
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="creating = false">Cancel</button>
          <button
            :disabled="!draft.content.trim() || !draft.dir.startsWith('/') || submitting"
            class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
            @click="create"
          >
            {{ submitting ? 'Checking…' : 'Create stack' }}
          </button>
        </div>
      </div>
    </div>

    <StackPanel
      v-if="open"
      :key="open.files[0]"
      :stack="open"
      @close="open = null; load()"
      @changed="emit('changed')"
      @open-path="emit('openPath', $event)"
      @open-logs="emit('openLogs', $event)"
    />
  </div>
</template>
