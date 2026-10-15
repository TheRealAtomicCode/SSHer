<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from '../api';
import { formatSize } from '../files';
import { fail, notify } from '../toast';
import type { PgIndex, PgMaintenance, PgSession, PgTopQuery, PostgresDatabase } from '../types';

/** Indexes (health, rebuild, defragment), what runs right now, and the slowest queries. */
const props = defineProps<{ databases: PostgresDatabase[] }>();

const view = ref<'indexes' | 'running' | 'slowest'>('indexes');

// ------------------------------------------------------------------ indexes

const db = ref('');
const indexes = ref<PgIndex[]>([]);
const hasFragStats = ref(false);
const loadingIdx = ref(false);
const filter = ref('');
const onlyAttention = ref(false);
const open = ref<Set<string>>(new Set());
const working = ref<string | null>(null);

const choosable = computed(() => props.databases.filter((d) => !['template0', 'template1'].includes(d.name)));

watch(
  choosable,
  (list) => {
    if (!db.value && list.length) db.value = [...list].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0].name;
  },
  { immediate: true },
);
watch(db, () => loadIndexes());

async function loadIndexes() {
  if (!db.value) return;
  loadingIdx.value = true;
  try {
    const res = await api.postgresIndexes(db.value);
    indexes.value = res.indexes;
    hasFragStats.value = res.pgstattuple;
  } catch (err) {
    fail(err);
  } finally {
    loadingIdx.value = false;
  }
}

const lastVacuum = (i: PgIndex) => [i.lastVacuum, i.lastAutovacuum].filter(Boolean).sort().at(-1) ?? null;
const deadPct = (i: PgIndex) => (i.liveRows && i.deadRows ? Math.round((i.deadRows / (i.liveRows + i.deadRows)) * 100) : 0);

/** Why an index deserves a look — the "attention" filter and the amber notes. */
function concerns(i: PgIndex): string[] {
  const out: string[] = [];
  if (!i.valid) out.push('invalid — a failed concurrent build; rebuild it');
  if (i.frag && i.frag.leaf_fragmentation > 30) out.push(`${Math.round(i.frag.leaf_fragmentation)}% fragmented`);
  if (i.frag && i.frag.avg_leaf_density < 60) out.push(`only ${Math.round(i.frag.avg_leaf_density)}% full — bloated`);
  if (deadPct(i) >= 20 && (i.deadRows ?? 0) > 1000) out.push(`table has ${deadPct(i)}% dead rows — defragment it`);
  if (i.scans === 0 && !i.primary && !i.unique && i.bytes > 1024 * 1024) out.push('never used — costs writes for nothing?');
  return out;
}

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return indexes.value.filter(
    (i) => (!q || `${i.index} ${i.table} ${i.schema}`.toLowerCase().includes(q)) && (!onlyAttention.value || concerns(i).length),
  );
});
const attentionCount = computed(() => indexes.value.filter((i) => concerns(i).length).length);
const totalBytes = computed(() => indexes.value.reduce((n, i) => n + i.bytes, 0));

function toggleOpen(key: string) {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}

async function maintain(i: PgIndex, action: PgMaintenance) {
  const labels: Record<PgMaintenance, string> = {
    'reindex-index': `Rebuild index ${i.index}? It is built fresh beside the old one and swapped in — reads and writes keep working.`,
    'reindex-table': `Rebuild every index on ${i.table}? Done concurrently — reads and writes keep working.`,
    vacuum: '',
    'vacuum-full': `FULL defragment of ${i.table}?\n\nIt rewrites the table and all its indexes to the smallest size, but LOCKS the table — nothing can read or write it until it finishes. Best done at a quiet time.`,
  };
  if (labels[action] && !confirm(labels[action])) return;
  const name = action === 'reindex-index' ? i.index : i.table;
  working.value = `${action}:${i.schema}.${name}`;
  try {
    const res = await api.postgresMaintenance({ db: db.value, action, schema: i.schema, name });
    notify(`${action.startsWith('reindex') ? 'Rebuilt' : 'Defragmented'} ${name} in ${res.seconds}s`);
    await loadIndexes();
  } catch (err) {
    fail(err);
  } finally {
    working.value = null;
  }
}

