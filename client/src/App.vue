<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from './api';
import ActivityLogPanel from './components/ActivityLogPanel.vue';
import ConnectPanel from './components/ConnectPanel.vue';
import DbTransferView from './components/DbTransferView.vue';
import DockerView from './components/DockerView.vue';
import DotNetView from './components/DotNetView.vue';
import FileExplorer from './components/FileExplorer.vue';
import HomeView from './components/HomeView.vue';
import LogsView from './components/LogsView.vue';
import MonitorView from './components/MonitorView.vue';
import SecurityView from './components/SecurityView.vue';
import { resetMyIps } from './privacy';
import { parseRoute, routeToHash, type Route } from './router';
import NginxView from './components/NginxView.vue';
import PgBackRestView from './components/PgBackRestView.vue';
import PortsView from './components/PortsView.vue';
import PostgresView from './components/PostgresView.vue';
import ProcessesView from './components/ProcessesView.vue';
import QuickLinksView from './components/QuickLinksView.vue';
import ShortcutDialog from './components/ShortcutDialog.vue';
import ShortcutsView from './components/ShortcutsView.vue';
import TerminalDock from './components/TerminalDock.vue';
import UsersView from './components/UsersView.vue';
import { copyToClipboard } from './files';
import * as prefs from './prefs';
import { sudoMode, toggleSudoMode } from './sudoMode';
import { askForSudoPassword, sudoPrompt } from './sudoPrompt';
import SudoPasswordDialog from './components/SudoPasswordDialog.vue';
import { dismiss, fail, notify, sessionState, toasts } from './toast';
import type { Credentials, Session, Shortcut, View } from './types';

async function copyToastMessage(message: string) {
  await copyToClipboard(message);
  notify('Copied');
}

const session = ref<Session | null>(null);
const connecting = ref(false);
const connectError = ref('');
const view = ref<View>('home');
/** Which container the Logs page opens on, when jumping there from the Docker page. */
const logsFor = ref('');
/** The database the Transfer page has selected (#/dbtransfer/<db>). */
const transferDb = ref('');
const isFullscreen = ref(false);
const activityOpen = ref(false);
const terminalOpen = ref(false);

const explorer = ref<InstanceType<typeof FileExplorer> | null>(null);

const serverKey = computed(() => (session.value ? prefs.serverId(session.value) : ''));
const serverLabel = computed(
  () => prefs.savedServers().find((s) => s.id === serverKey.value)?.label ?? '',
);

// ---------------------------------------------------------------- shortcuts

const shortcuts = ref<Shortcut[]>([]);
const shortcutDraft = ref<Partial<Shortcut> | null>(null);

watch(serverKey, (key) => {
  shortcuts.value = key ? prefs.shortcuts(key) : [];
});

function persistShortcuts(list: Shortcut[]) {
  shortcuts.value = list;
  prefs.saveShortcuts(serverKey.value, list);
}

function saveShortcut(entry: Shortcut) {
  const exists = shortcuts.value.some((s) => s.id === entry.id);
  persistShortcuts(
    exists ? shortcuts.value.map((s) => (s.id === entry.id ? entry : s)) : [...shortcuts.value, entry],
  );
  shortcutDraft.value = null;
  notify(exists ? `Updated “${entry.name}”` : `Added shortcut “${entry.name}”`);
}

function removeShortcut(entry: Shortcut) {
  if (!confirm(`Remove the shortcut “${entry.name}”?`)) return;
  persistShortcuts(shortcuts.value.filter((s) => s.id !== entry.id));
}

/** `reveal` = "open in folder": show the containing folder with the item selected,
 *  instead of opening the item itself. */
async function openShortcut(entry: { path: string; isDirectory: boolean; reveal?: boolean }) {
  view.value = 'files';
  await nextTick();
  if (entry.reveal) await explorer.value?.revealPath(entry.path);
  else await explorer.value?.openPath(entry.path, entry.isDirectory);
}

// ------------------------------------------------------------------ session

