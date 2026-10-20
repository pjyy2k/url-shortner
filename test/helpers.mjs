import { CodeAllocator } from '../src/codes.ts';
export function attachAllocator(env, initial = 0) {
  const persistent = new Map([['next',initial]]);let queue=Promise.resolve();
  const state={storage:{async get(key){return persistent.get(key);},async put(key,value){persistent.set(key,value);}},blockConcurrencyWhile(callback){const result=queue.then(callback);queue=result.catch(()=>{});return result;}};
  let allocator=new CodeAllocator(state,env);
  env.CODE_ALLOCATOR={idFromName(name){if(name!=='global-short-code-sequence')throw Error('Wrong allocator identity');return name;},get(){return allocator;}};
  return {persistent,restart(){allocator=new CodeAllocator(state,env);}};
}
