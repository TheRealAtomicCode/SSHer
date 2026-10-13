<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { SERIES_COLORS } from '../chartColors';


const props = withDefaults(
  defineProps<{
    series: { name: string; values: (number | null)[]; color?: string }[];
    /** Epoch ms for each value index. */
    times: number[];
    format: (v: number) => string;
    /** Fixed top of the scale (e.g. 100 for percentages); otherwise fits the data. */
    max?: number;
    height?: number;
  }>(),
  { height: 130, max: undefined },
);

const box = ref<HTMLElement | null>(null);
const width = ref(600);
const hover = ref<number | null>(null);
let observer: ResizeObserver | undefined;

onMounted(() => {
  if (!box.value) return;
  observer = new ResizeObserver(([entry]) => (width.value = Math.max(200, entry.contentRect.width)));
  observer.observe(box.value);
});
onUnmounted(() => observer?.disconnect());

const PAD = { top: 8, right: 8, bottom: 18, left: 52 };
const plotW = computed(() => width.value - PAD.left - PAD.right);
const plotH = computed(() => props.height - PAD.top - PAD.bottom);
const count = computed(() => props.times.length);

/** Round the top of the scale up to a tidy number so gridline labels read cleanly. */
const top = computed(() => {
  if (props.max !== undefined) return props.max;
  const peak = Math.max(0, ...props.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  if (peak <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(peak));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= peak) ?? 10;
  return step * mag;
});

const x = (i: number) => PAD.left + (count.value <= 1 ? plotW.value : (i / (count.value - 1)) * plotW.value);
const y = (v: number) => PAD.top + plotH.value - (Math.min(v, top.value) / top.value) * plotH.value;

const colorOf = (i: number) => props.series[i].color ?? SERIES_COLORS[i % SERIES_COLORS.length];

/** Gaps (null) break the line rather than dropping to zero. */
const paths = computed(() =>
  props.series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }),
);

/** A faint area under a single series; two overlapping areas would muddy each other. */
const area = computed(() => {
  if (props.series.length !== 1) return '';
  const pts = props.series[0].values.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean) as number[][];
  if (pts.length < 2) return '';
  const base = PAD.top + plotH.value;
  return `M${pts[0][0]},${base}L${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}L${pts.at(-1)![0]},${base}Z`;
});

const grid = computed(() => [0, 0.5, 1].map((f) => ({ y: y(top.value * f), label: props.format(top.value * f) })));

function onMove(e: MouseEvent) {
  if (!box.value || count.value === 0) return;
  const rect = box.value.getBoundingClientRect();
  const px = e.clientX - rect.left - PAD.left;
  hover.value = Math.max(0, Math.min(count.value - 1, Math.round((px / plotW.value) * (count.value - 1))));
}

const tip = computed(() => {
  if (hover.value === null) return null;
  const i = hover.value;
  const left = x(i);
  return {
    left: Math.min(left + 10, width.value - 170),
    time: new Date(props.times[i]).toLocaleTimeString(),
    rows: props.series.map((s, si) => ({ name: s.name, color: colorOf(si), value: s.values[i] })),
  };
});

const latest = computed(() => props.series.map((s) => [...s.values].reverse().find((v) => v !== null) ?? null));
const spanSeconds = computed(() => (count.value > 1 ? Math.round((props.times.at(-1)! - props.times[0]) / 1000) : 0));
</script>

<template>
  <div>
    <!-- Legend (always, for 2+ series), doubling as the direct label for the latest value. -->
    <div v-if="series.length > 1" class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
      <span v-for="(s, i) in series" :key="s.name" class="flex items-center gap-1.5 text-slate-400">
        <span class="h-0.5 w-3 rounded" :style="{ background: colorOf(i) }" />
        {{ s.name }}
        <span class="font-medium text-slate-200 tabular-nums">{{ latest[i] === null ? '—' : format(latest[i]!) }}</span>
      </span>
    </div>

    <div ref="box" class="relative" :style="{ height: `${height}px` }" @mousemove="onMove" @mouseleave="hover = null">
      <svg :width="width" :height="height" class="block">
        <g>
          <line
            v-for="g in grid"
            :key="g.y"
            :x1="PAD.left"
            :x2="width - PAD.right"
            :y1="g.y"
            :y2="g.y"
            stroke="#1e293b"
            stroke-width="1"
          />
          <text v-for="g in grid" :key="`t${g.y}`" :x="PAD.left - 6" :y="g.y + 3" text-anchor="end" font-size="10" fill="#64748b">
            {{ g.label }}
          </text>
          <text :x="PAD.left" :y="height - 4" font-size="10" fill="#475569">−{{ spanSeconds }}s</text>
          <text :x="width - PAD.right" :y="height - 4" text-anchor="end" font-size="10" fill="#475569">now</text>
        </g>
        <path v-if="area" :d="area" :fill="colorOf(0)" fill-opacity="0.12" />
        <path
          v-for="(d, i) in paths"
          :key="series[i].name"
          :d="d"
          fill="none"
          :stroke="colorOf(i)"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <g v-if="hover !== null">
          <line :x1="x(hover)" :x2="x(hover)" :y1="PAD.top" :y2="PAD.top + plotH" stroke="#475569" stroke-width="1" />
          <template v-for="(s, i) in series" :key="`m${s.name}`">
            <circle
              v-if="s.values[hover] !== null"
              :cx="x(hover)"
              :cy="y(s.values[hover]!)"
              r="4"
              :fill="colorOf(i)"
              stroke="#0f172a"
              stroke-width="2"
            />
          </template>
        </g>
      </svg>

      <div
        v-if="tip"
        class="pointer-events-none absolute top-1 z-10 w-40 rounded-md border border-slate-700 bg-slate-900/95 px-2 py-1.5 text-[11px] shadow-lg"
        :style="{ left: `${tip.left}px` }"
      >
        <p class="mb-0.5 text-slate-500">{{ tip.time }}</p>
        <p v-for="r in tip.rows" :key="r.name" class="flex items-center gap-1.5">
          <span class="h-2 w-2 rounded-full" :style="{ background: r.color }" />
          <span class="flex-1 text-slate-400">{{ r.name }}</span>
          <span class="font-medium text-slate-100 tabular-nums">{{ r.value === null ? '—' : format(r.value) }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
