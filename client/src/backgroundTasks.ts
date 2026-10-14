// Uploads (and what runs after them: docker load, unzip) as one list the whole app
// shares — what the background-tasks tray shows. A task starts in this tab while the
// browser is still sending the file; once SSHer's server has it, the server's job
// list (GET /api/transfers) is the source of truth. That list is what makes a task
// survive a page reload: the browser upload dies with the page, but anything already
// past it keeps running server-side and shows up again here. Cancelling aborts
// whichever part is live — the browser upload, the SFTP copy, or the remote command.
import { computed, reactive } from 'vue';
import * as api from './api';

export type TaskStage = 'uploading' | 'waiting' | 'copying' | 'processing' | 'done' | 'error' | 'cancelled';

export interface Task {
  id: string;
  label: string;
  stage: TaskStage;
  /** What runs after the copy ("docker load"), if anything. */
  processing: string;
  /** Of the current stage; null when there's nothing to measure (processing). */
  percent: number | null;
  error: string;
  startedAt: number;
}

const ACTIVE: TaskStage[] = ['uploading', 'waiting', 'copying', 'processing'];
const DONE_VISIBLE_MS = 10_000;
const DISMISSED_KEY = 'ssher.dismissedTasks';

const state = reactive({ tasks: [] as Task[] });
/** The browser-side upload of each task this tab started, to abort it. */
const controllers = new Map<string, AbortController>();
let timer: ReturnType<typeof setTimeout> | undefined;

export const tasks = computed(() => state.tasks);
export const activeCount = computed(() => state.tasks.filter((t) => ACTIVE.includes(t.stage)).length);

export const isActive = (t: Task) => ACTIVE.includes(t.stage);

function dismissedIds(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function find(id: string): Task | undefined {
  return state.tasks.find((t) => t.id === id);
}

function finished(task: Task, stage: TaskStage, error = '') {
  if (!isActive(task)) return;
  task.stage = stage;
  task.error = error;
  task.percent = stage === 'done' ? 100 : task.percent;
  if (stage === 'done') setTimeout(() => dismiss(task.id), DONE_VISIBLE_MS);
}

export function dismiss(id: string) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedIds(), id].slice(-50)));
  } catch {
    /* only means it can reappear after a reload */
  }
}

export function isCancelled(err: unknown): boolean {
  return (err as Error)?.message === 'Cancelled';
}

/** Registers an upload this tab is starting. Pass `signal` to the upload call, feed
 *  it the browser's progress, and call `settle` when the call resolves or fails. */
export function trackUpload(id: string, label: string, processing = '') {
  const controller = new AbortController();
  controllers.set(id, controller);
  state.tasks.push({ id, label, stage: 'uploading', processing, percent: 0, error: '', startedAt: Date.now() });
  schedulePoll(1000);
  return {
    signal: controller.signal,
    progress(percent: number) {
      const task = find(id);
      if (task?.stage !== 'uploading') return;
      task.percent = percent;
      // Handed over — but a proxy may still be holding it before SSHer sees it.
      if (percent >= 100) Object.assign(task, { stage: 'waiting', percent: null });
    },
    settle(err?: unknown) {
      controllers.delete(id);
      const task = find(id);
      if (!task) return;
      if (!err) finished(task, 'done');
      else finished(task, isCancelled(err) ? 'cancelled' : 'error', isCancelled(err) ? '' : (err as Error).message);
    },
  };
}

export async function cancel(id: string) {
  controllers.get(id)?.abort();
  await api.cancelTransfer(id).catch(() => {});
  const task = find(id);
  if (task) finished(task, 'cancelled');
}

/** One poll of the server's job list, merged in. */
export async function refreshTasks() {
  let jobs: Awaited<ReturnType<typeof api.listTransfers>>['transfers'];
  try {
    jobs = (await api.listTransfers()).transfers;
  } catch {
    return; // not connected, or a blip — the next poll will tell
  }
  const dismissed = new Set(dismissedIds());
  for (const job of jobs) {
    if (dismissed.has(job.id)) continue;
    let task = find(job.id);
    // Cancelled here: the server may take a moment to stop, but the user is done with it.
    if (task?.stage === 'cancelled') continue;
    if (!task) {
      task = { id: job.id, label: job.label, stage: 'copying', processing: job.processing, percent: 0, error: '', startedAt: job.startedAt };
      state.tasks.push(task);
    }
    if (job.stage === 'copying' || job.stage === 'processing') {
      task.stage = job.stage;
      task.percent = job.stage === 'copying' && job.total ? Math.round((job.transferred / job.total) * 100) : null;
    } else if (isActive(task) && !controllers.has(job.id)) {
      // Ended while nobody in this tab was waiting on it (e.g. after a reload).
      finished(task, job.stage, job.error);
    }
  }
}

function schedulePoll(delay = 2000) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await refreshTasks();
    if (state.tasks.some(isActive)) schedulePoll();
  }, delay);
}

/** Call once a session exists (app start, after login) to pick up running jobs. */
export async function resumeTasks() {
  await refreshTasks();
  if (state.tasks.some(isActive)) schedulePoll();
}
