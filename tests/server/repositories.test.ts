import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RepositoryStore,githubRepository,type RepositoryCommand} from '../../src/server/repositories';
import type {Project} from '../../src/shared/model';
const exec=promisify(execFile);
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'pilot-repository-')),path=join(directory,'planning');await mkdir(path);const p:Project={id:randomUUID(),name:'Disposable',repository:'https://github.com/example/disposable.git',managed:true,path,created:new Date().toISOString()};return {directory,p};}
test('GitHub URLs reject credentials, local paths, options and alternate protocols',()=>{
 for(const input of ['https://user:pass@github.com/org/repo','file:///tmp/repo','--upload-pack=evil','ssh://evil/repo','https://github.com/org/repo?token=secret','https://github.com/org/repo#ref','https://github.com/org/../repo','https://github.com/org/..'])assert.throws(()=>githubRepository(input));
 assert.equal(githubRepository('https://github.com/flowforestcom/website.git').ssh,'git@github.com:flowforestcom/website.git');
 assert.equal(githubRepository('git@github.com:org/project.git').settings,'https://github.com/org/project/settings/keys');
});
test('project key generation is idempotent, private, isolated and removable',async()=>{
 const {directory,p}=await fixture(),store=new RepositoryStore(directory);
 try{
  const before=await store.view(p);assert.equal(before.publicKey,null);
  const first=await store.generate(p),again=await store.generate(p);
  assert.match(first.publicKey!,/^ssh-ed25519 /);assert.equal(first.publicKey,again.publicKey);
  assert.match(first.fingerprint!,/^SHA256:/);
  const key=join(directory,'credentials/projects',p.id,'id_ed25519');
  assert.equal((await stat(key)).mode&0o777,0o600);
  assert.equal(JSON.stringify(first).includes('PRIVATE KEY'),false);
  const other={...p,id:randomUUID()};assert.equal((await store.view(other)).publicKey,null);
  const privateKey=await readFile(key,'utf8');
  assert.equal(JSON.stringify(first).includes(privateKey),false);
  await store.removeKey(p);assert.equal((await store.view(p)).publicKey,null);
 }finally{await store.close();}
});
test('containment refuses symlinked credential folders',async()=>{
 const {directory,p}=await fixture(),outside=await mkdtemp(join(tmpdir(),'pilot-key-outside-'));
 await symlink(outside,join(directory,'credentials'));
 const store=new RepositoryStore(directory);
 await assert.rejects(()=>store.generate(p),/Symlinks/);
});

async function localGitFixture(){
 const {directory,p}=await fixture(),source=join(directory,'source');await mkdir(source);
 await exec('git',['init','-b','main',source]);await writeFile(join(source,'index.html'),'<p>Baseline</p>');
 await exec('git',['-C',source,'add','.']);await exec('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.com','commit','-m','Baseline']);
 const commands:string[][]=[];
 const command:RepositoryCommand=async(file,args,options)=>{
  commands.push([file,...args]);
  if(file==='git'&&args.includes('clone')){
   // Test-only injection maps the fixed remote to a local disposable repository.
   args=args.map(a=>a==='git@github.com:example/disposable.git'?source:a);
   args=['-c','protocol.file.allow=always',...args.filter((a,i)=>!(a==='-c'&&args[i+1]==='protocol.file.allow=never')&&a!=='protocol.file.allow=never')];
  }
  return exec(file,args,options);
 };
 return {directory,p,source,commands,store:new RepositoryStore(directory,command)};
}
test('explicit connection uses a worktree, preserves old plans, and never installs/commits/pushes',async()=>{
 const {directory,p,source,commands,store}=await localGitFixture();await mkdir(join(p.path,'docs'));await writeFile(join(p.path,'docs/spec.md'),'# Uncommitted intent');
 const old=p.path;
 try{
  await store.generate(p);
  const mainBefore=(await exec('git',['-C',source,'rev-parse','HEAD'])).stdout;
  let prepared=false;
  const view=await store.connect(p,async()=>{prepared=true;},async path=>{p.path=path;});
  assert.equal(prepared,true);assert.equal(view.connected,true);assert.equal(view.branch,'work/pilot-'+p.id.slice(0,8));
  assert.equal(await readFile(join(p.path,'docs/spec.md'),'utf8'),'# Uncommitted intent');
  assert.equal(await readFile(join(old,'docs/spec.md'),'utf8'),'# Uncommitted intent');
  const main=join(directory,'repositories',p.id,'main');
  assert.equal((await exec('git',['-C',main,'rev-parse','HEAD'])).stdout,mainBefore);
  assert.equal((await exec('git',['-C',main,'status','--porcelain'])).stdout,'');
  assert.match((await exec('git',['-C',p.path,'status','--porcelain'])).stdout,/docs/);
  assert.equal(commands.some(c=>c.some(a=>['push','commit','install'].includes(a))),false);
  await assert.rejects(()=>store.connect(p,async()=>{},async()=>{}),/already connected/);
 }finally{await store.close();}
});
test('conflicting local plans fail without replacing the old workspace or repository content',async()=>{
 const {p,store}=await localGitFixture(),old=p.path;
 await writeFile(join(p.path,'index.html'),'Uncommitted planning asset');
 try{
  await store.generate(p);
  await assert.rejects(()=>store.connect(p,async()=>{},async path=>{p.path=path;}),/without overwriting/);
  assert.equal(p.path,old);assert.equal(await readFile(join(old,'index.html'),'utf8'),'Uncommitted planning asset');
 }finally{await store.close();}
});
