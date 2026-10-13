// An SSH tunnel to the server's PostgreSQL, so a desktop client (pgAdmin, DBeaver,
// psql) can connect without a VPN and without port 5432 ever being opened to the
// internet. A plain TCP listener on THIS machine (the one running the SSHer back
// end); every connection it accepts is carried over the session's existing SSH
// connection (`forwardOut`) to the server's own loopback, where Postgres is
// listening anyway. `ssh -L 15432:127.0.0.1:5432 user@vps`, without a terminal.
//
// The listener binds to 127.0.0.1 only: anything else would publish the database
// to whatever network this machine is on, which is the exact thing the tunnel is
// there to avoid. It closes on "Stop", on disconnect, and when the SSH connection
// drops — it can never outlive the session it rides on.
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { Express, Response } from 'express';
import { badRequestRoute, port, type AsyncRoute, type SessionRequest } from './ops.js';
import { execAsPostgres } from './postgres.js';
import type { SshSession } from './ssh.js';

const BIND_HOST = '127.0.0.1';
const DEFAULT_LOCAL_PORT = 15432;

interface Tunnel {
  server: Server;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  startedAt: number;
  sockets: Set<Socket>;
  /** Connections accepted since the tunnel opened, live or finished. */
  total: number;
  lastError: string;
  /** Undoes the SSH connection's close hook, so enabling/disabling repeatedly
   *  doesn't pile up listeners on it. */
  detach: () => void;
}

/** One tunnel per SSH session, keyed by session id. */
const tunnels = new Map<string, Tunnel>();

/** The back end inside a container listens on the container's loopback, which the
 *  machine's pgAdmin can't reach — worth saying up front rather than letting the
 *  tunnel "work" and every connection to it fail. */
const inContainer = existsSync('/.dockerenv');

/** `ssh` is what pgAdmin's own SSH Tunnel tab asks for — the same login this
 *  session used — for when pgAdmin does the tunnelling itself instead. */
function describe(session: SshSession, tunnel: Tunnel | undefined, postgresPort: number) {
  return {
    inContainer,
    ssh: { host: session.host, port: session.port, username: session.username },
    postgresPort,
    bindHost: BIND_HOST,
    defaultLocalPort: DEFAULT_LOCAL_PORT,
    tunnel: tunnel
      ? {
          localPort: tunnel.localPort,
          remoteHost: tunnel.remoteHost,
          remotePort: tunnel.remotePort,
          startedAt: tunnel.startedAt,
          active: tunnel.sockets.size,
          total: tunnel.total,
          lastError: tunnel.lastError,
        }
      : null,
  };
}

export function stopPgTunnel(sessionId: string): void {
  const tunnel = tunnels.get(sessionId);
  if (!tunnel) return;
  tunnels.delete(sessionId);
  tunnel.detach();
  for (const socket of tunnel.sockets) socket.destroy();
  tunnel.server.close();
}

/** The port Postgres is configured on — not always 5432 (a second cluster on a
 *  Debian box is 5433). Falls back to the default if psql can't be asked. */
async function postgresPort(session: SshSession): Promise<number> {
  const result = await execAsPostgres(session, 'psql -X -At -q -c "SHOW port" 2>/dev/null').catch(() => null);
  const port = Number(result?.stdout.trim());
  return Number.isInteger(port) && port > 0 ? port : 5432;
}

function startPgTunnel(session: SshSession, localPort: number, remotePort: number): Promise<Tunnel> {
  const tunnel: Tunnel = {
    server: createServer(),
    localPort,
    remoteHost: '127.0.0.1',
    remotePort,
    startedAt: Date.now(),
    sockets: new Set(),
    total: 0,
    lastError: '',
    detach: () => {},
  };

  tunnel.server.on('connection', (socket) => {
    tunnel.sockets.add(socket);
    tunnel.total++;
    // A database client in use is activity: without this, the idle sweep would end
    // the SSH session (and the tunnel with it) under a pgAdmin that is mid-query.
    session.lastUsed = Date.now();
    socket.on('data', () => (session.lastUsed = Date.now()));
    socket.on('close', () => tunnel.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.pause();

    session.conn.forwardOut(socket.remoteAddress ?? BIND_HOST, socket.remotePort ?? 0, tunnel.remoteHost, tunnel.remotePort, (err, channel) => {
      if (err) {
        tunnel.lastError = `The server refused the forward to ${tunnel.remoteHost}:${tunnel.remotePort}: ${err.message}`;
        socket.destroy();
        return;
      }
      tunnel.lastError = '';
      channel.on('error', () => socket.destroy());
      channel.on('close', () => socket.destroy());
      socket.on('close', () => channel.close());
      socket.pipe(channel).pipe(socket);
      socket.resume();
    });
  });

  return new Promise((resolve, reject) => {
    tunnel.server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${localPort} is already in use on this machine — pick another (a local PostgreSQL is usually on 5432).`
            : err.message,
        ),
      );
    });
    tunnel.server.listen(localPort, BIND_HOST, () => {
      tunnels.set(session.id, tunnel);
      // The SSH connection is what carries every byte; once it's gone the
      // listener would only accept connections it can't serve.
      const close = () => stopPgTunnel(session.id);
      session.conn.once('close', close);
      session.conn.once('end', close);
      tunnel.detach = () => {
        session.conn.off('close', close);
        session.conn.off('end', close);
      };
      resolve(tunnel);
    });
  });
}

export function registerPgTunnel(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/postgres/tunnel',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const tunnel = tunnels.get(session.id);
      res.json(describe(session, tunnel, tunnel?.remotePort ?? (await postgresPort(session))));
    }),
  );

  app.post(
    '/api/postgres/tunnel/start',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      stopPgTunnel(session.id);
      const localPort = port(req.body?.localPort ?? DEFAULT_LOCAL_PORT, 'Local port');
      const remotePort = req.body?.remotePort ? port(req.body.remotePort, 'PostgreSQL port') : await postgresPort(session);
      const tunnel = await startPgTunnel(session, localPort, remotePort);
      res.json(describe(session, tunnel, remotePort));
    }),
  );

  app.post(
    '/api/postgres/tunnel/stop',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      stopPgTunnel(session.id);
      res.json(describe(session, undefined, await postgresPort(session)));
    }),
  );
}
