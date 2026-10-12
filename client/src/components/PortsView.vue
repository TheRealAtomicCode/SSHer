<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import * as api from '../api';
import { fail, notify } from '../toast';
import type { Exposure, Listener, PortsState, Session, UfwRule } from '../types';

const props = defineProps<{ session: Session }>();

const state = ref<PortsState | null>(null);
const loading = ref(false);
const working = ref('');
const showLocal = ref(false);
const ruleOpen = ref(false);

const rule = reactive({
  action: 'allow' as 'allow' | 'deny' | 'reject' | 'limit',
  port: '',
  proto: 'tcp' as 'tcp' | 'udp' | 'any',
  from: '',
  comment: '',
  exclusive: true,
});

async function refresh() {
  loading.value = true;
  try {
    state.value = await api.ports();
  } catch (err) {
    fail(err);
  } finally {
    loading.value = false;
  }
}

/** Runs a firewall change, then reloads so the table always shows the server's truth. */
async function act(label: string, fn: () => Promise<unknown>, success: string) {
  working.value = label;
  try {
    await fn();
    notify(success);
    await refresh();
  } catch (err) {
    fail(err);
  } finally {
    working.value = '';
  }
}

const EXPOSURE: Record<Exposure, { label: string; tone: string; icon: string; text: string }> = {
  open: {
    label: 'Public',
    tone: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    icon: 'fa-globe',
    text: 'Listening on all interfaces and allowed by the firewall — reachable from the internet.',
  },
  restricted: {
    label: 'Allow-listed',
    tone: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    icon: 'fa-shield-alt',
    text: 'Only the source addresses in its rules can reach it.',
  },
  docker: {
    label: 'Public (Docker)',
    tone: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    icon: 'fa-docker',
    text: 'Published by Docker on all interfaces. Docker bypasses ufw, so firewall rules do NOT block it — bind it to 127.0.0.1 instead.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    icon: 'fa-ban',
    text: 'A process listens publicly, but the firewall drops outside traffic.',
  },
  local: {
    label: 'Local only',
    tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    icon: 'fa-lock',
    text: 'Bound to loopback — only the server itself can connect.',
  },
};

const KNOWN: Record<number, string> = {
  22: 'SSH',
  53: 'DNS',
  80: 'HTTP',
  443: 'HTTPS',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  6379: 'Redis',
  27017: 'MongoDB',
  51820: 'WireGuard',
};

const listeners = computed(() =>
  (state.value?.listeners ?? []).filter((l) => showLocal.value || l.exposure !== 'local'),
);
const localCount = computed(() => (state.value?.listeners ?? []).filter((l) => l.exposure === 'local').length);

/** Databases and caches open to the world are the classic way servers get breached. */
const RISKY = new Set([3306, 5432, 6379, 27017, 9200, 11211]);
const warnings = computed(() =>
  (state.value?.listeners ?? []).filter(
    (l) => (l.exposure === 'open' || l.exposure === 'docker') && RISKY.has(l.port),
  ),
);

/** Firewall rules not tied to anything currently listening. */
const orphanRules = computed(() => {
  const s = state.value;
  if (!s) return [];
  const used = new Set(s.listeners.flatMap((l) => l.rules));
  return s.ufw.rules.filter((r) => !used.has(r.number));
});

const isSsh = (l: Listener) => l.port === props.session.port && l.proto === 'tcp';

/** Docker's default address pools — containers reach host services from here. */
const DOCKER_NETS = '172.16.0.0/12';

