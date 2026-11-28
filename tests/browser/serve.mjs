import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
const data=await mkdtemp(join(tmpdir(),'dashboard-browser-'));
// The attention scenarios seed durable lifecycle rows for their own disposable project. They learn
// the root this server really uses from one marker file created **for this run** in the ignored
// test-output directory. The name is random, creation is exclusive ('wx': an existing path, including
// a symlink, is refused) and the mode is private. The tests discover it by its random name and refuse
// anything that is not a private regular file. There is no fixed shared name and no debug route.
const outputDirectory=join(process.cwd(),'test-results');
await mkdir(outputDirectory,{recursive:true,mode:0o700});
// The marker must not be redirected through a symlinked output directory.
const outputInfo=await lstat(outputDirectory);
if(outputInfo.isSymbolicLink()||!outputInfo.isDirectory())throw new Error('the test output directory must be a real directory');
// This run owns the fixture markers in the ignored output directory. Remove an earlier run's
// marker so exactly one is discoverable, and retry an earlier data-root removal the teardown could
// not finish. Nothing outside that random-name pattern and that temp-root pattern is touched.
for(const name of await readdir(outputDirectory).catch(()=>[])){
  if(!/^attention-fixture-[a-f0-9]{32}\.root$/.test(name))continue;
  const oldMarker=join(outputDirectory,name);
  const info=await lstat(oldMarker).catch(()=>null);
  if(info?.isFile()&&!(info.isSymbolicLink())&&(info.mode&0o077)===0){
    const oldRoot=(await readFile(oldMarker,'utf8').catch(()=>'')).trim();
    const resolved=resolve(oldRoot);
    if(resolved.startsWith(resolve(tmpdir())+sep)&&/^dashboard-browser-[A-Za-z0-9]{6}$/.test(basename(resolved))){
      const oldInfo=await lstat(resolved).catch(()=>null);
      if(oldInfo?.isDirectory()&&!oldInfo.isSymbolicLink())await rm(resolved,{recursive:true,force:true}).catch(()=>{});
    }
  }
  await rm(oldMarker,{force:true});
}
const marker=join(outputDirectory,'attention-fixture-'+randomBytes(16).toString('hex')+'.root');
const handle=await open(marker,'wx',0o600);
try{await handle.writeFile(data,'utf8');}finally{await handle.close();}
const child=spawn(process.execPath,['dist/server.mjs'],{stdio:'inherit',env:{...process.env,DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:'4399',DASHBOARD_AGENTS:'on',DASHBOARD_AGENT_PAUSE_MS:'1500'}});
// Normal teardown removes this run's marker and disposable data root. An unclean SIGKILL can leave
// both in the system temp folder and the ignored output directory; they hold no credentials, and the
// next start removes an earlier marker of this name pattern.
let cleaned=false;
async function cleanup(){
  if(cleaned)return;
  cleaned=true;
  try{await rm(marker,{force:true});}catch{}
  try{await rm(data,{recursive:true,force:true});}catch{}
}
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
child.on('exit',code=>{void cleanup().then(()=>process.exit(code??1));});
