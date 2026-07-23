const positive = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;

export function estimatedTokens(chars: number): number {
  return Math.ceil(positive(chars) / 4);
}

export function jsonChars(value: unknown): number {
  try { return JSON.stringify(value).length; }
  catch { return 0; }
}

export { positive };
