import { openWithMap } from './prefs';
import type { FileApp, RemoteFile } from './types';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'sql', 'html', 'css', 'scss', 'json', 'yml', 'yaml', 'toml',
  'xml', 'ini', 'conf', 'env', 'dockerfile', 'lua', 'pl', 'swift', 'kt',
]);
const TEXT = new Set(['txt', 'md', 'log', 'csv', 'rst', 'cfg', 'lock', 'gitignore', 'license']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'deb', 'rpm']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv']);

// Extension-less files you would reach for nano to edit. Dotfiles (.bashrc) and
// anything else without an extension are treated as text anyway, so this list
// only needs the names that would otherwise be ambiguous.
const NANO_NAMES = new Set([
  'makefile', 'dockerfile', 'jenkinsfile', 'vagrantfile', 'gemfile', 'rakefile', 'procfile',
  'readme', 'license', 'licence', 'changelog', 'authors', 'contributing', 'notice', 'todo',
  'crontab', 'fstab', 'hosts', 'passwd', 'group', 'sudoers', 'shadow', 'hostname',
  'sshd_config', 'ssh_config', 'known_hosts', 'authorized_keys', 'motd', 'issue',
  'resolv.conf', 'nginx.conf', 'my.cnf', 'php.ini', 'inputrc', 'profile', 'bashrc',
]);

export function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** The key an "open with" preference is remembered under: the extension, or the
 *  bare filename for extension-less files like `Dockerfile`. */
export function typeKey(file: RemoteFile): string {
  return extension(file.name) || file.name.toLowerCase();
}

export function typeLabel(file: RemoteFile): string {
  const ext = extension(file.name);
  return ext ? `.${ext}` : file.name;
}

/** What this file opens in when the user has expressed no preference. */
export function defaultApp(file: RemoteFile): FileApp {
  if (isImage(file)) return 'image';
  if (isText(file) || NANO_NAMES.has(file.name.toLowerCase())) return 'editor';
  return 'download';
}

/** The remembered choice for this file type, falling back to the default. */
export function appFor(file: RemoteFile): FileApp {
  return openWithMap()[typeKey(file)] ?? defaultApp(file);
}

export function isImage(file: RemoteFile): boolean {
  return !file.isDirectory && IMAGE.has(extension(file.name));
}

/** Files we are willing to render in the text viewer. Extensionless files are
 *  treated as text too — dotfiles and scripts like `Makefile` usually are. */
export function isText(file: RemoteFile): boolean {
  if (file.isDirectory) return false;
  const ext = extension(file.name);
  if (!ext) return true;
  return TEXT.has(ext) || CODE.has(ext);
}

export function iconFor(file: RemoteFile): string {
  if (file.isDirectory) return 'fa-folder';
  const ext = extension(file.name);
  if (IMAGE.has(ext)) return 'fa-file-image';
  if (CODE.has(ext)) return 'fa-file-code';
  if (ARCHIVE.has(ext)) return 'fa-file-archive';
  if (AUDIO.has(ext)) return 'fa-file-audio';
  if (VIDEO.has(ext)) return 'fa-file-video';
  if (ext === 'pdf') return 'fa-file-pdf';
  if (TEXT.has(ext) || !ext) return 'fa-file-alt';
  return 'fa-file';
}

export function iconColor(file: RemoteFile): string {
  if (file.isDirectory) return 'text-sky-400';
  const ext = extension(file.name);
  if (IMAGE.has(ext)) return 'text-purple-400';
  if (CODE.has(ext)) return 'text-emerald-400';
  if (ARCHIVE.has(ext)) return 'text-amber-400';
  if (AUDIO.has(ext)) return 'text-pink-400';
  if (VIDEO.has(ext)) return 'text-rose-400';
  if (ext === 'pdf') return 'text-red-400';
  return 'text-slate-400';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Renders the low 9 mode bits the way `ls -l` does. */
export function formatMode(mode: number): string {
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) {
    out += mode & (1 << (8 - i)) ? bits[i] : '-';
  }
  return out;
}

/** Quotes a path for a shell only when it needs it. */
export function cdCommand(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? `cd ${path}` : `cd '${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Cleans up whatever gets pasted into the path box. People paste a shell line as
 * readily as a bare path — including the `cd '/var/log'` this app hands out — so
 * strip a leading `cd`, surrounding quotes and a trailing slash, and expand `~`.
 */
export function normalizePathInput(raw: string, home: string): string {
  let value = raw.trim();
  if (!value) return home;

  value = value.replace(/^cd\s+/i, '').trim();

  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length > 1) {
    value = value.slice(1, -1);
    // Undo the '\'' dance that shell-quoting a single quote produces.
    if (quote === "'") value = value.replace(/'\\''/g, "'");
  }

  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = `${home === '/' ? '' : home}${value.slice(1)}`;

  // Keep a lone "/" but drop a trailing slash anywhere else.
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http hosts.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }
}
