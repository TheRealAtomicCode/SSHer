// Security checks: a read-only audit of the server (exposed ports, SSH config, firewall,
// PostgreSQL exposure, suspicious processes and files, users, keys, updates, Docker),
// plus optional third-party scanners (Lynis, rkhunter, chkrootkit, ClamAV) and fail2ban
// that can be installed and then run from the same page.
//
// The audit itself only reads. The only things here that change the server are the
// explicit, confirmed actions: install a tool, run a tool, stop a process, quarantine
// a file — each a separate request the user clicks.
import posix from 'node:path/posix';
import type { Express, Request, Response } from 'express';
import { badRequestRoute, need, run, runSteps, str, writeRemote, type AsyncRoute, type SessionRequest } from './ops.js';
import { connections } from './monitor.js';
import { exec, shellQuote, type SshSession } from './ssh.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'ok';

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  /** Why it matters, in plain words. */
  detail: string;
  evidence: string[];
  /** A page in SSHer where it can be fixed. */
  link?: 'ports' | 'postgres' | 'users' | 'docker' | 'processes';
  /** Shell to fix it by hand, when there is a simple one. */
  fixCommand?: string;
  /** Suspicious process / file the UI can act on (stop / quarantine). */
  process?: { pid: number; exe: string; user: string; name: string; cpu: number };
  file?: string;
}

const SECTIONS = {
  sshd: "sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|port|permitemptypasswords|maxauthtries|pubkeyauthentication) '",
  ufw: 'command -v ufw >/dev/null && ufw status 2>/dev/null || echo "__NO_UFW__"',
  listen: 'ss -tulnpH 2>/dev/null',
  procs: `for p in /proc/[0-9]*; do pid=\${p#/proc/}; exe=$(readlink "$p/exe" 2>/dev/null) || continue; printf '%s|%s|%s|%s\\n' "$pid" "$(stat -c %U "$p" 2>/dev/null)" "$(cat "$p/comm" 2>/dev/null)" "$exe"; done`,
  cpu: 'ps -eo pid=,pcpu=',
  tempExec: 'find /tmp /var/tmp /dev/shm -xdev -type f -perm -u+x 2>/dev/null | head -50',
  pgDataExec: `d=$(ls -d /var/lib/postgresql/*/main 2>/dev/null | head -1); [ -n "$d" ] && find "$d" -maxdepth 1 -type f -perm -u+x 2>/dev/null; [ -n "$d" ] && find "$d" -maxdepth 1 -name '.*' -type f 2>/dev/null`,
  uid0: "awk -F: '$3==0{print $1}' /etc/passwd",
  emptyPw: "awk -F: '($2==\"\"){print $1}' /etc/shadow 2>/dev/null",
  keys: 'for h in /root /home/*; do f="$h/.ssh/authorized_keys"; [ -f "$f" ] && echo "$f $(grep -cE \'^(ssh|ecdsa|sk-)\' "$f")"; done',
  updates: 'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l; apt list --upgradable 2>/dev/null | grep -ci -- "-security"; dpkg -s unattended-upgrades >/dev/null 2>&1 && echo yes || echo no; [ -f /var/run/reboot-required ] && echo reboot || echo noreboot',
  fail2ban: 'systemctl is-active fail2ban 2>/dev/null | head -1; true',
  pgConf: `command -v psql >/dev/null || exit 0; su postgres -s /bin/sh -c "psql -tAX -c \\"select current_setting('listen_addresses') || '|' || current_setting('hba_file')\\"" 2>/dev/null`,
  pgRoles: `command -v psql >/dev/null || exit 0; su postgres -s /bin/sh -c "psql -tAX -c \\"select rolname from pg_roles where rolsuper and rolcanlogin\\"" 2>/dev/null`,
  cron: `grep -rhsE 'curl|wget|base64|/tmp/|/dev/shm|\\.sh *\\|' /etc/cron* /var/spool/cron 2>/dev/null | grep -v '^#' | head -10`,
  docker: `command -v docker >/dev/null || exit 0; for id in $(docker ps -q); do docker inspect -f '{{.Name}}|{{.HostConfig.Privileged}}|{{range .Mounts}}{{.Source}},{{end}}|{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}}:{{.HostPort}},{{end}}{{end}}' "$id"; done`,
};

