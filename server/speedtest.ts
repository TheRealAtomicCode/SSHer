// Internet speed test of the SERVER's own connection (not the browser's): curl on the
// server against Cloudflare's speed-test endpoints (speed.cloudflare.com — the same
// ones its web speed test uses). Run as the login user; nothing needs root. One phase
// per request, so the page can show each result as soon as it is in.
//
// A single transfer under-measures a fast link (TCP is still ramping up when it ends),
// so download and upload each run STREAMS transfers in parallel for at most
// SECONDS, and the result is all bytes moved / wall time. curl's -w still reports the
// bytes of a transfer cut off by --max-time, so a slow link is measured the same way.
import type { Express, Response } from 'express';
import { badRequestRoute, need, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { exec, type SshSession } from './ssh.js';

const BASE = 'https://speed.cloudflare.com';
const STREAMS = 4;
const SECONDS = 8;
/** __down refuses 100 MB and up. */
const DOWN_BYTES = 99_000_000;
const UP_BYTES = 25_000_000;

/** Sums the bytes the parallel curls report and divides by the wall time. */
function parallel(curl: string): string {
  return `
    start=$(date +%s%N)
    for i in $(seq ${STREAMS}); do ${curl} > /tmp/ssher-speed-$$-$i 2>/dev/null & done
    wait
    ms=$(( ($(date +%s%N) - start) / 1000000 ))
    bytes=0
    for i in $(seq ${STREAMS}); do b=$(cut -d. -f1 /tmp/ssher-speed-$$-$i 2>/dev/null); bytes=$((bytes + \${b:-0})); rm -f /tmp/ssher-speed-$$-$i; done
    echo "$bytes $ms"
  `;
}

const SCRIPTS = {
  // TCP connect time (minus DNS) of 5 fresh connections; the client takes the best.
  // The cf-ray header's suffix is the Cloudflare location that answered (e.g. MXP).
  latency: `
    for i in 1 2 3 4 5; do curl -s -o /dev/null --max-time 5 -w '%{time_namelookup} %{time_connect}\\n' '${BASE}/__down?bytes=0'; done
    curl -s -o /dev/null -D - --max-time 5 '${BASE}/__down?bytes=0' | tr -d '\\r' | grep -i '^cf-ray:'
  `,
  download: parallel(`curl -s -o /dev/null --max-time ${SECONDS} -w '%{size_download}' '${BASE}/__down?bytes=${DOWN_BYTES}'`),
  upload: parallel(
    `head -c ${UP_BYTES} /dev/zero | curl -s -o /dev/null --max-time ${SECONDS} -w '%{size_upload}' -H 'content-type: application/octet-stream' --data-binary @- '${BASE}/__up'`,
  ),
};
type Phase = keyof typeof SCRIPTS;

async function runPhase(session: SshSession, phase: Phase) {
  const out = (await exec(session, SCRIPTS[phase])).stdout;
  if (phase === 'latency') {
    const rtts = out
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((f) => f.length === 2 && f[1] > 0)
      .map(([dns, connect]) => (connect - dns) * 1000);
    need(rtts.length, 'Could not reach speed.cloudflare.com from the server — is it online, with working DNS?');
    const colo = /cf-ray:\s*\S+-([A-Z]{3})/i.exec(out)?.[1] ?? '';
    return { latencyMs: Math.round(Math.min(...rtts) * 10) / 10, location: colo };
  }
  const [bytes, ms] = out.trim().split(/\s+/).map(Number);
  need(bytes > 0 && ms > 0, `The ${phase} test moved no data — the server could not reach speed.cloudflare.com.`);
  return { mbps: Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10, bytes, seconds: ms / 1000 };
}

export function registerSpeedTest(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.post(
    '/api/system/speedtest',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const phase = str(req.body?.phase) as Phase;
      need(phase in SCRIPTS, 'phase must be latency, download or upload');
      if (phase === 'latency') {
        const curl = await exec(session, 'command -v curl >/dev/null 2>&1 && echo yes');
        need(curl.stdout.trim() === 'yes', 'curl is not installed on the server. Install it with: apt-get install -y curl');
      }
      res.json(await runPhase(session, phase));
    }),
  );
}
