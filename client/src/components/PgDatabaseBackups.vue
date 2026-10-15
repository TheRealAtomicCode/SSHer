<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { fail, notify } from '../toast';
import type { PgDump, PostgresDatabase, PostgresRole } from '../types';

/**
 * Backups of chosen databases (pg_dump, one file each), kept on the server. The whole-server
 * backups on the Backups page (pgBackRest) always cover every database at once — they are what
 * makes "rewind to 10:42" possible — so picking databases one by one happens here.
 */
const props = defineProps<{ databases: PostgresDatabase[]; roles: PostgresRole[] }>();
const emit = defineEmits<{ changed: [] }>();

const dumps = ref<PgDump[]>([]);
const dir = ref('');
const picked = ref<Set<string>>(new Set());
const running = ref(false);
const restoring = ref<{ dump: PgDump; target: string; owner: string; busy: boolean } | null>(null);

const choosable = computed(() => props.databases.filter((d) => !['template0', 'template1'].includes(d.name)));
const byDb = computed(() => {
  const map = new Map<string, PgDump[]>();
  for (const d of dumps.value) {
    if (!map.has(d.database)) map.set(d.database, []);
    map.get(d.database)!.push(d);
  }
  return [...map.entries()];
});

async function load() {
  try {
    const res = await api.postgresDumps();
    dumps.value = res.dumps;
    dir.value = res.dir;
  } catch (err) {
    fail(err);
  }
}

function toggle(name: string) {
  const next = new Set(picked.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  picked.value = next;
}

async function backUp() {
  running.value = true;
  try {
    const res = await api.postgresBackupDatabases([...picked.value]);
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length) fail(new Error(failed.map((r) => `${r.database}: ${r.output}`).join('\n')));
    const done = res.results.filter((r) => r.ok);
    if (done.length) notify(`Backed up ${done.map((r) => `${r.database} (${r.output})`).join(', ')}`);
    picked.value = new Set();
    await load();
    emit('changed');
  } catch (err) {
    fail(err);
  } finally {
    running.value = false;
  }
}

function download(d: PgDump) {
  const a = document.createElement('a');
  a.href = api.postgresSavedDumpUrl(d.file);
  a.click();
}

async function remove(d: PgDump) {
  if (!confirm(`Delete the backup ${d.file.split('/')[1]}?`)) return;
  try {
    await api.postgresDeleteDump(d.file);
    await load();
  } catch (err) {
    fail(err);
  }
}

function startRestore(d: PgDump) {
  const owner = props.databases.find((x) => x.name === d.database)?.owner ?? 'postgres';
  restoring.value = { dump: d, target: `${d.database}_restored`, owner, busy: false };
}

async function restore() {
  const r = restoring.value;
  if (!r) return;
  r.busy = true;
  try {
    await api.postgresRestoreDump(r.dump.file, r.target, r.owner);
    notify(`Restored into the new database ${r.target}`);
    restoring.value = null;
    emit('changed');
  } catch (err) {
    fail(err);
    r.busy = false;
  }
}

const when = (ms: number) => new Date(ms).toLocaleString();

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900/40">
    <div class="border-b border-slate-800 px-4 py-3">
      <p class="flex items-center gap-2 text-sm font-medium text-white"><v-icon name="fa-archive" scale="0.8" class="text-sky-300" /> Back up databases</p>
      <p class="mt-0.5 text-xs text-slate-500">
        Pick the databases to back up now — each becomes its own compressed file on the server
        (<span class="font-mono">{{ dir || '…' }}</span>, readable by postgres only). The Backups page backs up the whole server at once.
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
      <label
        v-for="d in choosable"
        :key="d.name"
        class="flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition"
        :class="picked.has(d.name) ? 'border-sky-500 bg-sky-500/10 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'"
      >
        <input type="checkbox" class="accent-sky-500" :checked="picked.has(d.name)" @change="toggle(d.name)" />
        <span class="font-mono">{{ d.name }}</span>
        <span class="text-slate-500">{{ formatSize(d.bytes ?? 0) }}</span>
      </label>
      <div class="flex-1" />
      <button
        :disabled="!picked.size || running"
        class="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
        @click="backUp"
      >
        <v-icon :name="running ? 'fa-spinner' : 'fa-archive'" :class="running && 'animate-spin'" scale="0.7" />
        {{ running ? 'Backing up…' : `Back up ${picked.size || ''} now` }}
      </button>
    </div>

    <div v-if="byDb.length" class="border-t border-slate-800">
      <details v-for="[db, list] in byDb" :key="db" class="border-b border-slate-800/70 last:border-b-0">
        <summary class="flex cursor-pointer items-center gap-2 px-4 py-2 text-xs hover:bg-slate-900/60">
          <v-icon name="fa-database" scale="0.65" class="text-slate-500" />
          <span class="font-mono text-slate-200">{{ db }}</span>
          <span class="text-slate-500">{{ list.length }} backup{{ list.length === 1 ? '' : 's' }} · newest {{ when(list[0].createdAt) }}</span>
        </summary>
        <div v-for="d in list" :key="d.file" class="flex flex-wrap items-center gap-3 px-4 py-1.5 pl-10 text-xs">
          <span class="text-slate-300">{{ when(d.createdAt) }}</span>
          <span class="text-slate-500">{{ formatSize(d.bytes) }}</span>
          <div class="flex-1" />
          <button class="rounded-md px-2 py-0.5 text-sky-300 hover:bg-sky-500/10" @click="download(d)"><v-icon name="fa-download" scale="0.6" /> Download</button>
          <button class="rounded-md px-2 py-0.5 text-slate-300 hover:bg-slate-800" title="Restore into a new database (never over an existing one)" @click="startRestore(d)">
            <v-icon name="fa-history" scale="0.6" /> Restore as new
          </button>
          <button class="rounded-md px-2 py-0.5 text-red-400 hover:bg-red-950" @click="remove(d)"><v-icon name="fa-trash-alt" scale="0.6" /></button>
        </div>
      </details>
    </div>
    <p v-else class="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">No database backups yet.</p>

    <div v-if="restoring" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="text-base font-semibold text-white">Restore as a new database</h2>
        <p class="mt-1 text-xs text-slate-400">
          From <span class="font-mono">{{ restoring.dump.file.split('/')[1] }}</span>. Nothing existing is touched — compare it, copy data back, or point an app at it.
        </p>
        <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">New database name</label>
        <input v-model="restoring.target" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none" />
        <label class="mt-3 mb-1.5 block text-xs font-medium text-slate-400">Owner</label>
        <select v-model="restoring.owner" class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100">
          <option v-for="r in roles" :key="r.name" :value="r.name">{{ r.name }}</option>
        </select>
        <div class="mt-5 flex justify-end gap-2">
          <button class="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800" :disabled="restoring.busy" @click="restoring = null">Cancel</button>
          <button
            :disabled="!restoring.target || restoring.busy"
            class="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
            @click="restore"
          >
            {{ restoring.busy ? 'Restoring…' : 'Restore' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
