/** Minimal ANSI styling for the dev CLIs; plain text when not a terminal. */

const tty = Deno.stdout.isTerminal();
const wrap = (code: number) => (s: string): string =>
  tty ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = wrap(1);
export const dim = wrap(2);
export const cyan = wrap(36);
export const green = wrap(32);
export const yellow = wrap(33);

/** Locale-grouped integer (12345 -> "12,345"). */
export const n = (x: number): string => x.toLocaleString("en-US");
