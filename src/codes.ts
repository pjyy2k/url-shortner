import { CUSTOM_CODE, reservedCode, sequenceIndex } from './code-format.ts';
import type { Link } from './links.ts';
interface State {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
}
interface Env { LINKS: { get(key: string, type: 'json'): Promise<unknown>; put(key: string, value: string, options: { metadata: unknown; expiration?: number }): Promise<void> } }
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
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
    const payload = await request.json() as Link & { customCode?: unknown };
    const { customCode, ...link } = payload || {};
    if (!link || typeof link.url !== 'string' || typeof link.createdAt !== 'string' || !(link.expiresAt === null || Number.isSafeInteger(link.expiresAt))) return Response.json({ error: 'Invalid link' }, { status: 400 });
    return this.state.blockConcurrencyWhile(async () => {
      let next = (await this.state.storage.get<number>('next')) ?? 0;
      // Validate persisted state even for a custom request; never reset a corrupted counter.
      encodeCode(next);
      let code: string;
      if (customCode !== undefined && customCode !== '') {
        if (typeof customCode !== 'string' || !CUSTOM_CODE.test(customCode) || reservedCode(customCode)) return Response.json({ error: '단축 코드는 영문·숫자로 시작하는 1~32자의 영문·숫자·하이픈·밑줄이어야 합니다. api, admin은 사용할 수 없습니다.' }, { status: 400 });
        code = customCode;
        const index = sequenceIndex(code);
        if ((index !== null && index < next) || await this.state.storage.get<boolean>(`claimed:${code}`)) return Response.json({ error: '이미 사용되었거나 배정된 단축 코드입니다.' }, { status: 409 });
        // Stable legacy records predate this registry. All new writes share this Object.
        if (await this.env.LINKS.get(`link:${code}`, 'json')) {
          await this.state.storage.put(`claimed:${code}`, true);
          return Response.json({ error: '이미 사용 중인 단축 코드입니다.' }, { status: 409 });
        }
        await this.state.storage.put(`claimed:${code}`, true);
      } else {
        code = encodeCode(next);
        while (reservedCode(code) || await this.state.storage.get<boolean>(`claimed:${code}`)) { next++; code = encodeCode(next); }
        // Never reuse an allocated code, including deleted, expired, or uncertain failed writes.
        await this.state.storage.put('next', next + 1);
      }
      await this.env.LINKS.put(`link:${code}`, JSON.stringify(link), {
        metadata: { createdAt: link.createdAt, expiresAt: link.expiresAt, createdBy: link.createdBy },
        ...(link.expiresAt !== null ? { expiration: link.expiresAt } : {}),
      });
      return Response.json({ code, ...link }, { status: 201 });
    });
  }
}
