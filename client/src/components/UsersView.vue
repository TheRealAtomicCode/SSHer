<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { sudoMode } from '../sudoMode';
import { fail, notify } from '../toast';
import type { Session, SudoChange, SystemUser } from '../types';

const props = defineProps<{ session: Session }>();

const loading = ref(true);
const allUsers = ref<SystemUser[]>([]);
const showService = ref(false);
const selected = ref<SystemUser | null>(null);
const busy = ref(false);
const rule = ref('');

const newUserOpen = ref(false);
const newUser = reactive({
  name: '',
  systemAccount: false,
  createHome: true,
  shell: '',
  groupsText: '',
  setPassword: false,
  password: '',
});

async function refresh() {
  loading.value = true;
  try {
    allUsers.value = (await api.users()).users;
    if (selected.value) selected.value = allUsers.value.find((u) => u.name === selected.value!.name) ?? null;
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

const loginUsers = computed(() => allUsers.value.filter((u) => u.canLogin).sort((a, b) => a.uid - b.uid));
const serviceUsers = computed(() => allUsers.value.filter((u) => !u.canLogin).sort((a, b) => a.uid - b.uid));

function select(user: SystemUser) {
  selected.value = selected.value?.name === user.name ? null : user;
  rule.value = '';
}

function isSelf(user: SystemUser): boolean {
  return user.name === props.session.username;
}

async function applySudo(user: SystemUser, change: SudoChange) {
  if (isSelf(user)) {
    if (
      !confirm(
        `This is the account you're connected as.\n\nChanging its sudo access could lock you out of fixing it over SSH if something goes wrong. Continue anyway?`,
      )
    )
      return;
    change = { ...change, confirmSelf: true };
  }
  busy.value = true;
  try {
    await api.setUserSudo(user.name, change);
    notify(`Updated sudo access for ${user.name}`);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

function toggleSudoGroup(user: SystemUser) {
  applySudo(user, { group: !user.sudoGroup });
}

function grantPasswordless(user: SystemUser) {
  if (!confirm(`Give ${user.name} full passwordless sudo (NOPASSWD:ALL)?`)) return;
  applySudo(user, { passwordless: true });
}

function applyCustomRule(user: SystemUser) {
  if (!rule.value.trim()) return;
  if (!confirm(`Write this as /etc/sudoers.d/${user.name}?\n\n${rule.value.trim()}\n\nChecked with visudo before anything is replaced.`)) return;
  applySudo(user, { rule: rule.value });
}

function removeRuleFile(user: SystemUser) {
  if (!confirm(`Remove the sudoers rule for ${user.name}?`)) return;
  applySudo(user, { passwordless: false });
}

function revokeAll(user: SystemUser) {
  if (!confirm(`Revoke all sudo access for ${user.name}?\n\nRemoves it from the sudo group and deletes its sudoers.d rule, if any.`)) return;
  applySudo(user, { removeAll: true });
}

function openNewUser() {
  Object.assign(newUser, { name: '', systemAccount: false, createHome: true, shell: '', groupsText: '', setPassword: false, password: '' });
  newUserOpen.value = true;
}

async function submitNewUser() {
  if (!/^[a-z_][a-z0-9_-]*$/.test(newUser.name)) {
    fail(new Error('Username must be lowercase letters, digits, - or _, starting with a letter or underscore.'));
    return;
  }
  busy.value = true;
  try {
    await api.createUser({
      name: newUser.name,
      createHome: newUser.createHome,
      systemAccount: newUser.systemAccount,
      shell: newUser.shell || undefined,
      groups: newUser.groupsText.split(',').map((g) => g.trim()).filter(Boolean),
      password: newUser.setPassword ? newUser.password : undefined,
    });
    notify(`Created ${newUser.name}`);
    newUserOpen.value = false;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

async function removeUser(user: SystemUser) {
  if (!confirm(`Delete the user "${user.name}"?\n\nAlso deletes its home directory (${user.home}). This cannot be undone.`)) return;
  busy.value = true;
  try {
    await api.deleteUser(user.name, true);
    notify(`Deleted ${user.name}`);
    if (selected.value?.name === user.name) selected.value = null;
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);

const btn =
  'rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-40';
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-5">
    <div class="mx-auto max-w-4xl">
      <div class="mb-5 flex items-center gap-3">
        <v-icon name="fa-users" scale="1.3" class="text-emerald-400" />
        <div class="flex-1">
          <h1 class="text-base font-semibold text-white">Users</h1>
          <p class="text-xs text-slate-500">
            {{ loginUsers.length }} can log in · {{ serviceUsers.length }} service accounts
          </p>
        </div>
        <button class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white" title="Refresh" @click="refresh">
          <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!sudoMode.enabled"
          :title="!sudoMode.enabled ? 'Turn on sudo mode to create a user' : ''"
          @click="openNewUser"
        >
          <v-icon name="fa-plus" scale="0.75" /> New user
        </button>
      </div>

      <p v-if="!sudoMode.enabled" class="mb-4 flex items-center gap-2 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        <v-icon name="fa-lock" scale="0.7" /> Turn on sudo mode (top of the screen) to change group membership or sudo access — viewing is always allowed.
      </p>

      <div v-if="loading && !allUsers.length" class="py-16 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-emerald-400" />
      </div>

      <template v-else>
        <div class="overflow-hidden rounded-xl border border-slate-800">
          <div
            v-for="user in loginUsers"
            :key="user.name"
            class="border-b border-slate-800/70 last:border-b-0"
          >
            <button
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-900/60"
              :class="selected?.name === user.name && 'bg-slate-900/60'"
              @click="select(user)"
            >
              <v-icon name="fa-user" scale="0.9" class="text-sky-300" />
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                  {{ user.name }}
                  <span class="font-mono text-[11px] font-normal text-slate-500">uid {{ user.uid }}</span>
                  <span v-if="isSelf(user)" class="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] text-sky-300">you</span>
                  <span v-if="user.locked" class="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300">locked</span>
                  <span v-if="user.sudoGroup" class="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">sudo group</span>
                  <span v-if="user.sudoFile" class="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">sudoers rule</span>
                </p>
                <p class="truncate text-xs text-slate-500">{{ user.groups.join(', ') || '—' }} · {{ user.shell }}</p>
              </div>
              <v-icon name="fa-chevron-right" scale="0.6" class="shrink-0 text-slate-600 transition" :class="selected?.name === user.name && 'rotate-90'" />
            </button>

            <div v-if="selected?.name === user.name" class="space-y-3 border-t border-slate-800 bg-slate-950/50 px-4 py-4">
              <div class="flex flex-wrap gap-2">
                <button :class="btn" :disabled="!sudoMode.enabled || busy" @click="toggleSudoGroup(user)">
                  <v-icon name="fa-users" scale="0.7" /> {{ user.sudoGroup ? 'Remove from sudo group' : 'Add to sudo group' }}
                </button>
                <button :class="btn" :disabled="!sudoMode.enabled || busy" @click="grantPasswordless(user)">
                  <v-icon name="fa-unlock-alt" scale="0.7" /> Grant passwordless sudo
                </button>
                <button v-if="user.sudoFile" :class="btn" :disabled="!sudoMode.enabled || busy" @click="removeRuleFile(user)">
                  <v-icon name="fa-times" scale="0.7" /> Remove sudoers rule
                </button>
                <button
                  v-if="user.sudoGroup || user.sudoFile"
                  class="rounded-lg border border-red-900 px-2.5 py-1.5 text-xs text-red-400 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!sudoMode.enabled || busy"
                  @click="revokeAll(user)"
                >
                  <v-icon name="fa-ban" scale="0.7" /> Revoke all sudo access
                </button>
                <button
                  class="ml-auto rounded-lg border border-red-900 px-2.5 py-1.5 text-xs text-red-400 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!sudoMode.enabled || busy || isSelf(user)"
                  :title="isSelf(user) ? 'Cannot delete the account you are connected as' : ''"
                  @click="removeUser(user)"
                >
                  <v-icon name="fa-trash-alt" scale="0.7" /> Delete user
                </button>
              </div>

              <div>
                <label class="mb-1.5 block text-xs font-medium text-slate-400">Custom sudoers rule (optional, power users)</label>
                <div class="flex gap-2">
                  <input
                    v-model="rule"
                    :placeholder="`${user.name} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart myapp`"
                    class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                  />
                  <button :class="btn" :disabled="!sudoMode.enabled || busy || !rule.trim()" @click="applyCustomRule(user)">Apply</button>
                </div>
                <p class="mt-1 text-[11px] text-slate-500">
                  Written to /etc/sudoers.d/{{ user.name }} and checked with visudo before anything is replaced.
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          class="mt-5 flex items-center gap-2 text-xs text-slate-400 hover:text-white"
          @click="showService = !showService"
        >
          <v-icon name="fa-chevron-right" scale="0.6" class="transition-transform" :class="showService && 'rotate-90'" />
          {{ showService ? 'Hide' : 'Show' }} {{ serviceUsers.length }} service accounts (www-data and the like)
        </button>

        <div v-if="showService" class="mt-2 overflow-hidden rounded-xl border border-slate-800">
          <div
            v-for="user in serviceUsers"
            :key="user.name"
            class="border-b border-slate-800/70 last:border-b-0"
          >
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-900/60"
              :class="selected?.name === user.name && 'bg-slate-900/60'"
              @click="select(user)"
            >
              <v-icon name="fa-cog" scale="0.8" class="text-slate-500" />
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                  {{ user.name }}
                  <span class="font-mono text-[11px] text-slate-500">uid {{ user.uid }}</span>
                  <span v-if="user.sudoGroup" class="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">sudo group</span>
                  <span v-if="user.sudoFile" class="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">sudoers rule</span>
                </p>
                <p class="truncate text-xs text-slate-500">{{ user.home }} · {{ user.groups.join(', ') || '—' }}</p>
              </div>
            </button>

            <div v-if="selected?.name === user.name" class="space-y-3 border-t border-slate-800 bg-slate-950/50 px-4 py-4">
              <div class="flex flex-wrap gap-2">
                <button :class="btn" :disabled="!sudoMode.enabled || busy" @click="toggleSudoGroup(user)">
                  <v-icon name="fa-users" scale="0.7" /> {{ user.sudoGroup ? 'Remove from sudo group' : 'Add to sudo group' }}
                </button>
                <button :class="btn" :disabled="!sudoMode.enabled || busy" @click="grantPasswordless(user)">
                  <v-icon name="fa-unlock-alt" scale="0.7" /> Grant passwordless sudo
                </button>
                <button v-if="user.sudoFile" :class="btn" :disabled="!sudoMode.enabled || busy" @click="removeRuleFile(user)">
                  <v-icon name="fa-times" scale="0.7" /> Remove sudoers rule
                </button>
                <button
                  class="ml-auto rounded-lg border border-red-900 px-2.5 py-1.5 text-xs text-red-400 transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!sudoMode.enabled || busy || isSelf(user)"
                  @click="removeUser(user)"
                >
                  <v-icon name="fa-trash-alt" scale="0.7" /> Delete user
                </button>
              </div>
              <div>
                <label class="mb-1.5 block text-xs font-medium text-slate-400">Custom sudoers rule</label>
                <div class="flex gap-2">
                  <input
                    v-model="rule"
                    placeholder="www-data ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx"
                    class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                  />
                  <button :class="btn" :disabled="!sudoMode.enabled || busy || !rule.trim()" @click="applyCustomRule(user)">Apply</button>
                </div>
              </div>
              <p class="text-[11px] text-slate-500">
                To give this account read/write on a specific path, use Permissions… on it from the File Explorer.
              </p>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- New user -->
    <div
      v-if="newUserOpen"
      data-modal
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
      @click.self="newUserOpen = false"
    >
      <div class="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h2 class="mb-4 text-base font-semibold text-white">New user</h2>

        <label class="mb-1.5 block text-xs font-medium text-slate-400">Username</label>
        <input v-model="newUser.name" class="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none" placeholder="app_deploy" />

        <label class="mb-3 flex items-center gap-2 text-xs text-slate-300">
          <input v-model="newUser.systemAccount" type="checkbox" class="accent-emerald-500" />
          Service account (no login, system UID range)
        </label>

        <label class="mb-3 flex items-center gap-2 text-xs text-slate-300">
          <input v-model="newUser.createHome" type="checkbox" class="accent-emerald-500" />
          Create a home directory
        </label>

        <label class="mb-1.5 block text-xs font-medium text-slate-400">Shell <span class="text-slate-600">(optional)</span></label>
        <input
          v-model="newUser.shell"
          class="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          :placeholder="newUser.systemAccount ? '/usr/sbin/nologin' : '/bin/bash'"
        />

        <label class="mb-1.5 block text-xs font-medium text-slate-400">Extra groups <span class="text-slate-600">(optional, comma-separated)</span></label>
        <input v-model="newUser.groupsText" class="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none" placeholder="docker, www-data" />

        <label class="mb-3 flex items-center gap-2 text-xs text-slate-300">
          <input v-model="newUser.setPassword" type="checkbox" class="accent-emerald-500" />
          Set a password
        </label>
        <input
          v-if="newUser.setPassword"
          v-model="newUser.password"
          type="password"
          class="mb-3 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
        />
        <p v-else class="mb-3 text-[11px] text-slate-500">No password means no password login — fine for SSH-key or service accounts.</p>

        <div class="flex justify-end gap-2">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800" @click="newUserOpen = false">Cancel</button>
          <button
            class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            :disabled="!newUser.name || busy"
            @click="submitNewUser"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
