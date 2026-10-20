import { attachAllocator } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { createCredentials, sessionCookie } from '../src/auth.ts';
const TOKEN = 'test-only-password';
const initialCredentials = await createCredentials(TOKEN);
const session = (await sessionCookie(new Request('https://short.example'), {}, initialCredentials)).split(';')[0];
function setup() {
  const store = new Map([['auth:credentials', { value: JSON.stringify(initialCredentials) }]]);
  let reads = 0;
  const env = {
    ADMIN_TOKEN: TOKEN,
    LINKS: {
      async get(key) { reads++; return store.has(key) ? JSON.parse(store.get(key).value) : null; },
      async put(key, value, options) { store.set(key, { value, ...options }); },
      async delete(key) { store.delete(key); },
      async list({ prefix, limit, cursor }) {
        const keys = [...store].filter(([key]) => key.startsWith(prefix)).sort(([a],[b]) => a.localeCompare(b));
        const offset = Number(cursor || 0);
        return { keys: keys.slice(offset, offset + limit).map(([name, value]) => ({ name, metadata: value.metadata })), list_complete: offset + limit >= keys.length, cursor: String(offset + limit) };
      },
    },
    ASSETS: { async fetch(request) {
      // Match Workers Assets' canonical HTML handling, not a generic file server.
      if (new URL(request.url).pathname === '/index.html') return new Response(null, { status: 307, headers: { Location: '/' } });
      return new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } });
    } },
  };
  attachAllocator(env);
  const request = (path, { authenticated = true, method = 'GET', body, headers = {} } = {}) => worker.fetch(new Request(`https://short.example${path}`, { method, headers: { ...(authenticated ? { Cookie: session } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
  const create = (body = { url: 'https://example.org/path?q=한글' }) => request('/api/links', { method: 'POST', body });
  return { env, store, request, create, reads: () => reads };
}
test('anonymous users cannot read, create, or delete links', async () => {
  const s = setup();
  for (const [path, method] of [['/api/links','GET'],['/api/links','POST'],['/api/links/abcdefghijklmnop','DELETE']]) {
    assert.equal((await s.request(path, { method, authenticated: false })).status, 401);
  }
  assert.equal(s.store.size, 1); assert.equal(s.reads(), 3);
});
test('invalid cookie fails closed; unconfigured credentials require first setup', async () => {
  const s = setup();
  assert.equal((await s.request('/api/links', { headers: { Cookie: 'bad' } })).status, 401);
  s.store.delete('auth:credentials');
  assert.equal((await s.request('/api/links')).status, 409);
});
test('create → anonymous redirect → list → delete → not found', async () => {
  const s = setup(); const response = await s.create(); assert.equal(response.status, 201);
  const link = await response.json(); assert.equal(link.code, 'a');
  assert.equal(s.store.size, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(s.store.get(`link:${link.code}`).metadata)) < 1024);
  const redirect = await s.request(`/${link.code}`, { authenticated: false });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('Location'), new URL('https://example.org/path?q=한글').href);
  assert.equal(redirect.headers.get('Cache-Control'), 'no-store');
  const head = await s.request(`/${link.code}`, { method: 'HEAD', authenticated: false });
  assert.equal(head.status, 302); assert.equal(await head.text(), '');
  const page = await (await s.request('/api/links')).json(); assert.equal(page.links[0].url, link.url); assert.equal(page.cursor, null);
  assert.equal((await s.request(`/api/links/${link.code}`, { method: 'DELETE' })).status, 200);
  assert.equal((await s.request(`/${link.code}`, { authenticated: false })).status, 404);
});
test('expiration stored in KV and enforced even with stale KV data', async () => {
  const s = setup(); const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const r = await s.create({ url: 'https://example.org', expiresAt }); assert.equal(r.status, 201);
  const { code } = await r.json(); const record = s.store.get(`link:${code}`);
  assert.equal(record.expiration, Math.floor(Date.parse(expiresAt) / 1000));
  const data = JSON.parse(record.value); data.expiresAt = Math.floor(Date.now() / 1000) - 1; record.value = JSON.stringify(data);
  assert.equal((await s.request(`/${code}`, { authenticated: false })).status, 404);
  assert.deepEqual((await (await s.request('/api/links')).json()).links, []);
});
test('invalid URL, self loop, credentials, and unsafe schemes rejected', async () => {
  const s = setup();
  for (const url of ['javascript:alert(1)', 'data:text/plain,hi', 'ftp://example.org', '/relative', 'https://short.example/admin', 'https://short.example:8080/foo', 'https://user:password@example.org', 'not a URL', 'https://example.org/' + 'a'.repeat(4096)]) {
    assert.equal((await s.create({ url })).status, 400, url.slice(0, 70));
  }
  assert.equal(s.store.size, 1);
});
test('invalid expiry rejected; absent expiry remains permanent', async () => {
  const s = setup();
  for (const expiresAt of ['bad', 123, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 10000).toISOString()]) assert.equal((await s.create({ url: 'https://example.org', expiresAt })).status, 400);
  assert.equal((await s.create()).status, 201); assert.equal([...s.store.values()].find(v => v.metadata)?.expiration, undefined);
});
test('cross-origin mutations, malformed JSON, and oversized bodies rejected', async () => {
  const s = setup();
  assert.equal((await s.request('/api/links', { method: 'POST', body: { url: 'https://example.org' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await s.request('/api/links', { method: 'POST', body: { url: 'https://example.org' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await s.request('/api/links', { method: 'POST', body: { url: 'https://example.org', padding: 'a'.repeat(9000) } })).status, 400);
  const bad = new Request('https://short.example/api/links', { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal((await worker.fetch(bad, s.env)).status, 400); assert.equal(s.store.size, 1);
});
test('pagination covers all records, not limited to the first page', async () => {
  const s = setup();
  for (let i = 0; i < 55; i++) assert.equal((await s.create({ url: `https://example.org/${i}` })).status, 201);
  const first = await (await s.request('/api/links')).json(); assert.equal(first.links.length, 50); assert.ok(first.cursor);
  const second = await (await s.request(`/api/links?cursor=${first.cursor}`)).json(); assert.equal(second.links.length, 5); assert.equal(second.cursor, null);
  assert.equal(new Set([...first.links, ...second.links].map(x => x.code)).size, 55);
});
test('public shell has security headers and no secrets, invalid routes skip KV', async () => {
  const s = setup();
  for (const path of ['/', '/admin', '/admin/']) {
    const response = await s.request(path, { authenticated: false }); assert.equal(response.status, 200); assert.equal(response.headers.get('X-Frame-Options'), 'DENY'); assert.ok(!((await response.text()).includes(TOKEN)));
  }
  for (const path of ['/nope!', '/abc/def', '/robots.txt']) assert.equal((await s.request(path, { authenticated: false })).status, 404);
  assert.equal(s.reads(), 0);
  assert.equal((await s.request('/abcdefghijklmnop', { authenticated: false, method: 'POST' })).status, 405);
});
test('KV failures do not leak internal errors', async () => {
  const s = setup(); s.env.LINKS.get = async () => { throw new Error('private-service-details'); };
  const r = await s.request('/abcdefghijklmnop', { authenticated: false }); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('private-service-details'));
});
