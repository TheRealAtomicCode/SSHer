<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

/** A calendar + time picker in local time. `min`/`max` (epoch ms) limit what can be
 *  picked; days outside them are greyed out and a typed time is clamped into range. */
const props = defineProps<{ modelValue: number | null; min?: number | null; max?: number | null }>();
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const start = () => props.modelValue ?? props.max ?? Date.now();
const view = ref(new Date(start()));
watch(open, (o) => o && (view.value = new Date(start())));

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const monthLabel = computed(() => view.value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));

/** Six rows of seven, Monday first, padded with the neighbouring months' days. */
const cells = computed(() => {
  const y = view.value.getFullYear();
  const m = view.value.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(y, m, 1 - offset + i);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = dayStart + 86_400_000 - 1;
    const disabled = (props.min != null && dayEnd < props.min) || (props.max != null && dayStart > props.max);
    return { date: d, inMonth: d.getMonth() === m, disabled, key: dayStart };
  });
});

const selectedDay = computed(() => {
  if (!props.modelValue) return null;
  const d = new Date(props.modelValue);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
});
const today = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
})();

const time = computed(() => {
  const d = new Date(props.modelValue ?? start());
  return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
});

function clamp(ms: number): number {
  if (props.min != null && ms < props.min) return props.min;
  if (props.max != null && ms > props.max) return props.max;
  return ms;
}

function set(date: Date, h = time.value.h, m = time.value.m, s = time.value.s) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, s);
  emit('update:modelValue', clamp(Math.floor(d.getTime() / 1000) * 1000));
}

function pickDay(cell: { date: Date; disabled: boolean }) {
  if (cell.disabled) return;
  set(cell.date);
}

function setPart(part: 'h' | 'm' | 's', raw: string) {
  const max = part === 'h' ? 23 : 59;
  const n = Math.min(max, Math.max(0, Math.round(Number(raw) || 0)));
  const t = { ...time.value, [part]: n };
  set(new Date(props.modelValue ?? start()), t.h, t.m, t.s);
}

function step(part: 'h' | 'm' | 's', delta: number) {
  const unit = part === 'h' ? 3_600_000 : part === 'm' ? 60_000 : 1000;
  emit('update:modelValue', clamp((props.modelValue ?? start()) + delta * unit));
}

function shiftMonth(delta: number) {
  view.value = new Date(view.value.getFullYear(), view.value.getMonth() + delta, 1);
}

const canPrev = computed(() => props.min == null || new Date(view.value.getFullYear(), view.value.getMonth(), 1).getTime() > props.min);
const canNext = computed(
  () => props.max == null || new Date(view.value.getFullYear(), view.value.getMonth() + 1, 1).getTime() <= props.max,
);

const label = computed(() =>
  props.modelValue
    ? new Date(props.modelValue).toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : 'Pick a date and time…',
);

function onOutside(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('mousedown', onOutside));
onUnmounted(() => document.removeEventListener('mousedown', onOutside));

const pad = (n: number) => String(n).padStart(2, '0');
const timeField = 'w-11 rounded-md border border-slate-700 bg-slate-950 py-1 text-center font-mono text-sm text-slate-100 focus:border-sky-500 focus:outline-none';
const arrow = 'rounded px-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-white';
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-sm transition hover:border-slate-500"
      :class="open && 'border-sky-500'"
      @click="open = !open"
    >
      <v-icon name="fa-calendar-alt" scale="0.8" class="text-slate-400" />
      <span class="flex-1" :class="modelValue ? 'text-slate-100' : 'text-slate-500'">{{ label }}</span>
      <v-icon name="fa-angle-down" scale="0.8" class="text-slate-500" />
    </button>

    <div v-if="open" class="absolute z-30 mt-1 w-[19rem] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl" @keydown.esc="open = false">
      <!-- Month -->
      <div class="mb-2 flex items-center">
        <button type="button" :disabled="!canPrev" class="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-20" @click="shiftMonth(-1)">
          <v-icon name="fa-chevron-left" scale="0.7" />
        </button>
        <p class="flex-1 text-center text-sm font-medium text-white">{{ monthLabel }}</p>
        <button type="button" :disabled="!canNext" class="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-20" @click="shiftMonth(1)">
          <v-icon name="fa-chevron-right" scale="0.7" />
        </button>
      </div>

      <!-- Days -->
      <div class="grid grid-cols-7 gap-0.5 text-center text-xs">
        <span v-for="d in DAYS" :key="d" class="py-1 text-[10px] text-slate-500">{{ d }}</span>
        <button
          v-for="c in cells"
          :key="c.key"
          type="button"
          :disabled="c.disabled"
          class="rounded-md py-1.5 tabular-nums transition disabled:cursor-not-allowed disabled:opacity-20"
          :class="[
            c.key === selectedDay ? 'bg-sky-600 font-semibold text-white' : c.inMonth ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-800',
            c.key === today && c.key !== selectedDay && 'ring-1 ring-sky-700',
          ]"
          @click="pickDay(c)"
        >
          {{ c.date.getDate() }}
        </button>
      </div>

      <!-- Time -->
      <div class="mt-3 flex items-center justify-center gap-1 border-t border-slate-800 pt-3">
        <template v-for="(part, i) in (['h', 'm', 's'] as const)" :key="part">
          <span v-if="i" class="text-slate-500">:</span>
          <div class="flex flex-col items-center">
            <button type="button" :class="arrow" @click="step(part, 1)">▲</button>
            <input
              :value="pad(time[part])"
              :class="timeField"
              inputmode="numeric"
              :aria-label="part === 'h' ? 'Hour' : part === 'm' ? 'Minute' : 'Second'"
              @change="setPart(part, ($event.target as HTMLInputElement).value)"
              @keydown.up.prevent="step(part, 1)"
              @keydown.down.prevent="step(part, -1)"
            />
            <button type="button" :class="arrow" @click="step(part, -1)">▼</button>
          </div>
        </template>
      </div>

      <div class="mt-3 flex items-center justify-between text-[11px]">
        <button type="button" class="text-sky-400 hover:text-sky-300" @click="emit('update:modelValue', clamp(Math.floor(Date.now() / 1000) * 1000))">
          Now
        </button>
        <span class="text-slate-600">your local time · ↑↓ to step</span>
        <button type="button" class="rounded-md bg-slate-700 px-2.5 py-1 text-white hover:bg-slate-600" @click="open = false">Done</button>
      </div>
    </div>
  </div>
</template>
