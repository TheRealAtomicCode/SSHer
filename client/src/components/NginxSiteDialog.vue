<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import { fail } from '../toast';
import type { NginxCert, NginxSite, NginxSiteSpec, StepResult } from '../types';

const props = defineProps<{
  prefill?: Partial<NginxSiteSpec>;
  /** The raw file a drop produced — shown for reference, never written as-is. */
  rawPreview?: string;
}>();
const emit = defineEmits<{ close: []; created: [NginxSite] }>();

const spec = reactive<NginxSiteSpec>({
  name: props.prefill?.name ?? '',
  domain: props.prefill?.domain ?? '',
  target: props.prefill?.target ?? '',
  maxBody: props.prefill?.maxBody || '100m',
  overwrite: props.prefill?.overwrite ?? false,
  tlsCert: props.prefill?.tlsCert ?? '',
  originPull: props.prefill?.originPull ?? false,
});
/** Opened from an existing site's settings button: same name, rewritten in place. */
const editing = Boolean(props.prefill?.overwrite);

// ------------------------------------------------------------------- https

const certs = ref<NginxCert[]>([]);
const https = ref(Boolean(spec.tlsCert));
const addingCert = ref(false);
const savingCert = ref(false);
const newCert = reactive({ name: '', cert: '', key: '' });

onMounted(async () => {
  try {
    certs.value = (await api.nginxCerts()).certs;
    if (https.value && !spec.tlsCert && certs.value.length) spec.tlsCert = certs.value[0].name;
  } catch (err) {
    fail(err);
  }
});

function setHttps(on: boolean) {
  https.value = on;
  if (on && !spec.tlsCert && certs.value.length) spec.tlsCert = certs.value[0].name;
  if (on && !certs.value.length) addingCert.value = true;
}

/** `*.example.com` covers `app.example.com` but not `example.com` or `a.b.example.com`. */
function covers(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  return pattern.startsWith('*.') && host.endsWith(pattern.slice(1)) && !host.slice(0, -pattern.length + 1).includes('.');
}

const selectedCert = computed(() => certs.value.find((c) => c.name === spec.tlsCert) ?? null);
const uncovered = computed(() => {
  const cert = selectedCert.value;
  if (!https.value || !cert || !cert.domains.length) return [];
  return spec.domain.trim().split(/\s+/).filter((d) => d && !cert.domains.some((p) => covers(p, d)));
});

async function saveCert() {
  savingCert.value = true;
  try {
    const name = newCert.name.trim();
    certs.value = (await api.nginxAddCert({ name, cert: newCert.cert, key: newCert.key })).certs;
    spec.tlsCert = name;
    addingCert.value = false;
    Object.assign(newCert, { name: '', cert: '', key: '' });
  } catch (err) {
    fail(err);
  } finally {
    savingCert.value = false;
  }
}
const certFormOk = computed(
  () => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(newCert.name.trim()) && newCert.cert.includes('BEGIN CERTIFICATE') && /BEGIN (RSA |EC )?PRIVATE KEY/.test(newCert.key),
);

const submitting = ref(false);
const result = ref<{ log: StepResult[]; error: string; done: boolean } | null>(null);
const showRaw = ref(false);

