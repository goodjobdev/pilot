import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,symlink,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardStore } from '../../src/server/board-store';
import { Catalog } from '../../src/server/catalog';
import { newTask } from '../../src/shared/model';
test('registration, durable writes, conflicts and duplicate instance lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-store-')),store=new BoardStore(dir),c=new Catalog(dir,[dir],store);await c.init();
 try {const p=await c.register({name:'Fixture',managed:true,confirm:true});const first=await store.read(p);
 const next=await store.mutate(p,first.revision,{op:'putTask',task:newTask(randomUUID(),'Persist')});
 assert.equal(next.board.tasks.length,1);await assert.rejects(store.mutate(p,first.revision,{op:'adopt'}),/changed/);
 const path=join(p.path,'docs/dashboard/board.md');await writeFile(path,'broken');await assert.rejects(store.read(p),/read-only/);assert.equal(await readFile(path,'utf8'),'broken');
 const other=new Catalog(dir,[],store);await assert.rejects(other.init(),/locked/);
 await c.remove(p.id);assert.equal(await readFile(path,'utf8'),'broken');
 }finally{await c.close();}
});
test('approved roots and symlink escape never write outside project',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dashboard-path-')),outside=await mkdtemp(join(tmpdir(),'dashboard-outside-'));
 const store=new BoardStore(dir),c=new Catalog(dir,[dir],store);await c.init();
 try{await assert.rejects(c.register({name:'Bad',path:outside,managed:false,confirm:true}),/outside/);
 const existing=join(dir,'existing');await mkdir(existing);await symlink(outside,join(existing,'docs'));
 const p=await c.register({name:'Existing',path:existing,managed:false,confirm:true});
 await assert.rejects(store.initialize(p,'x'),/Symlinks/);
 await assert.rejects(c.register({name:'Duplicate',path:existing,managed:false,confirm:true}),/already/);
 }finally{await c.close();}
});
