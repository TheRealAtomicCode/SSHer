import { randomUUID } from 'node:crypto';
import { Client } from 'ssh2';
import type { ClientChannel, FileEntry, SFTPWrapper, Stats } from 'ssh2';

export interface SshSession {
  id: string;
  host: string;
  port: number;
  username: string;
  home: string;
  conn: Client;
  sftp: SFTPWrapper;
  lastUsed: number;
}

export interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const sessions = new Map<string, SshSession>();

/** Wraps a value in single quotes for safe use as a single POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function connect(opts: ConnectOptions): Promise<SshSession> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err);
    };

    conn.on('error', fail);
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        sftp.realpath('.', (rpErr, home) => {
          if (settled) return;
          settled = true;
          const session: SshSession = {
            id: randomUUID(),
            host: opts.host,
            port: opts.port ?? 22,
            username: opts.username,
            home: rpErr ? '/' : home,
            conn,
            sftp,
            lastUsed: Date.now(),
          };
          sessions.set(session.id, session);
          conn.on('close', () => sessions.delete(session.id));
          conn.on('end', () => sessions.delete(session.id));
          resolve(session);
        });
      });
    });

    conn.connect({
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      password: opts.password || undefined,
      privateKey: opts.privateKey || undefined,
      passphrase: opts.passphrase || undefined,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
    });
  });
}

export function getSession(id: string | undefined): SshSession | undefined {
  if (!id) return undefined;
  const session = sessions.get(id);
  if (session) session.lastUsed = Date.now();
  return session;
}

export function disconnect(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.conn.end();
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(session: SshSession, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
  });
}

/** Runs a command with `input` piped to its stdin — used to write root-owned files via `tee`. */
export function execWithInput(
  session: SshSession,
  command: string,
  input: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        resolve({ code: code ?? 0, stdout, stderr });
      });
      stream.end(input);
    });
  });
}

/** Hands back the raw channel for `command` instead of buffering it, so its stdout can
 *  be `.pipe()`d straight to an HTTP response — used to stream an on-the-fly zip without
 *  ever writing it to disk, the same way `/api/download` pipes an SFTP read stream. */
export function execChannel(session: SshSession, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/** Runs a command and rejects with the remote stderr when it exits non-zero. */
export async function execOrThrow(session: SshSession, command: string): Promise<string> {
  const result = await exec(session, command);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `command failed with exit code ${result.code}`);
  }
  return result.stdout;
}

export function readdir(session: SshSession, path: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    session.sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

export function stat(session: SshSession, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    session.sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

export function realpath(session: SshSession, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    session.sftp.realpath(path, (err, resolved) => (err ? reject(err) : resolve(resolved)));
  });
}

export function rename(session: SshSession, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    session.sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}

const idleSweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const session of sessions.values()) {
    if (session.lastUsed < cutoff) disconnect(session.id);
  }
}, 60_000);
idleSweep.unref();