/** One round trip: every section, separated by markers. */
async function collect(session: SshSession): Promise<Record<keyof typeof SECTIONS, string>> {
  const script = Object.entries(SECTIONS)
    .map(([name, cmd]) => `echo '@@${name}'; (${cmd})`)
    .join('; ');
  const out = await run(session, script);
  const result = {} as Record<keyof typeof SECTIONS, string>;
  for (const part of out.stdout.split('@@').slice(1)) {
    const nl = part.indexOf('\n');
    const name = (nl < 0 ? part : part.slice(0, nl)).trim() as keyof typeof SECTIONS;
    result[name] = nl < 0 ? '' : part.slice(nl + 1).trim();
  }
  return result;
}

const RISKY_PORTS: Record<number, string> = {
  5432: 'PostgreSQL', 3306: 'MySQL/MariaDB', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch',
  11211: 'Memcached', 5984: 'CouchDB', 2375: 'Docker API (unencrypted!)', 2376: 'Docker API', 8086: 'InfluxDB',
  5672: 'RabbitMQ', 15672: 'RabbitMQ admin', 9000: 'often an admin panel', 10250: 'Kubelet', 23: 'Telnet', 21: 'FTP',
};
/** Where legitimate programs live. Anything executing from elsewhere is unusual. */
const NORMAL_EXE = /^\/(usr|bin|sbin|lib|lib64|opt|snap|nix)\//;
const SHADY_EXE = /^(\/tmp\/|\/var\/tmp\/|\/dev\/shm\/|\/run\/user\/|\/var\/lib\/postgresql\/|\/var\/lib\/mysql\/|\/var\/www\/)/;
/** Names malware likes to hide behind. */
const IMPERSONATED = /^(init|systemd|kthreadd|kworker.*|ksoftirqd.*|sshd|cron|bash|sh|dbus-daemon|rsyslogd|\[.*\])$/;

