import type { FileApp, SavedServer, Shortcut, ViewMode } from './types';

const OPEN_WITH = 'ssh-fb.openWith';
const VIEW = 'ssh-fb.view';
const HIGHLIGHT = 'ssh-fb.highlight';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private-mode browsers can refuse to store; preferences are optional.
  }
}

/** Remembered choice of app per file type, e.g. { svg: 'editor', png: 'image' }. */
export function openWithMap(): Record<string, FileApp> {
  return read<Record<string, FileApp>>(OPEN_WITH, {});
}

export function rememberOpenWith(typeKey: string, app: FileApp): void {
  write(OPEN_WITH, { ...openWithMap(), [typeKey]: app });
}

export function forgetOpenWith(typeKey: string): void {
  const map = openWithMap();
  delete map[typeKey];
  write(OPEN_WITH, map);
}

export function viewMode(): ViewMode {
  return read<ViewMode>(VIEW, 'list');
}

export function setViewMode(mode: ViewMode): void {
  write(VIEW, mode);
}

export function highlightEnabled(): boolean {
  return read<boolean>(HIGHLIGHT, true);
}

export function setHighlightEnabled(enabled: boolean): void {
  write(HIGHLIGHT, enabled);
}

// ------------------------------------------------------------ saved servers

const SERVERS = 'ssh-fb.servers';
const SHORTCUTS = 'ssh-fb.shortcuts';

export const serverId = (s: { host: string; port: number; username: string }) =>
  `${s.username}@${s.host}:${s.port}`;

export function savedServers(): SavedServer[] {
  return read<SavedServer[]>(SERVERS, []).sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Called after a successful login; keeps an existing label and password unless replaced. */
export function rememberServer(entry: Omit<SavedServer, 'id' | 'lastUsed'>, keepPassword: boolean) {
  const id = serverId(entry);
  const list = savedServers();
  const existing = list.find((s) => s.id === id);
  const next: SavedServer = {
    ...existing,
    ...entry,
    id,
    lastUsed: Date.now(),
    label: entry.label || existing?.label,
  };
  if (!keepPassword) delete next.password;
  write(SERVERS, [next, ...list.filter((s) => s.id !== id)]);
}

export function updateServer(id: string, patch: Partial<SavedServer>): void {
  write(
    SERVERS,
    savedServers().map((s) => (s.id === id ? { ...s, ...patch } : s)),
  );
}

export function forgetServer(id: string): void {
  write(
    SERVERS,
    savedServers().filter((s) => s.id !== id),
  );
}

// --------------------------------------------------------------- shortcuts

/** Shortcuts are per server: a path on one box means nothing on another. */
export function shortcuts(server: string): Shortcut[] {
  return read<Record<string, Shortcut[]>>(SHORTCUTS, {})[server] ?? [];
}

export function saveShortcuts(server: string, list: Shortcut[]): void {
  const all = read<Record<string, Shortcut[]>>(SHORTCUTS, {});
  all[server] = list;
  write(SHORTCUTS, all);
}