function closePort(l: Listener) {
  // Databases on the host are usually reached by containers via host.docker.internal,
  // and that traffic passes through ufw too. Closing the port outright takes the apps
  // down, so close it to the internet only and keep a rule for the Docker networks.
  if (RISKY.has(l.port) && l.proto === 'tcp') {
    if (
      !confirm(
        `Close ${KNOWN[l.port] ?? 'port'} ${l.port} to the internet?\n\n` +
          `Containers keep access (an allow rule for the Docker networks ${DOCKER_NETS} is added first), ` +
          'and any rules for specific IPs are kept. Only the "Anywhere" rules are removed.',
      )
    ) {
      return;
    }
    act(
      `close-${l.port}`,
      async () => {
        await api.addFirewallRule({
          action: 'allow',
          port: String(l.port),
          proto: 'tcp',
          from: DOCKER_NETS,
          comment: 'docker containers',
        });
        await api.closePort(l.port, 'tcp', false, true);
      },
      `${l.port} closed to the internet — Docker containers and allow-listed IPs keep access`,
    );
    return;
  }

  let force = false;
  if (isSsh(l)) {
    if (!confirm(`Port ${l.port} is the SSH port this app is connected through.\n\nClosing it can lock you out of the server for good. Are you absolutely sure?`)) return;
    force = true;
  } else if (!confirm(`Close ${l.port}/${l.proto}?\n\nRemoves every ufw ALLOW rule for it (IPv4 and IPv6). The program keeps running; outside traffic is dropped.`)) {
    return;
  }
  act(`close-${l.port}`, () => api.closePort(l.port, l.proto, force), `Closed ${l.port}/${l.proto}`);
}

function openPort(l: Listener) {
  act(
    `open-${l.port}`,
    () => api.addFirewallRule({ action: 'allow', port: String(l.port), proto: l.proto as 'tcp' | 'udp' }),
    `Opened ${l.port}/${l.proto} to everyone`,
  );
}

function restrictPort(l: Listener) {
  rule.action = 'allow';
  rule.port = String(l.port);
  rule.proto = l.proto as 'tcp' | 'udp';
  rule.from = '';
  rule.comment = '';
  rule.exclusive = true;
  ruleOpen.value = true;
}

function deleteRule(r: UfwRule) {
  const sshRule = r.ports.some((p) => Number(p.port) === props.session.port) && r.action !== 'DENY';
  const msg = sshRule
    ? `Rule ${r.number} allows SSH (${r.to}). Deleting it may lock you out if no other rule allows port ${props.session.port}. Continue?`
    : `Delete rule ${r.number}: ${r.raw}?`;
  if (!confirm(msg)) return;
  act(`rule-${r.number}`, () => api.deleteFirewallRule(r.number, r.raw), `Deleted rule ${r.number}`);
}

function submitRule() {
  if (!rule.port.trim()) return;
  const restrict =
    rule.action === 'allow' && rule.exclusive && rule.from.trim() && /^\d+$/.test(rule.port.trim());
  if (restrict && Number(rule.port) === props.session.port) {
    if (!confirm(`This makes SSH reachable ONLY from ${rule.from}. If your IP changes you are locked out. Continue?`)) return;
  }
  act(
    'rule',
    async () => {
      await api.addFirewallRule({
        action: rule.action,
        port: rule.port.trim(),
        proto: rule.proto,
        from: rule.from.trim() || undefined,
        comment: rule.comment.trim() || undefined,
      });
      // Added first, removed second: the port is never left with no way in.
      if (restrict) {
        await api.closePort(Number(rule.port), rule.proto === 'udp' ? 'udp' : 'tcp', true, true);
      }
    },
    `Rule added: ${rule.action} ${rule.port}${rule.from ? ` from ${rule.from}` : ''}`,
  ).then(() => (ruleOpen.value = false));
}

function toggleFirewall() {
  const on = !state.value?.ufw.active;
  const msg = on
    ? `Enable ufw?\n\nAn allow rule for SSH port ${props.session.port} is added first so you stay connected. Anything else without a rule becomes unreachable.`
    : 'Disable the firewall?\n\nEvery listening port becomes reachable from the internet.';
  if (!confirm(msg)) return;
  act('ufw', () => api.setFirewall(on), on ? 'Firewall enabled' : 'Firewall disabled');
}