function audit(d: Record<keyof typeof SECTIONS, string>, sshPort: number, outbound: Map<string, number>): Finding[] {
  const f: Finding[] = [];
  const add = (x: Finding) => f.push(x);

  // ------------------------------------------------------------ processes
  const cpu = new Map<number, number>();
  for (const line of d.cpu.split('\n')) {
    const [pid, pc] = line.trim().split(/\s+/);
    cpu.set(Number(pid), Number(pc) || 0);
  }
  const procs = d.procs.split('\n').filter(Boolean).map((l) => {
    const [pid, user, name, ...exe] = l.split('|');
    return { pid: Number(pid), user, name, exe: exe.join('|') };
  });
  for (const p of procs) {
    const deleted = p.exe.endsWith(' (deleted)');
    const path = p.exe.replace(/ \(deleted\)$/, '');
    const fromShady = SHADY_EXE.test(path);
    const impersonating = IMPERSONATED.test(p.name) && p.pid !== 1 && !NORMAL_EXE.test(path);
    const hidden = posix.basename(path).startsWith('.');
    if (!(fromShady || impersonating || hidden || (deleted && !NORMAL_EXE.test(path)))) continue;
    const reasons = [
      fromShady && `runs from ${posix.dirname(path)}, where programs don't normally live`,
      impersonating && `calls itself "${p.name}" but isn't the real one (that lives in /usr or /sbin)`,
      hidden && 'its program file is hidden (name starts with a dot)',
      deleted && 'its program file was deleted after it started — a common way to hide',
    ].filter(Boolean) as string[];
    add({
      id: `proc-${p.pid}`,
      category: 'Malware & intrusion',
      severity: 'critical',
      title: `Suspicious process "${p.name}" (pid ${p.pid}, user ${p.user})`,
      detail: `This looks like malware: it ${reasons.join('; ')}.${(cpu.get(p.pid) ?? 0) > 50 ? ` It's using ${cpu.get(p.pid)}% CPU — typical of a cryptocurrency miner.` : ''}`,
      evidence: [`exe: ${p.exe}`, `cpu: ${cpu.get(p.pid) ?? 0}%`],
      process: { pid: p.pid, exe: path, user: p.user, name: p.name, cpu: cpu.get(p.pid) ?? 0 },
      file: deleted ? undefined : path,
      link: 'processes',
    });
  }

  for (const [proc, count] of outbound) {
    if (count < 20) continue;
    add({
      id: `scan-${proc}`,
      category: 'Malware & intrusion',
      severity: 'critical',
      title: `${proc} is opening ${count} outgoing connections at once`,
      detail:
        'Hundreds of half-open connections from this server to random addresses is what a scanner or botnet does — usually looking for the next server to break into. Normal servers don\'t do this.',
      evidence: [`${count} connections in SYN-SENT from ${proc}`],
      link: 'processes',
    });
  }

  const shadyFiles = [...d.tempExec.split('\n'), ...d.pgDataExec.split('\n')].filter(Boolean);
  for (const file of [...new Set(shadyFiles)]) {
    if (f.some((x) => x.file === file)) continue;
    add({
      id: `file-${file}`,
      category: 'Malware & intrusion',
      severity: file.startsWith('/var/lib/postgresql') ? 'critical' : 'high',
      title: `Executable file in ${posix.dirname(file)}: ${posix.basename(file)}`,
      detail: file.startsWith('/var/lib/postgresql')
        ? "PostgreSQL's data folder never contains programs or hidden files. A file like this is how attackers who got into the database run their own code."
        : 'Temporary folders are writable by everyone, so attackers drop their tools there. Check what it is before trusting it.',
      evidence: [file],
      file,
    });
  }

  if (d.cron) {
    add({
      id: 'cron',
      category: 'Malware & intrusion',
      severity: 'high',
      title: 'Scheduled jobs that download or run things from temp folders',
      detail: 'Attackers add cron jobs that re-download their tools so they come back after being removed. Check each line — a legitimate one is fine.',
      evidence: d.cron.split('\n'),
    });
  }

  // ---------------------------------------------------------------- ports
  const listeners = d.listen.split('\n').filter(Boolean).map((l) => {
    const c = l.trim().split(/\s+/);
    const local = c[4] ?? '';
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const addr = local.slice(0, local.lastIndexOf(':'));
    const proc = /\("([^"]+)"/.exec(c.slice(6).join(' '))?.[1] ?? '';
    return { proto: c[0], port, addr, proc, public: !/^(127\.|\[::1\]|::1)/.test(addr) && !addr.includes('%lo') };
  });
  const ufwActive = /Status: active/.test(d.ufw);
  const ufwAllows = (port: number) =>
    new RegExp(`^(${port}(/\\w+)?|[^\\n]*\\b${port}\\b)\\s+ALLOW\\s+(IN\\s+)?Anywhere`, 'm').test(d.ufw);

  const seenPorts = new Set<number>();
  for (const l of listeners.filter((x) => x.public)) {
    if (seenPorts.has(l.port)) continue;
    seenPorts.add(l.port);
    const name = RISKY_PORTS[l.port];
    const reachable = !ufwActive || ufwAllows(l.port) || l.proc === 'docker-proxy';
    if (name && reachable) {
      add({
        id: `port-${l.port}`,
        category: 'Exposed services',
        severity: l.port === 5432 || l.port === 6379 || l.port === 27017 || l.port === 2375 ? 'critical' : 'high',
        title: `${name} (port ${l.port}) is open to the whole internet`,
        detail: `Anyone can reach ${name} and try passwords against it — this is exactly how databases get broken into. Close it to the internet and allow only the addresses that need it.${l.proc === 'docker-proxy' ? ' It is published by Docker, which bypasses the firewall: bind it to 127.0.0.1 instead.' : ''}`,
        evidence: [`${l.proto} ${l.addr}:${l.port} (${l.proc || '?'})`, ufwActive ? 'ufw allows it from Anywhere' : 'the firewall is off'],
        link: 'ports',
      });
    }
  }
  // Firewall rules for ports nothing listens on: harmless today, open tomorrow.
  if (ufwActive) {
    const listening = new Set(listeners.map((l) => l.port));
    const ruled = [...d.ufw.matchAll(/^(\d+)(?:\/\w+)?\s+ALLOW\s+(?:IN\s+)?Anywhere/gm)].map((m) => Number(m[1]));
    const unused = [...new Set(ruled.filter((p) => !listening.has(p)))];
    if (unused.length) {
      add({
        id: 'unused-rules',
        category: 'Exposed services',
        severity: 'low',
        title: `Firewall allows ${unused.length} port(s) nothing is listening on: ${unused.join(', ')}`,
        detail: "Nothing uses them now, but anything that starts listening there later is instantly public. Remove rules you don't need.",
        evidence: unused.map((p) => `ufw allows ${p} from Anywhere`),
        link: 'ports',
      });
    }
  } else if (!d.ufw.includes('__NO_UFW__')) {
    add({ id: 'ufw-off', category: 'Firewall', severity: 'high', title: 'The firewall (ufw) is off', detail: 'Every listening port is reachable from the internet.', evidence: [d.ufw.split('\n')[0]], link: 'ports' });
  } else {
    add({ id: 'ufw-missing', category: 'Firewall', severity: 'medium', title: 'No ufw firewall installed', detail: 'Without a firewall every listening port is reachable from the internet.', evidence: [], fixCommand: 'apt-get install -y ufw' });
  }

  // ------------------------------------------------------------------ ssh
  const sshd = Object.fromEntries(d.sshd.split('\n').filter(Boolean).map((l) => l.split(/\s+/, 2)));
  if (sshd.permitrootlogin === 'yes') {
    add({
      id: 'ssh-root', category: 'SSH', severity: 'medium', title: 'root can log in over SSH with a password',
      detail: 'Bots try root passwords on every server all day. Use a normal user + sudo, or at least keys only for root (PermitRootLogin prohibit-password).',
      evidence: ['PermitRootLogin yes'], fixCommand: "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl reload ssh   # only once you can log in with a key!",
    });
  }
  if (sshd.passwordauthentication === 'yes') {
    add({
      id: 'ssh-password', category: 'SSH', severity: 'low', title: 'SSH accepts passwords',
      detail: 'Keys are far stronger than passwords. Turning passwords off stops brute-force attempts entirely — but only after a key works, or you lock yourself out.',
      evidence: ['PasswordAuthentication yes'],
    });
  }
  if (sshd.permitemptypasswords === 'yes') {
    add({ id: 'ssh-empty', category: 'SSH', severity: 'critical', title: 'SSH allows empty passwords', detail: 'Any account without a password can be logged into.', evidence: ['PermitEmptyPasswords yes'] });
  }
  if (d.fail2ban.trim() !== 'active') {
    add({
      id: 'fail2ban', category: 'SSH', severity: 'low', title: 'Nothing is blocking password guessing (fail2ban not running)',
      detail: 'fail2ban bans IPs after a few failed logins. Install it from the tools below.', evidence: [`fail2ban: ${d.fail2ban.trim()}`],
    });
  }
  void sshPort;

  // ------------------------------------------------------------ postgres
  if (d.pgConf) {
    const [listen, hba] = d.pgConf.split('|');
    if (listen === '*' || listen === '0.0.0.0') {
      add({
        id: 'pg-listen', category: 'PostgreSQL', severity: 'medium', title: `PostgreSQL listens on every address (listen_addresses = '${listen}')`,
        detail: "Fine if the firewall limits who can reach it — but combined with an open 5432 it's the front door attackers use.", evidence: [`listen_addresses = '${listen}'`, `hba_file = ${hba}`], link: 'postgres',
      });
    }
  }
  const superusers = d.pgRoles.split('\n').filter(Boolean);
  const unexpected = superusers.filter((r) => r !== 'postgres');
  if (unexpected.length) {
    add({
      id: 'pg-superusers', category: 'PostgreSQL', severity: 'high', title: `Extra PostgreSQL superuser(s) that can log in: ${unexpected.join(', ')}`,
      detail: "A superuser can read every database and run programs on the server (COPY … FROM PROGRAM). Attackers create one to keep access. If you didn't make it, disable it.",
      evidence: superusers.map((r) => `superuser: ${r}`),
      fixCommand: unexpected.map((r) => `su postgres -c "psql -c 'ALTER ROLE \\"${r}\\" NOLOGIN'"`).join('\n'),
      link: 'postgres',
    });
  }

  // ---------------------------------------------------------------- users
  const uid0 = d.uid0.split('\n').filter((u) => u && u !== 'root');
  if (uid0.length) {
    add({ id: 'uid0', category: 'Users', severity: 'critical', title: `Account(s) besides root with root powers (UID 0): ${uid0.join(', ')}`, detail: 'A second UID-0 account is a classic backdoor.', evidence: uid0, link: 'users' });
  }
  const empty = d.emptyPw.split('\n').filter(Boolean);
  if (empty.length) {
    add({ id: 'empty-pw', category: 'Users', severity: 'high', title: `Account(s) with no password: ${empty.join(', ')}`, detail: 'Anyone can log in as these if the login method allows it.', evidence: empty, link: 'users' });
  }
  const keys = d.keys.split('\n').filter(Boolean);
  if (keys.length) {
    add({
      id: 'ssh-keys', category: 'Users', severity: 'info', title: 'SSH keys that can log in',
      detail: "Check you recognise every key — attackers add their own to keep access.", evidence: keys.map((k) => { const [file, n] = k.split(' '); return `${file}: ${n} key(s)`; }),
    });
  }

  // -------------------------------------------------------------- updates
  const [upgradable, security, unattended, reboot] = d.updates.split('\n').map((s) => s.trim());
  if (Number(security) > 0) {
    add({ id: 'updates-sec', category: 'Updates', severity: 'high', title: `${security} security update(s) waiting`, detail: 'Known, published holes stay open until these are installed.', evidence: [`${upgradable} upgradable package(s), ${security} from -security`], fixCommand: 'apt-get update && apt-get upgrade -y' });
  } else if (Number(upgradable) > 0) {
    add({ id: 'updates', category: 'Updates', severity: 'low', title: `${upgradable} package update(s) available`, detail: 'Not security-critical, but worth installing.', evidence: [], fixCommand: 'apt-get update && apt-get upgrade -y' });
  }
  if (unattended === 'no') {
    add({ id: 'unattended', category: 'Updates', severity: 'low', title: 'Security updates are not installed automatically', detail: 'unattended-upgrades installs security fixes daily.', evidence: [], fixCommand: 'apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades' });
  }
  if (reboot === 'reboot') {
    add({ id: 'reboot', category: 'Updates', severity: 'medium', title: 'A reboot is needed to finish updates', detail: 'Updated kernel or libraries only take effect after a reboot.', evidence: ['/var/run/reboot-required exists'] });
  }

  // --------------------------------------------------------------- docker
  for (const line of d.docker.split('\n').filter(Boolean)) {
    const [name, privileged, mounts, ports] = line.split('|');
    const n = name.replace(/^\//, '');
    if (privileged === 'true') add({ id: `dk-priv-${n}`, category: 'Docker', severity: 'high', title: `Container ${n} runs privileged`, detail: 'A privileged container can take over the host.', evidence: ['Privileged: true'], link: 'docker' });
    if (mounts.includes('/var/run/docker.sock')) add({ id: `dk-sock-${n}`, category: 'Docker', severity: 'high', title: `Container ${n} has the Docker socket`, detail: 'Access to docker.sock is root on the host.', evidence: ['mounts /var/run/docker.sock'], link: 'docker' });
    const open = ports.split(',').filter((p) => p.startsWith('0.0.0.0:') || p.startsWith(':::'));
    if (open.length) add({ id: `dk-port-${n}`, category: 'Docker', severity: 'medium', title: `Container ${n} is published on all interfaces (${open.join(', ')})`, detail: "Docker-published ports bypass ufw. If it's behind nginx, bind it to 127.0.0.1.", evidence: open, link: 'docker' });
  }

  return f;
}

