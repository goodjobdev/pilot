import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,lstat,mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {ControlStore} from '../../src/server/state/control-store';
import {RunnerServiceAdmission} from '../../src/server/state/runner-service-admission';
import {RunnerServicePolicyStore} from '../../src/server/state/runner-service-policy';
import {RunnerService} from '../../src/server/state/runner-service';
import {dockerServiceRuntime,inspectDockerServiceOperation,runnerServiceContainerName} from '../../src/server/state/runner-service-docker';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';
const imageId='sha256:'+'a'.repeat(64),snapshot={version:1,files:[{path:'test/example.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')}]};
const request={jobId:'job-docker',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:validateRunnerSnapshot(snapshot).digest,recipe:'test-run',limits:{timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16}};
async function writable(path:string):Promise<void>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return;await chmod(path,0o700);for(const child of await readdir(path))await writable(join(path,child));}

test('docker port uses a read-only service snapshot, pinned image and verified container receipt',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-fake-docker-')),privateRoot=join(root,'private'),binary=join(root,'fake-docker'),argsFile=join(root,'argv.json');await mkdir(privateRoot,{mode:0o700});
 await writeFile(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='run'){fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(args));fs.writeFileSync(args[args.indexOf('--cidfile')+1],'b'.repeat(64));process.stdout.write('ok');}else if(args[0]==='inspect'){const run=JSON.parse(fs.readFileSync(${JSON.stringify(argsFile)},'utf8'));process.stdout.write(JSON.stringify({Id:args.at(-1),Name:'/'+run[run.indexOf('--name')+1],Config:{Labels:{'pilot.runner.operation':run[run.indexOf('--label')+1].split('=')[1]}},State:{Status:'exited',Running:false,Dead:false,ExitCode:0,FinishedAt:'2026-01-01T00:00:00Z'}}));}else process.exit(1);\n`,{mode:0o700});
 const store=new ControlStore(join(root,'store'));
 new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
 try{
  const journal=new RunnerServiceAdmission(store),runtime=dockerServiceRuntime({privateRoot,imageId,dockerBinary:binary}),service=new RunnerService(store,{privateRoot,applicationUid:uid+1},runtime);
  const result=await service.start(request,snapshot);assert.equal(result.status,'completed');assert.equal(journal.inspect(result.operationId).receipt?.stdoutBytes,2);
  const args=JSON.parse(await readFile(argsFile,'utf8')) as string[];
  assert.equal(args[0],'run');assert.equal(args[args.indexOf('--name')+1],runnerServiceContainerName(result.operationId));
  assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args[args.indexOf('--pull')+1],'never');assert.ok(args.includes('--read-only'));assert.ok(args.includes('--sig-proxy=false'));
  assert.equal(args[args.indexOf('--entrypoint')+1],'node');assert.equal(args.at(-2),imageId);assert.equal(args.at(-1),'--test');
  assert.match(args[args.indexOf('--mount')+1],/^type=bind,src=.+,dst=\/workspace,readonly$/);
  assert.ok(!args.includes('--privileged'));assert.ok(!args.some(arg=>arg.includes('docker.sock')));
  assert.equal((await service.start(request,snapshot)).status,'existing');
  const restarted=await inspectDockerServiceOperation({privateRoot,dockerBinary:binary},result.operationId);
  assert.deepEqual(restarted,{status:'exited',containerId:'b'.repeat(64),exitCode:0});
 }finally{store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});

test('abort and output overflow stop only the CLI and never kill a named container',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 for(const mode of ['abort','overflow'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-no-name-kill-')),privateRoot=join(root,'private'),binary=join(root,'fake-docker'),log=join(root,'commands');
  await mkdir(privateRoot,{mode:0o700});const snapshotDir=join(privateRoot,'snapshot-ABC123');await mkdir(snapshotDir,{mode:0o555});
  await writeFile(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},args[0]+'\\n');if(args[0]==='run'){${mode==='overflow'?"process.stdout.write('x'.repeat(4096));":""}setInterval(()=>{},1000);}\n`,{mode:0o700});
  const controller=new AbortController(),runtime=dockerServiceRuntime({privateRoot,imageId,dockerBinary:binary});
  try{
   const pending=runtime.run({operationId:randomUUID(),directory:snapshotDir,recipe:'test-run',limits:request.limits,signal:controller.signal});
   if(mode==='abort'){
    const end=Date.now()+5000;while(!(await readFile(log,'utf8').catch(()=>'' )).includes('run')){if(Date.now()>end)throw Error('fake CLI did not start');await new Promise(resolve=>setTimeout(resolve,10));}
    controller.abort();
   }
   await assert.rejects(pending,/termination was not confirmed/);
   await new Promise(resolve=>setTimeout(resolve,50));
   assert.deepEqual((await readFile(log,'utf8')).trim().split('\\n'),['run']);
  }finally{controller.abort();await writable(root);await rm(root,{recursive:true,force:true});}
 }
});

