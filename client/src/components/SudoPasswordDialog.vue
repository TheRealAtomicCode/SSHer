<script setup lang="ts">
import { onMounted, ref } from 'vue';
import * as api from '../api';
import * as prefs from '../prefs';
import { finishSudoPrompt, sudoPrompt } from '../sudoPrompt';
import { notify } from '../toast';
import type { Session } from '../types';

const props = defineProps<{ session: Session }>();

const password = ref('');
const remember = ref(true);
const show = ref(false);
const busy = ref(false);
const error = ref('');
const denied = ref(false);
const input = ref<HTMLInputElement | null>(null);

const serverKey = prefs.serverId(props.session);
const isSaved = prefs.savedServers().some((s) => s.id === serverKey);

onMounted(() => input.value?.focus());

async function submit() {
  if (!password.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.setSudoPassword(password.value);
    // Remember it, or make sure a stale remembered one is gone.
    prefs.updateServer(serverKey, { sudoPassword: remember.value ? password.value : undefined });
    sudoPrompt.savedRejected = false;
    notify(remember.value && isSaved ? 'sudo password saved for this server' : 'sudo unlocked for this session');
    finishSudoPrompt(true);
  } catch (err) {
    const payload = err instanceof api.ApiError ? err.payload : {};
    denied.value = Boolean(payload.sudoDenied);
    error.value = (err as Error).message;
    password.value = '';
    input.value?.focus();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
  >
    <form
      class="w-full max-w-md rounded-xl border border-amber-700/50 bg-slate-900 p-5 shadow-2xl"
      @submit.prevent="submit"
      @keydown.esc="finishSudoPrompt(false)"
    >
      <h2 class="flex items-center gap-2 font-semibold text-white">
        <v-icon name="fa-lock" class="text-amber-300" /> sudo password needed
      </h2>
      <p class="mt-1 text-sm text-slate-400">
        This needs root, and sudo on
        <span class="font-mono text-slate-200">{{ session.username }}@{{ session.host }}</span>
        asked for a password.
      </p>
      <p class="mt-2 rounded-md bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-500">
        {{ sudoPrompt.reason }}
      </p>
      <p v-if="sudoPrompt.savedRejected" class="mt-2 text-xs text-amber-300">
        Your saved sudo password for this server didn't work — it may have changed.
      </p>

      <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">
        Password for {{ session.username }}
      </label>
      <div class="relative">
        <input
          ref="input"
          v-model="password"
          :type="show ? 'text' : 'password'"
          autocomplete="current-password"
          :disabled="denied"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 pr-10 text-sm text-slate-100 focus:border-amber-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          tabindex="-1"
          class="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-white"
          @click="show = !show"
        >
          <v-icon :name="show ? 'fa-eye-slash' : 'fa-eye'" scale="0.8" />
        </button>
      </div>

      <label v-if="isSaved" class="mt-3 flex cursor-pointer items-start gap-2.5 text-sm text-slate-300">
        <input v-model="remember" type="checkbox" class="mt-0.5 accent-amber-500" />
        <span>
          Remember for this server
          <span class="block text-xs text-slate-500">
            Stored in this browser's localStorage. Manage it from the server's
            <b>Passwords</b> button on the login screen.
          </span>
        </span>
      </label>

      <p v-if="error" class="mt-3 rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300">
        {{ error }}<span v-if="denied"> — ask an admin to add this user to the sudo group, or log in as root.</span>
      </p>

      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
          @click="finishSudoPrompt(false)"
        >
          Cancel
        </button>
        <button
          v-if="!denied"
          type="submit"
          :disabled="!password || busy"
          class="flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40"
        >
          <v-icon v-if="busy" name="fa-spinner" class="animate-spin" scale="0.8" />
          Unlock & retry
        </button>
      </div>
    </form>
  </div>
</template>
