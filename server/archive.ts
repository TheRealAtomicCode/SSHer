// Compress / extract over the same SSH session everything else uses — shells out to
// zip/unzip/tar/7z/unrar, nothing installed on the remote side. Also exports the zip
// command builder so Phase D's drag-out-to-desktop endpoint can stream a multi-file
// zip without duplicating the quoting logic.
import posix from 'node:path/posix';
import type { Express, Response } from 'express';
import { badRequestRoute, execMaybeRoot, execMaybeRootOrThrow, need, RE, str, type AsyncRoute, type SessionRequest } from './ops.js';
import { exec, execChannel, shellQuote as shQuote, type SshSession } from './ssh.js';

// ------------------------------------------------------------------ helpers

export type CompressFormat = 'zip' | 'tar.gz' | 'tar.bz2' | 'tar.xz';

const COMPRESS_EXT: Record<CompressFormat, string> = {
  zip: '.zip',
  'tar.gz': '.tar.gz',
  'tar.bz2': '.tar.bz2',
  'tar.xz': '.tar.xz',
};

/** Tools each compress format needs. */
const COMPRESS_TOOL: Record<CompressFormat, string[]> = {
  zip: ['zip'],
  'tar.gz': ['tar', 'gzip'],
  'tar.bz2': ['tar', 'bzip2'],
  'tar.xz': ['tar', 'xz'],
};

type ExtractFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | '7z' | 'rar';

/** Longest suffix first, so `.tar.gz` matches before a bare `.gz` would. */
const EXTRACT_SUFFIXES: [string, ExtractFormat][] = [
  ['.tar.gz', 'tar.gz'],
  ['.tgz', 'tar.gz'],
  ['.tar.bz2', 'tar.bz2'],
  ['.tbz2', 'tar.bz2'],
  ['.tar.xz', 'tar.xz'],
  ['.txz', 'tar.xz'],
  ['.tar', 'tar'],
  ['.zip', 'zip'],
  ['.7z', '7z'],
  ['.rar', 'rar'],
];

function detectExtractFormat(name: string): { format: ExtractFormat; base: string } | null {
  const lower = name.toLowerCase();
  for (const [suffix, format] of EXTRACT_SUFFIXES) {
    if (lower.endsWith(suffix)) return { format, base: name.slice(0, name.length - suffix.length) };
  }
  return null;
}

const EXTRACT_TOOL: Record<ExtractFormat, string[]> = {
  zip: ['unzip'],
  tar: ['tar'],
  'tar.gz': ['tar'],
  'tar.bz2': ['tar'],
  'tar.xz': ['tar'],
  '7z': ['7z'],
  rar: ['unrar'],
};

interface Support {
  zip: boolean;
  unzip: boolean;
  tar: boolean;
  gzip: boolean;
  bzip2: boolean;
  xz: boolean;
  sevenZip: boolean;
  unrar: boolean;
}

async function checkSupport(session: SshSession): Promise<Support> {
  const tools = ['zip', 'unzip', 'tar', 'gzip', 'bzip2', 'xz', '7z', 'unrar'];
  const script = tools.map((t) => `command -v ${t} >/dev/null 2>&1 && echo "${t} yes"`).join('; ');
  const out = await exec(session, script);
  const found = new Set(out.stdout.split('\n').map((l) => l.trim().split(' ')[0]).filter(Boolean));
  return {
    zip: found.has('zip'),
    unzip: found.has('unzip'),
    tar: found.has('tar'),
    gzip: found.has('gzip'),
    bzip2: found.has('bzip2'),
    xz: found.has('xz'),
    sevenZip: found.has('7z'),
    unrar: found.has('unrar'),
  };
}

function canCompress(support: Support, format: CompressFormat): boolean {
  return COMPRESS_TOOL[format].every((t) =>
    t === 'zip' ? support.zip : t === 'tar' ? support.tar : t === 'gzip' ? support.gzip : t === 'bzip2' ? support.bzip2 : support.xz,
  );
}

