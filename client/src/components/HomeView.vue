<script setup lang="ts">
import type { Session, Shortcut, View } from '../types';

defineProps<{ session: Session; shortcuts: Shortcut[] }>();
const emit = defineEmits<{ navigate: [View]; openShortcut: [Shortcut] }>();

const TILES: { view: View; title: string; text: string; icon: string; tone: string }[] = [
  {
    view: 'files',
    title: 'File Explorer',
    text: 'Browse, edit, upload and move files over SFTP.',
    icon: 'fa-folder-open',
    tone: 'from-amber-500/20 text-amber-300 ring-amber-500/30',
  },
  {
    view: 'links',
    title: 'Quick Links',
    text: 'nginx, Docker, firewall and PostgreSQL config files — plus start, stop and reload buttons.',
    icon: 'fa-link',
    tone: 'from-emerald-500/20 text-emerald-300 ring-emerald-500/30',
  },
  {
    view: 'docker',
    title: 'Docker',
    text: 'Containers, logs, compose configs, updates — and deploy a new image by drag & drop.',
    icon: 'fa-docker',
    tone: 'from-sky-500/20 text-sky-300 ring-sky-500/30',
  },
  {
    view: 'ports',
    title: 'Ports & Firewall',
    text: 'What is listening, what is exposed to the internet, and the ufw rules.',
    icon: 'fa-shield-alt',
    tone: 'from-rose-500/20 text-rose-300 ring-rose-500/30',
  },
];
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-5xl">
      <h1 class="text-xl font-semibold text-white">
        Connected to <span class="font-mono text-emerald-400">{{ session.host }}</span>
      </h1>
      <p class="text-sm text-slate-500">
        Logged in as {{ session.username }} · home {{ session.home }} · port {{ session.port }}
      </p>

      <div class="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="tile in TILES"
          :key="tile.view"
          class="group rounded-2xl border border-slate-800 bg-gradient-to-br to-slate-900/40 p-5 text-left transition hover:-translate-y-0.5 hover:border-slate-600"
          :class="tile.tone.split(' ')[0]"
          @click="emit('navigate', tile.view)"
        >
          <div
            class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-950/60 ring-1"
            :class="tile.tone.split(' ').slice(1)"
          >
            <v-icon :name="tile.icon" scale="1.4" />
          </div>
          <p class="flex items-center gap-2 font-semibold text-white">
            {{ tile.title }}
            <v-icon
              name="fa-arrow-right"
              scale="0.7"
              class="text-slate-500 transition group-hover:translate-x-1"
            />
          </p>
          <p class="mt-1 text-sm text-slate-400">{{ tile.text }}</p>
        </button>
      </div>

      <div class="mt-8">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <v-icon name="fa-star" scale="0.8" class="text-amber-300" /> Shortcuts
          </h2>
          <button class="text-xs text-slate-400 hover:text-white" @click="emit('navigate', 'shortcuts')">
            Manage →
          </button>
        </div>
        <p v-if="!shortcuts.length" class="text-sm text-slate-500">
          None yet. Right-click anything in the File Explorer → Add to shortcuts.
        </p>
        <div v-else class="flex flex-wrap gap-2">
          <button
            v-for="s in shortcuts"
            :key="s.id"
            :title="s.description || s.path"
            class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 transition hover:border-amber-400/40"
            @click="emit('openShortcut', s)"
          >
            <v-icon
              :name="s.isDirectory ? 'fa-folder' : 'fa-file-alt'"
              scale="0.75"
              :class="s.isDirectory ? 'text-amber-300' : 'text-sky-300'"
            />
            {{ s.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
