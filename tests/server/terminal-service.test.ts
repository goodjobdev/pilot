import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { TerminalService } from '../../src/server/agents/terminal-service';
import type { Project } from '../../src/shared/model';

async function root(){return await mkdtemp(join(tmpdir(),'pilot-terminal-'));}
function project(path:string):Project{return {id:'11111111-1111-4111-8111-111111111111',name:'Disposable',path,managed:true,repository:'',created:new Date().toISOString()};}

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

test('interactive terminal keeps a configured POSIX /bin/sh alive as a login shell',async()=>{
  const path=await root(),service=new TerminalService(),projectRecord=project(path),previousShell=process.env.SHELL;
  process.env.SHELL='/bin/sh';
  try{
    const record=service.open(projectRecord);
    await delay(100);
    assert.equal(service.list(projectRecord.id).some(session=>session.id===record.id),true,'/bin/sh must receive its supported login option rather than exit immediately');
  }finally{
    try{await service.close();await rm(path,{recursive:true,force:true});}
    finally{if(previousShell===undefined)delete process.env.SHELL;else process.env.SHELL=previousShell;}
  }
});

test('interactive terminal rejects invalid dimensions and enforces session limit',async()=>{
  const path=await root(),service=new TerminalService(),projectRecord=project(path);
  try{
    assert.throws(()=>service.open(projectRecord,{cols:241}),/bounds/);
    const sessions=Array.from({length:8},()=>service.open(projectRecord));
    assert.throws(()=>service.open(projectRecord),/limit/);
    assert.equal(sessions.length,8);
  }finally{await service.close();await rm(path,{recursive:true,force:true});}
});