async function enableFragStats() {
  if (!confirm(`Measure fragmentation in ${db.value}?\n\nAdds the pgstattuple extension (part of PostgreSQL) to this database. It only reads.`)) return;
  try {
    await api.postgresEnableIndexStats(db.value);
    await loadIndexes();
  } catch (err) {
    fail(err);
  }
}

// ------------------------------------------------------------------ running

const sessions = ref<PgSession[]>([]);
const showBackground = ref(false);
const autoRefresh = ref(true);
let timer: ReturnType<typeof setInterval> | undefined;

async function loadSessions() {
  try {
    sessions.value = (await api.postgresActivity()).sessions;
  } catch (err) {
    fail(err);
    autoRefresh.value = false;
  }
}

const shownSessions = computed(() => sessions.value.filter((s) => showBackground.value || s.kind === 'client backend'));

async function stop(s: PgSession, terminate: boolean) {
  const what = terminate ? `Close the connection of ${s.user ?? '?'} on ${s.database ?? '?'} (pid ${s.pid})? Its open transaction is rolled back.` : `Cancel the query running in pid ${s.pid}? The connection stays.`;
  if (!confirm(what)) return;
  try {
    const res = await api.postgresStopSession(s.pid, terminate);
    notify(res.ok ? (terminate ? 'Connection closed' : 'Query cancelled') : 'It had already finished');
    await loadSessions();
  } catch (err) {
    fail(err);
  }
}

// ------------------------------------------------------------------ slowest

const top = ref<{ loaded: boolean; created: boolean; queries: PgTopQuery[]; since?: string | null } | null>(null);
const topBy = ref<'total' | 'mean' | 'calls'>('total');
const enabling = ref(false);

async function loadTop() {
  try {
    top.value = await api.postgresTopQueries(topBy.value);
  } catch (err) {
    fail(err);
  }
}
watch(topBy, loadTop);

async function enableTop() {
  if (!top.value?.loaded && !confirm('Turn on query statistics (pg_stat_statements)?\n\nPostgreSQL RESTARTS once (a few seconds — open connections drop and the apps reconnect). From then on it records how long every kind of query takes.')) return;
  enabling.value = true;
  try {
    const res = await api.postgresEnableTopQueries();
    notify(res.restarted ? 'Query statistics on — PostgreSQL restarted' : 'Query statistics on');
    await loadTop();
  } catch (err) {
    fail(err);
  } finally {
    enabling.value = false;
  }
}

async function resetTop() {
  if (!confirm('Clear the query statistics and start counting from now?')) return;
  await api.postgresResetTopQueries().catch(fail);
  await loadTop();
}

// ------------------------------------------------------------------ shared

watch(view, (v) => {
  if (v === 'running') loadSessions();
  if (v === 'slowest' && !top.value) loadTop();
});
onMounted(() => {
  timer = setInterval(() => {
    if (view.value === 'running' && autoRefresh.value && !document.hidden) loadSessions();
  }, 5000);
});
onUnmounted(() => clearInterval(timer));

