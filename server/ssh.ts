import { randomUUID } from 'node:crypto';
import { Client } from 'ssh2';
import type { ClientChannel, FileEntry, SFTPWrapper, Stats } from 'ssh2';

export interface CommandLogEntry {
  id: number;
  /** Epoch ms. */
  time: number;
  command: string;
  /** `null` means it never got an exit code — the exec request itself failed. */
  code: number | null;
  durationMs: number;
}

export interface SshSession {
  id: string;
  host: string;
  port: number;
  username: string;
  home: string;
  conn: Client;
  sftp: SFTPWrapper;
  lastUsed: number;
  /** Every shell command run for this session, oldest first, capped at
   *  COMMAND_LOG_LIMIT — what the "activity" panel shows. Command text only,
   *  never output: a command that writes a password (chpasswd, `ALTER ROLE …
   *  PASSWORD`) always pipes it over stdin rather than putting it on the command
   *  line, specifically so this log can never end up holding one. */
  commandLog: CommandLogEntry[];
  /** The password `sudo` accepted for this login, held in memory for the life of the
   *  session only. Fed to `sudo -S` over stdin, never put on a command line, so it
   *  can't reach the command log or the remote process list. */
  sudoPassword?: string;
  /** What we learned about sudo when the session opened (see probeSudo). */
  sudo: SudoState;
}

export type SudoState =
  | 'root' // logged in as root: nothing to escalate
  | 'nopasswd' // sudo works without a password
  | 'ok' // a password is stored and sudo accepted it
  | 'needed' // sudo wants a password we don't have (or the one we had was wrong)
  | 'denied' // this user may not use sudo at all
  | 'missing'; // sudo isn't installed

/** `sudo` reading its password from stdin with no prompt text. exec() spots this
 *  prefix and pipes the stored password in. */
export const SUDO_STDIN = "sudo -S -p ''";

/** The `sudo …` to put in front of a command, e.g. sudoPrefix(s, '-H -u postgres'). */
export function sudoPrefix(session: SshSession, args = ''): string {
  const base = session.sudoPassword ? SUDO_STDIN : 'sudo -n';
  return args ? `${base} ${args}` : base;
}

/** One password line per `sudo -S` in the command. A sudo that finds a still-valid
 *  timestamp doesn't read its line, which is harmless for the commands we run. */
function sudoStdin(session: SshSession, command: string): string {
  if (!session.sudoPassword) return '';
  const count = command.split(SUDO_STDIN).length - 1;
  return `${session.sudoPassword}\n`.repeat(count);
}

export interface ConnectOptions {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** 6-digit authenticator code, for servers with SSH two-factor (PAM google-authenticator). */
  otp?: string;
}

/** Thrown when the server asked for a verification code and none was supplied. */
export class OtpRequiredError extends Error {
  constructor() {
    super('This server asks for a verification code (two-factor login).');
  }
}

/** How servers word the second-factor prompt (google-authenticator, Duo, oathtool…). */
const OTP_PROMPT = /verification code|one[- ]time|otp|token|authenticator|2fa|two[- ]factor/i;

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_LOG_LIMIT = 300;
const sessions = new Map<string, SshSession>();
let nextCommandLogId = 0;

function recordCommand(session: SshSession, command: string, code: number | null, durationMs: number): void {
  session.commandLog.push({ id: nextCommandLogId++, time: Date.now(), command, code, durationMs });
  if (session.commandLog.length > COMMAND_LOG_LIMIT) session.commandLog.shift();
}

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

    let otpAsked = false;
    conn.on('error', (err) => fail(otpAsked && !opts.otp ? new OtpRequiredError() : err));
    // A server can also just hang up mid-login (sshd "fatal: Access denied … [preauth]")
    // without an error event; without this the login would wait forever.
    conn.on('close', () =>
      fail(otpAsked && !opts.otp ? new OtpRequiredError() : new Error('The server closed the connection during login (login refused)')),
    );
    // With two-factor on, sshd asks through keyboard-interactive: "Password:" then
    // "Verification code:". Answer each prompt with the right one.
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      // No code to give: hang up rather than send a blank one, which would count as a
      // failed attempt against the user's 2FA rate limit and be logged as a failure.
      if (!opts.otp && prompts.some((p) => OTP_PROMPT.test(p.prompt))) {
        otpAsked = true;
        conn.end();
        return;
      }
      finish(
        prompts.map((p) => {
          if (OTP_PROMPT.test(p.prompt)) {
            otpAsked = true;
            return opts.otp ?? '';
          }
          return opts.password ?? '';
        }),
      );
    });
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
            commandLog: [],
            sudo: opts.username === 'root' ? 'root' : 'needed',
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
      // Lets servers with two-factor ask for the code (see the keyboard-interactive handler).
      tryKeyboard: true,
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

