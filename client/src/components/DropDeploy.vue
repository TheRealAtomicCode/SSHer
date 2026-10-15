<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { isCancelled, trackUpload } from '../backgroundTasks';
import { fail, notify } from '../toast';
import { newTransferId } from '../transferProgress';
import type { StackCrash, StackRef, StackSummary, StepResult } from '../types';

/**
 * The drag-and-drop finish. Every dropped image archive is uploaded and `docker load`ed in
 * turn; then each loaded image is matched to what uses it:
 *
 *   a service of a stack     -> "Update hr-api, op-client in lptic" (old builds kept as :rollback)
 *   nothing on this server   -> "Deploy as a new app" (the wizard) or start a stack for it
 *
 * so dropping a whole folder of new builds is one click from running them.
 */
const props = defineProps<{ files: File[] }>();
const emit = defineEmits<{
  close: [];
  changed: [];
  deployNew: [string];
  openStack: [StackRef];
}>();

interface Row {
  file: File;
  state: 'queued' | 'uploading' | 'loaded' | 'failed' | 'cancelled';
  progress: number;
  images: string[];
  error: string;
}

const rows = reactive<Row[]>(props.files.map((file) => ({ file, state: 'queued', progress: 0, images: [], error: '' })));
const uploading = ref(true);
const stacks = ref<StackSummary[]>([]);
const picks = reactive<Record<string, Set<string>>>({});
const results = reactive<Record<string, { running: boolean; ok: boolean | null; log: StepResult[]; crashed: StackCrash[]; error: string }>>({});

const loaded = computed(() => [...new Set(rows.flatMap((r) => r.images))]);

/** Stacks with at least one service on a just-loaded image. */
const matches = computed(() =>
  stacks.value
    .map((s) => ({ stack: s, services: s.services.filter((x) => loaded.value.includes(x.image)) }))
    .filter((m) => m.services.length),
);
const unused = computed(() => loaded.value.filter((img) => !matches.value.some((m) => m.services.some((s) => s.image === img))));

const key = (s: StackSummary) => s.files[0];
const refOf = (s: StackSummary): StackRef => ({ dir: s.dir, files: s.files, project: s.project });

async function uploadAll() {
  for (const row of rows) {
    const id = newTransferId();
    const task = trackUpload(id, row.file.name, 'docker load');
    row.state = 'uploading';
    try {
      const res = await api.dockerLoad(row.file, (p) => {
        task.progress(p);
        row.progress = p;
      }, id, task.signal);
      task.settle();
      if (!res.images.length) throw new Error(`docker load did not report an image:\n${res.output}`);
      row.images = res.images;
      row.state = 'loaded';
    } catch (err) {
      task.settle(err);
      row.state = isCancelled(err) ? 'cancelled' : 'failed';
      row.error = isCancelled(err) ? '' : (err as Error).message;
    }
  }
  uploading.value = false;
  if (!loaded.value.length) return;
  notify(`Loaded ${loaded.value.length} image${loaded.value.length === 1 ? '' : 's'}`);
  emit('changed');
  try {
    stacks.value = (await api.stacks()).stacks;
  } catch (err) {
    fail(err);
  }
  // Tick by default every matching service that already exists — a new build of something
  // running is an update; one never deployed waits for the stack's own Deploy.
  for (const m of matches.value) picks[key(m.stack)] = new Set(m.services.filter((s) => s.state).map((s) => s.name));
}

function toggle(stackKey: string, service: string) {
  const set = new Set(picks[stackKey]);
  if (set.has(service)) set.delete(service);
  else set.add(service);
  picks[stackKey] = set;
}

async function update(m: (typeof matches.value)[number]) {
  const k = key(m.stack);
  const services = [...(picks[k] ?? [])];
  if (!services.length) return;
  results[k] = { running: true, ok: null, log: [], crashed: [], error: '' };
  try {
    const res = await api.stackUpdateImages(refOf(m.stack), services);
    Object.assign(results[k], { ok: res.ok, log: res.log, crashed: res.crashed });
    if (res.ok) notify(`${m.stack.project}: ${services.join(', ')} updated`);
    emit('changed');
  } catch (err) {
    Object.assign(results[k], {
      ok: false,
      log: err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [],
      error: (err as Error).message,
    });
  } finally {
    results[k].running = false;
  }
}

onMounted(uploadAll);

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
</script>

