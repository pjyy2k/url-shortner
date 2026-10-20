// Redirects also accept legacy codes that may start with '-' or '_'.
export const LINK_CODE = /^[A-Za-z0-9_-]{1,32}$/;
export const CUSTOM_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const RESERVED_CODES = new Set(['api', 'admin']);
export function reservedCode(code: string) { return RESERVED_CODES.has(code.toLowerCase()); }
export function sequenceIndex(code: string): number | null {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = 0;
  for (const character of code) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    value = value * 62 + digit + 1;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value - 1;
}
