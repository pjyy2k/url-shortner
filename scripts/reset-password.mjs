import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCredentials } from '../src/auth.ts';
if (!process.stdin.isTTY) { console.error('터미널에서 실행하세요.'); process.exit(1); }
const hiddenOutput = new Writable({ write(_chunk,_encoding,callback) {callback();} });
const input = createInterface({input:process.stdin,output:hiddenOutput,terminal:true});
let directory;
try {
  process.stdout.write('새 관리자 비밀번호 (10~128자, 입력 내용은 표시되지 않음): ');
  const password = await input.question('');process.stdout.write('\n');
  process.stdout.write('비밀번호 확인: ');
  const confirmation = await input.question('');process.stdout.write('\n');
  input.close();
  if (password !== confirmation) throw new Error('비밀번호 확인이 일치하지 않습니다.');
  if (password.length < 10 || password.length > 128 || /[\r\n\x00]/.test(password)) throw new Error('비밀번호는 10~128자로 입력하세요.');
  directory = await mkdtemp(join(tmpdir(),'shortner-password-'));
  const path = join(directory,'credentials.json');
  await writeFile(path,JSON.stringify(await createCredentials(password)),{mode:0o600});
  // Requires this administrator's Cloudflare Wrangler login; no public reset endpoint.
  const result=spawnSync(process.platform==='win32'?'npx.cmd':'npx',['wrangler','kv','key','put','auth:credentials','--binding','LINKS','--path',path,'--remote'],{stdio:'inherit',shell:process.platform==='win32'});
  if (result.status !== 0) throw new Error('Cloudflare 업데이트에 실패했습니다. Wrangler 로그인과 계정 권한을 확인하세요.');
  console.log('비밀번호를 재설정했습니다. KV 반영 후 새 비밀번호로 로그인하세요.');
} catch(error) { input.close();console.error(error.message);process.exitCode=1; }
finally {if(directory) await rm(directory,{recursive:true,force:true});}
