<script setup lang="ts">
import QRCode from 'qrcode';
import { computed, onMounted, ref } from 'vue';
import * as api from '../api';
import type { TwoFactorStatus, TwoFactorUser } from '../api';
import { copyToClipboard } from '../files';
import { fail, notify } from '../toast';
import type { StepResult, View } from '../types';
import StepLog from './StepLog.vue';

const emit = defineEmits<{ navigate: [View] }>();

const status = ref<TwoFactorStatus | null>(null);
const loading = ref(true);
const log = ref<{ title: string; steps: StepResult[]; running: boolean; error: string } | null>(null);
const emailDraft = ref<Record<string, string>>({});

async function refresh() {
  loading.value = true;
  try {
    status.value = await api.twoFactorStatus();
    emailDraft.value = Object.fromEntries(status.value.users.map((u) => [u.name, u.email]));
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

async function withLog(title: string, fn: () => Promise<{ log: StepResult[] }>) {
  log.value = { title, steps: [], running: true, error: '' };
  try {
    const res = await fn();
    log.value = { title, steps: res.log, running: false, error: '' };
  } catch (err) {
    const steps = err instanceof api.ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    log.value = { title, steps, running: false, error: (err as Error).message };
  }
  await refresh();
}

const users = computed(() => status.value?.users ?? []);
const missingEmail = computed(() => users.value.filter((u) => !u.email));
const withSecret = computed(() => users.value.filter((u) => u.hasSecret));
const withoutSecret = computed(() => users.value.filter((u) => !u.hasSecret));
const sudoUsers = computed(() => users.value.filter((u) => u.sudo && u.name !== 'root'));
const rootAllowed = computed(() => (status.value?.sshd.permitrootlogin ?? 'yes') !== 'no');

async function saveEmail(u: TwoFactorUser) {
  const email = (emailDraft.value[u.name] ?? '').trim();
  if (!email || email === u.email) return;
  try {
    await api.twoFactorEmail(u.name, email);
    notify(`Saved ${u.name}'s email`);
    await refresh();
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------- set up a user

const setup = ref<{
  user: string;
  email: string;
  step: 'email' | 'scan';
  qr: string;
  secret: string;
  scratch: string[];
  code: string;
  error: string;
  busy: boolean;
} | null>(null);

function startSetup(u: TwoFactorUser) {
  setup.value = { user: u.name, email: emailDraft.value[u.name] || u.email, step: 'email', qr: '', secret: '', scratch: [], code: '', error: '', busy: false };
}

async function makeSecret() {
  const s = setup.value;
  if (!s) return;
  s.busy = true;
  s.error = '';
  try {
    const res = await api.twoFactorSetup(s.user, s.email.trim());
    s.qr = await QRCode.toDataURL(res.otpauth, { margin: 1, width: 220, color: { dark: '#0f172a', light: '#ffffff' } });
    s.secret = res.secret;
    s.scratch = res.scratch;
    s.step = 'scan';
  } catch (err) {
    s.error = (err as Error).message;
  } finally {
    s.busy = false;
  }
}

async function confirmSetup() {
  const s = setup.value;
  if (!s) return;
  s.busy = true;
  s.error = '';
  try {
    await api.twoFactorConfirm(s.user, s.code.trim());
    notify(`2FA is set up for ${s.user}${status.value?.enforced ? ' — it is asked for at their next login' : ''}`);
    setup.value = null;
    await refresh();
  } catch (err) {
    s.error = (err as Error).message;
    s.code = '';
  } finally {
    if (setup.value) setup.value.busy = false;
  }
}

async function removeSecret(u: TwoFactorUser) {
  if (!confirm(`Remove ${u.name}'s authenticator?\n\nThey log in with just their password again${status.value?.enforced ? ' (2FA stays on for everyone else)' : ''}.`)) return;
  try {
    await api.twoFactorRemove(u.name);
    await refresh();
  } catch (err) {
    fail(err);
  }
}

// ----------------------------------------------------- enforce / close root (tested)

const guarded = ref<{ kind: 'enforce' | 'root'; user: string; password: string } | null>(null);

function openEnforce() {
  const me = withSecret.value.find((u) => u.name === status.value?.connectedAs);
  guarded.value = { kind: 'enforce', user: me?.name ?? withSecret.value[0]?.name ?? '', password: '' };
}

function openCloseRoot() {
  guarded.value = { kind: 'root', user: sudoUsers.value[0]?.name ?? '', password: '' };
}

async function runGuarded() {
  const g = guarded.value;
  if (!g?.user || !g.password) return;
  guarded.value = null;
  if (g.kind === 'enforce') await withLog('Turning on two-factor login', () => api.twoFactorEnforce(true, g.user, g.password));
  else await withLog('Closing direct root login', () => api.rootLogin(false, g.user, g.password));
}

async function turnOff() {
  if (!confirm('Turn off two-factor login?\n\nEveryone logs in with just their password again.')) return;
  await withLog('Turning off two-factor login', () => api.twoFactorEnforce(false));
}

async function reopenRoot() {
  if (!confirm('Allow root to log in over SSH again?')) return;
  await withLog('Reopening root login', () => api.rootLogin(true));
}

const btn = 'flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white disabled:opacity-40';
const field = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <v-icon name="fa-lock" class="text-emerald-300" />
      <h2 class="flex-1 text-sm font-semibold text-white">SSH login protection</h2>
      <button :class="btn" @click="refresh"><v-icon name="fa-sync-alt" scale="0.55" :class="loading && 'animate-spin'" /></button>
    </div>

    <div v-if="!status" class="py-6 text-center"><v-icon name="fa-spinner" class="animate-spin text-emerald-400" /></div>

    <template v-else>
      <!-- Status -->
      <div class="grid gap-2 sm:grid-cols-3">
        <div class="rounded-lg border border-slate-800 p-3 text-xs">
          <p class="text-slate-500">Authenticator module</p>
          <p class="mt-0.5 font-medium" :class="status.installed ? 'text-emerald-300' : 'text-slate-300'">{{ status.installed ? 'Installed' : 'Not installed' }}</p>
        </div>
        <div class="rounded-lg border border-slate-800 p-3 text-xs">
          <p class="text-slate-500">Two-factor login</p>
          <p class="mt-0.5 font-medium" :class="status.enforced ? 'text-emerald-300' : 'text-amber-300'">
            {{ status.enforced ? `On — ${withSecret.length} user(s) asked for a code` : 'Off' }}
          </p>
        </div>
        <div class="rounded-lg border border-slate-800 p-3 text-xs">
          <p class="text-slate-500">Direct root login</p>
          <p class="mt-0.5 font-medium" :class="rootAllowed ? 'text-amber-300' : 'text-emerald-300'">
            {{ rootAllowed ? `Allowed (${status.sshd.permitrootlogin ?? 'yes'})` : 'Closed' }}
          </p>
        </div>
      </div>

      <p class="mt-3 text-xs leading-relaxed text-slate-400">
        Two-factor login asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator,
        Authy, 1Password…) after the password. It's free and works offline — no Google account, and no emails are sent.
        Each user's <b class="text-slate-200">email</b> labels their entry in the app and records who the login belongs to.
      </p>

      <div v-if="!status.installed" class="mt-3">
        <button class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500" @click="withLog('Installing the authenticator module', api.twoFactorInstall)">
          <v-icon name="fa-cloud-download-alt" scale="0.7" /> Install
        </button>
      </div>

      <template v-else>
        <!-- Ask for emails -->
        <div v-if="missingEmail.length" class="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <v-icon name="fa-exclamation-triangle" scale="0.6" />
          Add an email for {{ missingEmail.map((u) => u.name).join(', ') }} below — each user needs one before setting up 2FA.
        </div>

        <!-- Users -->
        <div class="mt-3 overflow-hidden rounded-lg border border-slate-800">
          <table class="w-full text-xs">
            <thead class="bg-slate-900 text-left text-slate-500">
              <tr>
                <th class="px-3 py-2 font-medium">User</th>
                <th class="px-3 py-2 font-medium">Email</th>
                <th class="px-3 py-2 font-medium">2FA</th>
                <th class="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in users" :key="u.name" class="border-t border-slate-800/70">
                <td class="px-3 py-2">
                  <span class="font-mono text-slate-200">{{ u.name }}</span>
                  <span v-if="u.name === status.connectedAs" class="ml-1 text-[10px] text-emerald-400">you</span>
                  <span v-if="u.sudo && u.name !== 'root'" class="ml-1 rounded bg-slate-800 px-1 text-[10px] text-slate-400">sudo</span>
                </td>
                <td class="px-3 py-2">
                  <input
                    v-model="emailDraft[u.name]"
                    type="email"
                    placeholder="name@example.com"
                    class="w-full max-w-[16rem] rounded-md border bg-slate-950 px-2 py-1 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                    :class="u.email ? 'border-slate-800' : 'border-amber-700/70'"
                    @keydown.enter="saveEmail(u)"
                    @blur="saveEmail(u)"
                  />
                </td>
                <td class="px-3 py-2">
                  <span v-if="u.hasSecret" class="text-emerald-300"><v-icon name="fa-check" scale="0.6" /> Set up</span>
                  <span v-else class="text-slate-500">Not set up</span>
                </td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    :class="[btn, 'inline-flex']"
                    :disabled="!emailDraft[u.name]"
                    :title="emailDraft[u.name] ? '' : 'Add an email first'"
                    @click="startSetup(u)"
                  >
                    <v-icon name="fa-shield-alt" scale="0.55" /> {{ u.hasSecret ? 'Reset' : 'Set up' }}
                  </button>
                  <button v-if="u.hasSecret" :class="[btn, 'ml-1 inline-flex border-transparent text-slate-500 hover:text-red-300']" @click="removeSecret(u)">
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Turn on / off -->
        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <template v-if="!status.enforced">
            <button
              class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              :disabled="!withSecret.length || !status.supportsDropins"
              :title="withSecret.length ? '' : 'Set up 2FA for at least one user first'"
              @click="openEnforce"
            >
              <v-icon name="fa-lock" scale="0.6" /> Turn on two-factor login
            </button>
            <span v-if="!withSecret.length" class="text-[11px] text-slate-500">Set up at least one user first.</span>
          </template>
          <button v-else :class="btn" @click="turnOff">Turn off two-factor login</button>
          <span v-if="status.enforced && withoutSecret.length" class="text-[11px] text-amber-300/90">
            {{ withoutSecret.map((u) => u.name).join(', ') }} {{ withoutSecret.length === 1 ? 'has' : 'have' }} no authenticator yet and still log in with a password only.
          </span>
          <span v-if="!status.supportsDropins" class="text-[11px] text-red-300">This server's sshd_config doesn't read sshd_config.d, so this can't be applied safely from here.</span>
        </div>

        <!-- Root -->
        <div class="mt-4 rounded-lg border border-slate-800 p-3 text-xs">
          <p class="font-medium text-slate-200">Close direct root login</p>
          <p class="mt-1 text-slate-400">
            Bots try root's password all day. Closing it means you log in as a normal user and use sudo — root still exists, SSH
            just stops accepting it. SSHer tests a fresh login + sudo for that user before and after, and undoes it if either fails.
            Afterwards, log in to SSHer as that user (sudo passwords are asked for automatically).
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <template v-if="rootAllowed">
              <button class="rounded-lg bg-red-700 px-3 py-1.5 font-semibold text-white hover:bg-red-600 disabled:opacity-40" :disabled="!sudoUsers.length" @click="openCloseRoot">
                <v-icon name="fa-ban" scale="0.6" /> Close root login
              </button>
              <span v-if="!sudoUsers.length" class="text-amber-300/90">
                First create a normal user with sudo on the
                <button class="underline hover:text-white" @click="emit('navigate', 'users')">Users page</button>.
              </span>
            </template>
            <button v-else-if="status.rootLoginClosedBySsher" :class="btn" @click="reopenRoot">Allow root login again</button>
            <span v-else class="text-slate-500">Closed in sshd_config by hand.</span>
          </div>
        </div>
      </template>
    </template>

    <!-- Set up a user -->
    <div v-if="setup" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl" @keydown.esc="setup = null">
        <h3 class="flex items-center gap-2 font-semibold text-white"><v-icon name="fa-shield-alt" class="text-emerald-400" /> Two-factor for {{ setup.user }}</h3>

        <template v-if="setup.step === 'email'">
          <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">{{ setup.user }}'s email</label>
          <input v-model="setup.email" type="email" placeholder="name@example.com" :class="field" @keydown.enter="makeSecret" />
          <p class="mt-1 text-[11px] text-slate-500">Shown as the account name in their authenticator app. Nothing is sent to it.</p>
          <p v-if="setup.error" class="mt-2 text-sm text-red-300">{{ setup.error }}</p>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="setup = null">Cancel</button>
            <button class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40" :disabled="!setup.email || setup.busy" @click="makeSecret">Next</button>
          </div>
        </template>

        <template v-else>
          <ol class="mt-3 list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>Open the authenticator app on {{ setup.user }}'s phone and add an account by scanning this code.</li>
            <li>Save the backup codes somewhere safe — each one logs in once if the phone is lost.</li>
            <li>Type the 6-digit code the app now shows. Nothing changes until it matches.</li>
          </ol>
          <div class="mt-3 flex gap-4">
            <img :src="setup.qr" alt="QR code for the authenticator app" class="h-40 w-40 shrink-0 rounded-lg bg-white p-1" />
            <div class="min-w-0 text-[11px]">
              <p class="text-slate-500">Can't scan? Enter this key:</p>
              <button class="mt-0.5 font-mono break-all text-slate-200 hover:text-emerald-300" title="Copy" @click="copyToClipboard(setup.secret).then(() => notify('Key copied'))">
                {{ setup.secret.match(/.{1,4}/g)?.join(' ') }}
              </button>
              <p class="mt-2 text-slate-500">Backup codes:</p>
              <p class="font-mono leading-relaxed text-amber-200">{{ setup.scratch.join('  ') }}</p>
            </div>
          </div>
          <input
            v-model="setup.code"
            autofocus
            inputmode="numeric"
            maxlength="6"
            placeholder="123456"
            class="mt-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-center font-mono text-xl tracking-[0.4em] text-white focus:border-emerald-500 focus:outline-none"
            @keydown.enter="confirmSetup"
          />
          <p v-if="setup.error" class="mt-2 text-sm text-red-300">{{ setup.error }}</p>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="setup = null">Cancel</button>
            <button class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40" :disabled="setup.code.length < 6 || setup.busy" @click="confirmSetup">
              Confirm
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Tested change: which account to test with -->
    <div v-if="guarded" data-modal class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <form class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl" @submit.prevent="runGuarded" @keydown.esc="guarded = null">
        <h3 class="font-semibold text-white">{{ guarded.kind === 'enforce' ? 'Turn on two-factor login' : 'Close direct root login' }}</h3>
        <p class="mt-1 text-xs text-slate-400">
          SSHer will log in as this account in a fresh connection —
          {{ guarded.kind === 'enforce' ? 'with its password and a code' : 'and check sudo works' }} — before and after the
          change. If the "after" login fails, the change is undone automatically. Your current connection stays open.
        </p>
        <label class="mt-4 mb-1.5 block text-xs font-medium text-slate-400">Test with</label>
        <select v-model="guarded.user" :class="field">
          <option v-for="u in (guarded.kind === 'enforce' ? withSecret : sudoUsers)" :key="u.name" :value="u.name">{{ u.name }}{{ u.email ? ` (${u.email})` : '' }}</option>
        </select>
        <label class="mt-3 mb-1.5 block text-xs font-medium text-slate-400">{{ guarded.user }}'s password</label>
        <input v-model="guarded.password" type="password" autocomplete="off" :class="field" />
        <p class="mt-1 text-[11px] text-slate-500">Used only for the test logins, never stored.</p>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="guarded = null">Cancel</button>
          <button
            type="submit"
            class="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            :class="guarded.kind === 'enforce' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-700 hover:bg-red-600'"
            :disabled="!guarded.user || !guarded.password"
          >
            Test and apply
          </button>
        </div>
      </form>
    </div>

    <StepLog v-if="log" :title="log.title" :steps="log.steps" :running="log.running" :error="log.error" @close="log = null" />
  </section>
</template>
