interface Link { url: string; createdAt: string; expiresAt: number | null }
interface KV {
  get(key: string, type: 'json'): Promise<Link | null>;
  put(key: string, value: string, options: { metadata: Omit<Link, 'url'>; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{ keys: { name: string; metadata?: Omit<Link, 'url'> }[]; list_complete: boolean; cursor?: string }>;
}
interface Env { LINKS: KV; ADMIN_TOKEN?: string; ASSETS: { fetch(request: Request): Promise<Response> } }
const CODE = /^[A-Za-z0-9_-]{16}$/;
const SECURITY = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8' } });
}
async function authorized(request: Request, token: string) {
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 512) return false;
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${token}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
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
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api' || path.startsWith('/api/')) {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || env.ADMIN_TOKEN.length > 256 || /[\s]/.test(env.ADMIN_TOKEN)) return json({ error: '관리자 토큰 설정을 확인하세요.' }, 503);
    if (!await authorized(request, env.ADMIN_TOKEN)) return json({ error: '관리자 인증이 필요합니다.' }, 401);
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
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
      const link: Link = { url: target, createdAt: new Date().toISOString(), expiresAt };
      // 96 random bits: no shared sequence or read-then-write uniqueness assumption.
      const code = newCode();
      await env.LINKS.put(`link:${code}`, JSON.stringify(link), { metadata: { createdAt: link.createdAt, expiresAt }, ...(expiresAt ? { expiration: expiresAt } : {}) });
      return json({ code, ...link }, 201);
    }
    const deletion = path.match(/^\/api\/links\/([A-Za-z0-9_-]{16})$/);
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
