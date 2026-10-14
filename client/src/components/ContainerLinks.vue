<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail, notify } from '../toast';
import type { Container, LinkTestResult, StepResult } from '../types';
import {
  DEFAULT_PORT,
  editableParts,
  envKeys,
  envOf,
  findLinks,
  labelsOf,
  readParts,
  writeParts,
  type Link,
  type LinkKind,
  type Part,
  type Parts,
} from '../links';

const props = defineProps<{ container: Container }>();
const emit = defineEmits<{ changed: [] }>();

const loading = ref(true);
const env = ref<Record<string, string>>({});
const declared = ref<Link[]>([]);
const detected = ref<Link[]>([]);
const mirrors = ref<Record<string, Link[]>>({});
const showDetected = ref(false);
const overrides = ref<{ editable: boolean; reason: string; file: string; env: Record<string, string> }>({
  editable: false,
  reason: '',
  file: '',
  env: {},
});

/** Edited values per link id, and each link's last test. */
const edits = reactive<Record<string, Parts>>({});
const tests = reactive<Record<string, LinkTestResult | 'running'>>({});
const saving = ref('');
const saveLog = ref<{ steps: StepResult[]; error: string } | null>(null);
const reveal = reactive<Record<string, boolean>>({});

const visible = computed(() => (declared.value.length && !showDetected.value ? declared.value : [...declared.value, ...detected.value]));

