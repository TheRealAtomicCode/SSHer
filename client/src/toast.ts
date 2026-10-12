import { reactive } from 'vue';
import type { Toast } from './types';

/** App-wide toasts, so every view can report without threading callbacks through props. */
export const toasts = reactive<Toast[]>([]);
export const sessionState = reactive({ lost: false });

let nextId = 0;

export function notify(message: string, kind: Toast['kind'] = 'ok'): void {
  const toast = { id: nextId++, kind, message };
  toasts.push(toast);
  setTimeout(() => {
    const index = toasts.findIndex((t) => t.id === toast.id);
    if (index >= 0) toasts.splice(index, 1);
  }, kind === 'error' ? 7000 : 4000);
}

export function fail(err: unknown): void {
  const message = (err as Error).message;
  notify(message, 'error');
  if (message.includes('Not connected')) sessionState.lost = true;
}