const nameOk = computed(() => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(spec.name));
const domainOk = computed(() => spec.domain.trim().split(/\s+/).every((d) => /^(?=.{1,253}$)(\*\.)?([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(d)));
const targetOk = computed(() => /^[A-Za-z0-9][A-Za-z0-9.-]*:\d{1,5}$/.test(spec.target));
const canSubmit = computed(
  () => nameOk.value && domainOk.value && targetOk.value && (!https.value || Boolean(spec.tlsCert)) && !submitting.value,
);

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  result.value = { log: [], error: '', done: false };
  try {
    const res = await api.nginxAddSite({
      ...spec,
      tlsCert: https.value ? spec.tlsCert : '',
      originPull: https.value && spec.originPull,
    });
    result.value = { log: res.log, error: '', done: true };
    emit('created', res.site);
  } catch (err) {
    const log = err instanceof ApiError ? ((err.payload.log as StepResult[]) ?? []) : [];
    result.value = { log, error: (err as Error).message, done: false };
  } finally {
    submitting.value = false;
  }
}

const field =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none';
const label = 'mb-1.5 block text-xs font-medium text-slate-400';
const hint = 'mt-1 text-[11px] text-slate-500';
</script>

<template>
  <div
    data-modal
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
  >
    <div class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
      <div class="flex items-center gap-2 border-b border-slate-800 px-5 py-3.5">
        <v-icon name="fa-globe" class="text-emerald-400" />
        <h2 class="flex-1 text-base font-semibold text-white">{{ editing ? `Site settings — ${spec.name}` : 'Add an nginx site' }}</h2>
        <button
          v-if="!submitting"
          class="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          @click="emit('close')"
        >
          <v-icon name="fa-times" scale="0.85" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        <template v-if="!result">
          <div>
            <label :class="label">Site name</label>
            <input v-model="spec.name" :class="[field, 'font-mono']" placeholder="myapp" :disabled="editing" />
            <p :class="hint">Becomes /etc/nginx/sites-available/{{ spec.name || '…' }}</p>
          </div>
          <div>
            <label :class="label">Domain name(s)</label>
            <input v-model="spec.domain" :class="[field, 'font-mono']" placeholder="app.example.com" />
            <p :class="hint">Point its DNS at this server first. Space-separate several names.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div>
              <label :class="label">Proxy to (host:port)</label>
              <input v-model="spec.target" :class="[field, 'font-mono']" placeholder="127.0.0.1:3002" />
            </div>
            <div>
              <label :class="label">Max upload</label>
              <input v-model="spec.maxBody" :class="[field, 'font-mono']" placeholder="100m" />
              <p :class="hint">0 = no limit</p>
            </div>
          </div>

          <!-- HTTPS -->
          <div class="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <label class="flex items-center gap-2 text-sm text-white">
              <input :checked="https" type="checkbox" class="accent-emerald-500" @change="setHttps(($event.target as HTMLInputElement).checked)" />
              <v-icon name="fa-lock" scale="0.75" class="text-emerald-400" />
              Serve HTTPS from this server
            </label>
            <p :class="hint">
              Encrypts the hop between Cloudflare and this server too, so nobody on the network in between can read it.
              Port 80 then only redirects to https. Set Cloudflare's SSL/TLS mode to <b class="text-slate-300">Full (strict)</b>.
            </p>

            <div v-if="https" class="mt-3 space-y-3">
              <div v-if="certs.length && !addingCert">
                <label :class="label">Certificate</label>
                <div class="flex gap-2">
                  <select v-model="spec.tlsCert" :class="[field, 'font-mono']">
                    <option v-for="c in certs" :key="c.name" :value="c.name">
                      {{ c.name }} — {{ c.domains.join(', ') || 'no names' }}
                    </option>
                  </select>
                  <button class="shrink-0 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 hover:bg-slate-800" @click="addingCert = true">
                    + New
                  </button>
                </div>
                <p v-if="selectedCert" :class="hint">
                  {{ selectedCert.issuer }}<template v-if="selectedCert.expires">, valid until {{ selectedCert.expires.slice(0, 10) }}</template>
                </p>
                <p v-if="uncovered.length" class="mt-1 text-[11px] text-amber-300">
                  This certificate doesn't cover {{ uncovered.join(', ') }} — Full (strict) will reject it.
                </p>
              </div>

              <div v-if="addingCert" class="space-y-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3">
                <p class="text-xs text-slate-300">
                  In Cloudflare: <b>SSL/TLS → Origin Server → Create Certificate</b> (keep <span class="font-mono">yourdomain</span> and
                  <span class="font-mono">*.yourdomain</span>, 15 years). Paste both parts below. The key is shown only once there.
                </p>
                <input v-model="newCert.name" :class="[field, 'font-mono']" placeholder="certificate name, e.g. ssh-com-ly" />
                <textarea v-model="newCert.cert" :class="[field, 'h-20 font-mono text-[11px]']" placeholder="-----BEGIN CERTIFICATE-----" />
                <textarea v-model="newCert.key" :class="[field, 'h-20 font-mono text-[11px]']" placeholder="-----BEGIN PRIVATE KEY-----" />
                <p :class="hint">Stored in /etc/ssl/ssher, readable by root only. Checked that the key matches the certificate.</p>
                <div class="flex justify-end gap-2">
                  <button v-if="certs.length" class="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800" @click="addingCert = false">Cancel</button>
                  <button
                    :disabled="!certFormOk || savingCert"
                    class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                    @click="saveCert"
                  >
                    {{ savingCert ? 'Saving…' : 'Save certificate' }}
                  </button>
                </div>
              </div>

              <label v-if="spec.tlsCert && !addingCert" class="flex items-start gap-2 text-xs text-slate-300">
                <input v-model="spec.originPull" type="checkbox" class="mt-0.5 accent-emerald-500" />
                <span>
                  Only accept connections from Cloudflare (Authenticated Origin Pulls)
                  <span class="block text-[11px] text-amber-300/80">
                    Turn on SSL/TLS → Origin Server → Authenticated Origin Pulls in Cloudflare at the same time, or the site stops answering.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <label v-if="!editing" class="flex items-center gap-2 text-xs text-amber-300">
            <input v-model="spec.overwrite" type="checkbox" class="accent-amber-500" />
            Overwrite if {{ spec.name || 'this name' }} already exists
          </label>

          <div v-if="rawPreview">
            <button class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white" @click="showRaw = !showRaw">
              <v-icon name="fa-chevron-right" scale="0.6" :class="showRaw && 'rotate-90'" class="transition-transform" />
              The file you dropped (for reference — a fresh config is written from the fields above)
            </button>
            <pre v-if="showRaw" class="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ rawPreview }}</pre>
          </div>
        </template>

        <template v-else>
          <p v-if="submitting" class="flex items-center gap-2 text-sm text-emerald-300">
            <v-icon name="fa-spinner" class="animate-spin" /> Writing the site and reloading nginx…
          </p>
          <details
            v-for="(s, i) in result.log"
            :key="i"
            :open="!s.ok || i === result.log.length - 1"
            class="rounded-lg border bg-slate-950/50"
            :class="s.ok ? 'border-slate-800' : 'border-red-900'"
          >
            <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
              <v-icon :name="s.ok ? 'fa-check' : 'fa-times'" scale="0.7" :class="s.ok ? 'text-emerald-400' : 'text-red-400'" />
              <span :class="s.ok ? 'text-slate-200' : 'text-red-300'">{{ s.title }}</span>
            </summary>
            <pre v-if="s.output" class="max-h-48 overflow-auto border-t border-slate-800 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-slate-400">{{ s.output }}</pre>
          </details>
          <p v-if="result.error" class="rounded-lg border border-red-900/50 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            {{ result.error }} — fix the setting and try again.
          </p>
          <div v-if="result.done" class="rounded-xl border border-emerald-800/50 bg-emerald-950/30 p-4 text-sm text-emerald-200">
            <p class="flex items-center gap-2 font-medium">
              <v-icon name="fa-check-circle" /> {{ spec.name }} is live.
            </p>
            <p class="mt-1">Once DNS points here: <span class="font-mono text-white">{{ https ? 'https' : 'http' }}://{{ spec.domain.split(/\s+/)[0] }}</span></p>
          </div>
        </template>
      </div>

      <div class="flex items-center gap-2 border-t border-slate-800 px-5 py-3">
        <div class="flex-1" />
        <template v-if="!result">
          <button class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white" @click="emit('close')">
            Cancel
          </button>
          <button
            :disabled="!canSubmit"
            class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            @click="submit"
          >
            {{ editing ? 'Save & reload' : 'Create site' }}
          </button>
        </template>
        <button
          v-else-if="result.error && !submitting"
          class="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
          @click="submit"
        >
          Retry
        </button>
        <button
          v-else-if="result.done"
          class="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600"
          @click="emit('close')"
        >
          Done
        </button>
      </div>
    </div>
  </div>
</template>