// ---------------------------------------------------------------- tools

interface Tool {
  id: string;
  name: string;
  what: string;
  pkg: string;
  bin: string;
  /** Packages to remove on uninstall (defaults to `pkg`). */
  removePkgs?: string;
  /** Run before removing, e.g. stop the service. */
  beforeRemove?: string;
  /** Long-running checks; output is condensed to the interesting lines. */
  run?: string;
  /** Lines worth showing from the output. */
  keep?: RegExp;
}

const TOOLS: Tool[] = [
  {
    id: 'lynis', name: 'Lynis', pkg: 'lynis', bin: 'lynis',
    what: 'A full security audit: hundreds of checks on configuration, services and hardening. Takes 1–3 minutes.',
    run: "lynis audit system --quick --no-colors >/dev/null 2>&1; grep -E '^(warning|suggestion)\\[\\]=' /var/log/lynis-report.dat | sed -E 's/^(warning|suggestion)\\[\\]=/\\1: /'; grep -E '^hardening_index=' /var/log/lynis-report.dat",
  },
  {
    id: 'rkhunter', name: 'rkhunter', pkg: 'rkhunter', bin: 'rkhunter',
    what: 'Rootkit Hunter: looks for rootkits, backdoors and tampered system binaries.',
    run: 'rkhunter --update >/dev/null 2>&1; rkhunter --check --sk --rwo --nocolors 2>&1 | head -200',
  },
  {
    id: 'chkrootkit', name: 'chkrootkit', pkg: 'chkrootkit', bin: 'chkrootkit',
    what: 'A second, independent rootkit check (quick).',
    run: 'chkrootkit -q 2>&1 | head -200',
  },
  {
    id: 'clamav', name: 'ClamAV', pkg: 'clamav', bin: 'clamscan',
    what: 'Antivirus: scans the places attackers usually drop files (temp folders, homes, the PostgreSQL data folder). First run downloads the virus database (~250 MB).',
    run: 'freshclam --quiet 2>/dev/null; clamscan -r -i --no-summary /tmp /var/tmp /dev/shm /root /home /var/lib/postgresql /var/www 2>&1 | head -200',
    // The virus-database updater comes along as its own package and service.
    removePkgs: 'clamav clamav-freshclam clamav-base',
    beforeRemove: 'systemctl disable --now clamav-freshclam 2>/dev/null',
  },
  {
    id: 'fail2ban', name: 'fail2ban', pkg: 'fail2ban', bin: 'fail2ban-client',
    what: 'Not a scanner — it protects SSH by banning IPs after repeated failed logins (your own IP is never banned). Run turns it on.',
    // The jail file is written first (see the run route): Debian 12 has no auth.log, so
    // the stock sshd jail finds nothing to watch and fail2ban refuses to start.
    run: 'systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban 2>&1; sleep 2; fail2ban-client status sshd 2>&1',
    removePkgs: 'fail2ban',
    beforeRemove: 'systemctl disable --now fail2ban 2>/dev/null; rm -f /etc/fail2ban/jail.d/ssher-sshd.local',
  },
];

