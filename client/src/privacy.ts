import { reactive } from 'vue';
import * as api from './api';

const SHOW_KEY = 'ssh-fb.showMyIp';

function readShow(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) === '1';
  } catch {
    return false;
  }
}

/** Your own public IP(s) — the browser's (as the API sees it) and the SSH session's —
 *  hidden in connection lists and logs unless you choose to show them. */
export const privacy = reactive({ myIps: [] as string[], show: readShow(), loaded: false });

/** Loopback and private ranges aren't "your public IP", so they're never hidden. */
const isPublic = (ip: string) =>
  Boolean(ip) && !/^(127\.|::1$|::$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|fc|fd)/i.test(ip);

export async function loadMyIps(): Promise<void> {
  if (privacy.loaded) return;
  try {
    const me = await api.whoami();
    privacy.myIps = [...new Set([me.browserIp, me.sshClientIp].filter(isPublic))];
  } catch {
    privacy.myIps = [];
  } finally {
    privacy.loaded = true;
  }
}

export function resetMyIps(): void {
  privacy.myIps = [];
  privacy.loaded = false;
}

export function setShowMyIp(show: boolean): void {
  privacy.show = show;
  try {
    localStorage.setItem(SHOW_KEY, show ? '1' : '0');
  } catch {
    /* private mode */
  }
}

export const isMine = (ip: string) => privacy.myIps.includes(ip.replace(/^::ffff:/, ''));

/** What to display for an address: "you" when it's yours and hidden. */
export const showIp = (ip: string) => (isMine(ip) && !privacy.show ? 'you (hidden)' : ip);
