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
  const create=(guest=false)=>worker.fetch(new Request(`https://short.example/api/${guest?'guest/links':'links'}`,{method:'POST',headers:{'Content-Type':'application/json',...(!guest?{Cookie:cookie}:{})},body:JSON.stringify({url:'https://example.org',expiresAt:null})}),env);
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
