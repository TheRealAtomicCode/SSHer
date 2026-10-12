<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import * as api from '../api';
import { ApiError } from '../api';
import type { NginxSite, NginxSiteSpec, StepResult } from '../types';

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
  overwrite: false,
});

const submitting = ref(false);
const result = ref<{ log: StepResult[]; error: string; done: boolean } | null>(null);
const showRaw = ref(false);

const nameOk = computed(() => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(spec.name));
const domainOk = computed(() => spec.domain.trim().split(/\s+/).every((d) => /^(?=.{1,253}$)(\*\.)?([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/.test(d)));
const targetOk = computed(() => /^[A-Za-z0-9][A-Za-z0-9.-]*:\d{1,5}$/.test(spec.target));
const canSubmit = computed(() => nameOk.value && domainOk.value && targetOk.value && !submitting.value);

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  result.value = { log: [], error: '', done: false };
  try {
    const res = await api.nginxAddSite(spec);
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
        <h2 class="flex-1 text-base font-semibold text-white">Add an nginx site</h2>
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
            <input v-model="spec.name" :class="[field, 'font-mono']" placeholder="myapp" />
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
            </div>
          </div>
          <label class="flex items-center gap-2 text-xs text-amber-300">
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
            <p class="mt-1">Once DNS points here: <span class="font-mono text-white">http://{{ spec.domain.split(/\s+/)[0] }}</span></p>
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
            Create site
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
