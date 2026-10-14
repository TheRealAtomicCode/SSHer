import * as api from './api';

/** Not crypto.randomUUID(): that's only available in a secure context (HTTPS
 *  or localhost), and this app is explicitly meant to also run plain HTTP on
 *  a LAN/VPN (see SSHER_ACCESS_KEY). This only needs to be unique per upload,
 *  not unguessable. */
export function newTransferId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Polls GET /api/transfer-progress/:id for the part of an upload the browser's
 *  own XHR progress event can't see — once the file has fully reached this
 *  server, relaying it on to the actual remote target (and, for Docker/.NET,
 *  what happens after that) can still take a long time with no feedback
 *  otherwise. Checks every 3s for the first 15s, then every 5s after that —
 *  frequent while a short upload is most likely to finish, cheaper once it's
 *  clearly a long one. Returns a stop function; polling also stops itself once
 *  the server reports `done`. */
export function watchTransfer(
  transferId: string,
  /** `pending`: the file hasn't reached SSHer's server yet — a proxy in between is still holding it. */
  onUpdate: (state: { total: number; transferred: number; done: boolean; error: string; pending?: boolean }) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();

  async function poll() {
    if (stopped) return;
    try {
      const state = await api.transferProgress(transferId);
      if (stopped) return;
      onUpdate(state);
      if (state.done) return;
    } catch {
      // Transient network hiccup — keep polling on the usual cadence rather
      // than giving up on one failed check.
    }
    const delay = Date.now() - startedAt < 15_000 ? 3000 : 5000;
    timer = setTimeout(poll, delay);
  }

  timer = setTimeout(poll, 3000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
