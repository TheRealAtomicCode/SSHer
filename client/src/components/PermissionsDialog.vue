<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { fail, notify } from '../toast';
import type { AclEntry, FilePermissions, RemoteFile, SystemGroup, SystemUser } from '../types';

const props = defineProps<{ files: RemoteFile[] }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const loading = ref(true);
const current = ref<FilePermissions | null>(null);
const users = ref<SystemUser[]>([]);
const groups = ref<SystemGroup[]>([]);

const single = computed(() => (props.files.length === 1 ? props.files[0] : null));
const anyDir = computed(() => props.files.some((f) => f.isDirectory));
const recursive = ref(false);

const ownerPick = ref('');
const groupPick = ref('');
const modeBits = reactive({
  ownerR: true, ownerW: true, ownerX: false,
  groupR: true, groupW: false, groupX: false,
  otherR: true, otherW: false, otherX: false,
});

const aclUser = ref('');
const aclR = ref(true);
const aclW = ref(true);
const aclX = ref(false);
const aclDefault = ref(false);

function applyModeBitsFromOctal(mode: string) {
  const digits = mode.slice(-3).padStart(3, '0').split('').map(Number);
  const [o, g, ot] = digits;
  modeBits.ownerR = Boolean(o & 4); modeBits.ownerW = Boolean(o & 2); modeBits.ownerX = Boolean(o & 1);
  modeBits.groupR = Boolean(g & 4); modeBits.groupW = Boolean(g & 2); modeBits.groupX = Boolean(g & 1);
  modeBits.otherR = Boolean(ot & 4); modeBits.otherW = Boolean(ot & 2); modeBits.otherX = Boolean(ot & 1);
}

const octalMode = computed(() => {
  const bit = (r: boolean, w: boolean, x: boolean) => (r ? 4 : 0) + (w ? 2 : 0) + (x ? 1 : 0);
  return `${bit(modeBits.ownerR, modeBits.ownerW, modeBits.ownerX)}${bit(modeBits.groupR, modeBits.groupW, modeBits.groupX)}${bit(modeBits.otherR, modeBits.otherW, modeBits.otherX)}`;
});

async function reloadCurrent() {
  if (!single.value) return;
  current.value = await api.filePermissions(single.value.path).catch(() => current.value);
}

async function applyOwnerGroup() {
  try {
    await api.setFilePermissions(props.files.map((f) => f.path), {
      owner: ownerPick.value || undefined,
      group: groupPick.value || undefined,
      recursive: recursive.value,
    });
    notify('Owner/group updated');
    emit('changed');
    await reloadCurrent();
  } catch (err) {
    fail(err);
  }
}

async function applyMode() {
  try {
    await api.setFilePermissions(props.files.map((f) => f.path), { mode: octalMode.value, recursive: recursive.value });
    notify(`Permissions set to ${octalMode.value}`);
    emit('changed');
    await reloadCurrent();
  } catch (err) {
    fail(err);
  }
}

async function grantAccess() {
  if (!aclUser.value) return;
  const perms = `${aclR.value ? 'r' : ''}${aclW.value ? 'w' : ''}${aclX.value ? 'x' : ''}` || 'r';
  try {
    await api.setFileAcl(props.files.map((f) => f.path), {
      user: aclUser.value,
      perms,
      recursive: recursive.value,
      alsoDefault: aclDefault.value && anyDir.value,
    });
    notify(`Granted ${aclUser.value} ${perms} access`);
    await reloadCurrent();
  } catch (err) {
    fail(err);
  }
}

async function removeAcl(entry: AclEntry) {
  if (!entry.name) return;
  try {
    await api.setFileAcl(props.files.map((f) => f.path), { user: entry.name, remove: true, recursive: recursive.value });
    notify(`Removed ${entry.name}'s access`);
    await reloadCurrent();
  } catch (err) {
    fail(err);
  }
}