test('restart inspection treats a mismatched operation label as uncertain',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-runner-inspect-mismatch-')),privateRoot=join(root,'private'),binary=join(root,'fake-docker'),operationId=randomUUID();await mkdir(privateRoot,{mode:0o700});
 const operationDir=join(privateRoot,runnerServiceContainerName(operationId).replace(/^pilot-runner-/,'run-'));await mkdir(operationDir,{mode:0o700});await writeFile(join(operationDir,'container.id'),'c'.repeat(64),{mode:0o600});
 await writeFile(binary,`#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({Id:'c'.repeat(64),Name:'/'+${JSON.stringify(runnerServiceContainerName(operationId))},Config:{Labels:{'pilot.runner.operation':'other-operation'}},State:{Status:'running',Running:true,Dead:false,ExitCode:null,FinishedAt:''}}));\n`,{mode:0o700});
 try{assert.deepEqual(await inspectDockerServiceOperation({privateRoot,dockerBinary:binary},operationId),{status:'uncertain',containerId:'c'.repeat(64)});}
 finally{await writable(root);await rm(root,{recursive:true,force:true});}
});

test('docker port refuses mutable images and never reports an unconfirmed daemon state as complete',async t=>{
 const uid=process.getuid?.();if(!uid){t.skip('requires a non-root POSIX service identity');return;}
 const root=await mkdtemp(join(await realpath(tmpdir()),'pilot-fake-docker-bad-')),privateRoot=join(root,'private'),binary=join(root,'fake-docker');await mkdir(privateRoot,{mode:0o700});
 await writeFile(binary,`#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='run')fs.writeFileSync(args[args.indexOf('--cidfile')+1],'b'.repeat(64));else if(args[0]==='inspect')process.stdout.write(JSON.stringify({Status:'running',Running:true,Dead:false,ExitCode:0,FinishedAt:''}));\n`,{mode:0o700});
 const store=new ControlStore(join(root,'store'));
 new RunnerServicePolicyStore(store).update({expectedRevision:0,enabled:true,targets:[{agentId:request.agentId,projectId:request.projectId,sessionId:request.sessionId,workspaceId:request.workspaceId}],limits:request.limits,maxJobsPerHour:100});
 try{
  assert.throws(()=>dockerServiceRuntime({privateRoot,imageId:'node:latest',dockerBinary:binary}),/configuration/);
  const journal=new RunnerServiceAdmission(store),service=new RunnerService(store,{privateRoot,applicationUid:uid+1},dockerServiceRuntime({privateRoot,imageId,dockerBinary:binary}));
  const result=await service.start(request,snapshot);assert.equal(result.status,'uncertain');assert.equal(journal.inspect(result.operationId).state,'unknown');
 }finally{store.close();await writable(root);await rm(root,{recursive:true,force:true});}
});
