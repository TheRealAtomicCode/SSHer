// Tracks the part of an upload the browser's own XHR progress event can't see:
// once the file has fully reached this Node process, relaying it on to the
// remote server over SFTP (and, for Docker/.NET, what happens after that —
// docker load, unzip) can still take a long time with nothing to show for it.
// A route that does this calls start()/advance()/finish() around that work;
// the client polls GET /api/transfer-progress/:id to watch it.
const TRANSFER_TTL_MS = 5 * 60_000;

export interface TransferState {
  total: number;
  transferred: number;
  done: boolean;
  error: string;
}

const transfers = new Map<string, TransferState>();

export function startTransfer(id: string, total: number): void {
  transfers.set(id, { total, transferred: 0, done: false, error: '' });
  setTimeout(() => transfers.delete(id), TRANSFER_TTL_MS).unref();
}

export function advanceTransfer(id: string, transferred: number): void {
  const t = transfers.get(id);
  if (t) t.transferred = transferred;
}

export function finishTransfer(id: string, error = ''): void {
  const t = transfers.get(id);
  if (t) {
    t.done = true;
    t.error = error;
    if (!error) t.transferred = t.total;
  }
}

export function getTransfer(id: string): TransferState | undefined {
  return transfers.get(id);
}
