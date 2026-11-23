import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';

const limits={timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16};
const target={agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace'};
const request={jobId:'job-1',...target,policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits};
const script=`
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {ControlStore} from './src/server/state/control-store.ts';
import {RunnerServiceAdmission} from './src/server/state/runner-service-admission.ts';
import {RunnerServiceBudgetStore} from './src/server/state/runner-service-budget.ts';
const [root,mode,role]=process.argv.slice(1),s=new ControlStore(root);
const reader=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const request=${JSON.stringify(request)};
const hold=()=>{fs.writeSync(1,'locked\\n');const buf=Buffer.alloc(1),wait=new Int32Array(new SharedArrayBuffer(4));for(;;){try{if(fs.readSync(0,buf,0,1,null)>0)break;}catch(error){if(error.code!=='EAGAIN')throw error;}Atomics.wait(wait,0,0,10);}};
if(role==='holder'&&mode==='budget'){
 const original=s.admit.bind(s);
 s.admit=(input)=>original({...input,guard:()=>{const result=input.guard?.();hold();return result;}});
}
const execute=()=>{
 if(mode==='budget')return new RunnerServiceBudgetStore(s).reserve({...request,jobId:role});
 return new RunnerServiceAdmission(s).admit({...request,jobId:role},()=>{if(role==='holder')hold();return true;});
};
const attempt=()=>{try{execute();return {ok:true};}catch(e){return {code:e.code,message:e.message};}};
fs.writeSync(1,'ready\\n');
await reader.next();
if(role==='contender')s.db.exec('PRAGMA busy_timeout=200');
fs.writeSync(1,JSON.stringify(attempt())+'\\n');
if(role==='contender'){await reader.next();s.db.exec('PRAGMA busy_timeout=5000');fs.writeSync(1,JSON.stringify(attempt())+'\\n');}
s.close();process.exit(0);`;
async function within<T>(promise:Promise<T>,ms=5000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('child process deadline exceeded')),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
function start(root:string,mode:string,role:string){
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,root,mode,role],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
 return {child,stderr:()=>stderr,lines:createInterface({input:child.stdout})[Symbol.asyncIterator](),closed:new Promise<number|null>(resolve=>child.once('close',resolve))};
}
for(const mode of ['admission','budget'] as const)test('a held writer lock bounds '+mode+' contention and the connection remains usable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-runner-held-lock-')),bootstrap=new ControlStore(root);
 if(mode==='budget')new RunnerServicePolicyStore(bootstrap).update({expectedRevision:0,enabled:true,targets:[target],limits,maxJobsPerHour:1});
 bootstrap.close();const holder=start(root,mode,'holder'),contender=start(root,mode,'contender');
 try{
  assert.equal((await within(holder.lines.next())).value,'ready',holder.stderr());assert.equal((await within(contender.lines.next())).value,'ready',contender.stderr());
  holder.child.stdin.write('go\n');assert.equal((await within(holder.lines.next())).value,'locked',holder.stderr());
  contender.child.stdin.write('go\n');const locked=JSON.parse((await within(contender.lines.next())).value!);
  assert.match(locked.message,/locked|busy/i,'a real lock timeout is not misreported as a policy refusal');
  holder.child.stdin.write('x');assert.deepEqual(JSON.parse((await within(holder.lines.next())).value!),{ok:true});
  contender.child.stdin.write('retry\n');const refused=JSON.parse((await within(contender.lines.next())).value!);
  assert.equal(refused.code,'CONFLICT');assert.match(refused.message,mode==='budget'?/job budget is exhausted/:/job is in progress or uncertain/);
  assert.equal(await within(holder.closed),0,holder.stderr());assert.equal(await within(contender.closed),0,contender.stderr());
 }finally{holder.child.kill('SIGKILL');contender.child.kill('SIGKILL');await Promise.all([within(holder.closed),within(contender.closed)]);await rm(root,{recursive:true,force:true});}
});
