import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { sessionCookie, createCredentials } from '../src/auth.ts';
const PASSWORD = 'initial-password-for-tests';
const initialCredentials = await createCredentials(PASSWORD);
function setup() {
  const store = new Map([['auth:credentials', { value: JSON.stringify(initialCredentials) }]]); let lists = 0;
  const env = { ADMIN_PASSWORD: PASSWORD, LINKS: {
    async get(key) { return store.has(key) ? JSON.parse(store.get(key).value) : null; },
    async put(key, value, options = {}) { store.set(key, { value, ...options }); },
    async delete(key) { store.delete(key); },
    async list({ prefix, limit, cursor }) {
      lists++; const entries = [...store].filter(([key]) => key.startsWith(prefix)); const offset = Number(cursor || 0);
      return { keys: entries.slice(offset,offset+limit).map(([name,v]) => ({ name,metadata:v.metadata })), list_complete: offset+limit>=entries.length, cursor: String(offset+limit) };
    },
  }, ASSETS: {async fetch() {return new Response('Login');}} };
  const request = (path, options = {}) => {
    const { method = 'GET', body, cookie, bearer, origin } = options;
    return worker.fetch(new Request(`https://short.example${path}`, { method, headers: { ...(cookie?{Cookie:cookie}:{}), ...(bearer?{Authorization:`Bearer ${bearer}`} : {}), ...(body?{'Content-Type':'application/json'}:{}), ...(origin?{Origin:origin}:{}) }, ...(body?{body:JSON.stringify(body)}:{}) }),env);
  };
  async function login(password = PASSWORD) { const response = await request('/api/auth/login', {method:'POST',body:{password}}); return {response,cookie:response.headers.get('Set-Cookie')?.split(';')[0]}; }
  return {env, store, request, login, lists:()=>lists};
}
test('password login issues an HttpOnly secure cookie and survives new requests without browser storage', async () => {
  const s=setup();
  assert.equal((await s.login('wrong')).response.status,401);
  const {response,cookie}=await s.login(); assert.equal(response.status,200);
  const header=response.headers.get('Set-Cookie');
  for(const attribute of ['HttpOnly','Secure','SameSite=Strict','Path=/','Max-Age=604800']) assert.ok(header.includes(attribute));
  assert.equal((await s.request('/api/auth/session',{cookie})).status,200);
  assert.equal((await s.request('/api/links',{cookie})).status,200);
  assert.equal((await s.request('/api/auth/session')).status,401);
});
test('password hash is salted; changing password invalidates prior sessions and legacy token', async () => {
  const s=setup();s.env.ADMIN_TOKEN='old-admin-token-that-is-at-least-32-characters';
  const {cookie}=await s.login();
  const response=await s.request('/api/auth/password',{method:'POST',cookie,body:{currentPassword:PASSWORD,newPassword:'my-new-password-2026'}});
  assert.equal(response.status,200);assert.ok(response.headers.get('Set-Cookie').includes('Max-Age=0'));
  const saved=s.store.get('auth:credentials').value;assert.ok(!saved.includes('my-new-password-2026'));assert.ok(!saved.includes(PASSWORD));
  const config=JSON.parse(saved);assert.match(config.salt,/^[a-f0-9]{32}$/);assert.equal(config.iterations,100000);
  assert.equal((await s.request('/api/auth/session',{cookie})).status,401);
  assert.equal((await s.request('/api/links',{bearer:s.env.ADMIN_TOKEN})).status,401);
  assert.equal((await s.login(PASSWORD)).response.status,401);
  const next=await s.login('my-new-password-2026');assert.equal(next.response.status,200);
  assert.equal((await s.request('/api/links',{cookie:next.cookie})).status,200);
});
test('password change requires authenticated current password, validates length and prevents cross-origin changes', async () => {
  const s=setup();const {cookie}=await s.login();
  const body={currentPassword:PASSWORD,newPassword:'new-valid-password'};
  assert.equal((await s.request('/api/auth/password',{method:'POST',body})).status,401);
  assert.equal((await s.request('/api/auth/password',{method:'POST',cookie,body:{...body,currentPassword:'wrong'}})).status,400);
  assert.equal((await s.request('/api/auth/password',{method:'POST',cookie,body:{...body,newPassword:'short'}})).status,400);
  assert.equal((await s.request('/api/auth/password',{method:'POST',cookie,body:{...body,newPassword:PASSWORD}})).status,400);
  assert.equal((await s.request('/api/auth/password',{method:'POST',cookie,body,origin:'https://evil.example'})).status,403);
  assert.equal(s.store.get('auth:credentials').value,JSON.stringify(initialCredentials));
});
test('tampered, expired and cross-host cookies are rejected', async () => {
  const s=setup();const {cookie}=await s.login();
  const tampered=cookie.slice(0,-1)+(cookie.endsWith('a')?'b':'a');
  assert.equal((await s.request('/api/auth/session',{cookie:tampered})).status,401);
  const foreign=await worker.fetch(new Request('https://other.example/api/auth/session',{headers:{Cookie:cookie}}),s.env);assert.equal(foreign.status,401);
  const original=Date.now;
  let expired;
  try { Date.now=()=>original()-8*24*3600*1000; expired=await sessionCookie(new Request('https://short.example/'),s.env,initialCredentials); }
  finally {Date.now=original;}
  assert.equal((await s.request('/api/auth/session',{cookie:expired.split(';')[0]})).status,401);
});
test('logout clears the session cookie', async () => {
  const s=setup();const {cookie}=await s.login();
  const r=await s.request('/api/auth/logout',{method:'POST',cookie});assert.equal(r.status,200);assert.ok(r.headers.get('Set-Cookie').includes('Max-Age=0'));
});
test('opening login and checking session never lists links; authorized link listing does', async () => {
  const s=setup();await s.request('/admin');await s.request('/api/auth/session');await s.login();assert.equal(s.lists(),0);
  const {cookie}=await s.login();await s.request('/api/links',{cookie});assert.equal(s.lists(),1);
});
test('API key is shown only on creation, stored as a hash, and can manage links', async () => {
  const s=setup();const {cookie}=await s.login();
  const issued=await s.request('/api/keys',{method:'POST',cookie,body:{name:'iPhone shortcut'}});assert.equal(issued.status,201);
  const key=await issued.json();assert.match(key.key,/^usk_[a-f0-9]{64}$/);assert.match(key.id,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify([...s.store]).includes(key.key));
  const list=await s.request('/api/keys',{cookie});const listText=await list.text();assert.ok(!listText.includes(key.key));assert.ok(listText.includes('iPhone shortcut'));
  const created=await s.request('/api/links',{method:'POST',bearer:key.key,body:{url:'https://example.org'}});assert.equal(created.status,201);
  const link=await created.json();assert.equal((await s.request('/'+link.code)).status,302);
  const links=await (await s.request('/api/links',{bearer:key.key})).json();assert.equal(links.links.length,1);
  assert.equal((await s.request('/api/links/'+link.code,{method:'DELETE',bearer:key.key})).status,200);
});
test('API keys cannot change passwords or issue/revoke keys; admin can revoke a key', async () => {
  const s=setup();const {cookie}=await s.login();
  const key=await (await s.request('/api/keys',{method:'POST',cookie,body:{name:'test'}})).json();
  for(const [path,method,body] of [['/api/auth/password','POST',{currentPassword:PASSWORD,newPassword:'new-password'}],['/api/keys','GET'],['/api/keys','POST',{name:'extra'}],['/api/keys/'+key.id,'DELETE']]) assert.equal((await s.request(path,{method,body,bearer:key.key})).status,401);
  assert.equal((await s.request('/api/keys/'+key.id,{method:'DELETE',cookie})).status,200);
  assert.equal((await s.request('/api/links',{bearer:key.key})).status,401);
});
test('changing password preserves explicitly issued API keys for integrations', async () => {
  const s=setup();const {cookie}=await s.login();
  const key=await (await s.request('/api/keys',{method:'POST',cookie,body:{name:'integration'}})).json();
  await s.request('/api/auth/password',{method:'POST',cookie,body:{currentPassword:PASSWORD,newPassword:'replacement-password'}});
  assert.equal((await s.request('/api/links',{bearer:key.key})).status,200);
});
test('API key names are required and invalid keys cannot authenticate', async () => {
  const s=setup();const {cookie}=await s.login();
  for(const name of ['', ' ', 'a'.repeat(81)]) assert.equal((await s.request('/api/keys',{method:'POST',cookie,body:{name}})).status,400);
  assert.equal((await s.request('/api/links',{bearer:'usk_'+'a'.repeat(64)})).status,401);
});
test('login rate limit returns 429 before password verification', async () => {
  const s=setup(); let attempts=0;
  s.env.LOGIN_RATE_LIMITER={async limit({key}) {assert.ok(key.startsWith('url-shortner-login:'));return {success:++attempts<=2};}};
  assert.equal((await s.login()).response.status,200);
  assert.equal((await s.login('wrong')).response.status,401);
  const third=await s.login(); assert.equal(third.response.status,429);assert.equal(third.response.headers.get('Retry-After'),'60');
});