async function load() {
  loading.value = true;
  try {
    const [ins, ov] = await Promise.all([
      api.dockerInspect(props.container.id),
      api.dockerLinkOverrides(props.container.id).catch((err) => ({ editable: false, reason: (err as Error).message, file: '', env: {} })),
    ]);
    env.value = envOf(ins.inspect);
    const found = findLinks(env.value, labelsOf(ins.inspect));
    declared.value = found.declared;
    detected.value = found.detected;
    mirrors.value = found.mirrors;
    overrides.value = ov;
    for (const l of [...found.declared, ...found.detected]) edits[l.id] = readParts(l, env.value);
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const changes = (l: Link) =>
  Object.assign({}, writeParts(l, env.value, edits[l.id]), ...(mirrors.value[l.id] ?? []).map((m) => {
    // Only the parts the declared link has; the mirror keeps its own for the rest.
    const parts = { ...readParts(m, env.value) };
    for (const p of editableParts(l)) parts[p] = edits[l.id][p];
    return dirtyOwn(l) ? writeParts(m, env.value, parts) : {};
  }));
const dirtyOwn = (l: Link) => Object.keys(writeParts(l, env.value, edits[l.id])).length > 0;
const dirty = (l: Link) => Object.keys(changes(l)).length > 0;
const overridden = (l: Link) => envKeys(l).filter((k) => k in overrides.value.env);

function target(kind: LinkKind, p: Parts) {
  return { kind, host: p.host, port: p.port || DEFAULT_PORT[kind], database: p.database, user: p.user, password: p.password, url: p.url };
}

async function test(id: string, kind: LinkKind, parts: Parts) {
  tests[id] = 'running';
  try {
    tests[id] = await api.dockerLinkTest(props.container.id, target(kind, parts));
  } catch (err) {
    tests[id] = { ok: false, note: '', steps: [{ title: 'Test', ok: false, detail: (err as Error).message }] };
  }
}

async function testAll() {
  await Promise.all(visible.value.map((l) => test(l.id, l.kind, edits[l.id])));
}

async function save(l: Link, unset: string[] = []) {
  const set = unset.length ? {} : changes(l);
  const what = unset.length
    ? `Remove SSHer's overrides for ${l.name} (${unset.join(', ')})? The values from the project's own files apply again.`
    : `Point ${l.name} at the new values?\n\n${Object.keys(set).join('\n')}\n\n` +
      `They are written to ${overrides.value.file} and ${props.container.compose?.service ?? 'the service'} is recreated (a few seconds of downtime).`;
  if (!confirm(what)) return;
  saving.value = l.id;
  saveLog.value = null;
  try {
    const res = await api.dockerLinkSave(props.container.id, set, unset);
    saveLog.value = { steps: res.log, error: '' };
    notify(`${l.name} updated — ${props.container.compose?.service} recreated`);
    emit('changed');
  } catch (err) {
    saveLog.value = { steps: err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [], error: (err as Error).message };
  } finally {
    saving.value = '';
  }
}

// ------------------------------------------------------------ ad-hoc target

const adhoc = reactive<Parts & { kind: LinkKind }>({ kind: 'postgres', host: 'host.docker.internal', port: '', database: '', user: '', password: '', url: '' });
const adhocParts = computed<Part[]>(() =>
  adhoc.kind === 'http' ? ['url'] : adhoc.kind === 'postgres' ? ['host', 'port', 'database', 'user', 'password'] : adhoc.kind === 'redis' ? ['host', 'port', 'password'] : ['host', 'port'],
);

const LABELS: Record<Part, string> = { host: 'Host', port: 'Port', database: 'Database', user: 'User', password: 'Password', url: 'URL' };
const KIND_TONE: Record<LinkKind, string> = {
  postgres: 'bg-sky-500/15 text-sky-300',
  redis: 'bg-red-500/15 text-red-300',
  http: 'bg-emerald-500/15 text-emerald-300',
  tcp: 'bg-slate-700 text-slate-300',
};

function keyFor(l: Link, part: Part): string {
  if (l.shape.type === 'fields') return l.shape.keys[part as Exclude<Part, 'url'>] ?? '';
  return l.shape.key;
}

onMounted(load);

const field =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none';
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-start gap-2">
      <p class="flex-1 text-xs text-slate-400">
        What this container talks to. <b class="text-slate-300">Test</b> connects from inside the container, so the
        result is what the app itself gets. <b class="text-slate-300">Save</b> keeps the change in
        <code class="text-slate-300">ssher.override.yml</code> beside the project and recreates the container.
      </p>
      <button
        v-if="visible.length"
        class="shrink-0 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-sky-500"
        @click="testAll"
      >
        <v-icon name="fa-plug" scale="0.6" /> Test all
      </button>
    </div>

    <p v-if="!loading && !overrides.editable" class="rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
      {{ overrides.reason }} You can still test.
    </p>

    <div v-if="loading" class="py-8 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>

    <p v-else-if="!visible.length" class="rounded-lg border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
      Nothing in this container's environment looks like a database or service address. Test any target below.
    </p>

    <!-- One card per link -->
    <div v-for="l in visible" :key="l.id" class="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-white">{{ l.name }}</span>
        <span class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase" :class="KIND_TONE[l.kind]">{{ l.kind }}</span>
        <span v-if="l.declared" class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400" title="Declared by the image's io.ssher.link labels">declared</span>
        <span v-else class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500" title="Guessed from the environment">detected</span>
        <span
          v-if="overridden(l).length"
          class="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-200"
          :title="`Set by SSHer: ${overridden(l).join(', ')}`"
        >
          overridden
        </span>
      </div>
      <p v-if="l.note" class="mb-2 text-[11px] text-slate-500">{{ l.note }}</p>
      <p v-if="mirrors[l.id]?.length" class="mb-2 text-[11px] text-slate-500">
        Also kept in
        <code class="text-slate-400">{{ mirrors[l.id].map((m) => envKeys(m)[0]).join(', ') }}</code>, which carries the same
        address and is updated with it.
      </p>

      <div class="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <template v-for="part in editableParts(l)" :key="part">
          <label class="text-[11px] text-slate-500">{{ LABELS[part] }}</label>
          <div>
            <div class="relative">
              <input
                v-model="edits[l.id][part]"
                :type="part === 'password' && !reveal[l.id] ? 'password' : 'text'"
                :class="field"
                :placeholder="part === 'port' ? DEFAULT_PORT[l.kind] : ''"
                spellcheck="false"
                autocomplete="off"
              />
              <button
                v-if="part === 'password'"
                class="absolute top-1/2 right-1.5 -translate-y-1/2 text-slate-500 hover:text-white"
                @click="reveal[l.id] = !reveal[l.id]"
              >
                <v-icon :name="reveal[l.id] ? 'fa-eye-slash' : 'fa-eye'" scale="0.6" />
              </button>
            </div>
            <p class="mt-0.5 truncate font-mono text-[10px] text-slate-600" :title="keyFor(l, part)">
              {{ keyFor(l, part) }}<span v-if="keyFor(l, part) in overrides.env" class="text-amber-400"> · overridden</span>
            </p>
          </div>
        </template>
      </div>

      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          class="rounded-md bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
          :disabled="tests[l.id] === 'running'"
          @click="test(l.id, l.kind, edits[l.id])"
        >
          <v-icon :name="tests[l.id] === 'running' ? 'fa-spinner' : 'fa-plug'" scale="0.6" :class="tests[l.id] === 'running' && 'animate-spin'" />
          Test{{ dirty(l) ? ' new values' : '' }}
        </button>
        <template v-if="overrides.editable">
          <button
            v-if="dirty(l)"
            class="rounded-md border border-emerald-700 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            :disabled="!!saving"
            @click="save(l)"
          >
            <v-icon :name="saving === l.id ? 'fa-spinner' : 'fa-save'" scale="0.6" :class="saving === l.id && 'animate-spin'" /> Save &amp; recreate
          </button>
          <button v-if="dirty(l)" class="text-[11px] text-slate-500 hover:text-white" @click="edits[l.id] = readParts(l, env)">Undo edits</button>
          <button
            v-if="!dirty(l) && overridden(l).length"
            class="text-[11px] text-amber-400 hover:text-amber-300 disabled:opacity-40"
            :disabled="!!saving"
            @click="save(l, overridden(l))"
          >
            Remove override
          </button>
        </template>
      </div>

      <!-- Test result -->
      <div v-if="tests[l.id] && tests[l.id] !== 'running'" class="mt-2.5 space-y-1 rounded-md bg-slate-950 p-2">
        <template v-for="(s, i) in (tests[l.id] as LinkTestResult).steps" :key="i">
          <p class="flex items-start gap-1.5 text-[11px]">
            <v-icon :name="s.ok ? 'fa-check-circle' : 'fa-times-circle'" scale="0.65" class="mt-0.5 shrink-0" :class="s.ok ? 'text-emerald-400' : 'text-red-400'" />
            <span>
              <span class="text-slate-300">{{ s.title }}</span>
              <span class="text-slate-500"> — {{ s.detail }}</span>
              <span v-if="s.hint" class="mt-0.5 block text-amber-300/90">{{ s.hint }}</span>
            </span>
          </p>
        </template>
        <p class="pt-1 text-[10px] text-slate-600">{{ (tests[l.id] as LinkTestResult).note }}</p>
      </div>
    </div>

    <button
      v-if="declared.length && detected.length"
      class="text-[11px] text-slate-500 hover:text-white"
      @click="showDetected = !showDetected"
    >
      {{ showDetected ? 'Hide' : 'Show' }} {{ detected.length }} more found in the environment
    </button>

    <!-- Save output -->
    <div v-if="saveLog" class="rounded-lg border p-2.5 text-[11px]" :class="saveLog.error ? 'border-red-900 bg-red-950/30' : 'border-slate-800'">
      <p v-if="saveLog.error" class="mb-1 font-medium text-red-300">{{ saveLog.error }}</p>
      <details v-for="(s, i) in saveLog.steps" :key="i" :open="!s.ok">
        <summary class="cursor-pointer" :class="s.ok ? 'text-slate-400' : 'text-red-300'">
          <v-icon :name="s.ok ? 'fa-check' : 'fa-times'" scale="0.55" /> {{ s.title }}
        </summary>
        <pre class="mt-1 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] whitespace-pre-wrap text-slate-400">{{ s.output }}</pre>
      </details>
    </div>

    <!-- Anything else -->
    <div class="rounded-lg border border-dashed border-slate-700 p-3">
      <p class="mb-2 text-xs font-medium text-slate-300">Can it reach…?</p>
      <p class="mb-2 text-[11px] text-slate-500">Try any address from inside this container. Nothing is saved.</p>
      <div class="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <label class="text-[11px] text-slate-500">Kind</label>
        <select v-model="adhoc.kind" :class="field">
          <option value="postgres">PostgreSQL</option>
          <option value="redis">Redis</option>
          <option value="http">HTTP(S) URL</option>
          <option value="tcp">Any TCP port</option>
        </select>
        <template v-for="part in adhocParts" :key="part">
          <label class="text-[11px] text-slate-500">{{ LABELS[part] }}</label>
          <input
            v-model="adhoc[part]"
            :type="part === 'password' ? 'password' : 'text'"
            :class="field"
            :placeholder="part === 'port' ? DEFAULT_PORT[adhoc.kind] : part === 'url' ? 'http://minio:9000/minio/health/live' : ''"
            spellcheck="false"
            autocomplete="off"
          />
        </template>
      </div>
      <button
        class="mt-2.5 rounded-md bg-slate-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-slate-600 disabled:opacity-40"
        :disabled="tests.adhoc === 'running'"
        @click="test('adhoc', adhoc.kind, adhoc)"
      >
        <v-icon :name="tests.adhoc === 'running' ? 'fa-spinner' : 'fa-plug'" scale="0.6" :class="tests.adhoc === 'running' && 'animate-spin'" /> Test
      </button>
      <div v-if="tests.adhoc && tests.adhoc !== 'running'" class="mt-2.5 space-y-1 rounded-md bg-slate-950 p-2">
        <p v-for="(s, i) in (tests.adhoc as LinkTestResult).steps" :key="i" class="flex items-start gap-1.5 text-[11px]">
          <v-icon :name="s.ok ? 'fa-check-circle' : 'fa-times-circle'" scale="0.65" class="mt-0.5 shrink-0" :class="s.ok ? 'text-emerald-400' : 'text-red-400'" />
          <span>
            <span class="text-slate-300">{{ s.title }}</span>
            <span class="text-slate-500"> — {{ s.detail }}</span>
            <span v-if="s.hint" class="mt-0.5 block text-amber-300/90">{{ s.hint }}</span>
          </span>
        </p>
        <p class="pt-1 text-[10px] text-slate-600">{{ (tests.adhoc as LinkTestResult).note }}</p>
      </div>
    </div>
  </div>
</template>
