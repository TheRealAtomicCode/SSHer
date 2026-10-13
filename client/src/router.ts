import type { View } from './types';

/** Where you are in SSHer, as it appears in the URL hash:
 *
 *    #/monitor
 *    #/files/etc/nginx/sites-available
 *    #/docker/devisehr-prod-hr-api-1/network
 *    #/logs/ssher-web-ssher-web-1
 *
 *  A hash, not a path, so it works the same in the Vite dev server, behind nginx, and
 *  in the Docker image without any server-side fallback rules. */
export interface Route {
  view: View;
  /** File Explorer folder. */
  path?: string;
  /** Docker / Logs: the selected container's name. */
  container?: string;
  /** Docker: the open tab in the container panel. */
  tab?: string;
}

const VIEWS: readonly View[] = [
  'home', 'monitor', 'security', 'files', 'shortcuts', 'links', 'users', 'processes',
  'nginx', 'docker', 'dotnet', 'logs', 'ports', 'postgres', 'dbtransfer', 'backups',
];

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const view = parts[0] as View;
  if (!VIEWS.includes(view)) return null;
  const rest = parts.slice(1);
  if (view === 'files') {
    const path = `/${rest.filter((s, i) => s || i === rest.length - 1).map(dec).join('/')}`.replace(/(.)\/$/, '$1');
    return { view, path: path || '/' };
  }
  if (view === 'docker') return { view, container: rest[0] ? dec(rest[0]) : undefined, tab: rest[1] || undefined };
  // Logs: the container; Transfer: the database.
  if (view === 'logs' || view === 'dbtransfer') return { view, container: rest[0] ? dec(rest[0]) : undefined };
  return { view };
}

export function routeToHash(r: Route): string {
  const enc = encodeURIComponent;
  if (r.view === 'files') {
    const path = r.path && r.path !== '/' ? r.path.split('/').map(enc).join('/') : '/';
    return `#/files${path}`;
  }
  if (r.view === 'docker' && r.container) {
    return `#/docker/${enc(r.container)}${r.tab && r.tab !== 'overview' ? `/${enc(r.tab)}` : ''}`;
  }
  if ((r.view === 'logs' || r.view === 'dbtransfer') && r.container) return `#/${r.view}/${enc(r.container)}`;
  return `#/${r.view}`;
}
