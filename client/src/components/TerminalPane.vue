<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as api from '../api';

const container = ref<HTMLElement | null>(null);
const closed = ref(false);

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObserver: ResizeObserver | null = null;
const encoder = new TextEncoder();

function connect() {
  closed.value = false;
  if (!container.value) return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: '#020617' },
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container.value);
  fitAddon.fit();

  const socket = new WebSocket(api.terminalUrl(term.cols, term.rows));
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => term?.focus();
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') return; // server only ever sends terminal output as binary
    term?.write(new Uint8Array(event.data as ArrayBuffer));
  };
  socket.onclose = () => {
    closed.value = true;
    term?.writeln('\r\n\x1b[2m— disconnected —\x1b[0m');
  };

  // xterm's onData gives a JS string; encode it so it goes out as a binary
  // frame, which is how the server tells real keystrokes apart from the one
  // other thing this socket carries, a JSON resize message sent as text.
  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
  });

  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !term) return;
    fitAddon.fit();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  });
  resizeObserver.observe(container.value);
}

function cleanup() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  ws?.close();
  ws = null;
  term?.dispose();
  term = null;
  fitAddon = null;
}

function reconnect() {
  cleanup();
  connect();
}

onMounted(connect);
onBeforeUnmount(cleanup);
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col bg-slate-950">
    <div ref="container" class="min-h-0 flex-1 overflow-hidden p-1" />
    <div v-if="closed" class="absolute inset-0 flex items-center justify-center bg-slate-950/85">
      <button
        class="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:border-emerald-500 hover:text-white"
        @click="reconnect"
      >
        <v-icon name="fa-redo" scale="0.8" /> Reconnect
      </button>
    </div>
  </div>
</template>
