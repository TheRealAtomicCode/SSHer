<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import * as prefs from '../prefs';
import type { Credentials, SavedServer } from '../types';

const props = defineProps<{ connecting: boolean; error: string }>();
const emit = defineEmits<{
  connect: [Credentials, { remember: boolean; label: string }];
}>();

const servers = ref<SavedServer[]>(prefs.savedServers());
const host = ref('');
const port = ref(22);
const username = ref('root');
const password = ref('');
const label = ref('');
const remember = ref(true);
const showPassword = ref(false);
const pending = ref<string | null>(null);
const editing = ref<string | null>(null);
const editLabel = ref('');

const passwordInput = ref<HTMLInputElement | null>(null);

function submit() {
  pending.value = null;
  emit(
    'connect',
    {
      host: host.value.trim(),
      port: Number(port.value) || 22,
      username: username.value.trim(),
      password: password.value,
    },
    { remember: remember.value, label: label.value.trim() },
  );
}

// ------------------------------------------------- login password prompt

/** Asks for a saved server's login password: none saved, or the saved one was refused. */
const loginPrompt = ref<{
  server: SavedServer;
  password: string;
  remember: boolean;
  show: boolean;
  error: string;
  rejected: boolean;
} | null>(null);
const promptInput = ref<HTMLInputElement | null>(null);

/** ssh2's wording when the server refuses the credentials, as opposed to a network error. */
const AUTH_FAILED = /authentication|auth fail|password|permission denied/i;

async function openLoginPrompt(server: SavedServer, error = '', rejected = false) {
  loginPrompt.value = { server, password: '', remember: true, show: false, error, rejected };
  await nextTick();
  promptInput.value?.focus();
}

function submitLoginPrompt() {
  const p = loginPrompt.value;
  if (!p?.password) return;
  p.error = '';
  pending.value = p.server.id;
  emit(
    'connect',
    { host: p.server.host, port: p.server.port, username: p.server.username, password: p.password },
    { remember: p.remember, label: p.server.label ?? '' },
  );
}

// When a one-click login (or the prompt) fails, decide whether it was the password.
watch(
  () => props.connecting,
  (now, before) => {
    if (!before || now || !pending.value || !props.error) return;
    const server = servers.value.find((s) => s.id === pending.value);
    pending.value = null;
    if (!server) return;
    if (!AUTH_FAILED.test(props.error)) {
      // Network trouble, not the password — show it, but don't ask for a new one.
      if (loginPrompt.value) loginPrompt.value.error = props.error;
      return;
    }
    if (loginPrompt.value) {
      loginPrompt.value.error = 'Wrong password — try again.';
      loginPrompt.value.password = '';
      promptInput.value?.focus();
    } else {
      openLoginPrompt(server, 'The saved password was rejected — it may have changed. Enter the current one.', true);
    }
  },
);

/** A saved password connects in one click; without one (or a refused one), it asks. */
function pick(server: SavedServer) {
  if (server.password) {
    pending.value = server.id;
    emit(
      'connect',
      { host: server.host, port: server.port, username: server.username, password: server.password },
      { remember: true, label: server.label ?? '' },
    );
  } else {
    openLoginPrompt(server);
  }
}

// ---------------------------------------------------------- passwords panel

/** Per-server: see which passwords are saved, forget or replace each, keep the server. */
const pwPanel = ref<{ server: SavedServer; editing: 'password' | 'sudoPassword' | null; value: string } | null>(null);

function refreshServers() {
  servers.value = prefs.savedServers();
  if (pwPanel.value) {
    const fresh = servers.value.find((s) => s.id === pwPanel.value!.server.id);
    if (fresh) pwPanel.value.server = fresh;
  }
}

function forgetPassword(field: 'password' | 'sudoPassword') {
  const panel = pwPanel.value;
  if (!panel) return;
  prefs.updateServer(panel.server.id, { [field]: undefined });
  refreshServers();
}

function savePassword() {
  const panel = pwPanel.value;
  if (!panel?.editing || !panel.value) return;
  prefs.updateServer(panel.server.id, { [panel.editing]: panel.value });
  panel.editing = null;
  panel.value = '';
  refreshServers();
}

