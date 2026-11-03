import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { codingTools,codingToolNames,insideWorktree } from '../../src/server/agents/coding-tools';
import { HttpError } from '../../src/server/board-store';

/**
 * The coding tools: the containment this build adds around Pi's own `read`, `write` and `bash`, and
 * the switches that decide whether they exist at all.
 *
 * The tools themselves belong to `@earendil-works/pi-durable`; what is tested here is what this
 * application is responsible for: every path stays inside the connected worktree, the environment is
 * rooted there, the shell is separable from read/write, and a refusal is a refusal rather than a
 * silent rewrite. No model is called and no provider is contacted.
 */
async function worktree(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-coding-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/plan.md'), '# Plan\n');
  await mkdir(join(root, '..', 'outside'), { recursive: true });
  await writeFile(join(root, '..', 'outside', 'secret.txt'), 'outside the worktree\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
/** The smallest execution api the tools actually use, so a tool body can run outside a harness. */
function api(cwd: string, output: string[] = []) {
  const env = new NodeExecutionEnv({ cwd });
  return {
    env,
    output: (chunk: string) => { output.push(chunk); },
    diagnostic: () => {},
    retainedOutput: () => ({ text: output.join(''), truncated: false }),
    agent: async () => ({ model: undefined }),
    models: { getModel: () => undefined }
  } as never;
}
const context = { abortSignal: undefined } as never;

test('insideWorktree accepts the worktree and refuses everything that leaves it',()=>{
 const root='/work/tree';
 for(const path of ['docs/plan.md','./a.txt','a/b/c.txt','/work/tree/docs/plan.md','/work/tree'])assert.equal(insideWorktree(root,path),true,path);
 for(const path of ['../outside.txt','docs/../../outside.txt','/etc/passwd','/work/other/x.txt','/work/tree/../other.txt','','   ','docs/a\0b.txt'])assert.equal(insideWorktree(root,path),false,path);
});

test('the read and write tools stay inside the worktree and refuse a path outside it',async t=>{
 const root=await worktree(t),coding=codingTools({root,shell:false});
 const [read,write]=coding.extension.tools as never as {name:string;execute:(a:unknown,api:unknown,context:unknown)=>Promise<{content?:string}>}[];
 assert.deepEqual(coding.extension.tools?.map(tool=>tool.name),['read','write']);
 // Inside: the tool reads and writes the real file.
 const inside=await read.execute({path:'docs/plan.md'},api(root),context);
 assert.match(JSON.stringify(inside),/Plan/);
 await write.execute({path:'docs/new.md',content:'# New\n'},api(root),context);
 assert.equal(await readFile(join(root,'docs/new.md'),'utf8'),'# New\n');
 // Outside: refused before anything is read or written, and the refusal names the path.
 for(const path of ['../outside/secret.txt','/etc/hostname',join(root,'..','outside','secret.txt')]){
  await assert.rejects(()=>read.execute({path},api(root),context),(error:Error)=>error instanceof HttpError&&error.status===403&&error.message.includes('connected repository worktree'),path);
  await assert.rejects(()=>write.execute({path,content:'overwritten\n'},api(root),context),(error:Error)=>error instanceof HttpError&&error.status===403,path);
 }
 assert.equal(await readFile(join(root,'..','outside','secret.txt'),'utf8'),'outside the worktree\n');
});

test('a symlink that leaves the worktree cannot be read, while one that stays inside it can',async t=>{
 const root=await worktree(t);
 await writeFile(join(root,'docs/real.md'),'# Real\n');
 await symlink('real.md',join(root,'docs/inside-link.md'));
 await symlink('/etc/hostname',join(root,'escape.txt'));
 const read=(codingTools({root,shell:false}).extension.tools as never as {name:string;execute:(a:unknown,api:unknown,context:unknown)=>Promise<unknown>}[])[0];
 const inside=await read.execute({path:'docs/inside-link.md'},api(root),context) as {content?:string};
 assert.match(JSON.stringify(inside),/# Real/,'a symlink that stays inside the worktree reads normally');
 // The path is inside the worktree, so the containment check passes it. The environment is what
 // refuses: it does not follow a link that leaves the root, so nothing outside can be read through
 // one. The refusal is the environment's own error, and no content is returned.
 await assert.rejects(()=>read.execute({path:'escape.txt'},api(root),context),(error:Error)=>!String(error.message).includes('hostname'));
});

test('the shell is separable: read and write do not install it, and it runs in the worktree',async t=>{
 const root=await worktree(t);
 assert.deepEqual(codingToolNames(false),['read','write']);
 assert.deepEqual(codingToolNames(true),['read','write','bash']);
 assert.equal(codingTools({root,shell:false}).extension.tools?.some(tool=>tool.name==='bash'),false);
 const withShell=codingTools({root,shell:true});
 const bash=withShell.extension.tools?.find(tool=>tool.name==='bash') as unknown as {execute:(a:unknown,api:unknown,context:unknown)=>Promise<{output?:string}>};
 assert.ok(bash,'the shell tool is installed when its switch is on');
 const output:string[]=[];
 const result=await bash.execute({command:'pwd; cat docs/plan.md'},api(root,output),context);
 const text=output.join('')+JSON.stringify(result);
 assert.match(text,/# Plan/,'the command ran with the worktree as its working directory');
});

test('the environment is rooted at the worktree, so a relative path resolves there and a command starts there',async()=>{
 const root=await worktree({after:()=>Promise.resolve()});
 const env=codingTools({root,shell:true}).env(undefined,context);
 const absolute=await env.absolutePath('docs/plan.md',context);
 assert.equal(absolute.ok&&absolute.value,join(root,'docs/plan.md'));
 assert.equal(env.cwd,root);
});

test('the instance switches decide what the interface reports as installed, per scope',async t=>{
 const { mkdtemp:mk }=await import('node:fs/promises');
 const { createApp }=await import('../../src/server/main');
 const { localConfig }=await import('../../src/server/security');
 const { ControlStore }=await import('../../src/server/state/control-store');
 const root=await mk(join(tmpdir(),'pilot-coding-http-'));
 const store=new ControlStore(root);
 const security=localConfig('http://127.0.0.1:0');
 const app=await createApp({dataRoot:root,browseRoots:[],security,agents:'on',control:store,coding:{enabled:true,shell:false}});
 await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
 security.origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
 t.after(async()=>{await app.close();store.close();await rm(root,{recursive:true,force:true});});
 const body=await (await fetch(security.origin+'/api/agents',{headers:{'x-dashboard-token':security.token}})).json() as {scopes:{scope:string;installed:boolean}[];fileEdit:{enabled:boolean}};
 const installed=new Map(body.scopes.map(entry=>[entry.scope,entry.installed]));
 assert.equal(installed.get('file_read'),true,'the read tool is installed when the coding switch is on');
 assert.equal(installed.get('file_write'),true,'the write tool is installed with it');
 assert.equal(installed.get('shell'),false,'the shell stays uninstalled while its own switch is off');
 assert.equal(installed.get('file_edit'),false,'the file-edit tool has its own switch and is off here');
 // The vocabulary describes the shell in the words an owner needs to decide: it is not contained.
 const shell=body.scopes.find(entry=>entry.scope==='shell');
 assert.match(String((shell as {description?:string}).description),/not contained/);
});