async function onConnect(credentials: Credentials, opts: { remember: boolean; label: string }) {
  connecting.value = true;
  connectError.value = '';
  try {
    // A remembered sudo password goes along so the server can try it first.
    const saved = prefs.savedServers().find((s) => s.id === prefs.serverId(credentials));
    const opened = await api.connect({ ...credentials, sudoPassword: saved?.sudoPassword });
    sudoPrompt.savedRejected = Boolean(opened.sudoSavedRejected);
    if (opened.sudoSavedRejected) notify("Your saved sudo password didn't work — you'll be asked for it when needed", 'error');
    session.value = opened;
    otpLogin.value = null;
    // The code is one-time: never saved with the server.
    const { sudoPassword: _sudo, otp: _otp, ...login } = credentials;
    prefs.rememberServer({ ...login, label: opts.label || undefined }, opts.remember);
    view.value = 'home';
  } catch (err) {
    if (err instanceof api.ApiError && err.payload.otpRequired) {
      // Two-factor server: ask for the authenticator code, then log in again.
      otpLogin.value = {
        credentials,
        opts,
        code: '',
        error: credentials.otp ? "That code wasn't accepted — wait for the next one in your app and try again." : '',
      };
    } else {
      connectError.value = (err as Error).message;
    }
  } finally {
    connecting.value = false;
  }
}

/** A login waiting for its authenticator code. */
const otpLogin = ref<{
  credentials: Credentials;
  opts: { remember: boolean; label: string };
  code: string;
  error: string;
} | null>(null);

function submitOtp() {
  const pending = otpLogin.value;
  if (!pending || !/^\d{6,8}$/.test(pending.code.trim())) return;
  onConnect({ ...pending.credentials, otp: pending.code.trim() }, pending.opts);
}

async function onDisconnect() {
  await api.disconnect().catch(() => {});
  session.value = null;
  // A different server can mean a different network path, so learn "my IP" again.
  resetMyIps();
}

watch(
  () => sessionState.lost,
  (lost) => {
    if (!lost) return;
    sessionState.lost = false;
    session.value = null;
    connectError.value = 'The SSH session ended. Pick the server to reconnect.';
  },
);

// -------------------------------------------------------------- fullscreen

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) {
    fail(err);
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
}

// ------------------------------------------------------------- access key

const access = ref<'checking' | 'needed' | 'ok'>('checking');
const accessInput = ref('');
const accessError = ref('');

async function checkAccess(): Promise<boolean> {
  const status = await api.accessStatus();
  access.value = status.ok ? 'ok' : 'needed';
  return status.ok;
}

async function submitAccessKey() {
  api.setAccessKey(accessInput.value.trim());
  if (await checkAccess()) {
    accessError.value = '';
    const restored = await api.restore();
    if (restored) session.value = restored;
  } else {
    accessError.value = 'That key is not right.';
  }
}

// Any request that fails with "sudo: a password is required" waits on this prompt,
// then retries once the password is accepted.
api.onSudoPasswordNeeded((reason) => (session.value ? askForSudoPassword(reason) : Promise.resolve(false)));

// ------------------------------------------------------------------ routing
//
// The URL hash mirrors where you are (see router.ts), so Back/Forward move around inside
// SSHer instead of leaving the site, and a link or reload lands on the same page.

/** The Docker page's open container + tab, as the URL has it. */
const dockerRoute = ref<{ container?: string; tab?: string }>({});
let applyingRoute = false;
/** A route from the URL that arrived before there was a session to show it in. */
let pendingRoute: Route | null = parseRoute(location.hash);

const currentHash = computed(() =>
  routeToHash({
    view: view.value,
    path: view.value === 'files' ? explorer.value?.cwd : undefined,
    container:
      view.value === 'docker'
        ? dockerRoute.value.container
        : view.value === 'logs'
          ? logsFor.value || undefined
          : view.value === 'dbtransfer'
            ? transferDb.value || undefined
            : undefined,
    tab: view.value === 'docker' ? dockerRoute.value.tab : undefined,
  }),
);

watch(currentHash, (hash) => {
  if (!session.value || applyingRoute || hash === location.hash) return;
  // The explorer's "/" before its first listing is a placeholder, not a place.
  if (view.value === 'files' && !explorer.value?.listed) return;
  history.pushState(null, '', hash);
});

function applyRoute(r: Route) {
  applyingRoute = true;
  // Before switching view, so the explorer doesn't first load the home folder.
  if (r.view === 'files' && r.path) explorer.value?.openPath(r.path, true);
  if (r.view === 'docker') dockerRoute.value = { container: r.container, tab: r.tab };
  if (r.view === 'logs' && r.container) logsFor.value = r.container;
  if (r.view === 'dbtransfer' && r.container) transferDb.value = r.container;
  view.value = r.view;
  nextTick(() => (applyingRoute = false));
}