function forgetAllPasswords() {
  if (!confirm('Forget every saved password? Your servers stay in the list; you will be asked for passwords when you connect.')) return;
  for (const s of servers.value) prefs.updateServer(s.id, { password: undefined, sudoPassword: undefined });
  refreshServers();
}

const savedPasswordCount = () => servers.value.filter((s) => s.password || s.sudoPassword).length;

function forget(server: SavedServer) {
  if (!confirm(`Remove ${server.label || server.id} from saved servers?`)) return;
  prefs.forgetServer(server.id);
  servers.value = prefs.savedServers();
}

function startRename(server: SavedServer) {
  editing.value = server.id;
  editLabel.value = server.label ?? '';
}

function saveRename(server: SavedServer) {
  prefs.updateServer(server.id, { label: editLabel.value.trim() || undefined });
  servers.value = prefs.savedServers();
  editing.value = null;
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const input =
  'w-full rounded-lg border border-slate-700 bg-slate-950 py-2.5 pr-3 pl-9 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none';
</script>

<template>
  <div class="flex min-h-full items-center justify-center p-6">
    <div class="grid w-full max-w-5xl gap-6" :class="servers.length ? 'lg:grid-cols-[1fr_26rem]' : 'max-w-md'">
      <!-- Saved servers -->
      <section v-if="servers.length" class="order-2 lg:order-1">
        <div class="mb-4 flex items-end justify-between">
          <div>
            <h2 class="text-lg font-semibold text-white">Your servers</h2>
            <p class="text-sm text-slate-500">Successful logins are saved in this browser.</p>
          </div>
          <div class="text-right">
            <span class="block text-xs text-slate-600">{{ servers.length }} saved</span>
            <button
              v-if="savedPasswordCount()"
              class="text-[11px] text-slate-500 hover:text-red-400"
              @click="forgetAllPasswords"
            >
              Forget all passwords
            </button>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div
            v-for="server in servers"
            :key="server.id"
            class="group relative cursor-pointer rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-emerald-600/60 hover:bg-slate-900"
            @click="editing !== server.id && pick(server)"
          >
            <div class="flex items-start gap-3">
              <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/20"
              >
                <v-icon
                  v-if="connecting && pending === server.id"
                  name="fa-spinner"
                  class="animate-spin text-emerald-400"
                />
                <v-icon v-else name="fa-server" class="text-emerald-400" />
              </div>
              <div class="min-w-0 flex-1">
                <form v-if="editing === server.id" @submit.prevent="saveRename(server)" @click.stop>
                  <input
                    v-model="editLabel"
                    autofocus
                    placeholder="Label, e.g. Production"
                    class="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white focus:border-emerald-500 focus:outline-none"
                    @keydown.esc="editing = null"
                    @blur="saveRename(server)"
                  />
                </form>
                <p v-else class="truncate font-medium text-white">
                  {{ server.label || server.host }}
                </p>
                <p class="truncate font-mono text-xs text-slate-400">
                  {{ server.username }}@{{ server.host }}<span v-if="server.port !== 22">:{{ server.port }}</span>
                </p>
                <p class="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                  <span class="flex items-center gap-1">
                    <v-icon name="fa-clock" scale="0.6" /> {{ ago(server.lastUsed) }}
                  </span>
                  <span
                    class="flex items-center gap-1"
                    :class="server.password ? 'text-emerald-500' : 'text-slate-500'"
                  >
                    <v-icon :name="server.password ? 'fa-bolt' : 'fa-lock'" scale="0.6" />
                    {{ server.password ? 'One-click' : 'Asks for password' }}
                  </span>
                  <span v-if="server.sudoPassword" class="flex items-center gap-1 text-amber-400" title="A sudo password is saved">
                    <v-icon name="fa-key" scale="0.6" /> sudo
                  </span>
                </p>
              </div>
            </div>

            <div
              class="absolute top-2 right-2 flex gap-0.5 opacity-0 transition group-hover:opacity-100"
              @click.stop
            >
              <button
                title="Passwords"
                class="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-amber-300"
                @click="pwPanel = { server, editing: null, value: '' }"
              >
                <v-icon name="fa-key" scale="0.65" />
              </button>
              <button
                title="Rename"
                class="rounded p-1.5 text-slate-500 hover:bg-slate-800 hover:text-white"
                @click="startRename(server)"
              >
                <v-icon name="fa-pen" scale="0.65" />
              </button>
              <button
                title="Forget this server"
                class="rounded p-1.5 text-slate-500 hover:bg-red-950 hover:text-red-400"
                @click="forget(server)"
              >
                <v-icon name="fa-trash-alt" scale="0.65" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- New connection -->
      <section class="order-1 lg:order-2">
        <div class="mb-6 text-center">
          <div
            class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30"
          >
            <v-icon name="fa-terminal" scale="1.4" class="text-emerald-400" />
          </div>
          <h1 class="text-2xl font-semibold text-white">SSHer</h1>
          <p class="mt-1 text-sm text-slate-400">Files, Docker and firewall for your servers.</p>
        </div>

        <form
          class="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl"
          @submit.prevent="submit"
        >
          <div class="grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <label class="mb-1.5 block text-xs font-medium text-slate-400">IP address / host</label>
              <div class="relative">
                <v-icon
                  name="fa-network-wired"
                  scale="0.8"
                  class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
                />
                <input v-model="host" required placeholder="192.168.1.10" autocomplete="off" :class="input" />
              </div>
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-medium text-slate-400">Port</label>
              <input
                v-model.number="port"
                type="number"
                min="1"
                max="65535"
                class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-400">Username</label>
            <div class="relative">
              <v-icon
                name="fa-user"
                scale="0.8"
                class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
              />
              <input v-model="username" required autocomplete="username" :class="input" />
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-400">Password</label>
            <div class="relative">
              <v-icon
                name="fa-lock"
                scale="0.8"
                class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
              />
              <input
                ref="passwordInput"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                required
                autocomplete="current-password"
                placeholder="••••••••"
                :class="[input, 'pr-10']"
              />
              <button
                type="button"
                tabindex="-1"
                class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-white"
                @click="showPassword = !showPassword"
              >
                <v-icon :name="showPassword ? 'fa-eye-slash' : 'fa-eye'" scale="0.8" />
              </button>
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-400">
              Label <span class="text-slate-600">(optional)</span>
            </label>
            <div class="relative">
              <v-icon
                name="fa-bookmark"
                scale="0.8"
                class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
              />
              <input v-model="label" placeholder="Production, Staging…" :class="input" />
            </div>
          </div>

          <label class="flex cursor-pointer items-start gap-2.5 text-sm text-slate-300">
            <input v-model="remember" type="checkbox" class="mt-0.5 accent-emerald-500" />
            <span>
              Remember password
              <span class="block text-xs text-slate-500">
                Stored in this browser's localStorage for one-click login. Leave off on shared
                computers.
              </span>
            </span>
          </label>

          <p
            v-if="error"
            class="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300"
          >
            <v-icon name="fa-exclamation-triangle" scale="0.8" class="mt-0.5 shrink-0" />
            <span>{{ error }}</span>
          </p>

          <button
            type="submit"
            :disabled="connecting"
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <v-icon v-if="connecting" name="fa-spinner" class="animate-spin" scale="0.9" />
            {{ connecting ? 'Connecting…' : 'Connect' }}
          </button>
        </form>
      </section>
    </div>

    <!-- Login password for a saved server (none saved, or the saved one was refused) -->
    <div
      v-if="loginPrompt"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      @click.self="loginPrompt = null"
    >
      <form
        class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
        @submit.prevent="submitLoginPrompt"
        @keydown.esc="loginPrompt = null"
      >
        <h2 class="flex items-center gap-2 font-semibold text-white">
          <v-icon name="fa-lock" class="text-emerald-400" /> {{ loginPrompt.server.label || loginPrompt.server.host }}
        </h2>
        <p class="mt-1 font-mono text-xs text-slate-400">
          {{ loginPrompt.server.username }}@{{ loginPrompt.server.host }}
        </p>
        <p
          v-if="loginPrompt.error"
          class="mt-3 rounded-lg border px-3 py-2 text-sm"
          :class="loginPrompt.rejected ? 'border-amber-800/60 bg-amber-950/40 text-amber-200' : 'border-red-900/50 bg-red-950/50 text-red-300'"
        >
          {{ loginPrompt.error }}
        </p>
        <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">Password</label>
        <div class="relative">
          <input
            ref="promptInput"
            v-model="loginPrompt.password"
            :type="loginPrompt.show ? 'text' : 'password'"
            autocomplete="current-password"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 pr-10 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="button"
            tabindex="-1"
            class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-white"
            @click="loginPrompt.show = !loginPrompt.show"
          >
            <v-icon :name="loginPrompt.show ? 'fa-eye-slash' : 'fa-eye'" scale="0.8" />
          </button>
        </div>
        <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-300">
          <input v-model="loginPrompt.remember" type="checkbox" class="accent-emerald-500" />
          Remember this password
        </label>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white" @click="loginPrompt = null">
            Cancel
          </button>
          <button
            type="submit"
            :disabled="!loginPrompt.password || connecting"
            class="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            <v-icon v-if="connecting" name="fa-spinner" class="animate-spin" scale="0.8" />
            Connect
          </button>
        </div>
      </form>
    </div>

    <!-- Saved passwords for one server -->
    <div
      v-if="pwPanel"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      @click.self="pwPanel = null"
    >
      <div class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl" @keydown.esc="pwPanel = null">
        <div class="mb-1 flex items-center gap-2">
          <v-icon name="fa-key" class="text-amber-300" />
          <h2 class="flex-1 font-semibold text-white">Passwords</h2>
          <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="pwPanel = null">
            <v-icon name="fa-times" scale="0.8" />
          </button>
        </div>
        <p class="mb-4 font-mono text-xs text-slate-400">
          {{ pwPanel.server.username }}@{{ pwPanel.server.host }}<span v-if="pwPanel.server.port !== 22">:{{ pwPanel.server.port }}</span>
        </p>

        <div
          v-for="row in [
            { field: 'password', title: 'Login password', hint: 'Used to open the SSH connection.' },
            { field: 'sudoPassword', title: 'sudo password', hint: pwPanel.server.username === 'root'
                ? 'Not needed — you log in as root.'
                : 'Used when an action needs root. Usually the same as the login password; SSHer tries that first.' },
          ] as const"
          :key="row.field"
          class="mb-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3"
        >
          <div class="flex items-center gap-2">
            <p class="flex-1 text-sm font-medium text-white">{{ row.title }}</p>
            <span
              class="rounded-full px-2 py-0.5 text-[10px]"
              :class="pwPanel.server[row.field] ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-500'"
            >
              {{ pwPanel.server[row.field] ? 'Saved' : 'Not saved' }}
            </span>
          </div>
          <p class="mt-0.5 text-[11px] text-slate-500">{{ row.hint }}</p>

          <form
            v-if="pwPanel.editing === row.field"
            class="mt-2 flex gap-2"
            @submit.prevent="savePassword"
          >
            <input
              v-model="pwPanel.value"
              type="password"
              autofocus
              placeholder="New password"
              class="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
            />
            <button type="submit" :disabled="!pwPanel.value" class="rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40">
              Save
            </button>
            <button type="button" class="rounded-md px-2 text-xs text-slate-400 hover:text-white" @click="pwPanel.editing = null">
              Cancel
            </button>
          </form>
          <div v-else class="mt-2 flex gap-2">
            <button
              class="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 hover:text-white"
              @click="pwPanel.editing = row.field; pwPanel.value = ''"
            >
              {{ pwPanel.server[row.field] ? 'Change' : 'Set' }}
            </button>
            <button
              v-if="pwPanel.server[row.field]"
              class="rounded-md border border-red-900 px-2.5 py-1 text-xs text-red-400 hover:bg-red-950"
              @click="forgetPassword(row.field)"
            >
              Forget
            </button>
          </div>
        </div>

        <p class="text-[11px] leading-relaxed text-slate-500">
          Passwords are kept in this browser's localStorage, in plain text. Forgetting one keeps the server
          in your list — you'll be asked for the password next time it's needed. A saved password isn't checked
          until it's used; if it's wrong, you're asked for the right one.
        </p>
      </div>
    </div>
  </div>
</template>