/** `quiet` keeps a command out of the activity log — for monitoring polls, which would
 *  otherwise flood it with the same command every second. */
export function exec(session: SshSession, command: string, quiet = false): Promise<ExecResult> {
  // A `sudo -S` command needs its password on stdin; route it through the input path.
  const password = sudoStdin(session, command);
  if (password) return execWithInput(session, command, '', quiet);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => {
      if (err) {
        if (!quiet) recordCommand(session, command, null, Date.now() - started);
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        if (!quiet) recordCommand(session, command, code ?? 0, Date.now() - started);
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
  quiet = false,
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => {
      if (err) {
        if (!quiet) recordCommand(session, command, null, Date.now() - started);
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        if (!quiet) recordCommand(session, command, code ?? 0, Date.now() - started);
        resolve({ code: code ?? 0, stdout, stderr });
      });
      // sudo -S consumes its password line first; the command gets the rest.
      stream.end(sudoStdin(session, command) + input);
    });
  });
}

/** Asks sudo, without using any cached timestamp (-k), whether `password` works. */
export async function checkSudoPassword(
  session: SshSession,
  password: string,
): Promise<'ok' | 'wrong' | 'denied'> {
  // Deliberately not execWithInput's sudo handling: this tests a candidate, not the stored one.
  const result = await new Promise<ExecResult>((resolve, reject) => {
    session.conn.exec(`${SUDO_STDIN} -k true`, (err, stream) => {
      if (err) return reject(err);
      let stderr = '';
      stream.on('data', () => {});
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => resolve({ code: code ?? 0, stdout: '', stderr }));
      stream.end(`${password}\n`);
    });
  });
  if (result.code === 0) return 'ok';
  if (/not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(result.stderr)) return 'denied';
  return 'wrong';
}

/** Works out how this login gets root, trying each candidate password in turn. */
export async function probeSudo(session: SshSession, candidates: (string | undefined)[]): Promise<SudoState> {
  if (session.username === 'root') return 'root';
  const installed = await exec(session, 'command -v sudo >/dev/null 2>&1 && echo yes');
  if (installed.stdout.trim() !== 'yes') return 'missing';
  const nopasswd = await exec(session, 'sudo -n true 2>&1');
  if (nopasswd.code === 0) return 'nopasswd';
  if (/not in the sudoers|may not run sudo/i.test(nopasswd.stdout)) return 'denied';

  for (const candidate of [...new Set(candidates.filter((c): c is string => Boolean(c)))]) {
    const verdict = await checkSudoPassword(session, candidate);
    if (verdict === 'ok') {
      session.sudoPassword = candidate;
      return 'ok';
    }
    if (verdict === 'denied') return 'denied';
  }
  return 'needed';
}

/** Hands back the raw channel for `command` instead of buffering it, so its stdout can
 *  be `.pipe()`d straight to an HTTP response — used to stream an on-the-fly zip without
 *  ever writing it to disk, the same way `/api/download` pipes an SFTP read stream.
 *  Logged at kick-off, not completion — the caller owns the channel from here, so the
 *  final exit code isn't available where this function could still record it. */
export function execChannel(session: SshSession, command: string): Promise<ClientChannel> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    session.conn.exec(command, (err, stream) => {
      recordCommand(session, command, null, Date.now() - started);
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

/** A real PTY-backed interactive shell (`terminal.ts`'s WebSocket bridge) rather
 *  than a one-shot command — not instrumented into the command log the way
 *  exec()/execWithInput() are, since a live shell's traffic isn't a discrete
 *  "command" the way a single exec() call is. */
export function openShell(session: SshSession, opts: { cols: number; rows: number }): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    session.conn.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
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

/** Buffers a whole remote file over SFTP — for config files and manifests small
 *  enough to read in one go (site configs, a .runtimeconfig.json), not arbitrary
 *  downloads (those stream, see index.ts's `/api/download`). */
export function readFile(session: SshSession, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = session.sftp.createReadStream(path);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const idleSweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const session of sessions.values()) {
    if (session.lastUsed < cutoff) disconnect(session.id);
  }
}, 60_000);
idleSweep.unref();
