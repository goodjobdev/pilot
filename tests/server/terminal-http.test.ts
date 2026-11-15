import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../../src/server/main';
import { localConfig } from '../../src/server/security';

async function waitFor(predicate:()=>boolean,timeout=5000):Promise<void>{const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw new Error('condition timed out');await delay(20);}}

test('terminal API is off by default and creates no shell service',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pilot-terminal-off-'));
  const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:root,browseRoots:[],security});
  try{
    const port=await new Promise<number>(resolve=>app.server.listen(0,'127.0.0.1',()=>resolve((app.server.address() as {port:number}).port)));
    security.origin='http://127.0.0.1:'+port;
    const token={'x-dashboard-token':security.token};
    const list=await fetch(security.origin+'/api/projects',{headers:{'x-dashboard-token':security.token}});
    const projects=await list.json() as {id:string}[];
    assert.equal(projects.length,0);
    assert.equal((await fetch(security.origin+'/api/projects/11111111-1111-4111-8111-111111111111/terminals',{headers:token})).status,503);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('owner creates a terminal and one-use WebSocket attaches; preview remains unavailable without owner-authenticated isolation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pilot-terminal-http-'));
  const security=localConfig('http://127.0.0.1:0'),app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',terminal:{enabled:true}});
  let ws:WebSocket|undefined;
  try{
    const port=await new Promise<number>(resolve=>app.server.listen(0,'127.0.0.1',()=>resolve((app.server.address() as {port:number}).port)));
    security.origin='http://127.0.0.1:'+port;
    const rejectedUpgrade=await new Promise<string>((resolve,reject)=>{
      const socket=createConnection(port,'127.0.0.1');let response='';
      const timeout=setTimeout(()=>{socket.destroy();reject(new Error('rejected upgrade response timed out'));},3000);
      socket.on('connect',()=>socket.write('GET /api/terminals/11111111-1111-4111-8111-111111111111/stream HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://untrusted.invalid\r\n\r\n'));
      socket.on('data',chunk=>{response+=chunk.toString('latin1');});
      socket.on('end',()=>{clearTimeout(timeout);resolve(response);});
      socket.on('error',error=>{clearTimeout(timeout);reject(error);});
    });
    assert.ok(rejectedUpgrade.startsWith('HTTP/1.1 403 Forbidden\r\n'));
    assert.ok(rejectedUpgrade.includes('Content-Length: 0\r\n\r\n'),'rejected upgrades use a valid CRLF-terminated empty response');
    const token={'x-dashboard-token':security.token},writes={...token,'content-type':'application/json',origin:security.origin};
    const projectResponse=await fetch(security.origin+'/api/projects',{method:'POST',headers:writes,body:JSON.stringify({name:'Disposable terminal project',managed:true,confirm:true})});
    assert.equal(projectResponse.status,201);
    const project=await projectResponse.json() as {id:string};
    const terminalResponse=await fetch(security.origin+'/api/projects/'+project.id+'/terminals',{method:'POST',headers:writes,body:JSON.stringify({cols:80,rows:24})});
    assert.equal(terminalResponse.status,201);
    const terminalBody=await terminalResponse.json() as {terminal:{id:string;cwd:string}};
    assert.ok(terminalBody.terminal.cwd);
    const ticketResponse=await fetch(security.origin+'/api/terminals/'+terminalBody.terminal.id+'/ticket',{method:'POST',headers:writes,body:JSON.stringify({projectId:project.id})});
    assert.equal(ticketResponse.status,200);
    const ticket=(await ticketResponse.json() as {ticket:string}).ticket;
    ws=new WebSocket('ws://127.0.0.1:'+port+'/api/terminals/'+terminalBody.terminal.id+'/stream',['pilot-terminal',ticket],{origin:security.origin});
    await new Promise<void>((resolve,reject)=>{ws!.once('open',()=>resolve());ws!.once('error',reject);});
    const output=new Promise<string>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('terminal output timed out')),5000);
      let matches=0,collected='';
      ws!.on('message',data=>{
        const frame=JSON.parse(data.toString()) as {type?:string;data?:string};
        if(frame.type==='output'&&frame.data?.includes('TERMINAL_TOOL_OK')){collected+=frame.data;if(++matches>=2){clearTimeout(timeout);resolve(collected);}}
      });
    });
    ws.send(JSON.stringify({type:'input',data:"printf 'TERMINAL_TOOL_OK\n'\r"}));
    const shellOutput=await output;
    assert.ok(shellOutput.split('TERMINAL_TOOL_OK').length>=3,'the output contains both the echoed input and command result: '+JSON.stringify(shellOutput));

    const previewPath='/api/terminals/'+terminalBody.terminal.id+'/preview/5173/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/';
    assert.equal((await fetch(security.origin+previewPath)).status,401,'the removed bearer URL cannot bypass owner authentication');
    assert.equal((await fetch(security.origin+previewPath,{headers:token})).status,404,'active HTML/SVG preview content is not served from Pilot origin');
    ws.close();await new Promise<void>(resolve=>ws!.once('close',()=>resolve()));ws=undefined;
    const deleted=await fetch(security.origin+'/api/terminals/'+terminalBody.terminal.id,{method:'DELETE',headers:writes,body:JSON.stringify({projectId:project.id})});
    assert.equal(deleted.status,200);
    assert.deepEqual((await (await fetch(security.origin+'/api/projects/'+project.id+'/terminals',{headers:token})).json() as {terminals:unknown[]}).terminals,[]);
  }finally{ws?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
