import {test} from 'node:test';
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {link,lstat,mkdir,mkdtemp,open,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RUNNER_SNAPSHOT_MAX_FILES,validateRunnerSnapshot} from '../../src/server/state/runner-snapshot';

const file=(path:string,bytes:string)=>({path,mode:'100644',base64:Buffer.from(bytes).toString('base64')});
const snapshot=(files:ReturnType<typeof file>[])=>validateRunnerSnapshot({version:1,files});
async function fixture(run:(root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'pilot-handoff-characterization-'));
 try{await run(root);}finally{await rm(root,{recursive:true,force:true});}
}

test('snapshot digest is content identity, not project or fork authorization',()=>{
 const bytes=[file('test.js','same')];
 // Two independently asserted origins do not enter the validator or its digest.
 const projectA={projectId:'project-a',forkId:'fork-a',snapshot:snapshot(bytes)};
 const projectB={projectId:'project-b',forkId:'fork-b',snapshot:snapshot(bytes)};
 assert.notEqual(projectA.projectId,projectB.projectId);
 assert.equal(projectA.snapshot.digest,projectB.snapshot.digest);
 assert.throws(()=>validateRunnerSnapshot({version:1,projectId:projectA.projectId,files:bytes}));
 assert.throws(()=>snapshot(Array.from({length:RUNNER_SNAPSHOT_MAX_FILES+1},(_,i)=>file(`f${i}.js`,''))));
});

test('a checked parent path can be replaced by a symlink before a no-follow leaf open',{skip:!constants.O_NOFOLLOW},async()=>fixture(async root=>{
 const project=join(root,'project'),outside=join(root,'outside');
 await mkdir(project);await mkdir(outside);await mkdir(join(project,'src'));
 await writeFile(join(project,'src','a.js'),'inside');await writeFile(join(outside,'a.js'),'outside');
 assert.ok((await lstat(join(project,'src'))).isDirectory());
 await rename(join(project,'src'),join(project,'old-src'));
 await symlink(outside,join(project,'src'));
 const handle=await open(join(project,'src','a.js'),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{assert.equal(await handle.readFile('utf8'),'outside');}finally{await handle.close();}
}));

test('a regular file within a tree can be a hard link to an outside mutable inode',async()=>fixture(async root=>{
 const project=join(root,'project');await mkdir(project);
 const outside=join(root,'outside.js'),inside=join(project,'a.js');
 await writeFile(outside,'before');await link(outside,inside);
 const stat=await lstat(inside);assert.ok(stat.isFile());assert.equal(stat.nlink,2);
 await writeFile(outside,'after');assert.equal(await readFile(inside,'utf8'),'after');
}));

test('a digest can faithfully bind a mixed-time read that never was a tree state',async()=>fixture(async root=>{
 const a=join(root,'a.js'),b=join(root,'b.js');
 await writeFile(a,'old-a');await writeFile(b,'old-b');
 const readA=await readFile(a,'utf8');
 await writeFile(a,'new-a');await writeFile(b,'new-b');
 const readB=await readFile(b,'utf8');
 const mixed=snapshot([file('a.js',readA),file('b.js',readB)]);
 assert.notEqual(mixed.digest,snapshot([file('a.js','old-a'),file('b.js','old-b')]).digest);
 assert.notEqual(mixed.digest,snapshot([file('a.js','new-a'),file('b.js','new-b')]).digest);
 assert.equal(mixed.files[0].base64,Buffer.from('old-a').toString('base64'));
 assert.equal(mixed.files[1].base64,Buffer.from('new-b').toString('base64'));
}));
