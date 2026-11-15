import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TerminalService, SHELL_MAX_OUTPUT_BYTES, runShellCommand } from '../../src/server/agents/terminal-service';
import type { Project } from '../../src/shared/model';

async function root(){return await mkdtemp(join(tmpdir(),'pilot-terminal-'));}
function project(path:string):Project{return {id:'11111111-1111-4111-8111-111111111111',name:'Disposable',path,managed:true,repository:'',created:new Date().toISOString()};}

test('shell command starts in the project cwd and returns bounded PTY output and exit status',async()=>{
  const path=await root();
  try{
    const result=await runShellCommand({command:'printf "terminal-ready"; pwd',cwd:path});
    assert.equal(result.exitCode,0);
    assert.equal(result.timedOut,false);
    assert.ok(result.stdout.includes('terminal-ready'));
    assert.ok(result.stdout.includes(path));
    assert.equal(result.truncated,false);
  }finally{await rm(path,{recursive:true,force:true});}
});

test('shell command timeout kills the foreground PTY process',async()=>{
  const path=await root();
  try{
    const result=await runShellCommand({command:'sleep 10',cwd:path,timeoutMs:100});
    assert.equal(result.timedOut,true);
    assert.equal(result.exitCode,null);
  }finally{await rm(path,{recursive:true,force:true});}
});

test('shell timeout escalates to SIGKILL when the command ignores SIGTERM',async()=>{
  const path=await root(),started=Date.now();
  try{
    const result=await runShellCommand({command:"trap '' TERM; while :; do sleep 0.05; done",cwd:path,timeoutMs:100});
    assert.equal(result.timedOut,true);
    assert.equal(result.exitCode,null);
    assert.ok(Date.now()-started<4000,'the ignored-TERM process group is forcibly reaped within a bounded interval');
  }finally{await rm(path,{recursive:true,force:true});}
});

test('shell abort signal stops a running command and completes within the termination bound',async()=>{
  const path=await root(),controller=new AbortController(),started=Date.now();
  try{
    const running=runShellCommand({command:"trap '' TERM; while :; do sleep 0.05; done",cwd:path,signal:controller.signal});
    setTimeout(()=>controller.abort(),100);
    const result=await running;
    assert.equal(result.timedOut,false);
    assert.equal(result.exitCode,null);
    assert.ok(Date.now()-started<3000,'abort escalates and reaps the active process promptly');
  }finally{controller.abort();await rm(path,{recursive:true,force:true});}
});

test('shell command output is hard capped and excess output stops the PTY',async()=>{
  const path=await root();
  try{
    const result=await runShellCommand({command:'yes x',cwd:path,timeoutMs:5000});
    assert.equal(result.truncated,true);
    assert.ok(Buffer.byteLength(result.stdout)<=SHELL_MAX_OUTPUT_BYTES);
  }finally{await rm(path,{recursive:true,force:true});}
});

test('shell rejects empty and oversized input before spawning a command',async()=>{
  const path=await root();
  try{
    await assert.rejects(runShellCommand({command:'  ',cwd:path}),/required/);
    await assert.rejects(runShellCommand({command:'x'.repeat(17*1024),cwd:path}),/16 KiB/);
  }finally{await rm(path,{recursive:true,force:true});}
});

test('interactive terminal sessions are project-bound, single-attached and tickets are short-lived',async()=>{
  const path=await root(),service=new TerminalService(),projectRecord=project(path);
  try{
    const record=service.open(projectRecord,{cols:80,rows:24});
    assert.equal(record.cwd,path);
    assert.equal(service.list(projectRecord.id).length,1);
    const ticket=service.issueTicket(record.id,projectRecord.id,1000);
    assert.equal(service.consumeTicket(record.id,ticket,1001),true);
    assert.equal(service.consumeTicket(record.id,ticket,1002),false);
    assert.equal(service.read(record.id,projectRecord.id).connected,true);
    assert.throws(()=>service.read(record.id,'22222222-2222-4222-8222-222222222222'),/not found/);
    assert.throws(()=>service.issueTicket(record.id,projectRecord.id,1003),/already has/);
    service.closeTerminal(record.id,projectRecord.id);
  }finally{await service.close();await rm(path,{recursive:true,force:true});}
});
