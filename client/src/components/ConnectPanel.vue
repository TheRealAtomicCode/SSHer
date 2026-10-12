<script setup lang="ts">
import { nextTick, ref } from 'vue';
import * as prefs from '../prefs';
import type { Credentials, SavedServer } from '../types';

defineProps<{ connecting: boolean; error: string }>();
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

/** A saved server with its password connects in one click; without one, it fills the form. */
async function pick(server: SavedServer) {
  host.value = server.host;
  port.value = server.port;
  username.value = server.username;
  label.value = server.label ?? '';
  password.value = server.password ?? '';
  remember.value = Boolean(server.password);
  if (server.password) {
    pending.value = server.id;
    emit(
      'connect',
      { host: server.host, port: server.port, username: server.username, password: server.password },
      { remember: true, label: server.label ?? '' },
    );
  } else {
    await nextTick();
    passwordInput.value?.focus();
  }
}

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
          <span class="text-xs text-slate-600">{{ servers.length }} saved</span>
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
                </p>
              </div>
            </div>

            <div
              class="absolute top-2 right-2 flex gap-0.5 opacity-0 transition group-hover:opacity-100"
              @click.stop
            >
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
  </div>
</template>
