import { readFile,writeFile,mkdir,lstat,readdir,realpath,open,unlink } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { createHash } from 'node:crypto';

const digest=data=>createHash('sha256').update(data).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Mirrors the application's own exclusions: derived or vendored folders are never planning data.
const generatedSegments=new Set(['node_modules','dist','build','out','target','coverage','vendor','venv','.git','.astro','.svelte-kit','.next','.nuxt','.turbo','.cache','test-results','playwright-report','.runway','.kilo','.pi-web','tmp']);
const isMarkdown=name=>name.endsWith('.md')||name.endsWith('.mdx');
const isGenerated=relative=>relative.split('/').slice(0,-1).some(part=>generatedSegments.has(part)||(part.startsWith('.')&&part!=='.github'));

async function safe(root,relative){
 if(relative.startsWith('/')||relative.includes('\\')||relative.split('/').some(p=>!p||p==='..'||p==='.'))throw Error('Unsafe backup path');
 let at=root;for(const part of relative.split('/')){at=join(at,part);const stat=await lstat(at);if(stat.isSymbolicLink())throw Error('Symlinks not allowed in backup');}return at;
}
/** Every Markdown file under a root, never following a symlink. */
async function walk(root,relative=''){
 const result=[];
 for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
  const rel=relative?relative+'/'+entry.name:entry.name;
  if(entry.isSymbolicLink())throw Error('Symlink in planning data');
  if(entry.isDirectory())result.push(...await walk(root,rel));
  else if(entry.isFile()&&isMarkdown(entry.name))result.push(rel);
 }
 return result;
}
async function newDirectory(path){await mkdir(path,{mode:0o700});return realpath(path);}

/**
 * Offline snapshot of everything the dashboard owns.
 *
 * A managed project lives inside the data root, so its whole tree is planning data and is
 * copied — the board, the inert source snapshots and the documentation the wiki edits. An
 * external project's repository is its own backup, so only the board and its snapshots are
 * copied. Credentials, the service lock and the agent session databases are never included.
 */
export async function backup(source,destination){
 const root=await realpath(source),lock=await open(join(root,'service.lock'),'wx',0o600);
 try{
  await lock.writeFile(JSON.stringify({pid:process.pid,purpose:'offline-backup'}));
  const raw=await readFile(await safe(root,'catalog.json'),'utf8'),catalog=JSON.parse(raw);
  if(catalog.version!==1||!Array.isArray(catalog.projects))throw Error('Unsupported catalog');
  const files=new Map([['catalog.json',Buffer.from(raw)]]);
  const collect=async(project,base,prefix)=>{
   for(const path of await walk(base)){
    const relative=prefix?prefix+'/'+path:path;
    if(isGenerated(relative))continue;
    files.set('projects/'+project.id+'/'+relative,await readFile(await safe(base,path)));
   }
  };
  for(const p of catalog.projects){
   if(!uuid.test(p.id))throw Error('Invalid project ID');
   if(p.managed)await collect(p,p.path,'');
   else{await safe(p.path,'docs/dashboard');await collect(p,join(p.path,'docs/dashboard'),'docs/dashboard');}
  }
  const out=await newDirectory(destination),manifest={version:1,created:new Date().toISOString(),files:[]};
  for(const [path,data] of files){await mkdir(dirname(join(out,path)),{recursive:true,mode:0o700});await writeFile(join(out,path),data,{flag:'wx',mode:0o600});manifest.files.push({path,sha256:digest(data)});}
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return manifest;
 }finally{await lock.close();await unlink(join(root,'service.lock'));}
}

export async function restore(source,destination){
 const root=await realpath(source),manifest=JSON.parse(await readFile(await safe(root,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length>20000)throw Error('Unsupported backup');
 // Backups made before the wiki stored board paths relative to docs/dashboard; canonicalise
 // them on the way in so one code path handles both shapes.
 const canonical=path=>{
  const match=/^(projects\/[a-f0-9-]{36}\/)(.+)$/.exec(path);
  if(!match)return path;
  const rest=match[2];
  return rest==='board.md'||rest.startsWith('sources/')?match[1]+'docs/dashboard/'+rest:path;
 };
 const data=new Map();
 for(const entry of manifest.files){
  if(!/^catalog\.json$|^projects\/[a-f0-9-]{36}\/[A-Za-z0-9._/-]+\.mdx?$/.test(entry.path))throw Error('Unsafe manifest entry');
  const bytes=await readFile(await safe(root,entry.path));
  if(digest(bytes)!==entry.sha256)throw Error('Backup checksum mismatch');
  data.set(canonical(entry.path),bytes);
 }
 if(!data.has('catalog.json'))throw Error('Missing catalog');
 const catalog=JSON.parse(data.get('catalog.json').toString());
 if(catalog.version!==1||!Array.isArray(catalog.projects))throw Error('Unsupported catalog');
 const out=resolve(destination);
 // Validate everything before creating the new restore directory.
 for(const p of catalog.projects){if(!uuid.test(p.id)||!data.has('projects/'+p.id+'/docs/dashboard/board.md'))throw Error('Incomplete project backup');}
 await newDirectory(out);
 for(const p of catalog.projects){
  const workspace=join(out,'workspaces',p.id);await mkdir(join(workspace,'docs/dashboard'),{recursive:true,mode:0o700});
  for(const [path,bytes] of data){
   const prefix='projects/'+p.id+'/';
   if(!path.startsWith(prefix))continue;
   const target=join(workspace,path.slice(prefix.length));
   await mkdir(dirname(target),{recursive:true,mode:0o700});
   await writeFile(target,bytes,{flag:'wx',mode:0o600});
  }
  p.path=workspace;p.managed=true;
 }
 await writeFile(join(out,'catalog.json'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx',mode:0o600});
 return {projects:catalog.projects.length,root:out};
}
