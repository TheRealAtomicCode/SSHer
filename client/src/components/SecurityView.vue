<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import type { SecurityFinding, SecurityTool, Severity } from '../api';
import { copyToClipboard } from '../files';
import { fail, notify } from '../toast';
import type { StepResult, View } from '../types';
import StepLog from './StepLog.vue';
import TwoFactorPanel from './TwoFactorPanel.vue';

const emit = defineEmits<{
  navigate: [View];
  openPath: [{ path: string; isDirectory: boolean; reveal?: boolean }];
}>();

const findings = ref<SecurityFinding[]>([]);
const scannedAt = ref<number | null>(null);
const scanning = ref(false);
const tools = ref<SecurityTool[]>([]);
const toolOutput = ref<Record<string, { running: boolean; output: string; ok: boolean; seconds: number } | undefined>>({});
const busy = ref<Set<string>>(new Set());
const log = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);

const TOOLS_KEY = 'ssh-fb.securityRunTools';
const runToolsWithScan = ref((() => {
  try {
    return localStorage.getItem(TOOLS_KEY) !== '0';
  } catch {
    return true;
  }
})());
function setRunTools(v: boolean) {
  runToolsWithScan.value = v;
  try {
    localStorage.setItem(TOOLS_KEY, v ? '1' : '0');
  } catch {
    /* private mode */
  }
}

// Status colors (dataviz reference status palette) — always paired with an icon + label.
const SEVERITY: Record<Severity, { label: string; icon: string; color: string; bg: string }> = {
  critical: { label: 'Critical', icon: 'fa-times-circle', color: '#d03b3b', bg: 'bg-red-500/10 border-red-900/60' },
  high: { label: 'High', icon: 'fa-exclamation-triangle', color: '#ec835a', bg: 'bg-orange-500/10 border-orange-900/50' },
  medium: { label: 'Medium', icon: 'fa-exclamation-triangle', color: '#fab219', bg: 'bg-amber-500/5 border-amber-900/40' },
  low: { label: 'Low', icon: 'fa-info-circle', color: '#94a3b8', bg: 'bg-slate-900/40 border-slate-800' },
  info: { label: 'Info', icon: 'fa-info-circle', color: '#64748b', bg: 'bg-slate-900/40 border-slate-800' },
  ok: { label: 'OK', icon: 'fa-check-circle', color: '#0ca30c', bg: 'bg-slate-900/40 border-slate-800' },
};
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const counts = computed(() => Object.fromEntries(ORDER.map((s) => [s, findings.value.filter((f) => f.severity === s).length])));
const grouped = computed(() => ORDER.map((s) => ({ severity: s, items: findings.value.filter((f) => f.severity === s) })).filter((g) => g.items.length));
const compromised = computed(() => findings.value.some((f) => f.category === 'Malware & intrusion' && f.severity === 'critical'));

async function loadTools() {
  try {
    tools.value = (await api.securityTools()).tools;
  } catch (err) {
    fail(err);
  }
}

async function scan() {
  scanning.value = true;
  try {
    const res = await api.securityScan();
    findings.value = res.findings;
    scannedAt.value = res.time;
  } catch (err) {
    fail(err);
  } finally {
    scanning.value = false;
  }
  // Installed tools run too, one after another, their results filling in as they finish.
  if (runToolsWithScan.value) {
    for (const t of tools.value.filter((x) => x.installed)) await runTool(t);
  }
}

async function runTool(t: SecurityTool) {
  toolOutput.value = { ...toolOutput.value, [t.id]: { running: true, output: '', ok: true, seconds: 0 } };
  try {
    const res = await api.securityRunTool(t.id);
    toolOutput.value = { ...toolOutput.value, [t.id]: { running: false, output: res.output, ok: res.ok, seconds: res.seconds } };
  } catch (err) {
    toolOutput.value = { ...toolOutput.value, [t.id]: { running: false, output: (err as Error).message, ok: false, seconds: 0 } };
  }
}

async function install(t: SecurityTool) {
  if (!confirm(`Install ${t.name} on this server?\n\nRuns apt-get install ${t.pkg}.`)) return;
  log.value = { title: `Installing ${t.name}`, steps: [], running: true, error: '' };
  try {
    const res = await api.securityInstallTool(t.id);
    log.value = { title: `Installing ${t.name}`, steps: res.log, running: false, error: '' };
    await loadTools();
    const fresh = tools.value.find((x) => x.id === t.id);
    if (fresh?.installed) runTool(fresh);
  } catch (err) {
    const steps = err instanceof api.ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.value = { title: `Installing ${t.name}`, steps, running: false, error: (err as Error).message };
  }
}

async function uninstall(t: SecurityTool) {
  const extra = t.id === 'fail2ban' ? '\n\nSSH stops being protected against password guessing.' : '';
  if (!confirm(`Uninstall ${t.name}?\n\nRuns apt-get remove ${t.pkg} (and removes packages nothing needs any more).${extra}`)) return;
  log.value = { title: `Uninstalling ${t.name}`, steps: [], running: true, error: '' };
  try {
    const res = await api.securityUninstallTool(t.id);
    log.value = { title: `Uninstalling ${t.name}`, steps: res.log, running: false, error: '' };
    toolOutput.value = { ...toolOutput.value, [t.id]: undefined };
    await loadTools();
  } catch (err) {
    const steps = err instanceof api.ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.value = { title: `Uninstalling ${t.name}`, steps, running: false, error: (err as Error).message };
  }
}