const FAIL2BAN_JAIL = '/etc/fail2ban/jail.d/ssher-sshd.local';

function fail2banJail(sshPort: number, ignore: string[]): string {
  return [
    '# Managed by SSHer (Security page).',
    '# Reads SSH logins from the systemd journal — Debian 12 and newer have no /var/log/auth.log.',
    '[sshd]',
    'enabled  = true',
    'backend  = systemd',
    `port     = ${sshPort}`,
    'maxretry = 5',
    'findtime = 10m',
    'bantime  = 1h',
    // Never ban yourself: localhost and the address SSHer is connecting from.
    `ignoreip = 127.0.0.1/8 ::1 ${ignore.join(' ')}`.trim(),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- routes

/** The visitor's own IPs, so the UI can hide them: the browser's (as this API sees it,
 *  through Cloudflare/nginx headers) and the SSH session's client address. */
async function whoami(req: Request, session: SshSession) {
  const header = (h: string) => String(req.headers[h] ?? '').split(',')[0].trim();
  const browser = header('cf-connecting-ip') || header('x-real-ip') || header('x-forwarded-for') || (req.socket.remoteAddress ?? '');
  const ssh = (await exec(session, 'echo "$SSH_CLIENT"', true)).stdout.trim().split(/\s+/)[0] ?? '';
  const clean = (ip: string) => ip.replace(/^::ffff:/, '');
  return { browserIp: clean(browser), sshClientIp: clean(ssh) };
}

export function registerSecurity(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get('/api/whoami', requireSession, route(async (req, res) => {
    res.json(await whoami(req, req.session!));
  }));

  app.get(
    '/api/security/scan',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [data, conns] = await Promise.all([collect(session), connections(session)]);
      const outbound = new Map<string, number>();
      for (const c of conns) if (c.state === 'SYN-SENT' && c.process) outbound.set(`${c.process} (pid ${c.pid})`, (outbound.get(`${c.process} (pid ${c.pid})`) ?? 0) + 1);
      const findings = audit(data, session.port, outbound);
      const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'ok'];
      findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
      res.json({ time: Date.now(), findings });
    }),
  );

  app.get(
    '/api/security/tools',
    requireSession,
    route(async (req, res) => {
      const out = await run(req.session!, TOOLS.map((t) => `command -v ${t.bin} >/dev/null 2>&1 && echo "${t.id}=yes" || echo "${t.id}=no"`).join('; '), true);
      const installed = Object.fromEntries(out.stdout.split('\n').filter(Boolean).map((l) => l.split('=')));
      res.json({ tools: TOOLS.map((t) => ({ id: t.id, name: t.name, what: t.what, pkg: t.pkg, installed: installed[t.id] === 'yes' })) });
    }),
  );

  app.post(
    '/api/security/tools/:id/install',
    requireSession,
    route(async (req, res) => {
      const tool = TOOLS.find((t) => t.id === req.params.id);
      need(tool, 'unknown tool');
      const { log, ok } = await runSteps(req.session!, [
        { title: 'Update package lists', command: 'apt-get update 2>&1 | tail -3' },
        { title: `Install ${tool.name}`, command: `DEBIAN_FRONTEND=noninteractive apt-get install -y ${tool.pkg} 2>&1 | tail -5` },
      ]);
      if (!ok) {
        res.status(500).json({ error: `Installing ${tool.name} failed`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  app.post(
    '/api/security/tools/:id/run',
    requireSession,
    route(async (req, res) => {
      const tool = TOOLS.find((t) => t.id === req.params.id);
      need(tool?.run, 'unknown tool');
      const session = req.session!;
      const started = Date.now();
      let prefix = '';
      if (tool.id === 'fail2ban') {
        // The systemd backend needs python3-systemd; then a jail that reads the journal.
        const dep = await run(session, 'dpkg -s python3-systemd >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y python3-systemd 2>&1 | tail -2');
        const me = await whoami(req, session);
        const ignore = [...new Set([me.sshClientIp, me.browserIp].filter((ip) => ip && !/^(127\.|::1$)/.test(ip)))];
        await writeRemote(session, FAIL2BAN_JAIL, fail2banJail(session.port, ignore));
        prefix = `${dep.stdout.trim() ? `${dep.stdout.trim()}\n` : ''}Wrote ${FAIL2BAN_JAIL} (journal backend; never bans ${ignore.join(', ') || 'localhost'})\n\n`;
      }
      const out = await run(session, tool.run);
      res.json({ ok: out.code === 0, output: prefix + (out.stdout + out.stderr).trim(), seconds: Math.round((Date.now() - started) / 1000) });
    }),
  );

  app.post(
    '/api/security/tools/:id/uninstall',
    requireSession,
    route(async (req, res) => {
      const tool = TOOLS.find((t) => t.id === req.params.id);
      need(tool, 'unknown tool');
      const steps = [
        ...(tool.beforeRemove ? [{ title: `Stop ${tool.name}`, command: `${tool.beforeRemove}; true` }] : []),
        { title: `Uninstall ${tool.name}`, command: `DEBIAN_FRONTEND=noninteractive apt-get remove -y ${tool.removePkgs ?? tool.pkg} 2>&1 | tail -4` },
        { title: 'Remove packages nothing needs any more', command: 'DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>&1 | tail -3' },
      ];
      const { log, ok } = await runSteps(req.session!, steps);
      if (!ok) {
        res.status(500).json({ error: `Uninstalling ${tool.name} failed`, log });
        return;
      }
      res.json({ ok: true, log });
    }),
  );

  /** Stops a process the scan flagged. Refuses PID 1 and SSHer's own connection. */
  app.post(
    '/api/security/kill',
    requireSession,
    route(async (req, res) => {
      const pid = Number(req.body?.pid);
      need(Number.isInteger(pid) && pid > 1, 'invalid pid');
      const result = await run(req.session!, `kill -9 ${pid} 2>&1 && echo "stopped ${pid}"`);
      need(result.code === 0, result.stdout.trim() || `could not stop ${pid}`);
      res.json({ ok: true, output: result.stdout.trim() });
    }),
  );

  /** Moves a flagged file out of the way with no permissions — kept, not deleted, so
   *  it can still be inspected (or handed to someone who investigates). */
  app.post(
    '/api/security/quarantine',
    requireSession,
    route(async (req, res) => {
      const path = str(req.body?.path);
      need(/^\/[^\0\n\r"'`$\\]+$/.test(path) && !path.includes('..'), 'invalid path');
      need(!/^\/(usr|bin|sbin|lib|lib64|etc|boot)\//.test(path), 'refusing to move a system file');
      const dest = `/root/ssher-quarantine/${Date.now()}-${posix.basename(path)}`;
      const result = await run(
        req.session!,
        `mkdir -p /root/ssher-quarantine && chmod 700 /root/ssher-quarantine && mv -- ${shellQuote(path)} ${shellQuote(dest)} && chmod 000 ${shellQuote(dest)} && echo ${shellQuote(dest)}`,
      );
      need(result.code === 0, (result.stdout + result.stderr).trim() || 'could not quarantine');
      res.json({ ok: true, dest: result.stdout.trim() });
    }),
  );
}
