import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const data=await mkdtemp(join(tmpdir(),'dashboard-browser-'));
const child=spawn(process.execPath,['dist/server.mjs'],{stdio:'inherit',env:{...process.env,DASHBOARD_MODE:'local',DASHBOARD_DATA:data,PORT:'4399',DASHBOARD_AGENTS:'on',DASHBOARD_AGENT_PAUSE_MS:'1500'}});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));child.on('exit',code=>process.exit(code??1));
