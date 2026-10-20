import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { GuestQuota } from '../src/guest.ts';
function setup() {
  const kv = new Map(); const persistent = new Map(); let queue = Promise.resolve(); let reads = 0; let lists = 0;
  const env = { LINKS: {
    async get(key) { reads++;return kv.get(key)?.link || null; },
    async put(key,value,options) { kv.set(key,{link:JSON.parse(value),...options}); },
    async list() {lists++;return {keys:[],list_complete:true};},
  }};
  const state = { storage: {async get(key){return persistent.get(key);},async put(key,value){persistent.set(key,value);}},blockConcurrencyWhile(callback){const result=queue.then(callback);queue=result.catch(()=>{});return result;} };
  let quota = new GuestQuota(state,env);
  env.GUEST_QUOTA={idFromName(name){assert.equal(name,'all-guests-global-daily');return name;},get(){return quota;}};
  const request=(body={url:'https://example.org'},method='POST',headers={})=>worker.fetch(new Request('https://short.example/api/guest/links',{method,headers:{'Content-Type':'application/json',...headers},...(['GET','HEAD'].includes(method)?{}:{body:JSON.stringify(body)})}),env);
  return {env,kv,persistent,request,reads:()=>reads,lists:()=>lists,restart(){quota=new GuestQuota(state,env);}};
}
test('guest creates without authentication; expiry is fixed at seven days even with forged inputs',async()=>{
  const s=setup();const now=Date.now();
  const r=await s.request({url:'https://example.org',expiresAt:null,ttl:999999999,createdBy:'admin'});assert.equal(r.status,201);
  const link=await r.json();assert.equal(link.createdBy,'guest');
  assert.ok(Math.abs(link.expiresAt-Math.floor(now/1000)-604800)<=1);
  assert.equal(s.kv.get('link:'+link.code).expiration,link.expiresAt);
  assert.equal(s.reads(),0);assert.equal(s.lists(),0);
  assert.equal((await worker.fetch(new Request('https://short.example/'+link.code),s.env)).status,302);
  s.kv.get('link:'+link.code).link.expiresAt=Math.floor(now/1000)-1;
  assert.equal((await worker.fetch(new Request('https://short.example/'+link.code),s.env)).status,404);
});
test('100 is a global combined quota, enforced for concurrent requests across different IPs',async()=>{
  const s=setup();const requests=Array.from({length:110},(_,i)=>s.request({url:`https://example.org/${i}`},'POST',{'CF-Connecting-IP':`198.51.100.${i}`}));
  const results=await Promise.all(requests);
  assert.equal(results.filter(r=>r.status===201).length,100);assert.equal(results.filter(r=>r.status===429).length,10);assert.equal(s.kv.size,100);
  s.restart();assert.equal((await s.request()).status,429);
});
test('global quota resets at midnight in Asia/Seoul, not UTC',async()=>{
  const s=setup();const original=Date.now;
  try {
    Date.now=()=>Date.parse('2026-10-20T23:59:59+09:00');
    await Promise.all(Array.from({length:100},()=>s.request()));assert.equal((await s.request()).status,429);
    Date.now=()=>Date.parse('2026-10-21T00:00:00+09:00');assert.equal((await s.request()).status,201);
    assert.deepEqual(s.persistent.get('daily'),{date:'2026-10-21',count:1});
  } finally {Date.now=original;}
});
test('invalid URL and cross-origin input do not consume daily capacity',async()=>{
  const s=setup();
  for(const url of ['javascript:alert(1)','https://short.example/foo','https://u:p@example.org','bad']) assert.equal((await s.request({url})).status,400);
  assert.equal((await s.request({url:'https://example.org'},'POST',{Origin:'https://evil.example'})).status,403);
  assert.equal(s.persistent.has('daily'),false);assert.equal(s.kv.size,0);
});
test('guests cannot list or delete links through the guest endpoint',async()=>{
  const s=setup();for(const method of ['GET','DELETE']) assert.equal((await s.request({},method)).status,405);assert.equal(s.lists(),0);
});
test('IP request limit and absent global quota binding fail closed',async()=>{
  const s=setup();s.env.GUEST_RATE_LIMITER={async limit(){return {success:false};}};
  assert.equal((await s.request()).status,429);assert.equal(s.kv.size,0);
  delete s.env.GUEST_RATE_LIMITER;delete s.env.GUEST_QUOTA;
  assert.equal((await s.request()).status,503);
});
test('a failed KV write cannot release a reservation and allow more than 100 creations',async()=>{
  const s=setup();s.env.LINKS.put=async()=>{throw new Error('unknown KV commit outcome');};
  assert.equal((await s.request()).status,503);assert.equal(s.persistent.get('daily').count,1);
});
test('administrator and API-key integrations are exempt from the guest quota and seven-day expiry',async()=>{
  const s=setup();const {createCredentials,sessionCookie}=await import('../src/auth.ts');
  const credentials=await createCredentials('administrator-password');s.kv.set('auth:credentials',{link:credentials});
  const cookie=(await sessionCookie(new Request('https://short.example'),s.env,credentials)).split(';')[0];
  s.persistent.set('daily',{date:new Date(Date.now()+9*3600000).toISOString().slice(0,10),count:100});
  const request=(path,body,headers={})=>worker.fetch(new Request('https://short.example'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),s.env);
  const admin=await request('/api/links',{url:'https://example.org/admin',expiresAt:null},{Cookie:cookie});assert.equal(admin.status,201);assert.equal((await admin.json()).expiresAt,null);
  const key=await (await request('/api/keys',{name:'integration'},{Cookie:cookie})).json();
  const api=await request('/api/links',{url:'https://example.org/api',expiresAt:null},{Authorization:`Bearer ${key.key}`});assert.equal(api.status,201);assert.equal((await api.json()).expiresAt,null);
  assert.equal((await s.request()).status,429);assert.equal(s.persistent.get('daily').count,100);
});
