// Live monitoring: raw kernel counters for CPU, memory, disk and network, plus the
// current TCP/UDP connections. Each sample is ONE shell round trip reading /proc —
// cheap enough to poll every second. The server hands back cumulative counters and
// a timestamp; the client turns two consecutive samples into rates, so nothing here
// keeps per-session state.
import type { Express, Response } from 'express';
import { badRequestRoute, need, run, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { exec, readFile, shellQuote, type SshSession } from './ssh.js';

/** Whole disks only — partitions (sda1) would double-count their disk's IO. */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
/** Virtual interfaces are listed but kept out of the host total: their traffic is
 *  already counted on the real interface it leaves through. */
const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|cni|flannel|tun|tap|wg)/;

const SAMPLE_SCRIPT = [
  'date +%s%3N',
  'head -1 /proc/stat',
  'grep -c ^processor /proc/cpuinfo',
  'cat /proc/loadavg',
  'cat /proc/uptime',
  'cat /proc/meminfo',
  'cat /proc/net/dev',
  'cat /proc/diskstats',
  'df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs --output=target,size,used,avail 2>/dev/null | tail -n +2',
].join("; echo '@@'; ");

export interface Sample {
  time: number;
  cpu: { total: number; idle: number; iowait: number; cores: number };
  load: [number, number, number];
  uptimeSeconds: number;
  memory: { total: number; available: number; buffersCached: number; swapTotal: number; swapFree: number };
  network: { name: string; rx: number; tx: number; virtual: boolean }[];
  disks: { name: string; readBytes: number; writeBytes: number }[];
  filesystems: { mount: string; size: number; used: number; avail: number }[];
}

function parseSample(out: string): Sample {
  const [time, stat, cores, loadavg, uptime, meminfo, netdev, diskstats, df] = out.split('@@').map((s) => s.trim());

  // cpu  user nice system idle iowait irq softirq steal …
  const cpuFields = stat.split(/\s+/).slice(1).map(Number);
  const total = cpuFields.slice(0, 8).reduce((a, b) => a + b, 0);

  const mem: Record<string, number> = {};
  for (const line of meminfo.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }

  const network = netdev
    .split('\n')
    .slice(2)
    .map((line) => {
      const [name, rest] = line.split(':');
      const f = (rest ?? '').trim().split(/\s+/).map(Number);
      return { name: name.trim(), rx: f[0] ?? 0, tx: f[8] ?? 0, virtual: VIRTUAL_IF.test(name.trim()) };
    })
    .filter((n) => n.name);

  // major minor name reads merged sectors_read … writes merged sectors_written …
  const disks = diskstats
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => WHOLE_DISK.test(f[2] ?? ''))
    .map((f) => ({ name: f[2], readBytes: Number(f[5]) * 512, writeBytes: Number(f[9]) * 512 }));

  const filesystems = df
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [mount, size, used, avail] = line.trim().split(/\s+/);
      return { mount, size: Number(size), used: Number(used), avail: Number(avail) };
    })
    .filter((f) => f.size > 0 && !f.mount.startsWith('/boot/efi'));

  const [l1, l5, l15] = loadavg.split(/\s+/).map(Number);
  return {
    time: Number(time),
    cpu: { total, idle: cpuFields[3] + (cpuFields[4] ?? 0), iowait: cpuFields[4] ?? 0, cores: Number(cores) || 1 },
    load: [l1, l5, l15],
    uptimeSeconds: Number(uptime.split(/\s+/)[0]) || 0,
    memory: {
      total: mem.MemTotal ?? 0,
      available: mem.MemAvailable ?? mem.MemFree ?? 0,
      buffersCached: (mem.Buffers ?? 0) + (mem.Cached ?? 0),
      swapTotal: mem.SwapTotal ?? 0,
      swapFree: mem.SwapFree ?? 0,
    },
    network,
    disks,
    filesystems,
  };
}

export interface Connection {
  proto: string;
  state: string;
  local: string;
  localPort: number;
  peer: string;
  peerPort: number;
  process: string;
  pid: number | null;
}

/** `ss -tunapH`: one line per socket. Listening sockets are left out (they're on the
 *  Ports page); everything else — established, time-wait, … — is a "request". */
export function parseSs(out: string): Connection[] {
  const split = (addr: string): [string, number] => {
    const i = addr.lastIndexOf(':');
    return [addr.slice(0, i).replace(/^\[|\]$/g, '').replace(/%\w+$/, ''), Number(addr.slice(i + 1)) || 0];
  };
  const rows: Connection[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [proto, state, , , local, peer] = f;
    if (state === 'LISTEN' || (proto === 'udp' && state === 'UNCONN')) continue;
    const users = f.slice(6).join(' ');
    const proc = /\("([^"]+)",pid=(\d+)/.exec(users);
    const [localAddr, localPort] = split(local);
    const [peerAddr, peerPort] = split(peer);
    rows.push({
      proto,
      state,
      local: localAddr,
      localPort,
      peer: peerAddr,
      peerPort,
      process: proc?.[1] ?? '',
      pid: proc ? Number(proc[2]) : null,
    });
  }
  return rows;
}

export async function connections(session: SshSession): Promise<Connection[]> {
  // Root sees every process's sockets; unprivileged ss only names its own.
  const out = await run(session, 'ss -tunapH 2>/dev/null', true);
  return parseSs(out.stdout);
}