onMounted(async () => {
  try {
    const u = await api.users();
    users.value = u.users;
    groups.value = u.groups;
    if (single.value) {
      current.value = await api.filePermissions(single.value.path);
      ownerPick.value = current.value.owner;
      groupPick.value = current.value.group;
      applyModeBitsFromOctal(current.value.mode);
    }
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
});

const checkbox = 'accent-emerald-500';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
const select =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
const btn = 'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500';
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <div class="flex items-center gap-2 border-b border-slate-800 px-5 py-3.5">
        <v-icon name="fa-user-cog" class="text-emerald-400" />
        <h2 class="flex-1 truncate text-base font-semibold text-white">
          Permissions — {{ single ? single.name : `${files.length} items` }}
        </h2>
        <button class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
        <div v-if="loading" class="py-10 text-center">
          <v-icon name="fa-spinner" scale="1.3" class="animate-spin text-emerald-400" />
        </div>

        <template v-else>
          <label v-if="anyDir" class="flex items-center gap-2 text-xs text-slate-300">
            <input v-model="recursive" type="checkbox" :class="checkbox" /> Apply to contents recursively
          </label>

          <!-- Owner / group -->
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label :class="label">Owner</label>
              <select v-model="ownerPick" :class="select">
                <option value="">— leave unchanged —</option>
                <option v-for="u in users" :key="u.name" :value="u.name">{{ u.name }}</option>
              </select>
            </div>
            <div>
              <label :class="label">Group</label>
              <select v-model="groupPick" :class="select">
                <option value="">— leave unchanged —</option>
                <option v-for="g in groups" :key="g.name" :value="g.name">{{ g.name }}</option>
              </select>
            </div>
          </div>
          <button :class="btn" @click="applyOwnerGroup">Apply owner/group</button>

          <!-- Mode -->
          <div>
            <label :class="label">Permissions ({{ octalMode }})</label>
            <div class="grid grid-cols-[4rem_repeat(3,1fr)] items-center gap-x-3 gap-y-1.5 text-xs text-slate-300">
              <span />
              <span class="text-center text-slate-500">Read</span>
              <span class="text-center text-slate-500">Write</span>
              <span class="text-center text-slate-500">Execute</span>

              <span>Owner</span>
              <input v-model="modeBits.ownerR" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.ownerW" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.ownerX" type="checkbox" :class="[checkbox, 'justify-self-center']" />

              <span>Group</span>
              <input v-model="modeBits.groupR" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.groupW" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.groupX" type="checkbox" :class="[checkbox, 'justify-self-center']" />

              <span>Other</span>
              <input v-model="modeBits.otherR" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.otherW" type="checkbox" :class="[checkbox, 'justify-self-center']" />
              <input v-model="modeBits.otherX" type="checkbox" :class="[checkbox, 'justify-self-center']" />
            </div>
            <button :class="[btn, 'mt-2']" @click="applyMode">Apply permissions</button>
          </div>

          <!-- ACL -->
          <div class="border-t border-slate-800 pt-4">
            <p class="mb-2 text-xs font-medium text-slate-400">
              Grant access to another user (without changing the owner) — e.g. an app's service account
            </p>
            <p v-if="current && !current.hasAcl" class="mb-2 text-[11px] text-amber-300">
              The `acl` package isn't installed on this server — install it (apt-get install acl) to use this.
            </p>
            <template v-else>
              <div v-if="current?.acl.length" class="mb-3 space-y-1">
                <div
                  v-for="(entry, i) in current.acl.filter((e) => e.tag === 'user' && e.name)"
                  :key="i"
                  class="flex items-center gap-2 rounded-lg bg-slate-950 px-3 py-1.5 text-xs"
                >
                  <span class="font-mono text-slate-200">{{ entry.name }}</span>
                  <span class="text-slate-500">{{ entry.perms }}</span>
                  <span v-if="entry.default" class="text-slate-600">(new files)</span>
                  <button class="ml-auto text-slate-500 hover:text-red-400" @click="removeAcl(entry)">
                    <v-icon name="fa-times" scale="0.7" />
                  </button>
                </div>
              </div>
              <div class="flex flex-wrap items-end gap-2">
                <div class="flex-1">
                  <label :class="label">User</label>
                  <select v-model="aclUser" :class="select">
                    <option value="">Pick a user…</option>
                    <option v-for="u in users" :key="u.name" :value="u.name">{{ u.name }}</option>
                  </select>
                </div>
                <label class="flex items-center gap-1 text-xs text-slate-300"><input v-model="aclR" type="checkbox" :class="checkbox" /> read</label>
                <label class="flex items-center gap-1 text-xs text-slate-300"><input v-model="aclW" type="checkbox" :class="checkbox" /> write</label>
                <label class="flex items-center gap-1 text-xs text-slate-300"><input v-model="aclX" type="checkbox" :class="checkbox" /> exec</label>
                <button :class="btn" :disabled="!aclUser" @click="grantAccess">Grant</button>
              </div>
              <label v-if="anyDir" class="mt-2 flex items-center gap-2 text-xs text-slate-400">
                <input v-model="aclDefault" type="checkbox" :class="checkbox" />
                Also apply to new files created in here later
              </label>
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
