import type { Link } from './links.ts';
interface State {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
}
interface Env { LINKS: { put(key: string, value: string, options: { metadata: unknown; expiration?: number }): Promise<void> } }
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RESERVED = new Set(['api', 'admin']);
// Bijective base 62: a ... 9, aa ... 99, aaa ... . Every shorter length is used first.
export function encodeCode(index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER) throw new Error('Code sequence exhausted or corrupted');
  let value = index + 1;
  let code = '';
  while (value > 0) {
    value--;
    code = ALPHABET[value % 62] + code;
    value = Math.floor(value / 62);
  }
  return code;
}
export class CodeAllocator {
  private state: State;
  private env: Env;
  constructor(state: State, env: Env) { this.state = state; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const link = await request.json() as Link;
    if (!link || typeof link.url !== 'string' || typeof link.createdAt !== 'string' || !(link.expiresAt === null || Number.isSafeInteger(link.expiresAt))) return Response.json({ error: 'Invalid link' }, { status: 400 });
    return this.state.blockConcurrencyWhile(async () => {
      let next = (await this.state.storage.get<number>('next')) ?? 0;
      let code = encodeCode(next);
      while (RESERVED.has(code)) { next++; code = encodeCode(next); }
      // Never reuse an allocated code, including deleted, expired, or uncertain failed writes.
      await this.state.storage.put('next', next + 1);
      await this.env.LINKS.put(`link:${code}`, JSON.stringify(link), {
        metadata: { createdAt: link.createdAt, expiresAt: link.expiresAt, createdBy: link.createdBy },
        ...(link.expiresAt !== null ? { expiration: link.expiresAt } : {}),
      });
      return Response.json({ code, ...link }, { status: 201 });
    });
  }
}