function canExtract(support: Support, format: ExtractFormat): boolean {
  return EXTRACT_TOOL[format].every((t) =>
    t === 'unzip' ? support.unzip : t === 'tar' ? support.tar : t === '7z' ? support.sevenZip : support.unrar,
  );
}

/** Validates that every path sits directly inside the same directory (what a File
 *  Explorer selection always is), and returns {dir, names}. */
function sameParent(paths: string[]): { dir: string; names: string[] } {
  need(paths.length > 0, 'No files selected');
  const dir = posix.dirname(paths[0]);
  const names: string[] = [];
  for (const p of paths) {
    need(RE.absPath.test(p), `Invalid path: ${p}`);
    need(posix.dirname(p) === dir, 'All selected items must be in the same folder');
    names.push(posix.basename(p));
  }
  return { dir, names };
}

/** The `zip`/`tar` command that builds `name` from `names`, run from inside `dir`.
 *  Exported so the drag-out-to-desktop download can build the same command for a
 *  throwaway archive streamed straight to the HTTP response. */
export function compressCommand(dir: string, names: string[], name: string, format: CompressFormat): string {
  const cd = `cd ${shQuote(dir)}`;
  const args = names.map(shQuote).join(' ');
  if (format === 'zip') return `${cd} && zip -r -X -- ${shQuote(name)} ${args}`;
  const flag = format === 'tar.gz' ? 'czf' : format === 'tar.bz2' ? 'cjf' : 'cJf';
  return `${cd} && tar ${flag} ${shQuote(name)} -- ${args}`;
}

/** Same archive, written to stdout instead of a named file — used to stream a
 *  throwaway zip straight into an HTTP response (the drag-out-to-desktop download). */
function compressStreamCommand(dir: string, names: string[], format: CompressFormat): string {
  const cd = `cd ${shQuote(dir)}`;
  const args = names.map(shQuote).join(' ');
  if (format === 'zip') return `${cd} && zip -r -X -q - -- ${args}`;
  const flag = format === 'tar.gz' ? 'czf' : format === 'tar.bz2' ? 'cjf' : 'cJf';
  return `${cd} && tar ${flag} - -- ${args}`;
}

// ------------------------------------------------------------------- routes