onMounted(refresh);

const field =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-rose-500 focus:outline-none';
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto p-6">
    <div class="mx-auto max-w-6xl">
      <div class="mb-5 flex flex-wrap items-center gap-3">
        <v-icon name="fa-shield-alt" scale="1.3" class="text-rose-400" />
        <div class="flex-1">
          <h1 class="text-xl font-semibold text-white">Ports & Firewall</h1>
          <p class="text-sm text-slate-500">What is listening on {{ session.host }}, and who can reach it.</p>
        </div>
        <button
          class="rounded-md p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
          title="Refresh"
          @click="refresh"
        >
          <v-icon name="fa-sync-alt" scale="0.85" :class="loading && 'animate-spin'" />
        </button>
        <button
          :disabled="!state?.ufw.installed"
          class="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-40"
          @click="restrictPort({ port: 0, proto: 'tcp' } as Listener); rule.port = ''"
        >
          <v-icon name="fa-plus" scale="0.75" /> Add rule
        </button>
      </div>

      <div v-if="!state" class="py-20 text-center">
        <v-icon name="fa-spinner" scale="1.5" class="animate-spin text-rose-400" />
      </div>

      <template v-else>
        <!-- Firewall status -->
        <div class="mb-5 grid gap-3 md:grid-cols-3">
          <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4 md:col-span-2">
            <div class="flex items-center gap-3">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-lg ring-1"
                :class="state.ufw.active ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' : 'bg-rose-500/10 text-rose-300 ring-rose-500/30'"
              >
                <v-icon :name="state.ufw.active ? 'fa-shield-alt' : 'fa-unlock'" />
              </div>
              <div class="flex-1">
                <p class="font-medium text-white">
                  ufw firewall is
                  <span :class="state.ufw.active ? 'text-emerald-400' : 'text-rose-400'">
                    {{ !state.ufw.installed ? 'not installed' : state.ufw.active ? 'active' : 'inactive' }}
                  </span>
                </p>
                <p class="text-xs text-slate-500">
                  {{ state.ufw.installed ? state.ufw.defaults || 'No defaults reported' : 'Install with: apt install ufw' }}
                </p>
              </div>
              <button
                v-if="state.ufw.installed"
                :disabled="working === 'ufw'"
                class="rounded-lg border px-3 py-1.5 text-xs transition"
                :class="state.ufw.active ? 'border-slate-700 text-slate-300 hover:border-rose-600 hover:text-rose-300' : 'border-emerald-700 text-emerald-300 hover:bg-emerald-500/10'"
                @click="toggleFirewall"
              >
                {{ state.ufw.active ? 'Disable' : 'Enable' }}
              </button>
            </div>
          </div>
          <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-400">
            <p class="mb-1 font-medium text-slate-300">Remember</p>
            Docker-published ports skip ufw entirely. Bind containers to 127.0.0.1 and put nginx in front
            — that is how the DeviseHR containers are set up.
          </div>
        </div>

        <!-- Risk warnings -->
        <div
          v-for="w in warnings"
          :key="w.port"
          class="mb-3 flex items-start gap-3 rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200"
        >
          <v-icon name="fa-exclamation-triangle" class="mt-0.5 shrink-0 text-rose-400" />
          <div class="flex-1">
            <b>{{ KNOWN[w.port] ?? 'Port' }} {{ w.port }} is open to the internet.</b>
            Databases should not be public — anyone can try passwords against it. Close it, or allow only your
            own IP.
          </div>
          <button class="shrink-0 rounded-lg border border-rose-800 px-2.5 py-1 text-xs hover:bg-rose-900/50" @click="restrictPort(w)">
            Allow one IP
          </button>
          <button class="shrink-0 rounded-lg bg-rose-600 px-2.5 py-1 text-xs text-white hover:bg-rose-500" @click="closePort(w)">
            Close
          </button>
        </div>

        <!-- Listening ports -->
        <div class="mb-6 overflow-hidden rounded-xl border border-slate-800">
          <div class="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
            <h2 class="text-sm font-semibold text-white">Listening ports</h2>
            <label class="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
              <input v-model="showLocal" type="checkbox" class="accent-rose-500" />
              Show local-only ({{ localCount }})
            </label>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-slate-500">
                <tr>
                  <th class="px-4 py-2 font-medium">Port</th>
                  <th class="px-4 py-2 font-medium">Program</th>
                  <th class="px-4 py-2 font-medium">Bound to</th>
                  <th class="px-4 py-2 font-medium">Exposure</th>
                  <th class="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in listeners" :key="`${l.proto}/${l.port}`" class="border-t border-slate-800/70 hover:bg-slate-900/50">
                  <td class="px-4 py-2.5">
                    <span class="font-mono text-white">{{ l.port }}</span>
                    <span class="ml-1 text-xs text-slate-500">/{{ l.proto }}</span>
                    <p v-if="KNOWN[l.port]" class="text-[11px] text-slate-500">{{ KNOWN[l.port] }}</p>
                  </td>
                  <td class="px-4 py-2.5 text-xs">
                    <span class="text-slate-200">{{ l.processes.join(', ') || '—' }}</span>
                    <p v-if="l.containers.length" class="text-[11px] text-sky-400">
                      <v-icon name="fa-docker" scale="0.6" /> {{ l.containers.join(', ') }}
                    </p>
                  </td>
                  <td class="px-4 py-2.5 font-mono text-[11px] text-slate-400">{{ l.addresses.join('  ') }}</td>
                  <td class="px-4 py-2.5">
                    <span
                      class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ring-1"
                      :class="EXPOSURE[l.exposure].tone"
                      :title="EXPOSURE[l.exposure].text"
                    >
                      <v-icon :name="EXPOSURE[l.exposure].icon" scale="0.55" />
                      {{ EXPOSURE[l.exposure].label }}
                    </span>
                    <span v-if="isSsh(l)" class="ml-1.5 text-[10px] text-emerald-500">this session</span>
                  </td>
                  <td class="px-4 py-2.5 text-right whitespace-nowrap">
                    <v-icon v-if="working.endsWith(`-${l.port}`)" name="fa-spinner" scale="0.75" class="animate-spin text-rose-300" />
                    <template v-else-if="state.ufw.active && l.exposure !== 'local' && l.exposure !== 'docker'">
                      <button
                        v-if="l.exposure === 'blocked'"
                        class="rounded-md px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10"
                        @click="openPort(l)"
                      >
                        <v-icon name="fa-lock-open" scale="0.6" /> Open
                      </button>
                      <button class="rounded-md px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/10" @click="restrictPort(l)">
                        <v-icon name="fa-shield-alt" scale="0.6" /> Allow IP
                      </button>
                      <button
                        v-if="l.exposure !== 'blocked'"
                        class="rounded-md px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                        @click="closePort(l)"
                      >
                        <v-icon name="fa-ban" scale="0.6" /> Close
                      </button>
                    </template>
                    <span v-else-if="l.exposure === 'docker'" class="text-[11px] text-slate-500">change in Docker</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Rules -->
        <div v-if="state.ufw.active" class="overflow-hidden rounded-xl border border-slate-800">
          <div class="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
            <h2 class="text-sm font-semibold text-white">Firewall rules</h2>
            <span class="text-xs text-slate-500">{{ state.ufw.rules.length }} rules · applied top to bottom</span>
          </div>
          <table class="w-full text-sm">
            <tbody>
              <tr v-for="r in state.ufw.rules" :key="r.number" class="border-t border-slate-800/70 first:border-t-0 hover:bg-slate-900/50">
                <td class="w-12 px-4 py-2 text-right font-mono text-xs text-slate-600">{{ r.number }}</td>
                <td class="px-2 py-2">
                  <span
                    class="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    :class="r.action === 'ALLOW' ? 'bg-emerald-500/15 text-emerald-300' : r.action === 'LIMIT' ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300'"
                  >
                    {{ r.action }} {{ r.direction }}
                  </span>
                </td>
                <td class="px-2 py-2 font-mono text-xs text-slate-200">{{ r.to }}</td>
                <td class="px-2 py-2 text-xs text-slate-400">from {{ r.from }}</td>
                <td class="px-2 py-2">
                  <span v-if="orphanRules.includes(r)" class="text-[10px] text-slate-600" title="Nothing is listening on this port right now">
                    nothing listening
                  </span>
                </td>
                <td class="px-4 py-2 text-right">
                  <v-icon v-if="working === `rule-${r.number}`" name="fa-spinner" scale="0.7" class="animate-spin text-rose-300" />
                  <button v-else class="rounded p-1 text-slate-500 hover:bg-rose-950 hover:text-rose-400" title="Delete rule" @click="deleteRule(r)">
                    <v-icon name="fa-trash-alt" scale="0.65" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- Add rule dialog -->
    <div
      v-if="ruleOpen"
      data-modal
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      @click.self="ruleOpen = false"
    >
      <form class="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl" @submit.prevent="submitRule" @keydown.esc="ruleOpen = false">
        <h2 class="mb-4 flex items-center gap-2 font-semibold text-white">
          <v-icon name="fa-shield-alt" class="text-rose-400" /> Firewall rule
        </h2>
        <div class="space-y-4">
          <div class="grid grid-cols-4 gap-1 rounded-lg border border-slate-800 p-0.5 text-xs">
            <button
              v-for="a in (['allow', 'limit', 'deny', 'reject'] as const)"
              :key="a"
              type="button"
              class="rounded-md py-1.5 capitalize"
              :class="rule.action === a ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'"
              @click="rule.action = a"
            >
              {{ a }}
            </button>
          </div>
          <p class="-mt-2 text-[11px] text-slate-500">
            <template v-if="rule.action === 'limit'">Allow, but block an IP making 6+ connections in 30 s (good for SSH).</template>
            <template v-else-if="rule.action === 'reject'">Refuse with an error, instead of silently dropping.</template>
            <template v-else-if="rule.action === 'deny'">Silently drop traffic.</template>
            <template v-else>Let traffic in.</template>
          </p>
          <div class="grid grid-cols-[1fr_7rem] gap-3">
            <div>
              <label class="mb-1.5 block text-xs font-medium text-slate-400">Port or range</label>
              <input v-model="rule.port" required placeholder="8080  or  6000:6100" :class="[field, 'font-mono']" />
            </div>
            <div>
              <label class="mb-1.5 block text-xs font-medium text-slate-400">Protocol</label>
              <select v-model="rule.proto" :class="field">
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
                <option value="any">both</option>
              </select>
            </div>
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-400">
              Only from <span class="text-slate-600">(blank = anywhere)</span>
            </label>
            <input v-model="rule.from" placeholder="203.0.113.7  or  10.0.0.0/8" :class="[field, 'font-mono']" />
          </div>
          <div>
            <label class="mb-1.5 block text-xs font-medium text-slate-400">Comment <span class="text-slate-600">(optional)</span></label>
            <input v-model="rule.comment" placeholder="office VPN" :class="field" />
          </div>
          <label v-if="rule.action === 'allow' && rule.from" class="flex items-start gap-2 text-xs text-amber-200">
            <input v-model="rule.exclusive" type="checkbox" class="mt-0.5 accent-amber-500" />
            <span>
              Make this the only way in
              <span class="block text-[11px] text-slate-500">Removes the existing "Anywhere" allow rules for this port.</span>
            </span>
          </label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white" @click="ruleOpen = false">
            Cancel
          </button>
          <button type="submit" :disabled="working === 'rule'" class="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50">
            Add rule
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
