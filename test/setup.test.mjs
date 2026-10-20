import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { SetupGate } from '../src/setup.ts';
import { checkPassword } from '../src/auth.ts';
function setup() {
  const kv = new Map(); const persistent = new Map(); let queue = Promise.resolve(); let stale = false; let failWrite = false;
  const env = { LINKS: {
    async get(key) { return stale ? null : kv.get(key) || null; },
    async put(key,value) { if (failWrite) {failWrite=false;throw new Error('KV temporarily unavailable');} kv.set(key,JSON.parse(value)); },
  }};
  const state = { storage: {
    async get(key) {return persistent.get(key);}, async put(key,value) {persistent.set(key,value);}, async delete(key) {persistent.delete(key);},
  }, blockConcurrencyWhile(callback) { const result = queue.then(callback);queue=result.catch(()=>{});return result; }};
  let gate = new SetupGate(state,env);
  env.SETUP_GATE={idFromName(name){return name;},get(){return gate;}};
  const request=(path,body,origin)=>worker.fetch(new Request('https://short.example'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
  return {env,kv,persistent,request,setStale(value){stale=value;},failNextWrite(){failWrite=true;},restart(){gate=new SetupGate(state,env);}};
}
test('without any Worker secrets, a fresh site reports setup required and accepts a password', async () => {
  const s=setup();
  assert.deepEqual(await (await s.request('/api/auth/session')).json(),{setupRequired:true});
  assert.equal((await s.request('/api/auth/login',{password:'not-set-password'})).status,409);
  assert.equal((await s.request('/api/auth/setup',{password:'my-first-password'})).status,200);
  assert.equal((await s.request('/api/auth/login',{password:'my-first-password'})).status,200);
  assert.equal(s.persistent.get('initialized'),true);assert.equal(s.persistent.has('pending'),false);
});
test('initial setup cannot replace an existing password', async () => {
  const s=setup();await s.request('/api/auth/setup',{password:'my-first-password'});
  const before=JSON.stringify(s.kv.get('auth:credentials'));
  assert.equal((await s.request('/api/auth/setup',{password:'other-password'})).status,409);
  assert.equal(JSON.stringify(s.kv.get('auth:credentials')),before);
});
test('concurrent first setups have exactly one winner even while KV reads remain stale', async () => {
  const s=setup();s.setStale(true);
  const [first,second]=await Promise.all([s.request('/api/auth/setup',{password:'first-password'}),s.request('/api/auth/setup',{password:'second-password'})]);
  assert.deepEqual([first.status,second.status].sort(),[200,409]);
  const record=s.kv.get('auth:credentials');
  assert.equal(await checkPassword('first-password',s.env,record),true);
  assert.equal(await checkPassword('second-password',s.env,record),false);
  s.restart();assert.equal((await s.request('/api/auth/setup',{password:'third-password'})).status,409);
});
test('failed KV initialization retries only the original password, including after gate restart', async () => {
  const s=setup();s.failNextWrite();
  assert.equal((await s.request('/api/auth/setup',{password:'my-first-password'})).status,503);
  assert.equal(s.persistent.has('pending'),true);s.restart();
  assert.equal((await s.request('/api/auth/setup',{password:'different-password'})).status,409);
  assert.equal((await s.request('/api/auth/setup',{password:'my-first-password'})).status,200);
  assert.equal(s.persistent.get('initialized'),true);assert.equal(s.persistent.has('pending'),false);
});
test('first setup validates passwords and rejects cross-origin requests', async () => {
  const s=setup();
  for(const password of ['short','a'.repeat(129),'long-password\n']) assert.equal((await s.request('/api/auth/setup',{password})).status,400);
  assert.equal((await s.request('/api/auth/setup',{password:'first-password'},'https://evil.example')).status,403);
  assert.equal(s.kv.size,0);assert.equal(s.persistent.size,0);
});
test('legacy secrets do not bypass first setup or authenticate as passwords', async () => {
  const s=setup();s.env.ADMIN_TOKEN='legacy-token-that-is-longer-than-32-characters';s.env.ADMIN_PASSWORD='legacy-password';
  assert.equal((await s.request('/api/auth/login',{password:s.env.ADMIN_PASSWORD})).status,409);
  assert.deepEqual(await (await s.request('/api/auth/session')).json(),{setupRequired:true});
});
