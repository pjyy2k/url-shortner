import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { encodeCode } from '../src/codes.ts';
import { createCredentials,sessionCookie } from '../src/auth.ts';
import { GuestQuota } from '../src/guest.ts';
import { attachAllocator } from './helpers.mjs';
const credentials=await createCredentials('test-code-password');
const cookie=(await sessionCookie(new Request('https://short.example'),{},credentials)).split(';')[0];
function setup(initial=0) {
  const kv=new Map([['auth:credentials',{value:JSON.stringify(credentials)}]]);
  const env={LINKS:{async get(key){return kv.has(key)?JSON.parse(kv.get(key).value):null;},async put(key,value,options){kv.set(key,{value,...options});},async delete(key){kv.delete(key);}}};
  const allocator=attachAllocator(env,initial);
  const quotaState=new Map();let queue=Promise.resolve();
  const state={storage:{async get(key){return quotaState.get(key);},async put(key,value){quotaState.set(key,value);}},blockConcurrencyWhile(fn){const result=queue.then(fn);queue=result.catch(()=>{});return result;}};
  const guest=new GuestQuota(state,env);env.GUEST_QUOTA={idFromName:n=>n,get:()=>guest};
  const create=(guest=false,body={})=>worker.fetch(new Request(`https://short.example/api/${guest?'guest/links':'links'}`,{method:'POST',headers:{'Content-Type':'application/json',...(!guest?{Cookie:cookie}:{})},body:JSON.stringify({url:'https://example.org',expiresAt:null,...body})}),env);
  return {env,kv,allocator,create};
}
function indexOf(code){let value=0;const alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';for(const c of code)value=value*62+alphabet.indexOf(c)+1;return value-1;}
test('all one-character codes are used before two, then three characters',()=>{
  assert.equal(encodeCode(0),'a');assert.equal(encodeCode(25),'z');assert.equal(encodeCode(26),'A');assert.equal(encodeCode(61),'9');
  assert.equal(encodeCode(62),'aa');assert.equal(encodeCode(3905),'99');assert.equal(encodeCode(3906),'aaa');
  const codes=Array.from({length:3906},(_,i)=>encodeCode(i));assert.equal(new Set(codes).size,3906);assert.ok(codes.every(c=>c.length<=2));
});
test('reserved api and admin paths are skipped',async()=>{
  for(const [reserved,next]of[['api','apj'],['admin','admio']]){
    const s=setup(indexOf(reserved));const response=await s.create();assert.equal(response.status,201);assert.equal((await response.json()).code,next);assert.equal(s.kv.has('link:'+reserved),false);
  }
});
test('simultaneous admin and guest creation share a collision-free sequence',async()=>{
  const s=setup();const responses=await Promise.all(Array.from({length:100},(_,i)=>s.create(i%2===0)));
  for(const r of responses)assert.equal(r.status,201);
  const links=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(links.map(x=>x.code)).size,100);
  assert.equal(links.filter(x=>x.code.length===1).length,62);assert.equal(links.filter(x=>x.code.length===2).length,38);
});
test('the allocation counter persists across object restart and never reuses deleted codes',async()=>{
  const s=setup();const a=await(await s.create()).json();assert.equal(a.code,'a');s.kv.delete('link:a');s.allocator.restart();
  assert.equal((await(await s.create()).json()).code,'b');
});
test('uncertain failed KV writes consume a code rather than risking reuse',async()=>{
  const s=setup();const put=s.env.LINKS.put;s.env.LINKS.put=async()=>{throw Error('KV unavailable');};assert.equal((await s.create()).status,503);
  s.env.LINKS.put=put;s.allocator.restart();assert.equal((await(await s.create()).json()).code,'b');
});
test('short and legacy 16-character links both redirect and can be deleted',async()=>{
  const s=setup();const short=await(await s.create()).json();const legacy='Ab_cd-ef01234567';assert.equal(legacy.length,16);
  s.kv.set('link:'+legacy,{value:JSON.stringify({url:'https://example.org/legacy',createdAt:new Date().toISOString(),expiresAt:null})});
  for(const code of [short.code,legacy]){
    assert.equal((await worker.fetch(new Request('https://short.example/'+code),s.env)).status,302);
    const deletion=await worker.fetch(new Request('https://short.example/api/links/'+code,{method:'DELETE',headers:{Cookie:cookie}}),s.env);assert.equal(deletion.status,200);
    assert.equal((await worker.fetch(new Request('https://short.example/'+code),s.env)).status,404);
  }
});
test('corrupted or exhausted sequence numbers fail closed',async()=>{
  for(const value of [-1,NaN,1.5,'0',Number.MAX_SAFE_INTEGER])assert.throws(()=>encodeCode(value));
  const s=setup(-1);assert.equal((await s.create()).status,503);assert.equal(s.kv.size,1);
});
test('administrator can choose a custom code, redirect it and delete it',async()=>{
  const s=setup();const response=await s.create(false,{url:'example.org/event',customCode:'my-event_2026'});assert.equal(response.status,201);
  const link=await response.json();assert.equal(link.code,'my-event_2026');assert.equal(link.url,'https://example.org/event');
  const redirect=await worker.fetch(new Request('https://short.example/'+link.code),s.env);assert.equal(redirect.status,302);assert.equal(redirect.headers.get('Location'),link.url);
  assert.equal((await worker.fetch(new Request('https://short.example/api/links/'+link.code,{method:'DELETE',headers:{Cookie:cookie}}),s.env)).status,200);
  assert.equal((await s.create(false,{customCode:'my-event_2026'})).status,409);
});
test('duplicate custom reservations are serialized even when KV does not show the first write',async()=>{
  const s=setup();const get=s.env.LINKS.get;s.env.LINKS.get=async(key,type)=>key.startsWith('link:')?null:get(key,type);
  const results=await Promise.all(Array.from({length:10},()=>s.create(false,{customCode:'sale'})));
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409).length,9);
  s.kv.delete('link:sale');s.allocator.restart();assert.equal((await s.create(false,{customCode:'sale'})).status,409);
});
test('custom codes reserved ahead of the sequence are skipped by automatic allocation',async()=>{
  const s=setup();assert.equal((await s.create(false,{customCode:'a'})).status,201);
  assert.equal((await(await s.create()).json()).code,'b');
  assert.equal((await s.create(false,{customCode:'b'})).status,409);
  s.kv.delete('link:b');assert.equal((await s.create(false,{customCode:'b'})).status,409);
});
test('custom creation cannot overwrite an existing legacy code',async()=>{
  const s=setup();const code='Ab_cd-ef01234567';const value=JSON.stringify({url:'https://example.org/legacy',createdAt:new Date().toISOString(),expiresAt:null});s.kv.set('link:'+code,{value});
  assert.equal((await s.create(false,{customCode:code})).status,409);assert.equal(s.kv.get('link:'+code).value,value);
});
test('custom code format, reserved routes, case and maximum length are enforced',async()=>{
  const s=setup();for(const customCode of ['api','API','admin','Admin','a/b','foo.bar','한글','_start','-start','x'.repeat(33),123])assert.equal((await s.create(false,{customCode})).status,400,String(customCode));
  for(const customCode of ['Event','event','x'.repeat(32)])assert.equal((await s.create(false,{customCode})).status,201);
  assert.equal((await(await s.create(false,{customCode:'   '})).json()).code,'a');
});
test('guest-supplied custom code is ignored; the guest still receives an automatic seven-day link',async()=>{
  const s=setup();const response=await s.create(true,{url:'example.org/guest',customCode:'private-alias'});assert.equal(response.status,201);
  const data=await response.json();assert.equal(data.code,'a');assert.equal(data.createdBy,'guest');assert.equal(data.url,'https://example.org/guest');assert.ok(data.expiresAt>0);assert.equal(s.kv.has('link:private-alias'),false);
});
test('authenticated API keys can choose codes without granting that ability to guests',async()=>{
  const s=setup();const issued=await worker.fetch(new Request('https://short.example/api/keys',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'integration'})}),s.env);
  const key=await issued.json();const created=await worker.fetch(new Request('https://short.example/api/links',{method:'POST',headers:{Authorization:`Bearer ${key.key}`,'Content-Type':'application/json'},body:JSON.stringify({url:'example.org',customCode:'api-integration'})}),s.env);
  assert.equal(created.status,201);assert.equal((await created.json()).code,'api-integration');
});
test('schemeless destinations default to HTTPS for admin and guest creation, preserving explicit HTTP',async()=>{
  for(const guest of [false,true]){
    const s=setup();for(const [input,expected]of[['example.org','https://example.org/'],['  example.org/path?q=1  ','https://example.org/path?q=1'],['example.org:8080/test','https://example.org:8080/test'],['//example.org/a','https://example.org/a'],['http://example.org/plain','http://example.org/plain'],['https://example.org/secure','https://example.org/secure']]){
      const response=await s.create(guest,{url:input});assert.equal(response.status,201,input);assert.equal((await response.json()).url,expected);
    }
  }
});
test('automatic HTTPS never converts unsafe schemes, credentials, malformed input or self-loops into accepted links',async()=>{
  for(const guest of [false,true]){
    const s=setup();for(const url of ['javascript:alert(1)','data:text/html,evil','mailto:user@example.org','ftp://example.org/file','short.example/foo','user:password@example.org','/relative','bad','https://example.org/\nattack','https://example.org\\@short.example'])assert.equal((await s.create(guest,{url})).status,400,url);
  }
});
