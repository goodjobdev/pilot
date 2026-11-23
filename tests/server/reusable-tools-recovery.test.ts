import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ControlStore } from '../../src/server/state/control-store';
import { ReusableToolStore } from '../../src/server/state/reusable-tools';

const child=resolve('tests/server/fixtures/reusable-recovery-child.ts');
const launch=(root:string,phase:string,mode:string,tool='define')=>spawn(process.execPath,['--import','tsx',child,root,phase,mode,tool],{stdio:['ignore','pipe','pipe']});

test('a killed unsafe definition write is not replayed before or after its durable admission',async()=>{
 for(const phase of ['before','after'] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-reusable-crash-'));let running:ReturnType<typeof launch>|undefined;
  try{
   running=launch(root,phase,'run');let errors='';running.stderr!.on('data',chunk=>errors+=String(chunk));
   const deadline=Date.now()+10000;
   for(;;){if(await access(join(root,'entered')).then(()=>true,()=>false))break;if(running.exitCode!==null)throw Error('child exited before boundary: '+errors);if(Date.now()>deadline)throw Error('child did not reach boundary: '+errors);await new Promise(resolve=>setTimeout(resolve,25));}
   running.kill('SIGKILL');await once(running,'exit');running=undefined;
   const control=new ControlStore(join(root,'control')),store=new ReusableToolStore(control);
   assert.equal(store.list('33333333-3333-4333-8333-333333333333','agent').length,phase==='after'?1:0);
   control.close();
   const restarted=launch(root,phase,'reopen');let output='',stderr='';restarted.stdout!.on('data',chunk=>output+=String(chunk));restarted.stderr!.on('data',chunk=>stderr+=String(chunk));
   const timer=setTimeout(()=>restarted.kill('SIGKILL'),15000);
   const [code]=await once(restarted,'exit');clearTimeout(timer);assert.equal(code,0,stderr);
   const report=JSON.parse(output.trim().split('\n').at(-1)!);assert.match(report.interrupted,/interrupted/i);
   assert.equal(report.definitions.length,phase==='after'?1:0,'restart must not execute the interrupted mutation');
   assert.equal(await access(join(root,'replayed')).then(()=>true,()=>false),false,'reopen must not enter the definition write');
   const reopened=new ControlStore(join(root,'control'));try{
    const restored=new ReusableToolStore(reopened),input={projectId:'33333333-3333-4333-8333-333333333333',agentId:'agent',name:'pick',revision:0,fields:['name'],guard:()=>{}};
    if(phase==='after'){
      assert.throws(()=>restored.write(input),/conflict/i,'identical retry must not create a second revision');
      assert.throws(()=>restored.write({...input,fields:['different']}),/conflict/i,'changed retry cannot replace the committed definition');
      assert.deepEqual(restored.list(input.projectId,input.agentId)[0].fields,['name']);
    } else {assert.equal(restored.write(input).revision,1,'an explicit new attempt can create after inspection');}
   }finally{reopened.close();}
  }finally{if(running&&running.exitCode===null){running.kill('SIGKILL');await once(running,'exit').catch(()=>{});}await rm(root,{recursive:true,force:true});}
 }
});

test('a killed unsafe invocation is reported interrupted and never executed again on reopen',async()=>{
 for(const phase of ['before','after'] as const){
  const root=await mkdtemp(join(tmpdir(),'pilot-reusable-invoke-crash-'));let running:ReturnType<typeof launch>|undefined;
  try{
   running=launch(root,phase,'run','invoke');let errors='';running.stderr!.on('data',chunk=>errors+=String(chunk));const deadline=Date.now()+10000;
   for(;;){if(await access(join(root,'entered')).then(()=>true,()=>false))break;if(running.exitCode!==null)throw Error('child exited: '+errors);if(Date.now()>deadline)throw Error('child did not reach invocation boundary: '+errors);await new Promise(resolve=>setTimeout(resolve,25));}
   running.kill('SIGKILL');await once(running,'exit');running=undefined;
   const restarted=launch(root,phase,'reopen','invoke');let output='',stderr='';restarted.stdout!.on('data',chunk=>output+=String(chunk));restarted.stderr!.on('data',chunk=>stderr+=String(chunk));
   const timer=setTimeout(()=>restarted.kill('SIGKILL'),15000);const [code]=await once(restarted,'exit');clearTimeout(timer);assert.equal(code,0,stderr);
   const report=JSON.parse(output.trim().split('\n').at(-1)!);assert.match(report.interrupted,/interrupted/i);assert.equal(report.definitions.length,1);
   assert.equal(await access(join(root,'replayed')).then(()=>true,()=>false),false,'reopen must not invoke again');
  }finally{if(running&&running.exitCode===null){running.kill('SIGKILL');await once(running,'exit').catch(()=>{});}await rm(root,{recursive:true,force:true});}
 }
});
