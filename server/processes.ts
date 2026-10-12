// Process list + signal — always elevated (same bucket as users.ts/Docker/
// nginx), since killing another user's process needs root regardless of the
// File Explorer's sudo-mode toggle, and this isn't a File Explorer action.
import type { Express, Response } from 'express';
import { badRequestRoute, need, runOrThrow, str, type AsyncRoute, type SessionRequest } from './ops.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  etime: string;
  stat: string;
  command: string;
}

// pid, ppid, user, %cpu, %mem, etime and stat never contain whitespace; args
// (the command line) can, so it's last and takes the rest of the line.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/;

function parsePs(output: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      cpu: Number(m[4]),
      mem: Number(m[5]),
      etime: m[6],
      stat: m[7],
      command: m[8].trim(),
    });
  }
  return rows;
}

const SIGNALS = ['TERM', 'KILL', 'HUP', 'INT'] as const;

export function registerProcesses(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/processes',
    requireSession,
    route(async (req, res) => {
      const out = await runOrThrow(req.session!, 'ps -eo pid,ppid,user,pcpu,pmem,etime,stat,args --no-headers --sort=-pcpu 2>&1');
      res.json({ processes: parsePs(out) });
    }),
  );

  app.post(
    '/api/processes/:pid/signal',
    requireSession,
    route(async (req, res) => {
      const pid = Number(req.params.pid);
      // pid 1 is init — killing it panics the whole machine; pid 0 means
      // "every process in the caller's own process group" to kill(2), never
      // what a single-row "kill" button should do.
      need(Number.isInteger(pid) && pid > 1, 'Refusing to signal that pid');
      const signal = str(req.body?.signal).toUpperCase();
      need((SIGNALS as readonly string[]).includes(signal), 'invalid signal');
      // No extra wrapping: runOrThrow already throws on a non-zero exit using
      // the combined output, which for `kill` is the actually useful part
      // ("Operation not permitted", "No such process") — a wrapper that
      // substitutes its own generic message would only hide that.
      const output = await runOrThrow(req.session!, `kill -${signal} ${pid} 2>&1`);
      res.json({ ok: true, output: output || 'ok' });
    }),
  );
}
