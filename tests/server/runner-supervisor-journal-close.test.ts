import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunnerSupervisorJournal} from '../../src/server/state/runner-supervisor-journal';

const request={jobId:'journal-close',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:'a'.repeat(64),recipe:'test-run',limits:{timeoutMs:500,outputBytes:256,memoryBytes:64*1024*1024,cpus:1,pids:16}};

test('journal close-first survives reopen and binds exact content without occupying the barrier',()=>{
 const root=mkdtempSync(join(tmpdir(),'pilot-journal-close-'));
 try{
  const first=new RunnerSupervisorJournal(root);
  assert.equal(first.closeRequest(request),'closed-before-dispatch');
  assert.equal(first.closeRequest(request),'closed-before-dispatch');
  first.close();
  const reopened=new RunnerSupervisorJournal(root);
  try{
   assert.throws(()=>reopened.admit(request,100),/closed before dispatch/);
   const changed={...request,limits:{...request.limits,timeoutMs:499}};
   assert.throws(()=>reopened.closeRequest(changed),/different request content/);
   assert.throws(()=>reopened.admit(changed,100),/different request content/);
   assert.equal(reopened.admit({...request,jobId:'other'},100).first,true);
  }finally{reopened.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('journal admission-first remains possible and blocks other admissions, not other tombstones',()=>{
 const root=mkdtempSync(join(tmpdir(),'pilot-journal-admit-'));
 try{
  const first=new RunnerSupervisorJournal(root),second=new RunnerSupervisorJournal(root);
  try{
   assert.equal(first.admit(request,100).first,true);
   assert.equal(second.closeRequest(request),'dispatch-possible');
   assert.equal(second.admit(request,200).first,false);
   assert.throws(()=>second.closeRequest({...request,limits:{...request.limits,timeoutMs:499}}),/different request content/);
   const other={...request,jobId:'other'};
   assert.equal(second.closeRequest(other),'closed-before-dispatch');
   assert.throws(()=>first.admit({...request,jobId:'third'},100),/unresolved/);
  }finally{second.close();first.close();}
  const reopened=new RunnerSupervisorJournal(root);
  try{assert.equal(reopened.closeRequest(request),'dispatch-possible');assert.equal(reopened.admit(request,300).first,false);}
  finally{reopened.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('corrupt closure evidence fails closed on admission and reopen',()=>{
 const root=mkdtempSync(join(tmpdir(),'pilot-journal-corrupt-'));
 try{
  const journal=new RunnerSupervisorJournal(root);
  journal.closeRequest(request);
  journal.db.prepare("UPDATE supervisor_closures SET evidence_digest='forged'").run();
  assert.throws(()=>journal.admit({...request,jobId:'other'},100),/closure evidence is corrupt/);
  journal.close();
  assert.throws(()=>new RunnerSupervisorJournal(root),/closure evidence is corrupt/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
