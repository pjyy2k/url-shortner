interface State {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
}
interface Env { LINKS: { put(key: string, value: string, options: { expiration: number; metadata: unknown }): Promise<void> } }
interface Daily { date: string; count: number }
// One named Object for the whole service, not one Object per IP or user.
export class GuestQuota {
  private state: State;
  private env: Env;
  constructor(state: State, env: Env) { this.state = state; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const body = await request.json() as { url?: unknown };
    if (typeof body?.url !== 'string') return Response.json({ error: 'Invalid URL' }, { status: 400 });
    const target = body.url;
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const date = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const previous = await this.state.storage.get<Daily>('daily');
      const daily = previous?.date === date ? previous : { date, count: 0 };
      if (daily.count >= 100) return Response.json({ error: '오늘의 게스트 생성 한도 100개에 도달했습니다. 한국시간 자정 이후 다시 이용하세요.' }, { status: 429 });
      // Reserve durably before writing KV. An uncertain failed write never allows an overshoot.
      await this.state.storage.put('daily', { date, count: daily.count + 1 });
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
      const expiresAt = Math.floor(now / 1000) + 7 * 24 * 60 * 60;
      const link = { url: target, createdAt: new Date(now).toISOString(), expiresAt, createdBy: 'guest' };
      await this.env.LINKS.put(`link:${code}`, JSON.stringify(link), { expiration: expiresAt, metadata: { createdAt: link.createdAt, expiresAt, createdBy: 'guest' } });
      return Response.json({ code, ...link }, { status: 201 });
    });
  }
}