function onPopState() {
  const r = parseRoute(location.hash) ?? { view: 'home' as View };
  if (!session.value) {
    pendingRoute = r;
    return;
  }
  applyRoute(r);
}

watch(session, (s, old) => {
  if (!s || old) return;
  // The panels mount with the session; route once they exist.
  nextTick(() => {
    if (pendingRoute) {
      const r = pendingRoute;
      pendingRoute = null;
      applyRoute(r);
      history.replaceState(null, '', routeToHash(r));
    } else {
      history.replaceState(null, '', currentHash.value);
    }
  });
});

onMounted(() => window.addEventListener('popstate', onPopState));
onUnmounted(() => window.removeEventListener('popstate', onPopState));

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (!(await checkAccess())) return;
  const restored = await api.restore();
  if (restored) session.value = restored;
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});

const NAV: { view: View; label: string; icon: string; sub?: boolean }[] = [
  { view: 'home', label: 'Overview', icon: 'fa-th-large' },
  { view: 'monitor', label: 'Monitoring', icon: 'fa-chart-line' },
  { view: 'files', label: 'File Explorer', icon: 'fa-folder-open' },
  { view: 'shortcuts', label: 'Shortcuts', icon: 'fa-star', sub: true },
  { view: 'links', label: 'Quick Links', icon: 'fa-link' },
  { view: 'users', label: 'Users', icon: 'fa-users' },
  { view: 'processes', label: 'Processes', icon: 'fa-microchip' },
  { view: 'nginx', label: 'Nginx', icon: 'fa-globe' },
  { view: 'dotnet', label: '.NET apps', icon: 'si-dotnet' },
  { view: 'docker', label: 'Docker', icon: 'fa-docker' },
  { view: 'logs', label: 'Container logs', icon: 'fa-terminal', sub: true },
  { view: 'ports', label: 'Ports & Firewall', icon: 'fa-shield-alt' },
  { view: 'security', label: 'Security', icon: 'fa-bug' },
  { view: 'postgres', label: 'PostgreSQL', icon: 'fa-database' },
  { view: 'dbtransfer', label: 'Transfer database', icon: 'fa-arrow-right', sub: true },
  { view: 'backups', label: 'Backups', icon: 'fa-save', sub: true },
];
</script>

