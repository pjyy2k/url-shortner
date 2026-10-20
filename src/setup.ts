import { AUTH_KEY, credentials, createCredentials, checkPassword } from './auth.ts';
import type { AuthEnv, Credentials } from './auth.ts';
interface State {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<unknown> };
}
const reply = (data: unknown, status = 200) => Response.json(data, { status });
// Only handles initial ownership. Normal login, password changes and links use KV.
export class SetupGate {
  private state: State;
  private env: AuthEnv;
  constructor(state: State, env: AuthEnv) { this.state = state; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
    const body = await request.json() as { password?: unknown };
    const password = body?.password;
    if (typeof password !== 'string' || password.length < 10 || password.length > 128 || /[\r\n\x00]/.test(password)) return reply({ error: '비밀번호는 10~128자로 입력하세요.' }, 400);
    return this.state.blockConcurrencyWhile(async () => {
      if (await this.state.storage.get<boolean>('initialized')) return reply({ error: '최초 설정이 완료되었습니다. 잠시 후 로그인하세요.' }, 409);
      // A pending record allows retry after a failed KV write, with the same password only.
      let pending = await this.state.storage.get<Credentials>('pending');
      if (pending) {
        if (!await checkPassword(password, this.env, pending)) return reply({ error: '다른 최초 설정이 진행 중입니다.' }, 409);
      } else {
        if (await credentials(this.env)) {
          await this.state.storage.put('initialized', true);
          return reply({ error: '이미 비밀번호가 설정되어 있습니다.' }, 409);
        }
        pending = await createCredentials(password);
        await this.state.storage.put('pending', pending);
      }
      await this.env.LINKS.put(AUTH_KEY, JSON.stringify(pending));
      await this.state.storage.put('initialized', true);
      await this.state.storage.delete('pending');
      return reply({ ok: true });
    });
  }
}