export function registerMonitor(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/monitor/sample',
    requireSession,
    route(async (req, res) => {
      // Plain exec, no sudo: everything read here is world-readable.
      const out = await exec(req.session!, SAMPLE_SCRIPT, true);
      res.json(parseSample(out.stdout));
    }),
  );

  app.get(
    '/api/monitor/connections',
    requireSession,
    route(async (req, res) => {
      res.json({ connections: await connections(req.session!) });
    }),
  );

  // ------------------------------------------------------------------ logs

  /** The last N lines of a log file. Limited to log locations so this can't become a
   *  general root file reader. `quiet` because the log views poll it. */
  app.get(
    '/api/logs/tail',
    requireSession,
    route(async (req, res) => {
      const path = str(req.query.path);
      need(LOG_PATH.test(path) && !path.includes('..'), 'Only files under /var/log or Docker container logs can be read here');
      const lines = Math.min(20000, Math.max(10, Number(req.query.lines) || 500));
      const out = await run(req.session!, `[ -f ${shellQuote(path)} ] && tail -n ${lines} ${shellQuote(path)} || echo "__MISSING__"`, true);
      const text = out.stdout;
      if (text.trim() === '__MISSING__') {
        res.json({ path, exists: false, lines: [] });
        return;
      }
      const size = await run(req.session!, `stat -c %s ${shellQuote(path)} 2>/dev/null`, true);
      res.json({ path, exists: true, size: Number(size.stdout.trim()) || 0, lines: text.split('\n').filter(Boolean) });
    }),
  );

  // ----------------------------------------------------------------- nginx

  /** A site's own access/error log paths, from its config (nginx's defaults otherwise). */
  app.get(
    '/api/nginx/site-logs',
    requireSession,
    route(async (req, res) => {
      const name = str(req.query.name);
      need(/^[A-Za-z0-9._-]+$/.test(name), 'invalid site name');
      const conf = (await readFile(req.session!, `/etc/nginx/sites-available/${name}`).catch(() => Buffer.from(''))).toString('utf8');
      const first = (directive: string) =>
        [...conf.matchAll(new RegExp(`^\\s*${directive}\\s+([^\\s;]+)`, 'gm'))].map((m) => m[1]).find((p) => p !== 'off') ?? '';
      // Sites can listen on more than 80/443 (the Rayan app is on 10000).
      const ports = [...new Set([...conf.matchAll(/^\s*listen\s+(?:\[::\]:|[\d.]+:)?(\d+)/gm)].map((m) => Number(m[1])))];
      res.json({
        access: first('access_log') || '/var/log/nginx/access.log',
        error: first('error_log') || '/var/log/nginx/error.log',
        ports,
      });
    }),
  );

  /** nginx's processes (CPU, memory) and the connections they hold right now. */
  app.get(
    '/api/nginx/stats',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const [ps, conns] = await Promise.all([
        run(session, 'ps -C nginx -o pid=,pcpu=,rss=,etimes=,args= 2>/dev/null', true),
        connections(session),
      ]);
      const processes = ps.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [pid, cpu, rss, etimes, ...args] = l.trim().split(/\s+/);
          return { pid: Number(pid), cpuPct: Number(cpu), memBytes: Number(rss) * 1024, uptimeSeconds: Number(etimes), command: args.join(' ') };
        });
      res.json({ processes, connections: conns.filter((c) => c.process === 'nginx') });
    }),
  );

  // ---------------------------------------------------------------- docker

  /** Per running container: CPU and memory (docker stats) and exact network byte
   *  counters read from the container's own network namespace. */
  app.get(
    '/api/docker/stats',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const script = [
        `docker stats --no-stream --format '{{json .}}' 2>/dev/null`,
        `echo '@@'`,
        `for id in $(docker ps -q); do pid=$(docker inspect -f '{{.State.Pid}}' "$id"); echo "## $id $pid"; cat /proc/$pid/net/dev 2>/dev/null | tail -n +3; done`,
      ].join('; ');
      const out = await run(session, script, true);
      const [statsPart, netPart = ''] = out.stdout.split('@@');
      const net: Record<string, { pid: number; rx: number; tx: number }> = {};
      let current = '';
      for (const line of netPart.split('\n')) {
        const head = /^## (\w+) (\d+)/.exec(line);
        if (head) {
          current = head[1];
          net[current] = { pid: Number(head[2]), rx: 0, tx: 0 };
          continue;
        }
        const [ifname, rest] = line.split(':');
        if (!current || !rest || ifname.trim() === 'lo') continue;
        const f = rest.trim().split(/\s+/).map(Number);
        net[current].rx += f[0] ?? 0;
        net[current].tx += f[8] ?? 0;
      }
      const time = Date.now();
      const containers = statsPart
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, string>)
        .map((s) => {
          const id = s.ID.slice(0, 12);
          const n = Object.entries(net).find(([k]) => k.startsWith(id))?.[1];
          return {
            id,
            name: s.Name,
            cpuPct: parseFloat(s.CPUPerc) || 0,
            memUsage: s.MemUsage,
            memPct: parseFloat(s.MemPerc) || 0,
            pids: Number(s.PIDs) || 0,
            netRx: n?.rx ?? 0,
            netTx: n?.tx ?? 0,
          };
        });
      res.json({ time, containers });
    }),
  );

  /** Connections inside one container's network namespace. */
  app.get(
    '/api/docker/connections',
    requireSession,
    route(async (req, res) => {
      const pid = Number(req.query.pid);
      need(Number.isInteger(pid) && pid > 1, 'the container is not running');
      const out = await run(req.session!, `nsenter -t ${pid} -n ss -tunapH 2>/dev/null`, true);
      res.json({ connections: parseSs(out.stdout) });
    }),
  );
}

/** /var/log/** and Docker's per-container json logs. */
const LOG_PATH = /^(\/var\/log\/[^\0\n\r"'`$\\]+|\/var\/lib\/docker\/containers\/[0-9a-f]{64}\/[0-9a-f]{64}-json\.log)$/;
