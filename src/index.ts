import { allocateLink } from './links.ts';
import type { Link, AllocatorEnv } from './links.ts';
import { credentials, checkPassword, changePassword, sessionCookie, validSession, clearCookie, newApiKey, apiKeyHash, validApiKey } from './auth.ts';
export { SetupGate } from './setup.ts';
export { GuestQuota } from './guest.ts';
export { CodeAllocator } from './codes.ts';

interface KV {
  get<T = Link>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string, options?: { metadata?: unknown; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list<T = Omit<Link, 'url'>>(options: { prefix: string; limit: number; cursor?: string }): Promise<{ keys: { name: string; metadata?: T }[]; list_complete: boolean; cursor?: string }>;
}
interface Env extends AllocatorEnv { LINKS: KV; GUEST_QUOTA?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }; SETUP_GATE?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }; GUEST_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }; LOGIN_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }; ASSETS: { fetch(request: Request): Promise<Response> } }
const CODE = /^(?:[A-Za-z0-9]{1,9}|[A-Za-z0-9_-]{16})$/;
const SECURITY = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new Error('Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function safeTarget(value: unknown, origin: URL): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hostname === origin.hostname) return null;
    return target.href.length <= 4096 ? target.href : null;
  } catch { return null; }
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api' || path.startsWith('/api/')) {
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    if (path === '/api/guest/links') {
      if (request.method !== 'POST') return json({ error: '게스트는 링크 생성만 가능합니다.' }, 405, { Allow: 'POST' });
      if (env.GUEST_RATE_LIMITER) {
        const limit = await env.GUEST_RATE_LIMITER.limit({ key: `url-shortner-guest:${request.headers.get('CF-Connecting-IP') || 'unknown'}` });
        if (!limit.success) return json({ error: '생성 요청이 많습니다. 1분 후 다시 시도하세요.' }, 429, { 'Retry-After': '60' });
      }
      if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'JSON 요청이 필요합니다.' }, 415);
      let body;
      try { body = await readBody(request); } catch { return json({ error: '요청 형식이 잘못되었거나 너무 큽니다.' }, 400); }
      const target = safeTarget(body?.url, url);
      if (!target) return json({ error: '유효한 외부 HTTP/HTTPS URL을 입력하세요.' }, 400);
      if (!env.GUEST_QUOTA) return json({ error: '게스트 생성 기능을 배포해 주세요.' }, 503);
      const quota = env.GUEST_QUOTA.get(env.GUEST_QUOTA.idFromName('all-guests-global-daily'));
      // Only the normalized URL reaches the quota gate; callers cannot override expiry or role.
      const result = await quota.fetch(new Request('https://quota.internal/', { method: 'POST', body: JSON.stringify({ url: target }) }));
      return json(await result.json(), result.status);
    }
    if (path === '/api/auth/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });
    if (['/api/auth/login', '/api/auth/setup'].includes(path) && request.method === 'POST' && env.LOGIN_RATE_LIMITER) {
      const limit = await env.LOGIN_RATE_LIMITER.limit({ key: `url-shortner-login:${request.headers.get('CF-Connecting-IP') || 'unknown'}` });
      if (!limit.success) return json({ error: '로그인 시도가 많습니다. 1분 후 다시 시도하세요.' }, 429, { 'Retry-After': '60' });
    }
    const stored = await credentials(env);
    if (path === '/api/auth/session' && request.method === 'GET' && !stored) return json({ setupRequired: true });
    if (path === '/api/auth/setup' && request.method === 'POST') {
      if (stored) return json({ error: '이미 관리자 비밀번호가 설정되어 있습니다.' }, 409);
      if (!env.SETUP_GATE) return json({ error: '최초 설정 기능을 배포해 주세요.' }, 503);
      let body;
      try { body = await readBody(request); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
      const password = body?.password;
      if (typeof password !== 'string' || password.length < 10 || password.length > 128 || /[\r\n\x00]/.test(password)) return json({ error: '비밀번호는 10~128자로 입력하세요.' }, 400);
      const gate = env.SETUP_GATE.get(env.SETUP_GATE.idFromName('administrator-first-setup'));
      const result = await gate.fetch(new Request('https://setup.internal/', { method: 'POST', body: JSON.stringify({ password }) }));
      return json(await result.json(), result.status);
    }
    if (!stored) return json({ error: '먼저 관리자 비밀번호를 설정하세요.', setupRequired: true }, 409);
    if (path === '/api/auth/login' && request.method === 'POST') {
      let body;
      try { body = await readBody(request); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
      if (!await checkPassword(body?.password, env, stored)) return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
      return json({ ok: true, passwordChanged: !!stored }, 200, { 'Set-Cookie': await sessionCookie(request, env, stored) });
    }
    const admin = await validSession(request, env, stored);
    const authenticated = admin || ((path === '/api/links' || path.startsWith('/api/links/')) && await validApiKey(request, env));
    if (!authenticated) return json({ error: '관리자 로그인이 필요합니다.' }, 401);
    if (path === '/api/auth/session' && request.method === 'GET') return json({ ok: true, passwordChanged: !!stored });
    if (path === '/api/auth/password' && request.method === 'POST') {
      let body;
      try { body = await readBody(request); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
      if (!await checkPassword(body?.currentPassword, env, stored)) return json({ error: '현재 비밀번호가 올바르지 않습니다.' }, 400);
      const next = body?.newPassword;
      if (typeof next !== 'string' || next.length < 10 || next.length > 128 || /[\r\n\x00]/.test(next)) return json({ error: '새 비밀번호는 10~128자로 입력하세요.' }, 400);
      if (await checkPassword(next, env, stored)) return json({ error: '현재와 다른 비밀번호를 입력하세요.' }, 400);
      await changePassword(next, env);
      return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });
    }
    if (path === '/api/keys' && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && cursor.length > 2048) return json({ error: '잘못된 페이지입니다.' }, 400);
      const page = await env.LINKS.list<{ name: string; createdAt: string }>({ prefix: 'apikey:', limit: 50, cursor });
      return json({ keys: page.keys.map(k => ({ id: k.name.slice(7), ...k.metadata })), cursor: page.list_complete ? null : page.cursor });
    }
    if (path === '/api/keys' && request.method === 'POST') {
      let body;
      try { body = await readBody(request); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
      if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80) return json({ error: '키 이름을 1~80자로 입력하세요.' }, 400);
      const key = newApiKey();
      const id = await apiKeyHash(key);
      const metadata = { name: body.name.trim(), createdAt: new Date().toISOString() };
      await env.LINKS.put(`apikey:${id}`, JSON.stringify({ version: 1, ...metadata }), { metadata });
      return json({ key, id, ...metadata }, 201);
    }
    const keyDeletion = path.match(/^\/api\/keys\/([a-f0-9]{64})$/);
    if (keyDeletion && request.method === 'DELETE') {
      await env.LINKS.delete(`apikey:${keyDeletion[1]}`);
      return json({ ok: true });
    }
    if (path === '/api/links' && request.method === 'GET') {
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && cursor.length > 2048) return json({ error: '잘못된 페이지입니다.' }, 400);
      const page = await env.LINKS.list({ prefix: 'link:', limit: 50, cursor });
      const now = Math.floor(Date.now() / 1000);
      const records = await Promise.all(page.keys.map(async k => ({ code: k.name.slice(5), link: await env.LINKS.get(k.name, 'json') })));
      return json({ links: records.filter(r => r.link && (!r.link.expiresAt || r.link.expiresAt > now)).map(r => ({ code: r.code, ...r.link })), cursor: page.list_complete ? null : page.cursor });
    }
    if (path === '/api/links' && request.method === 'POST') {
      if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'JSON 요청이 필요합니다.' }, 415);
      let body;
      try { body = await readBody(request); } catch { return json({ error: '요청 형식이 잘못되었거나 너무 큽니다.' }, 400); }
      const target = safeTarget(body?.url, url);
      if (!target) return json({ error: '유효한 외부 HTTP/HTTPS URL을 입력하세요. 인증정보가 포함된 URL은 허용되지 않습니다.' }, 400);
      let expiresAt: number | null = null;
      if (body.expiresAt !== null && body.expiresAt !== undefined && body.expiresAt !== '') {
        const parsed = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
        expiresAt = Math.floor(parsed / 1000);
        if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) + 60) return json({ error: '만료일은 현재보다 1분 이상 이후여야 합니다.' }, 400);
      }
      const link: Link = { url: target, createdAt: new Date().toISOString(), expiresAt, createdBy: 'admin' };
      const result = await allocateLink(env, link);
      return json(await result.json(), result.status);
    }
    const deletion = path.match(/^\/api\/links\/([A-Za-z0-9]{1,9}|[A-Za-z0-9_-]{16})$/);
    if (deletion && request.method === 'DELETE') {
      await env.LINKS.delete(`link:${deletion[1]}`);
      return json({ ok: true });
    }
    return json({ error: '지원하지 않는 API 또는 메서드입니다.' }, 404);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...SECURITY, Allow: 'GET, HEAD' } });
  if (['/', '/admin', '/admin/', '/app.js', '/style.css'].includes(path)) {
    const assetURL = new URL(request.url);
    // Use the canonical directory URL: ASSETS redirects /index.html to /.
    if (['/', '/admin', '/admin/'].includes(path)) assetURL.pathname = '/';
    const asset = await env.ASSETS.fetch(new Request(assetURL, request));
    const response = new Response(request.method === 'HEAD' ? null : asset.body, asset);
    for (const [key, value] of Object.entries(SECURITY)) response.headers.set(key, value);
    return response;
  }
  const code = path.slice(1);
  if (!CODE.test(code)) return new Response('링크를 찾을 수 없습니다.', { status: 404, headers: SECURITY });
  const link = await env.LINKS.get(`link:${code}`, 'json');
  if (!link || (link.expiresAt !== null && link.expiresAt <= Math.floor(Date.now() / 1000))) return new Response('존재하지 않거나 만료된 링크입니다.', { status: 404, headers: SECURITY });
  const target = safeTarget(link.url, url);
  if (!target) return new Response('잘못된 링크입니다.', { status: 404, headers: SECURITY });
  return new Response(null, { status: 302, headers: { ...SECURITY, Location: target } });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch { return json({ error: '처리하지 못했습니다. 잠시 후 다시 시도하세요.' }, 503); }
  },
};