function ago(v: string | number | null) {
  if (!v) return 'never';
  const s = (Date.now() - (typeof v === 'number' ? v : Date.parse(v))) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const secs = (s: number | null) => (s == null ? '—' : s < 60 ? `${s.toFixed(1)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);
const ms = (v: number) => (v < 1000 ? `${v.toFixed(v < 10 ? 2 : 0)} ms` : `${(v / 1000).toFixed(1)} s`);

const tabBtn = (on: boolean) => (on ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white');
const small = 'rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-sky-500 hover:text-white disabled:opacity-40';
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-4">
    <div class="flex rounded-lg border border-slate-700 p-0.5 text-xs" style="width: fit-content">
      <button v-for="t in [['indexes', 'Indexes'], ['running', 'Running now'], ['slowest', 'Slowest queries']] as const" :key="t[0]" class="rounded-md px-3 py-1.5 transition" :class="tabBtn(view === t[0])" @click="view = t[0]">
        {{ t[1] }}
      </button>
    </div>

    <!-- ============================================================ indexes -->
    <template v-if="view === 'indexes'">
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="db" class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100">
          <option v-for="d in choosable" :key="d.name" :value="d.name">{{ d.name }}</option>
        </select>
        <input v-model="filter" placeholder="Filter by index or table…" class="w-56 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none" />
        <label class="flex items-center gap-1.5 text-xs text-slate-400">
          <input v-model="onlyAttention" type="checkbox" class="accent-amber-500" /> Needs attention ({{ attentionCount }})
        </label>
        <div class="flex-1" />
        <span class="text-xs text-slate-500">{{ indexes.length }} indexes · {{ formatSize(totalBytes) }}</span>
        <button :class="small" @click="loadIndexes"><v-icon name="fa-sync-alt" scale="0.6" :class="loadingIdx && 'animate-spin'" /></button>
      </div>

      <p v-if="!hasFragStats && indexes.length" class="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
        Fragmentation isn't measured in this database yet.
        <button class="ml-1 text-sky-300 hover:underline" @click="enableFragStats">Measure it</button>
        (adds the read-only pgstattuple extension). Size, use and the last rebuild / defragment are shown either way.
      </p>

      <div class="overflow-hidden rounded-xl border border-slate-800">
        <div class="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_5rem_6rem_7rem_7rem] gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2 text-[11px] font-medium text-slate-500">
          <span>Index</span><span>Table</span><span class="text-right">Size</span><span class="text-right">Used</span><span>Last rebuilt</span><span>Defragmented</span>
        </div>
        <div v-if="loadingIdx && !indexes.length" class="py-10 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
        <div v-for="i in shown" :key="`${i.schema}.${i.index}`" class="border-b border-slate-800/60 last:border-b-0">
          <button
            class="grid w-full grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_5rem_6rem_7rem_7rem] items-center gap-3 px-4 py-2 text-left text-xs hover:bg-slate-900/60"
            @click="toggleOpen(`${i.schema}.${i.index}`)"
          >
            <span class="min-w-0">
              <span class="block truncate font-mono text-slate-200" :title="i.index">{{ i.index }}</span>
              <span class="flex flex-wrap gap-1 pt-0.5">
                <span v-if="i.primary" class="rounded bg-sky-900/50 px-1 text-[10px] text-sky-300">primary key</span>
                <span v-else-if="i.unique" class="rounded bg-slate-800 px-1 text-[10px] text-slate-400">unique</span>
                <span class="rounded bg-slate-800 px-1 text-[10px] text-slate-500">{{ i.method }}</span>
                <span v-for="c in concerns(i)" :key="c" class="rounded bg-amber-900/40 px-1 text-[10px] text-amber-200">{{ c }}</span>
              </span>
            </span>
            <span class="truncate font-mono text-slate-400" :title="`${i.schema}.${i.table}`">{{ i.table }}</span>
            <span class="text-right text-slate-300">{{ formatSize(i.bytes) }}</span>
            <span class="text-right text-slate-400" :title="i.lastUsed ? `last used ${ago(i.lastUsed)}` : ''">{{ i.scans.toLocaleString() }}×</span>
            <span class="text-slate-400">{{ i.rebuiltAt ? ago(i.rebuiltAt) : 'unknown' }}</span>
            <span :class="lastVacuum(i) ? 'text-slate-400' : 'text-amber-300'">{{ ago(lastVacuum(i)) }}</span>
          </button>
          <div v-if="open.has(`${i.schema}.${i.index}`)" class="space-y-2 border-t border-slate-800/60 bg-slate-950/50 px-4 py-3 text-xs">
            <pre class="overflow-x-auto rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ i.definition }}</pre>
            <div class="grid gap-x-6 gap-y-1 text-[11px] text-slate-400 sm:grid-cols-2">
              <p>Table size (with indexes): <span class="text-slate-200">{{ formatSize(i.tableBytes) }}</span></p>
              <p>Rows: <span class="text-slate-200">{{ (i.liveRows ?? 0).toLocaleString() }}</span> live, <span :class="deadPct(i) >= 20 ? 'text-amber-300' : 'text-slate-200'">{{ (i.deadRows ?? 0).toLocaleString() }} dead ({{ deadPct(i) }}%)</span></p>
              <p>Index last used: <span class="text-slate-200">{{ ago(i.lastUsed) }}</span></p>
              <p>Statistics refreshed: <span class="text-slate-200">{{ ago([i.lastAnalyze, i.lastAutoanalyze].filter(Boolean).sort().at(-1) ?? null) }}</span></p>
              <p v-if="i.frag">Fragmentation: <span class="text-slate-200">{{ Math.round(i.frag.leaf_fragmentation) }}%</span>, pages {{ Math.round(i.frag.avg_leaf_density) }}% full</p>
              <p>Last rebuilt: <span class="text-slate-200">{{ i.rebuiltAt ? new Date(i.rebuiltAt).toLocaleString() : 'unknown' }}</span></p>
            </div>
            <div class="flex flex-wrap gap-2 pt-1">
              <button :class="small" :disabled="Boolean(working)" title="REINDEX INDEX CONCURRENTLY — no lock on reads/writes" @click="maintain(i, 'reindex-index')">
                <v-icon :name="working === `reindex-index:${i.schema}.${i.index}` ? 'fa-spinner' : 'fa-redo'" scale="0.6" :class="working === `reindex-index:${i.schema}.${i.index}` && 'animate-spin'" /> Rebuild this index
              </button>
              <button :class="small" :disabled="Boolean(working)" title="REINDEX TABLE CONCURRENTLY" @click="maintain(i, 'reindex-table')">
                <v-icon name="fa-redo" scale="0.6" /> Rebuild all indexes of {{ i.table }}
              </button>
              <button :class="small" :disabled="Boolean(working)" title="VACUUM (ANALYZE) — reclaims dead rows and refreshes statistics, no blocking lock" @click="maintain(i, 'vacuum')">
                <v-icon :name="working === `vacuum:${i.schema}.${i.table}` ? 'fa-spinner' : 'fa-broom'" scale="0.6" :class="working === `vacuum:${i.schema}.${i.table}` && 'animate-spin'" /> Defragment {{ i.table }}
              </button>
              <button :class="[small, '!border-amber-800 !text-amber-300']" :disabled="Boolean(working)" title="VACUUM FULL — smallest possible, but locks the table" @click="maintain(i, 'vacuum-full')">
                <v-icon name="fa-compress" scale="0.6" /> Full defragment (locks)
              </button>
            </div>
          </div>
        </div>
        <p v-if="!loadingIdx && !shown.length" class="py-8 text-center text-xs text-slate-500">No indexes match.</p>
      </div>
      <p class="text-[11px] text-slate-500">
        <b>Rebuild</b> makes a fresh, compact copy of an index without stopping the app. <b>Defragment</b> (VACUUM) clears out dead rows
        left by updates and deletes and refreshes the planner's statistics; PostgreSQL also does this on its own (autovacuum) — the
        column shows whichever happened last. "Last rebuilt" is when the index file was written.
      </p>
    </template>

    <!-- ============================================================ running -->
    <template v-else-if="view === 'running'">
      <div class="flex flex-wrap items-center gap-3 text-xs">
        <label class="flex items-center gap-1.5 text-slate-400"><input v-model="autoRefresh" type="checkbox" class="accent-sky-500" /> Refresh every 5 s</label>
        <label class="flex items-center gap-1.5 text-slate-400"><input v-model="showBackground" type="checkbox" class="accent-sky-500" /> Show PostgreSQL's own background processes</label>
        <div class="flex-1" />
        <button :class="small" @click="loadSessions"><v-icon name="fa-sync-alt" scale="0.6" /> Refresh</button>
      </div>
      <div class="overflow-hidden rounded-xl border border-slate-800">
        <div v-for="s in shownSessions" :key="s.pid" class="border-b border-slate-800/60 px-4 py-2.5 text-xs last:border-b-0">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              class="w-20 font-semibold tabular-nums"
              :class="s.state === 'active' && (s.seconds ?? 0) > 60 ? 'text-red-300' : s.state === 'active' && (s.seconds ?? 0) > 5 ? 'text-amber-300' : 'text-slate-300'"
            >{{ secs(s.seconds) }}</span>
            <span
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="s.state === 'active' ? 'bg-emerald-900/50 text-emerald-300' : s.state?.startsWith('idle in transaction') ? 'bg-amber-900/50 text-amber-200' : 'bg-slate-800 text-slate-400'"
            >{{ s.state ?? s.kind }}</span>
            <span class="font-mono text-slate-200">{{ s.database ?? '—' }}</span>
            <span class="text-slate-500">{{ s.user ?? '' }}{{ s.client ? ` @ ${s.client}` : '' }}{{ s.application ? ` · ${s.application}` : '' }}</span>
            <span v-if="s.wait" class="text-slate-500">waiting: {{ s.waitType }}/{{ s.wait }}</span>
            <div class="flex-1" />
            <span class="text-slate-600">pid {{ s.pid }}</span>
            <template v-if="s.kind === 'client backend'">
              <button v-if="s.state === 'active'" :class="small" @click="stop(s, false)">Cancel query</button>
              <button :class="[small, '!text-red-300']" @click="stop(s, true)">End connection</button>
            </template>
          </div>
          <pre v-if="s.query" class="mt-1.5 max-h-28 overflow-auto rounded bg-slate-950 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ s.query }}</pre>
        </div>
        <p v-if="!shownSessions.length" class="py-8 text-center text-xs text-slate-500">Nothing connected right now.</p>
      </div>
      <p class="text-[11px] text-slate-500">
        Longest first. "Idle in transaction" holds locks while doing nothing — a sign of an app that forgot to commit. <b>Cancel</b> stops
        just the running statement; <b>End connection</b> closes it (its open transaction is rolled back).
      </p>
    </template>

    <!-- ============================================================ slowest -->
    <template v-else>
      <div v-if="!top" class="py-10 text-center"><v-icon name="fa-spinner" class="animate-spin text-sky-400" /></div>
      <div v-else-if="!top.loaded || !top.created" class="rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-sm">
        <p class="font-medium text-white">Query statistics are off</p>
        <p class="mt-1 text-xs text-slate-400">
          PostgreSQL can record how long every kind of query takes (pg_stat_statements, part of PostgreSQL), so the slowest and the most
          expensive ones show up here — across all databases.
          <template v-if="!top.loaded"> Turning it on <b>restarts PostgreSQL once</b> (a few seconds; the apps reconnect by themselves).</template>
        </p>
        <button
          class="mt-3 flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          :disabled="enabling"
          @click="enableTop"
        >
          <v-icon :name="enabling ? 'fa-spinner' : 'fa-play'" :class="enabling && 'animate-spin'" scale="0.65" /> Turn on query statistics
        </button>
      </div>
      <template v-else>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-slate-400">Sort by</span>
          <div class="flex rounded-lg border border-slate-700 p-0.5">
            <button v-for="b in [['total', 'Total time'], ['mean', 'Slowest each'], ['calls', 'Most frequent']] as const" :key="b[0]" class="rounded-md px-2.5 py-1" :class="tabBtn(topBy === b[0])" @click="topBy = b[0]">
              {{ b[1] }}
            </button>
          </div>
          <span v-if="top.since" class="text-slate-500">since {{ new Date(top.since).toLocaleString() }}</span>
          <div class="flex-1" />
          <button :class="small" @click="loadTop"><v-icon name="fa-sync-alt" scale="0.6" /></button>
          <button :class="small" @click="resetTop">Reset</button>
        </div>
        <div class="overflow-hidden rounded-xl border border-slate-800">
          <div v-for="(q, n) in top.queries" :key="n" class="border-b border-slate-800/60 px-4 py-2.5 text-xs last:border-b-0">
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              <span class="text-slate-300"><b class="text-white">{{ ms(q.meanMs) }}</b> each</span>
              <span class="text-slate-400">slowest {{ ms(q.maxMs) }}</span>
              <span class="text-slate-400">{{ q.calls.toLocaleString() }} calls</span>
              <span class="text-slate-400">total {{ ms(q.totalMs) }}</span>
              <span class="text-slate-500">{{ q.rows.toLocaleString() }} rows</span>
              <div class="flex-1" />
              <span class="font-mono text-slate-500">{{ q.database }} · {{ q.user }}</span>
            </div>
            <pre class="mt-1.5 max-h-28 overflow-auto rounded bg-slate-950 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ q.query }}</pre>
          </div>
          <p v-if="!top.queries.length" class="py-8 text-center text-xs text-slate-500">Nothing recorded yet — give the apps a little while.</p>
        </div>
      </template>
    </template>
  </div>
</template>