<template>
  <div data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
    <div class="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <div class="flex items-center gap-2 border-b border-slate-800 px-6 py-4">
        <v-icon name="fa-docker" class="text-sky-400" scale="1.1" />
        <h2 class="flex-1 text-base font-semibold text-white">
          {{ uploading ? `Loading ${rows.length} image${rows.length === 1 ? '' : 's'}…` : 'Images loaded' }}
        </h2>
        <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-5 overflow-auto px-6 py-5">
        <!-- Upload queue -->
        <div class="space-y-1.5">
          <div v-for="r in rows" :key="r.file.name" class="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
            <div class="flex items-center gap-2 text-xs">
              <v-icon
                :name="r.state === 'loaded' ? 'fa-check-circle' : r.state === 'failed' ? 'fa-times' : r.state === 'uploading' ? 'fa-spinner' : 'fa-file-upload'"
                :class="[r.state === 'loaded' ? 'text-emerald-400' : r.state === 'failed' ? 'text-red-400' : 'text-slate-500', r.state === 'uploading' && 'animate-spin']"
                scale="0.75"
              />
              <span class="min-w-0 flex-1 truncate font-mono text-slate-200">{{ r.file.name }}</span>
              <span class="text-slate-500">{{ mb(r.file.size) }}</span>
              <span v-if="r.state === 'uploading'" class="w-10 text-right tabular-nums text-sky-300">{{ r.progress }}%</span>
            </div>
            <p v-if="r.images.length" class="mt-0.5 pl-6 font-mono text-[11px] text-emerald-300/80">{{ r.images.join(', ') }}</p>
            <p v-if="r.error" class="mt-0.5 pl-6 text-[11px] whitespace-pre-wrap text-red-300">{{ r.error }}</p>
            <div v-if="r.state === 'uploading'" class="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
              <div class="h-full bg-sky-500 transition-all" :style="{ width: `${r.progress}%` }" />
            </div>
          </div>
          <p v-if="uploading" class="text-[11px] text-slate-500">
            Progress also shows in the background-tasks tray — you can close this and keep working; come back with the Stacks tab.
          </p>
        </div>

        <!-- Where they go -->
        <template v-if="!uploading">
          <div v-for="m in matches" :key="key(m.stack)" class="rounded-xl border border-sky-800/50 bg-sky-500/5 p-4">
            <div class="flex items-center gap-2">
              <v-icon name="fa-cubes" class="text-sky-300" />
              <p class="flex-1 text-sm font-semibold text-white">{{ m.stack.project }}</p>
              <button class="text-xs text-sky-300 hover:text-sky-200" @click="emit('openStack', refOf(m.stack))">Open stack →</button>
            </div>
            <p class="mt-0.5 font-mono text-[11px] text-slate-500">{{ m.stack.files[0] }}</p>
            <div class="mt-3 space-y-1">
              <label v-for="s in m.services" :key="s.name" class="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" class="accent-sky-500" :checked="picks[key(m.stack)]?.has(s.name)" @change="toggle(key(m.stack), s.name)" />
                <span class="font-medium text-white">{{ s.name }}</span>
                <span class="font-mono text-slate-500">{{ s.image }}</span>
                <span class="text-slate-500">— {{ s.state ? `${s.state} now` : 'not created yet' }}</span>
              </label>
            </div>
            <template v-if="!results[key(m.stack)]">
              <button
                :disabled="!picks[key(m.stack)]?.size"
                class="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                @click="update(m)"
              >
                <v-icon name="fa-rocket" scale="0.7" />
                Update {{ picks[key(m.stack)]?.size ?? 0 }} service{{ picks[key(m.stack)]?.size === 1 ? '' : 's' }}
              </button>
              <p class="mt-1 text-[11px] text-slate-500">Each running build is kept as <code>:rollback</code> first; containers are recreated, then checked to stay up.</p>
            </template>
            <div v-else class="mt-3 space-y-1">
              <p v-if="results[key(m.stack)].running" class="flex items-center gap-2 text-xs text-sky-300">
                <v-icon name="fa-spinner" class="animate-spin" scale="0.7" /> Updating…
              </p>
              <details v-for="(l, i) in results[key(m.stack)].log" :key="i" :open="!l.ok" class="rounded border border-slate-800 bg-slate-950/50">
                <summary class="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs">
                  <v-icon :name="l.ok ? 'fa-check' : 'fa-times'" scale="0.6" :class="l.ok ? 'text-emerald-400' : 'text-red-400'" /> {{ l.title }}
                </summary>
                <pre v-if="l.output" class="max-h-40 overflow-auto px-2 py-1 font-mono text-[10px] whitespace-pre-wrap text-slate-400">{{ l.output }}</pre>
              </details>
              <details v-for="c in results[key(m.stack)].crashed" :key="c.container" open class="rounded border border-red-900/60">
                <summary class="px-2 py-1 text-xs text-red-200">{{ c.service }} — {{ c.state }}, exit {{ c.exitCode }}</summary>
                <pre class="max-h-48 overflow-auto px-2 py-1 font-mono text-[10px] whitespace-pre-wrap text-slate-300">{{ c.logs }}</pre>
              </details>
              <p v-if="results[key(m.stack)].error" class="text-xs text-red-300">{{ results[key(m.stack)].error }}</p>
              <p v-if="results[key(m.stack)].ok" class="text-xs text-emerald-300"><v-icon name="fa-check-circle" scale="0.7" /> Updated and staying up.</p>
            </div>
          </div>

          <div v-if="unused.length" class="rounded-xl border border-slate-800 p-4">
            <p class="text-sm font-medium text-white">Not used by anything on this server yet</p>
            <div v-for="img in unused" :key="img" class="mt-2 flex flex-wrap items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{{ img }}</span>
              <button class="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-sky-500" @click="emit('deployNew', img)">
                Deploy as a single app
              </button>
            </div>
            <p class="mt-2 text-[11px] text-slate-500">
              Part of a multi-service app with settings (API + front end + database…)? Drop or create its compose file in
              <b>Stacks</b> — the image is already loaded, so the stack finds it.
            </p>
          </div>

          <p v-if="!loaded.length" class="text-sm text-slate-400">Nothing was loaded.</p>
        </template>
      </div>
    </div>
  </div>
</template>
