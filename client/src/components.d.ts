import type { OhVueIcon } from 'oh-vue-icons';

// `v-icon` is registered globally in main.ts; teach vue-tsc about it.
declare module 'vue' {
  export interface GlobalComponents {
    VIcon: typeof OhVueIcon;
    'v-icon': typeof OhVueIcon;
  }
}

export {};