function mark(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function stop(f: SecurityFinding) {
  const p = f.process!;
  if (!confirm(`Stop process ${p.pid} ("${p.name}", ${p.exe})?\n\nIt is killed immediately (kill -9). Malware often restarts itself — quarantine its file too, and run the scan again.`)) return;
  mark(f.id, true);
  try {
    await api.securityKill(p.pid);
    notify(`Stopped ${p.pid}`);
    await scan();
  } catch (err) {
    fail(err);
  } finally {
    mark(f.id, false);
  }
}

async function quarantine(f: SecurityFinding) {
  const path = f.file!;
  if (!confirm(`Quarantine ${path}?\n\nIt is moved to /root/ssher-quarantine/ with no permissions — kept for inspection, not deleted, and it can no longer run.`)) return;
  mark(f.id, true);
  try {
    const res = await api.securityQuarantine(path);
    notify(`Moved to ${res.dest}`);
    await scan();
  } catch (err) {
    fail(err);
  } finally {
    mark(f.id, false);
  }
}

async function copyFix(cmd: string) {
  await copyToClipboard(cmd);
  notify('Command copied — run it in the terminal');
}

const PAGE_NAMES: Record<NonNullable<SecurityFinding['link']>, string> = {
  ports: 'Ports & Firewall', postgres: 'PostgreSQL', users: 'Users', docker: 'Docker', processes: 'Processes',
};

/** Tool output lines worth highlighting. */
const lineTone = (l: string) =>
  /warning|infected|found|suspect|\bINFECTED\b|vulnerable/i.test(l) && !/not found|nothing found|not infected/i.test(l)
    ? 'text-amber-300'
    : /suggestion/i.test(l)
      ? 'text-sky-300'
      : 'text-slate-400';

onMounted(async () => {
  await loadTools();
  await scan();
});

const btn = 'flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-40';
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-5">
    <div class="mx-auto max-w-5xl space-y-5">
      <!-- Header -->
      <div class="flex flex-wrap items-center gap-3">
        <v-icon name="fa-shield-alt" scale="1.3" class="text-red-300" />
        <div class="flex-1">
          <h1 class="text-base font-semibold text-white">Security</h1>
          <p class="text-xs text-slate-500">
            A read-only audit of this server{{ scannedAt ? ` · last run ${new Date(scannedAt).toLocaleTimeString()}` : '' }}.
            Nothing changes unless you press an action button.
          </p>
        </div>
        <button
          class="flex items-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
          :disabled="scanning"
          @click="scan"
        >
          <v-icon :name="scanning ? 'fa-spinner' : 'fa-search'" :class="scanning && 'animate-spin'" scale="0.8" />
          {{ scanning ? 'Scanning…' : 'Run scan' }}
        </button>
      </div>

      <!-- Summary -->
      <div class="flex flex-wrap gap-2">
        <div v-for="s in ORDER" :key="s" class="flex items-center gap-2 rounded-lg border px-3 py-2" :class="SEVERITY[s].bg">
          <v-icon :name="SEVERITY[s].icon" scale="0.8" :style="{ color: SEVERITY[s].color }" />
          <span class="text-lg font-semibold text-white tabular-nums">{{ counts[s] ?? 0 }}</span>
          <span class="text-xs text-slate-400">{{ SEVERITY[s].label }}</span>
        </div>
      </div>

      <div v-if="compromised" class="rounded-xl border border-red-800 bg-red-950/40 p-4 text-sm text-red-100">
        <p class="flex items-center gap-2 font-semibold"><v-icon name="fa-times-circle" /> This server shows signs of being compromised</p>
        <ol class="mt-2 list-decimal space-y-1 pl-5 text-xs text-red-200/90">
          <li>Close the way in first (usually the open database port — see below), or the attacker just comes back.</li>
          <li>Stop the suspicious processes, then quarantine their files. Run the scan again: anything that reappears has a way to restart itself.</li>
          <li>Disable accounts you didn't create, and change every password and secret the server holds.</li>
          <li>Treat data on this server as seen by the attacker. The safest fix is rebuilding on a fresh server from a known-good backup.</li>
        </ol>
      </div>

      <TwoFactorPanel @navigate="(v) => emit('navigate', v)" />

      <!-- Findings -->
      <div v-if="scanning && !findings.length" class="py-16 text-center"><v-icon name="fa-spinner" scale="1.5" class="animate-spin text-red-300" /></div>
      <p v-else-if="scannedAt && !findings.length" class="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-6 text-center text-sm text-emerald-200">
        <v-icon name="fa-check-circle" /> Nothing found.
      </p>

      <section v-for="g in grouped" :key="g.severity" class="space-y-2">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
          <v-icon :name="SEVERITY[g.severity].icon" scale="0.8" :style="{ color: SEVERITY[g.severity].color }" />
          {{ SEVERITY[g.severity].label }} <span class="font-normal text-slate-500">· {{ g.items.length }}</span>
        </h2>
        <div v-for="f in g.items" :key="f.id" class="rounded-xl border p-4" :class="SEVERITY[f.severity].bg">
          <div class="flex flex-wrap items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-white">{{ f.title }}</p>
              <p class="text-[11px] text-slate-500">{{ f.category }}</p>
            </div>
            <v-icon v-if="busy.has(f.id)" name="fa-spinner" class="animate-spin text-slate-400" />
          </div>
          <p class="mt-2 text-xs leading-relaxed text-slate-300">{{ f.detail }}</p>
          <div v-if="f.evidence.length" class="mt-2 rounded-md bg-slate-950/70 px-2 py-1.5 font-mono text-[11px] break-all text-slate-400">
            <p v-for="(e, i) in f.evidence" :key="i">{{ e }}</p>
          </div>
          <div class="mt-3 flex flex-wrap gap-1.5">
            <button v-if="f.process" :class="[btn, 'border-red-800 text-red-300 hover:border-red-600']" :disabled="busy.has(f.id)" @click="stop(f)">
              <v-icon name="fa-stop" scale="0.6" /> Stop process
            </button>
            <button v-if="f.file" :class="[btn, 'border-red-800 text-red-300 hover:border-red-600']" :disabled="busy.has(f.id)" @click="quarantine(f)">
              <v-icon name="fa-ban" scale="0.6" /> Quarantine file
            </button>
            <button
              v-if="f.file || f.process?.exe"
              :class="btn"
              @click="emit('openPath', { path: (f.file || f.process!.exe), isDirectory: false, reveal: true })"
            >
              <v-icon name="fa-folder-open" scale="0.6" /> Open in folder
            </button>
            <button v-if="f.link" :class="btn" @click="emit('navigate', f.link)">
              <v-icon name="fa-arrow-right" scale="0.6" /> {{ PAGE_NAMES[f.link] }}
            </button>
            <button v-if="f.fixCommand" :class="btn" :title="f.fixCommand" @click="copyFix(f.fixCommand)">
              <v-icon name="fa-copy" scale="0.6" /> Copy fix command
            </button>
          </div>
        </div>
      </section>

      <!-- Tools -->
      <section class="space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="flex-1 text-sm font-semibold text-white">Security tools</h2>
          <label class="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" class="accent-red-500" :checked="runToolsWithScan" @change="setRunTools(($event.target as HTMLInputElement).checked)" />
            Run installed tools with every scan
          </label>
        </div>
        <p class="text-xs text-slate-500">
          Optional, well-known open-source tools that go deeper than the built-in checks. Install one and its checks run
          as part of the scan (they can take a few minutes).
        </p>
        <div class="grid gap-3 md:grid-cols-2">
          <div v-for="t in tools" :key="t.id" class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <div class="flex items-center gap-2">
              <p class="flex-1 text-sm font-medium text-white">{{ t.name }}</p>
              <span class="rounded-full px-2 py-0.5 text-[10px]" :class="t.installed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'">
                {{ t.installed ? 'Installed' : 'Not installed' }}
              </span>
            </div>
            <p class="mt-1 text-xs text-slate-400">{{ t.what }}</p>
            <div class="mt-3 flex gap-1.5">
              <button v-if="!t.installed" :class="btn" :disabled="Boolean(log?.running)" @click="install(t)">
                <v-icon name="fa-cloud-download-alt" scale="0.6" /> Install
              </button>
              <button v-else :class="btn" :disabled="toolOutput[t.id]?.running" @click="runTool(t)">
                <v-icon :name="toolOutput[t.id]?.running ? 'fa-spinner' : 'fa-play'" :class="toolOutput[t.id]?.running && 'animate-spin'" scale="0.6" />
                {{ toolOutput[t.id]?.running ? 'Running…' : 'Run' }}
              </button>
              <button
                v-if="t.installed"
                :class="[btn, 'ml-auto border-transparent text-slate-500 hover:border-red-900 hover:text-red-300']"
                :disabled="Boolean(log?.running) || toolOutput[t.id]?.running"
                @click="uninstall(t)"
              >
                <v-icon name="fa-trash-alt" scale="0.6" /> Uninstall
              </button>
            </div>
            <div v-if="toolOutput[t.id] && !toolOutput[t.id]!.running" class="mt-3">
              <p class="mb-1 text-[10px] text-slate-500">Finished in {{ toolOutput[t.id]!.seconds }} s</p>
              <pre class="max-h-64 overflow-auto rounded-md bg-slate-950 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap"><span v-for="(l, i) in toolOutput[t.id]!.output.split('\n')" :key="i" :class="lineTone(l)">{{ l }}
</span></pre>
            </div>
          </div>
        </div>
      </section>
    </div>

    <StepLog v-if="log" :title="log.title" :steps="log.steps" :running="log.running" :error="log.error" @close="log = null" />
  </div>
</template>
