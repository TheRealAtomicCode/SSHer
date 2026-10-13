import { reactive } from 'vue';

/** The sudo password dialog. Any number of requests can fail at once (a page loads
 *  several things in parallel); they all wait on the same prompt. */
export const sudoPrompt = reactive({
  open: false,
  /** The error that triggered it, e.g. "sudo: a password is required". */
  reason: '',
  /** True when a remembered password was tried and refused. */
  savedRejected: false,
});

let waiting: Promise<boolean> | null = null;
let settle: ((ok: boolean) => void) | null = null;

export function askForSudoPassword(reason: string): Promise<boolean> {
  if (waiting) return waiting;
  sudoPrompt.reason = reason;
  sudoPrompt.open = true;
  waiting = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return waiting;
}

/** Called by the dialog: true once sudo accepted a password, false on cancel. */
export function finishSudoPrompt(ok: boolean): void {
  sudoPrompt.open = false;
  settle?.(ok);
  waiting = null;
  settle = null;
}