<template>
  <div class="flex h-full flex-col bg-slate-950">
    <!-- Top strip: sudo mode + activity log, fixed at the very top, visible from every page. -->
    <div v-if="session" class="flex h-7 shrink-0 items-stretch">
      <button
        class="flex flex-1 items-center justify-center gap-1.5 text-xs font-medium transition"
        :class="sudoMode.enabled ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-slate-900 text-slate-500 hover:text-slate-300'"
        :title="sudoMode.enabled ? 'Click to turn sudo mode off' : 'Click to run File Explorer actions as root'"
        @click="toggleSudoMode"
      >
        <v-icon :name="sudoMode.enabled ? 'fa-unlock-alt' : 'fa-lock'" scale="0.7" />
        {{ sudoMode.enabled ? 'Sudo mode is ON — File Explorer actions run as root' : 'Sudo mode is off' }}
      </button>
      <button
        class="flex shrink-0 items-center gap-1.5 border-l border-slate-800 bg-slate-900 px-3 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white"
        :class="activityOpen && 'bg-slate-800 text-emerald-300'"
        title="See every shell command any button here has run this session"
        @click="activityOpen = !activityOpen"
      >
        <v-icon name="fa-terminal" scale="0.7" /> Activity
      </button>
      <button
        class="flex shrink-0 items-center gap-1.5 border-l border-slate-800 bg-slate-900 px-3 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white"
        :class="terminalOpen && 'bg-slate-800 text-emerald-300'"
        title="Two real shells on the server, side by side"
        @click="terminalOpen = !terminalOpen"
      >
        <v-icon name="fa-window-maximize" scale="0.7" /> Terminal
      </button>
    </div>

    <div v-if="access === 'needed'" class="flex min-h-full items-center justify-center p-6">
      <form
        class="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl"
        @submit.prevent="submitAccessKey"
      >
        <div
          class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/30"
        >
          <v-icon name="fa-lock" class="text-emerald-400" />
        </div>
        <h1 class="text-center text-lg font-semibold text-white">Access key</h1>
        <p class="mt-1 mb-4 text-center text-sm text-slate-400">
          This SSHer is protected. Enter the key set in SSHER_ACCESS_KEY.
        </p>
        <input
          v-model="accessInput"
          type="password"
          required
          autofocus
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
        />
        <p v-if="accessError" class="mt-2 text-sm text-red-400">{{ accessError }}</p>
        <button
          type="submit"
          class="mt-4 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          Unlock
        </button>
      </form>
    </div>

    <div v-else-if="access === 'checking'" class="flex min-h-full items-center justify-center">
      <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-emerald-400" />
    </div>

    <ConnectPanel
      v-else-if="!session"
      :connecting="connecting"
      :error="connectError"
      @connect="onConnect"
    />

    <div v-else class="flex min-h-0 flex-1">
      <!-- Sidebar -->
      <aside class="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div class="flex items-center gap-2.5 border-b border-slate-800 px-4 py-3">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30"
          >
            <v-icon name="fa-server" scale="0.85" class="text-emerald-400" />
          </div>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-white">
              {{ serverLabel || session.host }}
            </p>
            <p class="flex items-center gap-1.5 truncate text-[11px] text-emerald-400">
              <span class="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {{ session.username }}@{{ session.host }}
            </p>
          </div>
        </div>

        <nav class="flex-1 space-y-0.5 p-2">
          <button
            v-for="item in NAV"
            :key="item.view"
            class="flex w-full items-center gap-2.5 rounded-lg py-2 text-sm transition"
            :class="[
              item.sub ? 'pr-3 pl-8 text-[13px]' : 'px-3',
              view === item.view
                ? 'bg-emerald-500/10 text-emerald-300'
                : 'text-slate-400 hover:bg-slate-800 hover:text-white',
            ]"
            @click="view = item.view"
          >
            <v-icon
              :name="item.icon"
              :scale="item.sub ? 0.7 : 0.85"
              :class="item.view === 'shortcuts' ? 'text-amber-300' : ''"
            />
            <span class="flex-1 text-left">{{ item.label }}</span>
            <span
              v-if="item.view === 'shortcuts' && shortcuts.length"
              class="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400"
            >
              {{ shortcuts.length }}
            </span>
          </button>
        </nav>

        <div class="space-y-0.5 border-t border-slate-800 p-2">
          <button
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-white"
            @click="toggleFullscreen"
          >
            <v-icon :name="isFullscreen ? 'fa-compress' : 'fa-expand'" scale="0.8" />
            {{ isFullscreen ? 'Exit full screen' : 'Full screen' }}
          </button>
          <button
            class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-red-950 hover:text-red-400"
            @click="onDisconnect"
          >
            <v-icon name="fa-sign-out-alt" scale="0.8" /> Switch server
          </button>
        </div>
      </aside>

      <!-- Main -->
      <main class="flex min-w-0 flex-1 flex-col">
        <MonitorView v-if="view === 'monitor'" @open-path="openShortcut" />

        <SecurityView v-if="view === 'security'" @navigate="(v: View) => (view = v)" @open-path="openShortcut" />

        <HomeView
          v-if="view === 'home'"
          :session="session"
          :shortcuts="shortcuts"
          @navigate="(v: View) => (view = v)"
          @open-shortcut="openShortcut"
        />

        <!-- Kept mounted so the folder, selection and clipboard survive switching views. -->
        <FileExplorer
          v-show="view === 'files'"
          ref="explorer"
          :session="session"
          :active="view === 'files'"
          @add-shortcut="(entry) => (shortcutDraft = entry)"
        />

        <ShortcutsView
          v-if="view === 'shortcuts'"
          :shortcuts="shortcuts"
          @open="openShortcut"
          @reveal="(s: Shortcut) => openShortcut({ path: s.path, isDirectory: s.isDirectory, reveal: true })"
          @edit="(s: Shortcut) => (shortcutDraft = { ...s })"
          @remove="removeShortcut"
          @add="shortcutDraft = { path: explorer?.cwd ?? session.home, isDirectory: true, name: '' }"
          @reorder="persistShortcuts"
        />

        <QuickLinksView v-if="view === 'links'" @open-path="openShortcut" />

        <UsersView v-if="view === 'users'" :session="session" />

        <ProcessesView v-if="view === 'processes'" />

        <NginxView v-if="view === 'nginx'" @open-path="openShortcut" />

        <DotNetView v-if="view === 'dotnet'" />

        <DockerView
          v-if="view === 'docker'"
          :session="session"
          @open-path="openShortcut"
          :route="dockerRoute"
          @route="(r) => (dockerRoute = r)"
          @open-logs="(name: string) => { logsFor = name; view = 'logs'; }"
        />

        <LogsView v-if="view === 'logs'" :initial="logsFor" @open-path="openShortcut" @select="(n: string) => (logsFor = n)" />

        <PortsView v-if="view === 'ports'" :session="session" />

        <PostgresView v-if="view === 'postgres'" @navigate="(v: View) => (view = v)" />

        <DbTransferView
          v-if="view === 'dbtransfer'"
          :initial="transferDb"
          @select="(db: string) => (transferDb = db)"
          @navigate="(v: View) => (view = v)"
        />

        <PgBackRestView v-if="view === 'backups'" @open-path="openShortcut" />
      </main>
    </div>

    <SudoPasswordDialog v-if="sudoPrompt.open && session" :session="session" />

    <!-- Two-factor login: the server asked for the authenticator code -->
    <div
      v-if="otpLogin && !session"
      data-modal
      class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      <form
        class="w-full max-w-sm rounded-xl border border-emerald-700/50 bg-slate-900 p-5 shadow-2xl"
        @submit.prevent="submitOtp"
        @keydown.esc="otpLogin = null"
      >
        <h2 class="flex items-center gap-2 font-semibold text-white">
          <v-icon name="fa-shield-alt" class="text-emerald-400" /> Verification code
        </h2>
        <p class="mt-1 text-sm text-slate-400">
          <span class="font-mono text-slate-200">{{ otpLogin.credentials.username }}@{{ otpLogin.credentials.host }}</span>
          uses two-factor login. Open your authenticator app and type the 6-digit code.
        </p>
        <input
          v-model="otpLogin.code"
          autofocus
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="8"
          placeholder="123456"
          class="mt-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] text-white focus:border-emerald-500 focus:outline-none"
        />
        <p class="mt-1 text-[11px] text-slate-500">Lost your phone? A backup (scratch) code works here too — each one once.</p>
        <p v-if="otpLogin.error" class="mt-3 rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300">{{ otpLogin.error }}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white" @click="otpLogin = null">Cancel</button>
          <button
            type="submit"
            :disabled="connecting || !/^\d{6,8}$/.test(otpLogin.code.trim())"
            class="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            <v-icon v-if="connecting" name="fa-spinner" class="animate-spin" scale="0.8" /> Log in
          </button>
        </div>
      </form>
    </div>

    <ShortcutDialog
      v-if="shortcutDraft"
      :draft="shortcutDraft"
      @save="saveShortcut"
      @close="shortcutDraft = null"
    />

    <ActivityLogPanel :open="activityOpen" @close="activityOpen = false" />

    <TerminalDock :open="terminalOpen" @close="terminalOpen = false" />

    <!-- Bottom-right toasts. -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-[60] space-y-2">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm whitespace-pre-line shadow-xl"
        :class="
          toast.kind === 'ok'
            ? 'border-emerald-800 bg-emerald-950 text-emerald-200'
            : 'border-red-900 bg-red-950 text-red-200'
        "
      >
        <v-icon
          :name="toast.kind === 'ok' ? 'fa-check' : 'fa-exclamation-triangle'"
          scale="0.8"
          class="mt-0.5 shrink-0"
        />
        <span class="min-w-0 flex-1 break-words">{{ toast.message }}</span>
        <template v-if="toast.kind === 'error'">
          <button
            class="mt-0.5 shrink-0 text-red-300/70 hover:text-white"
            title="Copy this message"
            @click="copyToastMessage(toast.message)"
          >
            <v-icon name="fa-copy" scale="0.7" />
          </button>
          <button class="mt-0.5 shrink-0 text-red-300/70 hover:text-white" title="Dismiss" @click="dismiss(toast.id)">
            <v-icon name="fa-times" scale="0.7" />
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
