import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { workerRequestRun } from '../../src/server/agents/harness-host';

test('worker provider role requires an exact bound run and conversation',()=>{
  const normal={conversationId:1,marker:null,cachedRun:null,durableRun:null,requireDurable:true};
  assert.equal(workerRequestRun(normal),null);
  assert.equal(workerRequestRun({...normal,marker:'run-1',durableRun:'run-1'}),'run-1');
  assert.equal(workerRequestRun({...normal,marker:'run-1',cachedRun:'run-1',requireDurable:false}),'run-1');
  assert.throws(()=>workerRequestRun({...normal,marker:'run-1',cachedRun:'run-1'}),/durable worker conversation binding is unavailable/);
  assert.throws(()=>workerRequestRun({...normal,conversationId:undefined}),/conversation cannot be verified/);
  assert.throws(()=>workerRequestRun({...normal,durableRun:'run-1'}),/does not match/);
  assert.throws(()=>workerRequestRun({...normal,marker:'run-2',durableRun:'run-1'}),/does not match/);
  assert.throws(()=>workerRequestRun({...normal,marker:'run-1'}),/does not match/);
  assert.throws(()=>workerRequestRun({...normal,marker:'run-1',cachedRun:'run-1',durableRun:'run-2'}),/bindings disagree/);
});
