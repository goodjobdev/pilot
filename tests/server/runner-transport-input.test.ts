import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRunnerTransportInput,RUNNER_TRANSPORT_MAX_BODY_BYTES,RUNNER_TRANSPORT_MAX_DEPTH,RUNNER_TRANSPORT_MAX_VALUES} from '../../src/server/state/runner-transport-input';
import {validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';

const snapshot={version:1,files:[{path:'test/example.test.js',mode:'100644',base64:Buffer.from('test').toString('base64')}]};
const request={jobId:'job-1',agentId:'agent',projectId:'project',sessionId:'session',workspaceId:'workspace',policyRevision:1,snapshotDigest:validateRunnerSnapshot(snapshot).digest,recipe:'test-run',limits:{timeoutMs:1000,outputBytes:1024,memoryBytes:64*1024*1024,cpus:1,pids:16}};
const raw=()=>JSON.stringify({request,snapshot});
const parse=(text:string)=>parseRunnerTransportInput(Buffer.from(text,'utf8'));
test('the transport input accepts only the exact validated snapshot and fixed recipe',()=>{
 assert.deepEqual(parse(raw()).request,request);
 assert.throws(()=>parse(JSON.stringify({request,snapshot,command:'sh'})));
 assert.throws(()=>parse(JSON.stringify({request:{...request,recipe:'shell'},snapshot})));
 assert.throws(()=>parse(JSON.stringify({request:{...request,snapshotDigest:'a'.repeat(64)},snapshot})),/identity does not match/);
 assert.throws(()=>parse(JSON.stringify({request,snapshot:{...snapshot,files:[{...snapshot.files[0],path:'../escape'}]}})));
});
test('duplicate object keys, malformed JSON and trailing material are refused',()=>{
 const body=raw();
 for(const text of [
  body.replace('"request":','"request":null,"request":'),
  body.replace('"jobId":','"jobId":"a","jobId":'),
  body.replace('"jobId":','"jobId":"a","\\u006aobId":'),
  body.replace('"version":1','"version":1,"version":1'),
  body+' {}',
  body.replace('"policyRevision":1','"policyRevision":01'),
  body.replace('"agentId":"agent"','"agentId":"bad\\q"'),
  body.slice(0,-1),
 ])assert.throws(()=>parse(text),text.slice(0,120));
});
test('the input bound, strict UTF-8, and nesting limit apply before parsing',()=>{
 assert.throws(()=>parseRunnerTransportInput(Buffer.alloc(RUNNER_TRANSPORT_MAX_BODY_BYTES+1)),/document/);
 assert.throws(()=>parseRunnerTransportInput(Buffer.from([0xef,0xbb,0xbf,0x7b,0x7d])),/document/);
 assert.throws(()=>parseRunnerTransportInput(Buffer.from([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d])),/document/);
 const deep='['.repeat(RUNNER_TRANSPORT_MAX_DEPTH+2)+'0'+']'.repeat(RUNNER_TRANSPORT_MAX_DEPTH+2);
 assert.throws(()=>parse(deep),/transport JSON/);
 assert.throws(()=>parse('['+Array(RUNNER_TRANSPORT_MAX_VALUES).fill('0').join(',')+']'),/transport JSON/);
});
