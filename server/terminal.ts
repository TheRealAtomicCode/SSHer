// Two real, independent login shells over the existing SSH connection — a
// WebSocket bridged to ssh2's conn.shell() (a PTY-allocating interactive
// channel), unlike every other route here, which runs one-shot conn.exec()
// calls and buffers the result. History and Tab completion aren't implemented
// anywhere in this file: they're bash's own readline, working exactly as they
// would over a plain `ssh user@host`, because that is essentially what this is.
//
// This is, by nature, the single most powerful thing in this app — exactly as
// capable as SSHing in by hand, with none of the rest of the app's command-by-
// command validation in the way (nor should there be; that's what a terminal
// is). It reuses the app's existing two gates rather than inventing a third:
// the session must already be a valid connected `sid`, and the access-key
// check applies the same as every HTTP route. The File Explorer's sudo-mode
// toggle is irrelevant here and is deliberately not wired in: in a real
// terminal, typing `sudo` yourself already does that.
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSession, openShell } from './ssh.js';

export function registerTerminal(httpServer: Server, checkAccess: (key: string) => boolean): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/api/terminal')) return;

    const sid = url.searchParams.get('sid') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const session = getSession(sid);
    if (!session || !checkAccess(key)) {
      socket.destroy();
      return;
    }

    const cols = Math.max(1, Number(url.searchParams.get('cols')) || 80);
    const rows = Math.max(1, Number(url.searchParams.get('rows')) || 24);

    wss.handleUpgrade(req, socket, head, (ws) => {
      bridge(ws, session, cols, rows);
    });
  });
}

async function bridge(ws: WebSocket, session: Parameters<typeof openShell>[0], cols: number, rows: number): Promise<void> {
  try {
    const stream = await openShell(session, { cols, rows });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // A terminal someone is actively typing in is activity — getSession()
      // only refreshes this on a new HTTP request, which a long-running shell
      // session may not make for a while, and the 30-minute idle sweep in
      // ssh.ts ends the whole SSH connection (killing the shell with it), not
      // just a stale request.
      session.lastUsed = Date.now();
      if (isBinary) {
        stream.write(data);
        return;
      }
      // The one non-terminal-data message this carries: a resize, sent as
      // text/JSON so it can never be mistaken for a keystroke.
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg?.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          stream.setWindow(msg.rows, msg.cols, 0, 0);
        }
      } catch {
        // Malformed control message — ignore rather than crash the pane over it.
      }
    });

    const relay = (chunk: Buffer) => {
      session.lastUsed = Date.now();
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    };
    stream.on('data', relay);
    stream.stderr.on('data', relay);

    stream.on('close', () => ws.close());
    ws.on('close', () => stream.end());
    ws.on('error', () => stream.end());
  } catch (err) {
    ws.close(1011, (err as Error).message.slice(0, 120));
  }
}