export function registerArchive(app: Express, requireSession: import('express').RequestHandler, asyncRoute: AsyncRoute): void {
  const route = (handler: (req: SessionRequest, res: Response) => Promise<void>) => badRequestRoute(asyncRoute, handler);

  app.get(
    '/api/archive/support',
    requireSession,
    route(async (req, res) => {
      const support = await checkSupport(req.session!);
      res.json({
        compress: {
          zip: canCompress(support, 'zip'),
          'tar.gz': canCompress(support, 'tar.gz'),
          'tar.bz2': canCompress(support, 'tar.bz2'),
          'tar.xz': canCompress(support, 'tar.xz'),
        },
        extract: {
          zip: canExtract(support, 'zip'),
          tar: canExtract(support, 'tar'),
          'tar.gz': canExtract(support, 'tar.gz'),
          'tar.bz2': canExtract(support, 'tar.bz2'),
          'tar.xz': canExtract(support, 'tar.xz'),
          '7z': canExtract(support, '7z'),
          rar: canExtract(support, 'rar'),
        },
      });
    }),
  );

  /** Drag-out-to-desktop for a multi-selection or a folder: a throwaway zip (or tar.*)
   *  built just-in-time and piped straight to the response — never written to disk on
   *  either side. GET + query string because this is loaded by the browser's own
   *  download machinery (triggered by a `DownloadURL` drag, not `fetch`), the same
   *  reason `/api/download` takes `sid`/`key` as query params instead of headers. */
  app.get(
    '/api/archive/download-zip',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(String(req.query.paths ?? '[]'));
      } catch {
        parsed = [];
      }
      const list = (Array.isArray(parsed) ? parsed : []).map(String);
      const { dir, names } = sameParent(list);

      const support = await checkSupport(session);
      const requested = str(req.query.format) as CompressFormat;
      const priority: CompressFormat[] = [requested, 'zip', 'tar.gz', 'tar.bz2', 'tar.xz'];
      const format = priority.find((f) => f in COMPRESS_EXT && canCompress(support, f));
      need(format, 'No archive tool (zip/tar) is available on this server');

      let name = (str(req.query.name) || 'files').replace(/[/\\]/g, '_');
      if (!name.toLowerCase().endsWith(COMPRESS_EXT[format])) name += COMPRESS_EXT[format];

      const channel = await execChannel(session, compressStreamCommand(dir, names, format));

      res.setHeader('Content-Type', format === 'zip' ? 'application/zip' : 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      let stderr = '';
      channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      channel.on('close', (code: number | null) => {
        if (code) console.error(`[archive] download-zip exited ${code}: ${stderr.trim()}`);
      });
      channel.on('error', (err: Error) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.destroy(err);
      });
      channel.pipe(res);
    }),
  );

  app.post(
    '/api/archive/compress',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const paths: string[] = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : [];
      const { dir, names } = sameParent(paths);

      const format = str(req.body?.format) as CompressFormat;
      need(format in COMPRESS_EXT, 'Unsupported archive format');

      let name = str(req.body?.name) || 'Archive';
      need(!name.includes('/'), 'Name cannot contain "/"');
      if (!name.toLowerCase().endsWith(COMPRESS_EXT[format])) name += COMPRESS_EXT[format];

      const support = await checkSupport(session);
      need(canCompress(support, format), `${format} is not supported on this server (missing ${COMPRESS_TOOL[format].join('/')})`);

      const sudo = Boolean(req.body?.sudo);
      const target = posix.join(dir, name);
      if (!req.body?.overwrite) {
        const exists = await execMaybeRoot(session, `[ -e ${shQuote(target)} ] && echo yes || true`, sudo);
        need(exists.stdout.trim() !== 'yes', `${name} already exists — tick overwrite or pick another name`);
      }

      await execMaybeRootOrThrow(session, compressCommand(dir, names, name, format), sudo);
      res.json({ ok: true, path: target });
    }),
  );

  app.post(
    '/api/archive/extract',
    requireSession,
    route(async (req, res) => {
      const session = req.session!;
      const path = str(req.body?.path);
      need(RE.absPath.test(path), 'Invalid path');

      const detected = detectExtractFormat(posix.basename(path));
      need(detected, 'Not a recognized archive type');
      const { format, base } = detected;

      const support = await checkSupport(session);
      need(canExtract(support, format), `.${format.split('.').pop()} archives need ${EXTRACT_TOOL[format].join('/')}, which isn't installed on this server`);

      const parent = posix.dirname(path);
      const dest = str(req.body?.dest) || posix.join(parent, base);
      need(RE.absPath.test(dest), 'Invalid destination');

      const sudo = Boolean(req.body?.sudo);
      if (!req.body?.overwrite) {
        const exists = await execMaybeRoot(session, `[ -e ${shQuote(dest)} ] && echo yes || true`, sudo);
        need(exists.stdout.trim() !== 'yes', `${posix.basename(dest)} already exists here — tick overwrite or pick another destination`);
      }

      await execMaybeRootOrThrow(session, `mkdir -p -- ${shQuote(dest)}`, sudo);
      const cmd =
        format === 'zip'
          ? `unzip -o -q ${shQuote(path)} -d ${shQuote(dest)}`
          : format === '7z'
            ? `7z x -y -o${shQuote(dest)} ${shQuote(path)}`
            : format === 'rar'
              ? `unrar x -o+ ${shQuote(path)} ${shQuote(dest)}/`
              : `tar xf ${shQuote(path)} -C ${shQuote(dest)}`;
      await execMaybeRootOrThrow(session, cmd, sudo);
      res.json({ ok: true, path: dest });
    }),
  );
}
