// Tiny terminal-formatting helper. Honors NO_COLOR and non-TTY output (clig.dev: respect
// NO_COLOR; only style when stdout is a real terminal). Symbols stay ASCII-safe in meaning.

const useColor = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

// Status glyphs. Plain marks so they render in any UTF-8 terminal incl. Windows Terminal.
export const sym = {
  ok: c.green("✓"),
  bad: c.red("✗"),
  warn: c.yellow("!"),
  dot: c.dim("•"),
  arrow: c.cyan("→"),
};

export const line = (s = "") => console.log(s);
export const step = (s: string) => console.log(`  ${s}`);
