// Tracks uploads past the point the browser's own XHR progress event can see —
// once the file has fully reached this Node process, relaying it on to the remote
// server over SFTP (and, for Docker/.NET, what happens after that — docker load,
// unzip) can still take a long time. Each one is a job:
//   * the client polls GET /api/transfer-progress/:id to watch one it started;
//   * GET /api/transfers lists a session's jobs, so a page that was reloaded
//     mid-upload can show that the work is still going on server-side;
//   * POST /api/transfers/:id/cancel aborts one — the SFTP copy is cut and a
//     remote command started through runCancellable() is killed on the server.
import { open } from 'node:fs/promises';
import type { SshSession } from './ssh.js';

/** Kept this long after finishing, so a reloaded page still sees how it ended. */
const TRANSFER_TTL_MS = 5 * 60_000;
/** Backstop for a transfer whose route never called finish(). */
const TRANSFER_MAX_MS = 6 * 60 * 60_000;

export interface TransferState {
  total: number;
  transferred: number;
  done: boolean;
  error: string;
}

export type TransferStage = 'copying' | 'processing' | 'done' | 'error' | 'cancelled';

interface Job extends TransferState {
  id: string;
  sessionId: string;
  /** What the user would call it: "ssher-web.tar", "3 files → /var/www". */
  label: string;
  /** What runs after the copy, e.g. "docker load" — shown while processing. */
  processing: string;
  stage: TransferStage;
  startedAt: number;
  controller: AbortController;
}

export interface JobSummary {
  id: string;
  label: string;
  stage: TransferStage;
  processing: string;
  total: number;
  transferred: number;
  error: string;
  startedAt: number;
}

const jobs = new Map<string, Job>();

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Registers a job and returns the signal that fires if the user cancels it. */
export function startTransfer(
  id: string,
  total: number,
  opts: { sessionId: string; label: string; processing?: string },
): AbortSignal {
  const controller = new AbortController();
  jobs.set(id, {
    id,
    total,
    transferred: 0,
    done: false,
    error: '',
    sessionId: opts.sessionId,
    label: opts.label,
    processing: opts.processing ?? '',
    stage: 'copying',
    startedAt: Date.now(),
    controller,
  });
  // Not TTL-from-start: a copy longer than the TTL would vanish mid-way and read as unknown.
  setTimeout(() => jobs.delete(id), TRANSFER_MAX_MS).unref();
  return controller.signal;
}

export function advanceTransfer(id: string, transferred: number): void {
  const t = jobs.get(id);
  if (t) t.transferred = transferred;
}

/** The copy is over; what follows (docker load, unzip) is still part of the job. */
export function copyFinished(id: string): void {
  const t = jobs.get(id);
  if (!t || t.stage !== 'copying') return;
  t.transferred = t.total;
  // `done` here means "the copy is done" — what the per-upload progress poll has
  // always reported; the job as a whole stays listed until finishTransfer().
  t.done = true;
  if (t.processing) t.stage = 'processing';
}

export function finishTransfer(id: string, error = ''): void {
  const t = jobs.get(id);
  if (!t) return;
  t.done = true;
  if (t.controller.signal.aborted) {
    t.stage = 'cancelled';
    t.error = 'Cancelled';
  } else {
    t.stage = error ? 'error' : 'done';
    t.error = error;
    if (!error) t.transferred = t.total;
  }
  setTimeout(() => jobs.delete(id), TRANSFER_TTL_MS).unref();
}

export function getTransfer(id: string): TransferState | undefined {
  const t = jobs.get(id);
  return t && { total: t.total, transferred: t.transferred, done: t.done, error: t.error };
}

export function listTransfers(sessionId: string): JobSummary[] {
  return [...jobs.values()]
    .filter((t) => t.sessionId === sessionId)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t) => ({
      id: t.id,
      label: t.label,
      stage: t.stage,
      processing: t.processing,
      total: t.total,
      transferred: t.transferred,
      error: t.error,
      startedAt: t.startedAt,
    }));
}

/** Only the session that started a job may cancel it. */
export function cancelTransfer(id: string, sessionId: string): boolean {
  const t = jobs.get(id);
  if (!t || t.sessionId !== sessionId || t.stage === 'done' || t.stage === 'error' || t.stage === 'cancelled') return false;
  t.controller.abort();
  return true;
}

/** SFTP writes kept in flight at once. ssh2's createWriteStream sends one and waits
 *  for its ack before the next, so throughput was capped at chunk ÷ round-trip time
 *  (≈320 KB/s at 100 ms) no matter how fast the link is. 64 × 32 KB matches what
 *  ssh2's own fastPut uses, and fits the default SSH channel window. */
const UPLOAD_CONCURRENCY = 64;
const UPLOAD_CHUNK = 32 * 1024;

/** Copies a local file to the remote server over SFTP, reporting progress to job
 *  `id` and stopping (with the partial remote file left for the caller's cleanup)
 *  as soon as `signal` fires. `offset` is what earlier files of the same job sent. */
export async function sftpUpload(
  session: SshSession,
  localPath: string,
  remotePath: string,
  job: { id: string; signal: AbortSignal; offset?: number },
): Promise<number> {
  if (job.signal.aborted) throw new CancelledError();
  const { sftp } = session;
  const local = await open(localPath, 'r');
  let handle: Buffer | undefined;
  try {
    const size = (await local.stat()).size;
    handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.open(remotePath, 'w', (err, h) => (err ? reject(err) : resolve(h))),
    );
    const remote = handle;
    let sent = 0;
    await new Promise<void>((resolve, reject) => {
      let next = 0;
      let inFlight = 0;
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        job.signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const onAbort = () => settle(new CancelledError());
      job.signal.addEventListener('abort', onAbort, { once: true });
      const pump = () => {
        while (!settled && inFlight < UPLOAD_CONCURRENCY && next < size) {
          const position = next;
          const len = Math.min(UPLOAD_CHUNK, size - position);
          next += len;
          inFlight++;
          const buf = Buffer.allocUnsafe(len);
          local.read(buf, 0, len, position).then(({ bytesRead }) => {
            if (settled) return;
            if (bytesRead !== len) return settle(new Error(`${localPath} changed while it was being uploaded`));
            sftp.write(remote, buf, 0, len, position, (err) => {
              inFlight--;
              if (err) return settle(err);
              sent += len;
              advanceTransfer(job.id, (job.offset ?? 0) + sent);
              if (sent === size) settle();
              else pump();
            });
          }, settle);
        }
      };
      if (size === 0) settle();
      else pump();
    });
    return sent;
  } finally {
    await local.close().catch(() => {});
    if (handle) {
      const h = handle;
      await new Promise<void>((resolve) => sftp.close(h, () => resolve()));
    }
  }
}
