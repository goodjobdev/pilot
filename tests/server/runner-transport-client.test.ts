import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runnerClientPreflight} from '../../src/server/state/runner-transport-client';

test('stalled filesystem preflight observes cancellation and deadline without dispatching',async()=>{
 let release:(value:boolean)=>void=()=>{},calls=0;
 const blocked=()=>{calls++;return new Promise<boolean>(resolve=>release=resolve);};
 const controller=new AbortController(),pending=runnerClientPreflight(blocked,1000,controller.signal);
 await Promise.resolve();controller.abort();assert.equal(await pending,false);release(true);
 assert.equal(await runnerClientPreflight(()=>new Promise<boolean>(()=>{}),25),false);
 const already=new AbortController();already.abort();assert.equal(await runnerClientPreflight(blocked,1000,already.signal),false);
 assert.equal(calls,1,'a pre-aborted preflight does not run the check');
 assert.equal(await runnerClientPreflight(async()=>{throw Error('offline');},100),false);
});
