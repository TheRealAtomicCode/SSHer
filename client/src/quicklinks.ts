import type { ServiceName } from './api';

// Hard-coded config locations, grouped by the service they belong to. The paths are
// the standard Debian/Ubuntu ones plus what the DeviseHR VPS actually uses; any that
// don't exist on the connected server are greyed out rather than hidden.

export interface QuickLink {
  path: string;
  title: string;
  /** What the file is for, in a sentence. */
  what: string;
  dir?: boolean;
  /** Edit this through its own tool, not by hand. */
  caution?: string;
}

export interface ServiceControl {
  action: string;
  label: string;
  icon: string;
  tone?: 'danger' | 'primary';
  /** Shown in a confirm() before running. */
  confirm?: string;
}

export interface QuickGroup {
  id: ServiceName;
  title: string;
  icon: string;
  accent: string;
  blurb: string;
  controls: ServiceControl[];
  /** Offered after saving one of this group's files. */
  afterSave?: { action: string; label: string };
  links: QuickLink[];
}

export const QUICK_GROUPS: QuickGroup[] = [
  {
    id: 'nginx',
    title: 'nginx',
    icon: 'fa-globe',
    accent: 'emerald',
    blurb: 'The web server on ports 80/443. It sends each domain to the right container.',
    controls: [
      { action: 'test', label: 'Test config', icon: 'fa-check' },
      { action: 'reload', label: 'Reload', icon: 'fa-sync-alt', tone: 'primary' },
      { action: 'restart', label: 'Restart', icon: 'fa-redo' },
      { action: 'start', label: 'Start', icon: 'fa-play' },
      {
        action: 'stop',
        label: 'Stop',
        icon: 'fa-stop',
        tone: 'danger',
        confirm: 'Stop nginx?\n\nEvery website on this server (devisehr.ly, app., op., operators., the Rayan app) goes offline until it is started again.',
      },
    ],
    afterSave: { action: 'reload', label: 'Test & reload nginx' },
    links: [
      { path: '/etc/nginx/sites-available/devisehr', title: 'DeviseHR site', what: 'Maps devisehr.ly, app., op. and operators. to the four containers (ports 3001/3000/5001/5000), Cloudflare real-IP and upload limits.' },
      { path: '/etc/nginx/sites-available/rayanapp', title: 'Rayan app site', what: 'Serves /var/www/rayanapp on port 10000 and proxies /api to the .NET service on 10001.' },
      { path: '/etc/nginx/nginx.conf', title: 'Main config', what: 'Global settings: worker processes, gzip, logging format, and the include of sites-enabled/*.' },
      { path: '/etc/nginx/sites-enabled', title: 'Enabled sites', what: 'Symlinks to the sites that are live. Remove a link to disable a site without deleting it.', dir: true },
      { path: '/etc/nginx/sites-available', title: 'All sites', what: 'Every site file, enabled or not. New sites made by the Docker wizard go here.', dir: true },
      { path: '/var/log/nginx', title: 'Logs', what: 'access and error logs per site — first place to look for 502s and 413s.', dir: true },
    ],
  },
  {
    id: 'docker',
    title: 'Docker',
    icon: 'fa-docker',
    accent: 'sky',
    blurb: 'Runs the DeviseHR containers. Compose files describe them; .env.prod feeds them settings.',
    controls: [
      { action: 'restart', label: 'Restart Docker', icon: 'fa-redo', confirm: 'Restart the Docker daemon?\n\nEvery container stops and comes back (those with a restart policy). Expect ~10–30 s of downtime for all apps.' },
      { action: 'start', label: 'Start', icon: 'fa-play' },
      {
        action: 'stop',
        label: 'Stop',
        icon: 'fa-stop',
        tone: 'danger',
        confirm: 'Stop Docker entirely?\n\nAll containers stop — DeviseHR HR and Operator are down until Docker is started again.',
      },
    ],
    links: [
      { path: '/opt/DeviseHR/docker-compose.prod.yml', title: 'Compose: services', what: 'The four services, which ghcr.io image each runs, env file, volumes (uploads/storage) and host.docker.internal.' },
      { path: '/opt/DeviseHR/docker-compose.prod.override.yml', title: 'Compose: ports', what: 'Binds each container to 127.0.0.1:3000/3001/5000/5001 so only nginx can reach them.' },
      { path: '/opt/DeviseHR/.env.prod', title: '.env.prod', what: 'Database connection, JWT secrets, CORS origins, URLs. Apply with Docker → Apply (up -d). VITE_* values need an image rebuild.', caution: 'Contains secrets' },
      { path: '/opt/DeviseHR', title: 'DeviseHR project', what: 'The repo checkout the compose project runs from (devise.sh, publish.sh, deploy docs).', dir: true },
      { path: '/root/deploy-keep', title: 'Deploy backups', what: 'Saved copies of the prod compose files from a previous deploy.', dir: true },
      { path: '/etc/docker/daemon.json', title: 'Daemon config', what: 'Engine-wide settings such as log size limits and registry mirrors. Often absent — defaults apply.' },
      { path: '/root/.docker/config.json', title: 'Registry login', what: 'Saved credentials for ghcr.io, used by docker pull.', caution: 'Contains a token' },
    ],
  },
  {
    id: 'ufw',
    title: 'Firewall (ufw)',
    icon: 'fa-shield-alt',
    accent: 'rose',
    blurb: 'Decides which ports the internet can reach. Docker-published ports bypass it.',
    controls: [
      { action: 'reload', label: 'Reload rules', icon: 'fa-sync-alt', tone: 'primary' },
      { action: 'enable', label: 'Enable', icon: 'fa-shield-alt', confirm: 'Enable ufw?\n\nAn allow rule for your SSH port is added first so you stay connected.' },
      {
        action: 'disable',
        label: 'Disable',
        icon: 'fa-unlock',
        tone: 'danger',
        confirm: 'Disable the firewall?\n\nEvery listening port (including PostgreSQL 5432) becomes reachable from the internet.',
      },
    ],
    afterSave: { action: 'reload', label: 'Reload ufw' },
    links: [
      { path: '/etc/default/ufw', title: 'Defaults', what: 'Default policies (deny incoming / allow outgoing / routed) and whether IPv6 rules are managed.' },
      { path: '/etc/ufw/user.rules', title: 'Your rules (IPv4)', what: 'Where ufw stores the rules you add with ufw allow/deny — what the Ports page shows.', caution: 'Prefer the Ports page; ufw rewrites this file' },
      { path: '/etc/ufw/user6.rules', title: 'Your rules (IPv6)', what: 'The IPv6 copy of the rules above.', caution: 'Prefer the Ports page; ufw rewrites this file' },
      { path: '/etc/ufw/before.rules', title: 'Before rules', what: 'Raw iptables applied before your rules: loopback, ICMP/ping, DHCP, and where NAT/port-forwarding goes.' },
      { path: '/etc/ufw/after.rules', title: 'After rules', what: 'Raw iptables applied after your rules — rarely needed.' },
      { path: '/etc/ufw/applications.d', title: 'App profiles', what: 'Named port sets like "OpenSSH" or "Nginx Full" that rules can refer to.', dir: true },
    ],
  },
  {
    id: 'postgresql',
    title: 'PostgreSQL',
    icon: 'fa-hdd',
    accent: 'amber',
    blurb: 'The database on the host (port 5432). The containers reach it via host.docker.internal.',
    controls: [
      { action: 'reload', label: 'Reload config', icon: 'fa-sync-alt', tone: 'primary' },
      { action: 'restart', label: 'Restart', icon: 'fa-redo', confirm: 'Restart PostgreSQL?\n\nOpen connections drop; the apps reconnect after a few seconds.' },
      { action: 'start', label: 'Start', icon: 'fa-play' },
      { action: 'stop', label: 'Stop', icon: 'fa-stop', tone: 'danger', confirm: 'Stop PostgreSQL?\n\nDeviseHR cannot log anyone in or save anything until it is started again.' },
    ],
    afterSave: { action: 'reload', label: 'Reload PostgreSQL' },
    links: [
      { path: '/etc/postgresql/15/main/pg_hba.conf', title: 'pg_hba.conf', what: 'Who may connect from where: the Docker range 172.16.0.0/12, your 156.38.55.198, and a wide-open 0.0.0.0/0 line. Reload after editing.' },
      { path: '/etc/postgresql/15/main/postgresql.conf', title: 'postgresql.conf', what: 'Server settings — listen_addresses, max_connections, memory. listen_addresses changes need a restart.' },
      { path: '/var/log/postgresql', title: 'Logs', what: 'Failed logins and errors — check here when the API says it cannot reach the database.', dir: true },
      { path: '/root/db-backups', title: 'DB backups', what: 'Dumps taken before deploys and migrations.', dir: true },
    ],
  },
];

export const ALL_QUICK_PATHS = QUICK_GROUPS.flatMap((g) => g.links.map((l) => l.path));
