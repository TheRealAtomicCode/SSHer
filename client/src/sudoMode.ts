import { reactive } from 'vue';

/** Whether File Explorer / archive / permissions actions escalate with sudo.
 *  Off by default and reset on reload — an explicit, visible choice per
 *  session rather than a setting that silently persists. */
export const sudoMode = reactive({ enabled: false, warnedOnce: false });

export function toggleSudoMode(): void {
  if (!sudoMode.enabled && !sudoMode.warnedOnce) {
    const ok = confirm(
      'Turn on sudo mode?\n\n' +
        'File Explorer actions (delete, rename, move, compress, extract, permissions) ' +
        'will run as root until you turn this off again. Everything else in SSHer ' +
        '(Docker, nginx, .NET, the firewall) already runs elevated regardless of this switch.',
    );
    if (!ok) return;
    sudoMode.warnedOnce = true;
  }
  sudoMode.enabled = !sudoMode.enabled;
}
