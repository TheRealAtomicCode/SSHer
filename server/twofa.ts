// SSH two-factor login (authenticator-app codes) and closing direct root login.
//
// Uses the standard, free libpam-google-authenticator PAM module: after the password,
// sshd asks for the 6-digit code from any TOTP app (Google Authenticator, Microsoft
// Authenticator, Authy, 1Password…). No Google account and no email delivery involved —
// each user's email is only the label shown in their app and kept for your records.
//
// Both features can lock you out of the server, so every change is guarded:
//   * a user's secret is only saved after they type a working code from their app;
//   * turning 2FA on (or closing root) is tested with a brand-new SSH login before it's
//     kept, and rolled back automatically if that login fails. The current connection
//     is never dropped — sshd is reloaded, not restarted.
import { createHmac, randomBytes } from 'node:crypto';
import type { Express, Response } from 'express';
import { badRequestRoute, need, run, runSteps, str, writeRemote, type AsyncRoute, type SessionRequest } from './ops.js';
import { connect, disconnect, exec, execWithInput, SUDO_STDIN, shellQuote, type SshSession } from './ssh.js';

const PAM_FILE = '/etc/pam.d/sshd';
const PAM_LINE = 'auth required pam_google_authenticator.so nullok';
const DROPIN_2FA = '/etc/ssh/sshd_config.d/ssher-2fa.conf';
const DROPIN_NOROOT = '/etc/ssh/sshd_config.d/ssher-noroot.conf';
const META = '/etc/ssher/2fa.json';
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@"'`$\\]+@[^\s@"'`$\\]+\.[^\s@"'`$\\]+$/;

// ------------------------------------------------------------------- TOTP

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP: 6 digits, 30-second steps, HMAC-SHA1 — what every authenticator app uses. */
export function totp(secret: string, time = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

/** Accepts the previous and next 30 s step too, for phone clocks that are slightly off. */
function verifyTotp(secret: string, code: string): boolean {
  const c = code.replace(/\s/g, '');
  return [-30_000, 0, 30_000].some((d) => totp(secret, Date.now() + d) === c);
}

/** The file format the PAM module reads: secret, options, then emergency codes. */
function secretFile(secret: string, scratch: string[]): string {
  return [secret, '" RATE_LIMIT 5 30', '" WINDOW_SIZE 3', '" DISALLOW_REUSE', '" TOTP_AUTH', ...scratch, ''].join('\n');
}

// ---------------------------------------------------------------- helpers

interface UserRow {
  name: string;
  uid: number;
  home: string;
  hasSecret: boolean;
  sudo: boolean;
}

async function users(session: SshSession): Promise<UserRow[]> {
  // Login-capable accounts: root and regular users (uid >= 1000) with a real shell.
  const script = `getent passwd | awk -F: '($3==0 || $3>=1000) && $7 !~ /(nologin|false)$/ {print $1":"$3":"$6}' | while IFS=: read u uid home; do s=no; [ -f "$home/.google_authenticator" ] && s=yes; g=no; id -nG "$u" 2>/dev/null | grep -qwE 'sudo|wheel' && g=yes; echo "$u|$uid|$home|$s|$g"; done`;
  const out = await run(session, script, true);
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, uid, home, s, g] = l.split('|');
      return { name, uid: Number(uid), home, hasSecret: s === 'yes', sudo: g === 'yes' || name === 'root' };
    });
}

async function readMeta(session: SshSession): Promise<Record<string, { email: string; enabledAt: number }>> {
  const out = await run(session, `cat ${META} 2>/dev/null`, true);
  try {
    return JSON.parse(out.stdout || '{}');
  } catch {
    return {};
  }
}

async function writeMeta(session: SshSession, meta: Record<string, unknown>) {
  await writeRemote(session, META, `${JSON.stringify(meta, null, 2)}\n`);
  await run(session, `chmod 600 ${META}`);
}

async function sshdSettings(session: SshSession): Promise<Record<string, string>> {
  const out = await run(
    session,
    "sshd -T 2>/dev/null | grep -E '^(kbdinteractiveauthentication|challengeresponseauthentication|passwordauthentication|permitrootlogin|usepam|authenticationmethods) '",
    true,
  );
  return Object.fromEntries(out.stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/, 2)));
}

/** Which 30 s window each user's code was last used in by a test login. */
const lastCodeWindow = new Map<string, number>();

/** A brand-new SSH login, exactly as a user would make it — the proof a change is safe. */
async function testLogin(
  session: SshSession,
  username: string,
  password: string,
  opts: { checkSudo?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  // The code is computed here from the user's own secret, as their app would.
  const row = (await users(session)).find((u) => u.name === username);
  let otp: string | undefined;
  if (row?.hasSecret) {
    // The secret file says DISALLOW_REUSE: a code that already logged in once is
    // refused, so a second test inside the same 30 s waits for the next code.
    const key = `${session.host}:${username}`;
    if (lastCodeWindow.get(key) === Math.floor(Date.now() / 30_000)) {
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 1000));
    }
    const s = await run(session, `head -1 ${shellQuote(`${row.home}/.google_authenticator`)}`, true);
    otp = totp(s.stdout.trim());
    lastCodeWindow.set(key, Math.floor(Date.now() / 30_000));
  }
  try {
    const open = () => connect({ host: session.host, port: session.port, username, password, otp });
    let test: SshSession | undefined;
    // With 2FA, a code that a real login just used is refused (no reuse), and a login
    // straight after others can hit the per-user rate limit — so wait for a fresh code
    // and a fresh 30 s window, up to twice, before calling the test a failure.
    for (let attempt = 0; ; attempt++) {
      try {
        test = await open();
        break;
      } catch (err) {
        if (!otp || !row || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 31_000));
        const s = await run(session, `head -1 ${shellQuote(`${row.home}/.google_authenticator`)}`, true);
        otp = totp(s.stdout.trim());
        lastCodeWindow.set(`${session.host}:${username}`, Math.floor(Date.now() / 30_000));
      }
    }
    try {
      let output = `logged in as ${username}${otp ? ' with password + verification code' : ' with password'}`;
      if (opts.checkSudo && username !== 'root') {
        const r = await execWithInput(test, `${SUDO_STDIN} -k whoami`, `${password}\n`);
        if (r.stdout.trim() !== 'root') return { ok: false, output: `${output}, but sudo failed: ${(r.stderr || r.stdout).trim()}` };
        output += ', and sudo works';
      }
      return { ok: true, output };
    } finally {
      disconnect(test.id);
    }
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

// ----------------------------------------------------------------- routes

export function registerTwoFactor(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);
  /** Secrets shown but not yet confirmed with a code, per session + user. Never on disk. */
  const pending = new Map<string, { secret: string; scratch: string[]; email: string; expires: number }>();

  app.get(
    '/api/2fa/status',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [pkg, pam, includes, sshd, rows, meta, root] = await Promise.all([
        run(session, 'dpkg -s libpam-google-authenticator >/dev/null 2>&1 && echo yes', true),
        run(session, `grep -qE '^[[:space:]]*auth[[:space:]].*pam_google_authenticator\\.so' ${PAM_FILE} && echo yes`, true),
        run(session, "grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config && echo yes", true),
        sshdSettings(session),
        users(session),
        readMeta(session),
        run(session, `[ -f ${DROPIN_NOROOT} ] && echo yes`, true),
      ]);
      res.json({
        installed: pkg.stdout.trim() === 'yes',
        enforced: pam.stdout.trim() === 'yes' && (sshd.kbdinteractiveauthentication ?? sshd.challengeresponseauthentication) === 'yes',
        supportsDropins: includes.stdout.trim() === 'yes',
        sshd,
        rootLoginClosedBySsher: root.stdout.trim() === 'yes',
        connectedAs: session.username,
        users: rows.map((u) => ({ ...u, email: meta[u.name]?.email ?? '', enabledAt: meta[u.name]?.enabledAt ?? null })),
      });
    }),
  );

  app.post(
    '/api/2fa/install',
    requireSession,
    route(async (req, res) => {
      const { log, ok } = await runSteps(req.session!, [
        { title: 'Update package lists', command: 'apt-get update 2>&1 | tail -2' },
        { title: 'Install the authenticator PAM module', command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y libpam-google-authenticator 2>&1 | tail -3' },
      ]);
      if (!ok) {
        res.status(500).json({ error: 'Install failed', log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** Step 1 of setting a user up: a new secret + QR, kept in memory until confirmed. */
  app.post(
    '/api/2fa/setup',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const user = str(req.body?.user);
      const email = str(req.body?.email);
      need(USER_RE.test(user), 'invalid user');
      need(EMAIL_RE.test(email), 'Enter a valid email for this user');
      need((await users(session)).some((u) => u.name === user), `${user} isn't a login account on this server`);
      const hostname = (await exec(session, 'hostname', true)).stdout.trim() || session.host;
      const secret = base32Encode(randomBytes(20));
      const scratch = Array.from({ length: 5 }, () => String(10_000_000 + (randomBytes(4).readUInt32BE() % 90_000_000)));
      pending.set(`${session.id}:${user}`, { secret, scratch, email, expires: Date.now() + 15 * 60_000 });
      const issuer = `SSH ${hostname}`;
      const label = `${issuer}:${user} (${email})`;
      res.json({
        secret,
        scratch,
        otpauth: `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
      });
    }),
  );

  /** Step 2: the user typed a code from their app — only now is the secret saved. */
  app.post(
    '/api/2fa/confirm',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const user = str(req.body?.user);
      const code = str(req.body?.code);
      const p = pending.get(`${session.id}:${user}`);
      need(p && p.expires > Date.now(), 'Setup expired — start again');
      need(verifyTotp(p.secret, code), "That code doesn't match. Check the phone's time is set automatically, and type the newest code.");
      const row = (await users(session)).find((u) => u.name === user);
      need(row, 'user not found');
      const file = `${row.home}/.google_authenticator`;
      await writeRemote(session, file, secretFile(p.secret, p.scratch));
      // The PAM module refuses a secret file anyone else can read.
      await run(session, `chown ${shellQuote(user)}: ${shellQuote(file)} && chmod 400 ${shellQuote(file)}`);
      const meta = await readMeta(session);
      meta[user] = { email: p.email, enabledAt: Date.now() };
      await writeMeta(session, meta);
      pending.delete(`${session.id}:${user}`);
      res.json({ ok: true });
    }),
  );

  /** Just change the email on record (the app label stays as it was scanned). */
  app.post(
    '/api/2fa/email',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const user = str(req.body?.user);
      const email = str(req.body?.email);
      need(USER_RE.test(user), 'invalid user');
      need(EMAIL_RE.test(email), 'Enter a valid email');
      const meta = await readMeta(session);
      meta[user] = { email, enabledAt: meta[user]?.enabledAt ?? 0 };
      await writeMeta(session, meta);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/2fa/remove',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const user = str(req.body?.user);
      const row = (await users(session)).find((u) => u.name === user);
      need(row, 'user not found');
      await run(session, `rm -f ${shellQuote(`${row.home}/.google_authenticator`)}`);
      const meta = await readMeta(session);
      if (meta[user]) meta[user].enabledAt = 0;
      await writeMeta(session, meta);
      res.json({ ok: true });
    }),
  );

  /** Turn SSH two-factor on or off for the whole server. Users with no secret are not
   *  asked (`nullok`) — set everyone up, then turn this on. */
  app.post(
    '/api/2fa/enforce',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const enable = Boolean(req.body?.enabled);
      const log: { title: string; ok: boolean; output: string }[] = [];
      const step = async (title: string, command: string) => {
        const r = await run(session, `${command} 2>&1`);
        log.push({ title, ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
        return r.code === 0;
      };
      const rollback = async () => {
        await step('Undo: restore the PAM config', `[ -f ${PAM_FILE}.ssher-bak ] && cp -a ${PAM_FILE}.ssher-bak ${PAM_FILE}; rm -f ${DROPIN_2FA}; true`);
        await step('Undo: reload sshd', 'systemctl reload ssh 2>/dev/null || systemctl reload sshd');
      };

      if (!enable) {
        const ok =
          (await step('Remove the authenticator line from PAM', `sed -i '/pam_google_authenticator/d' ${PAM_FILE}`)) &&
          (await step('Remove SSHer’s sshd settings', `rm -f ${DROPIN_2FA}`)) &&
          (await step('Check sshd config', 'sshd -t')) &&
          (await step('Reload sshd', 'systemctl reload ssh 2>/dev/null || systemctl reload sshd'));
        if (!ok) {
          res.status(500).json({ error: 'Turning 2FA off failed', log });
          return;
        }
        res.json({ ok: true, log });
        return;
      }

      const testUser = str(req.body?.testUser) || session.username;
      const testPassword = String(req.body?.testPassword ?? '');
      need(testPassword, 'Enter the password of the account to test the new login with');
      const rows = await users(session);
      const tester = rows.find((u) => u.name === testUser);
      need(tester?.hasSecret, `Set up 2FA for ${testUser} first — the test login needs a working code`);
      const includes = await run(session, "grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config && echo yes", true);
      need(includes.stdout.trim() === 'yes', "This server's sshd_config doesn't read /etc/ssh/sshd_config.d — 2FA would need a hand edit here");

      // Prove the password is right before changing anything, so a typo can't be
      // mistaken for "2FA broke the login".
      const before = await testLogin(session, testUser, testPassword);
      log.push({ title: `Check ${testUser}'s password works (before the change)`, ok: before.ok, output: before.output });
      if (!before.ok) {
        res.status(400).json({ error: `Couldn't log in as ${testUser} with that password — nothing was changed`, log });
        return;
      }

      const dropin = [
        '# Managed by SSHer (Security page): two-factor SSH login.',
        '# Password, then the 6-digit code from an authenticator app. SSH keys are unaffected.',
        'KbdInteractiveAuthentication yes',
        'UsePAM yes',
        'PasswordAuthentication no',
        '',
      ].join('\n');
      const ok =
        (await step('Back up the PAM config', `cp -a ${PAM_FILE} ${PAM_FILE}.ssher-bak`)) &&
        (await step(
          'Ask for the authenticator code after the password (PAM)',
          `grep -q pam_google_authenticator ${PAM_FILE} || (grep -q '^@include common-auth' ${PAM_FILE} && sed -i '/^@include common-auth/a ${PAM_LINE}' ${PAM_FILE} || sed -i '1i ${PAM_LINE}' ${PAM_FILE}); grep pam_google ${PAM_FILE}`,
        ));
      if (!ok) {
        await rollback();
        res.status(500).json({ error: 'Changing PAM failed — undone', log });
        return;
      }
      try {
        await writeRemote(session, DROPIN_2FA, dropin);
        log.push({ title: `Write ${DROPIN_2FA}`, ok: true, output: dropin.trim() });
      } catch (err) {
        log.push({ title: `Write ${DROPIN_2FA}`, ok: false, output: (err as Error).message });
        await rollback();
        res.status(500).json({ error: 'Writing the sshd settings failed — undone', log });
        return;
      }
      if (!(await step('Check sshd config', 'sshd -t')) || !(await step('Reload sshd (your current connection stays open)', 'systemctl reload ssh 2>/dev/null || systemctl reload sshd'))) {
        await rollback();
        res.status(500).json({ error: 'sshd rejected the change — undone', log });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      const after = await testLogin(session, testUser, testPassword);
      log.push({ title: `Test a brand-new login as ${testUser} with password + code`, ok: after.ok, output: after.output });
      if (!after.ok) {
        await rollback();
        res.status(500).json({ error: 'The test login failed, so 2FA was turned off again — nothing is locked', log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** Close (or reopen) direct root login over SSH. Closing needs a tested sudo user. */
  app.post(
    '/api/2fa/root-login',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const allow = Boolean(req.body?.allow);
      const log: { title: string; ok: boolean; output: string }[] = [];
      const step = async (title: string, command: string) => {
        const r = await run(session, `${command} 2>&1`);
        log.push({ title, ok: r.code === 0, output: (r.stdout + r.stderr).trim() });
        return r.code === 0;
      };
      const reload = () => step('Reload sshd (your current connection stays open)', 'systemctl reload ssh 2>/dev/null || systemctl reload sshd');

      if (allow) {
        const ok = (await step('Remove the root-login block', `rm -f ${DROPIN_NOROOT}`)) && (await step('Check sshd config', 'sshd -t')) && (await reload());
        if (!ok) {
          res.status(500).json({ error: 'Reopening root login failed', log });
          return;
        }
        res.json({ ok: true, log });
        return;
      }

      const testUser = str(req.body?.testUser);
      const testPassword = String(req.body?.testPassword ?? '');
      need(USER_RE.test(testUser) && testUser !== 'root', 'Pick the normal (non-root) user you will log in as from now on');
      need(testPassword, `Enter ${testUser}'s password`);
      const tester = (await users(session)).find((u) => u.name === testUser);
      need(tester, `${testUser} isn't a login account`);
      need(tester.sudo, `${testUser} can't use sudo — add them to the sudo group first (Users page), or you'd have no way to become root`);

      const before = await testLogin(session, testUser, testPassword, { checkSudo: true });
      log.push({ title: `Log in as ${testUser} and check sudo works (before the change)`, ok: before.ok, output: before.output });
      if (!before.ok) {
        res.status(400).json({ error: `${testUser} couldn't log in and use sudo — nothing was changed`, log });
        return;
      }

      const dropin = '# Managed by SSHer (Security page): no direct root login. Log in as a sudo user.\nPermitRootLogin no\n';
      try {
        await writeRemote(session, DROPIN_NOROOT, dropin);
        log.push({ title: `Write ${DROPIN_NOROOT}`, ok: true, output: 'PermitRootLogin no' });
      } catch (err) {
        log.push({ title: `Write ${DROPIN_NOROOT}`, ok: false, output: (err as Error).message });
        res.status(500).json({ error: 'Writing the setting failed', log });
        return;
      }
      const undo = async () => {
        await step('Undo: remove the root-login block', `rm -f ${DROPIN_NOROOT}`);
        await reload();
      };
      if (!(await step('Check sshd config', 'sshd -t')) || !(await reload())) {
        await undo();
        res.status(500).json({ error: 'sshd rejected the change — undone', log });
        return;
      }
      const effective = (await sshdSettings(session)).permitrootlogin;
      log.push({ title: 'sshd now says PermitRootLogin', ok: effective === 'no', output: effective ?? '?' });
      if (effective !== 'no') {
        await undo();
        res.status(500).json({ error: 'Another setting overrides it (sshd still allows root) — undone. Check /etc/ssh/sshd_config by hand.', log });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      const after = await testLogin(session, testUser, testPassword, { checkSudo: true });
      log.push({ title: `Test a brand-new login as ${testUser} + sudo (after the change)`, ok: after.ok, output: after.output });
      if (!after.ok) {
        await undo();
        res.status(500).json({ error: `The test login as ${testUser} failed, so root login was reopened — nothing is locked`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );
}
