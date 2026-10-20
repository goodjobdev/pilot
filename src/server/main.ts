import { createServer } from 'node:http';
import { readFile,realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { previewImport,applyImport,documentsSchema,type ImportPreview } from './importer';
import { safePath } from './paths';
import { atomicWrite } from './board-store';
import { z } from 'zod';
import { resolve,extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { BoardStore,HttpError } from './board-store';
import { DocStore } from './docs-store';
import { HarnessHost } from './agents/harness-host';
import { AlertStore,type AlertTransport } from './alerts';
import { Catalog } from './catalog';
import { ProviderStore } from './providers';
import { RepositoryStore } from './repositories';
import { browse,within } from './paths';
import { authorize,headers,localConfig,hostedConfig,establishSession,type SecurityConfig } from './security';
import { emptyBoard } from '../shared/model';
import { serializeBoard } from '../shared/markdown';
export interface AppOptions {dataRoot:string;browseRoots:string[];security:SecurityConfig;clientRoot?:string;registry?:string;agents?:'on'|'off';agentPauseMs?:number;alertTransport?:AlertTransport;alertSubject?:string;alertCooldownMs?:number}
export async function createApp(options:AppOptions){
  const boards=new BoardStore(options.dataRoot),docs=new DocStore(),catalog=new Catalog(options.dataRoot,options.browseRoots,boards);await catalog.init();
  const providers=new ProviderStore(catalog.root),repositories=new RepositoryStore(catalog.root);
  const alerts=new AlertStore(options.dataRoot,{subject:options.alertSubject??(process.env.DASHBOARD_OWNER?'mailto:'+process.env.DASHBOARD_OWNER:undefined),transport:options.alertTransport,cooldownMs:options.alertCooldownMs});
  await alerts.init();
  // The agent harness is the only execution surface. It is off unless the instance enables it explicitly.
  const agents=new HarnessHost({
    dataRoot:options.dataRoot,providers,
    enabled:(options.agents??(process.env.DASHBOARD_AGENTS==='on'?'on':'off'))==='on',
    pauseMs:options.agentPauseMs??Number(process.env.DASHBOARD_AGENT_PAUSE_MS??2500),
    onEvent:event=>{
      // A notification says which project needs attention and where to go, never what it says.
      const title=event.kind==='question'?'An agent needs an answer':event.kind==='error'?'An agent run failed':'An agent finished';
      const body=[event.projectName,event.detail].filter(Boolean).join(' — ').slice(0,240);
      void alerts.notify({title,body,url:'/?project='+event.projectId+'&view=Agents',tag:'dashboard-'+event.projectId+'-'+event.kind},{key:event.projectId+':'+event.kind}).catch(()=>{/* a failed alert never breaks a run */});
    }
  });
  const previews=new Map<string,{projectId:string;revision:string;preview:ImportPreview;documents:{name:string;content:string}[];expires:number}>();
  const server=createServer(async(req,res)=>{
    headers(res);
    // Operational visibility without secrets: method, path and status only.
    const logged=(req.url??'/').split('?')[0];
    res.on('finish',()=>console.log(req.method+' '+logged+' -> '+res.statusCode));
    try {
      const url=new URL(req.url??'/',options.security.origin),path=url.pathname;
      if(req.headers.host!==new URL(options.security.origin).host)throw new HttpError(403,'Untrusted Host');
      const json=(data:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
      if(path==='/healthz'){json({ok:true});return;}
      if(path.startsWith('/api/')){
        const subject=await authorize(req,options.security);
        let payload:any={};
        if(!['GET','HEAD'].includes(req.method??'')){
          let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>8*1024*1024)throw new HttpError(413,'Request too large');}
          try{payload=JSON.parse(body);}catch{throw new HttpError(400,'Invalid JSON');}
        }
        if(path==='/api/settings/providers'&&req.method==='GET'){json(await providers.view());return;}
        if(path==='/api/settings/models'&&req.method==='POST'){json(await providers.savePreferences(payload));return;}
        const providerRoute=path.match(/^\/api\/settings\/providers\/([a-z0-9-]+)(?:\/(key|login))?$/);
        if(providerRoute){
          if(providerRoute[2]==='key'&&req.method==='POST'){await providers.saveKey(providerRoute[1],payload);json({ok:true});return;}
          if(providerRoute[2]==='login'&&req.method==='POST'){json(await providers.startLogin(providerRoute[1]));return;}
          if(!providerRoute[2]&&req.method==='DELETE'){await providers.logout(providerRoute[1]);json({ok:true});return;}
        }
        const loginRoute=path.match(/^\/api\/settings\/logins\/([a-f0-9-]{36})$/);
        if(loginRoute){
          if(req.method==='GET'){json(providers.login(loginRoute[1]));return;}
          if(req.method==='POST'){json(providers.reply(loginRoute[1],payload));return;}
          if(req.method==='DELETE'){await providers.cancel(loginRoute[1]);json({ok:true});return;}
        }
        const repositoryRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/repository(?:\/(key|test|connect))?$/);
        if(repositoryRoute){
          const p=catalog.get(repositoryRoute[1]),action=repositoryRoute[2];
          if(!action&&req.method==='GET'){json(await repositories.view(p));return;}
          if(action==='key'&&req.method==='POST'){json(await repositories.generate(p));return;}
          if(action==='key'&&req.method==='DELETE'){json(await repositories.removeKey(p));return;}
          if(action==='test'&&req.method==='POST'){json(await repositories.test(p));return;}
          if(action==='connect'&&req.method==='POST'){
            if(payload.confirm!==true)throw new HttpError(422,'Explicit confirmation required');
            json(await repositories.connect(p,async()=>{await boards.drain();await docs.drain();await agents.detach(p);},async()=>catalog.attachWorktree(p.id)));return;
          }
        }
        const scopedProject=path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/|$)/)?.[1];
        if(scopedProject&&repositories.isConnecting(scopedProject))throw new HttpError(409,'Repository connection in progress. Retry after it finishes.');
        if(path==='/api/session' && req.method==='GET'){json(establishSession(req,res,options.security,subject));return;}
        if(path==='/api/roots' && req.method==='GET'){json(options.browseRoots);return;}
        if(path==='/api/alerts' && req.method==='GET'){json({enabled:alerts.enabled,publicKey:alerts.publicKey,subscriptions:alerts.count});return;}
        if(path==='/api/alerts/subscribe' && req.method==='POST'){json(await alerts.subscribe(payload));return;}
        if(path==='/api/alerts/unsubscribe' && req.method==='POST'){json(await alerts.unsubscribe((payload as {endpoint?:unknown}).endpoint));return;}
        if(path==='/api/alerts/test' && req.method==='POST'){json(await alerts.notify({title:'Project dashboard',body:'Test alert — alerts reach this device.',url:'/',tag:'dashboard-test'}));return;}
        if(path==='/api/browse' && req.method==='GET'){json(await browse(url.searchParams.get('path')??options.browseRoots[0]??'',options.browseRoots));return;}
        if(path==='/api/preview' && req.method==='POST'){json(await catalog.preview(payload.path));return;}
        if(path==='/api/suggestions' && req.method==='GET'){
          if(!options.registry){json([]);return;}
          const r=JSON.parse(await readFile(options.registry,'utf8'));json([...(r.repos??[]),...(r.nestedRepos??[]),...(r.localOnly??[])].map(p=>({name:p.name,path:p.path,remote:p.remote??''})));return;
        }
        if(path==='/api/projects'){
          if(req.method==='GET'){json(await catalog.list());return;}
          if(req.method==='POST'){json(await catalog.register(payload),201);return;}
        }
        const agentsRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/agents(?:\/(stream|input|abort|answer|model))?$/);
        if(agentsRoute){
          const p=catalog.get(agentsRoute[1]);
          if(!agents.enabled){
            if(agentsRoute[2]===undefined&&req.method==='GET'){json({enabled:false,view:null});return;}
            throw new HttpError(503,'Agents are disabled on this instance');
          }
          if(agentsRoute[2]===undefined&&req.method==='GET'){json({enabled:true,view:await agents.view(p)});return;}
          if(agentsRoute[2]==='model'&&req.method==='POST'){const c=z.strictObject({model:z.strictObject({provider:z.string().min(1).max(100),modelId:z.string().min(1).max(200)}).nullable()}).parse(payload);json(await agents.setModel(p,c.model));return;}
          if(agentsRoute[2]==='input'&&req.method==='POST'){
            const data=z.strictObject({text:z.string().min(1).max(8000),mode:z.enum(['followUp','steer','reject']).default('followUp'),requestId:z.string().min(1).max(200).optional()}).parse(payload);
            json(await agents.submit(p,data));return;
          }
          if(agentsRoute[2]==='answer'&&req.method==='POST'){
            const data=z.strictObject({questionId:z.string().min(1).max(100),text:z.string().min(1).max(4000)}).parse(payload);
            json(await agents.answer(p,data));return;
          }
          if(agentsRoute[2]==='abort'&&req.method==='POST'){await agents.abort(p);json({ok:true});return;}
          if(agentsRoute[2]==='stream'&&req.method==='GET'){
            res.statusCode=200;res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-store');res.setHeader('Connection','keep-alive');
            res.write('retry: 3000\n\n');
            let closed=false,dispose:()=>Promise<void>=async()=>{};
            try{
              dispose=await agents.subscribe(p,view=>{if(!closed)res.write('data: '+JSON.stringify(view)+'\n\n');});
            }catch(e){
              res.write('event: error\ndata: '+JSON.stringify({error:(e as Error).message})+'\n\n');res.end();return;
            }
            const keepAlive=setInterval(()=>{if(!closed)res.write(': keep-alive\n\n');},20000);
            req.on('close',()=>{closed=true;clearInterval(keepAlive);void dispose();});
            return;
          }
        }
        const docsRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/docs(?:\/(document|search|asset|inbox))?$/);
        if(docsRoute){
          const p=catalog.get(docsRoute[1]);
          if(!docsRoute[2]&&req.method==='GET'){json({documents:await docs.list(p)});return;}
          if(docsRoute[2]==='document'&&req.method==='GET'){
            const target=url.searchParams.get('path');if(!target)throw new HttpError(400,'Document path is required');
            json(await docs.read(p,target));return;
          }
          if(docsRoute[2]==='search'&&req.method==='GET'){json({matches:await docs.search(p,url.searchParams.get('q')??'')});return;}
          if(docsRoute[2]==='inbox'&&req.method==='GET'){json({questions:await docs.inbox(p)});return;}
          if(docsRoute[2]==='asset'&&req.method==='GET'){
            const target=url.searchParams.get('path');if(!target)throw new HttpError(400,'Asset path is required');
            const asset=await docs.asset(p,target);
            res.statusCode=200;res.setHeader('Content-Type',asset.type);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
            if(asset.sandboxed)res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
            res.end(asset.bytes);return;
          }
          if(docsRoute[2]==='document'&&req.method==='POST'){
            const data=z.strictObject({path:z.string().min(1).max(1000),text:z.string().max(2*1024*1024),revision:z.string().min(1).max(200).optional()}).parse(payload);
            const saved=data.revision===undefined?await docs.create(p,data.path,data.text):await docs.write(p,data.path,data.revision,data.text);
            json(saved,data.revision===undefined?201:200);return;
          }
        }
        const importRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/import\/(preview|apply)$/);
        if(importRoute&&req.method==='POST'){
          const p=catalog.get(importRoute[1]);
          if(importRoute[2]==='preview'){
            const documents=documentsSchema.parse(payload.documents),current=await boards.read(p),preview=previewImport(current.board,documents),token=randomUUID();
            for(const [id,item] of previews)if(item.expires<Date.now())previews.delete(id);
            if(previews.size>=5)throw new HttpError(429,'Too many pending imports');
            previews.set(token,{projectId:p.id,revision:current.revision,preview,documents,expires:Date.now()+900000});json({preview,token});return;
          }
          const data=z.strictObject({token:z.string().uuid(),selected:z.array(z.string()).max(5000),edgeIds:z.array(z.string().uuid()).max(20000)}).parse(payload),pending=previews.get(data.token);
          if(!pending||pending.projectId!==p.id||pending.expires<Date.now())throw new HttpError(409,'Import preview expired; preview again');
          const current=await boards.read(p);if(current.revision!==pending.revision)throw new HttpError(409,'Board changed since preview');
          const board=applyImport(current.board,pending.preview,data.selected,data.edgeIds);
          for(const candidate of pending.preview.candidates.filter(c=>data.selected.includes(c.id))){
            const doc=pending.documents.find(d=>d.name===candidate.documentName)!;
            const file=await safePath(p.path,candidate.source.path,true);await atomicWrite(file,doc.content);
          }
          const result=await boards.mutate(p,current.revision,{op:'restore',board});previews.delete(data.token);json(result);return;
        }
        const sourceRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/sources\/([a-f0-9-]{36})$/);
        if(sourceRoute&&req.method==='GET'){
          const p=catalog.get(sourceRoute[1]),board=await boards.read(p),source=board.board.sources.find(s=>s.id===sourceRoute[2]);
          if(!source)throw new HttpError(404,'Source not registered');
          json({text:await readFile(await safePath(p.path,source.path),'utf8'),source});return;
        }
        const match=path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(board|initialize|export|relocate))?$/);
        if(match){
          const p=catalog.get(match[1]),action=match[2];
          if(!action&&req.method==='DELETE'){await catalog.remove(p.id);json({ok:true});return;}
          if(action==='relocate'&&req.method==='POST'){await catalog.relocate(p.id,payload.path);json(catalog.get(p.id));return;}
          if(action==='initialize'&&req.method==='POST'){if(payload.confirm!==true)throw Error('Confirmation required');json(await boards.initialize(p,serializeBoard(emptyBoard())));return;}
          if(action==='export'&&req.method==='GET'){res.setHeader('Content-Type','text/markdown; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="board.md"');res.end(await boards.raw(p));return;}
          if(action==='board'&&req.method==='GET'){json(await boards.read(p));return;}
          if(action==='board'&&req.method==='POST'){json(await boards.mutate(p,payload.revision,payload.operation));return;}
        }
        throw new HttpError(404,'Unknown API route');
      }
      if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
      if(options.security.mode==='hosted')await authorize(req,options.security);
      if(!options.clientRoot)throw new HttpError(404,'Client not built');
      const relative=decodeURIComponent(path==='/'?'/index.html':path),file=resolve(options.clientRoot,'.'+relative);
      if(!within(options.clientRoot,file))throw new HttpError(403,'Unsafe asset path');
      let data=await readFile(file);
      if(file.endsWith('index.html')&&options.security.mode==='local')data=Buffer.from(data.toString().replace('</head>','<meta name="dashboard-token" content="'+options.security.token+'"></head>'));
      const type:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
      res.setHeader('Content-Type',type[extname(file)]??'application/octet-stream');res.end(data);
    }catch(e){
      const err=e as Error;const code=e instanceof HttpError?e.status:(e as NodeJS.ErrnoException).code==='ENOENT'?404:400;
      console.error(req.method+' '+logged+' -> '+code+' '+err.message);
      res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:err.message,...(e instanceof HttpError&&e.code?{code:e.code}:{})}));
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,catalog,boards,docs,agents,alerts,providers,repositories,close:async()=>{await new Promise<void>((ok,fail)=>server.close(e=>e?fail(e):ok()));await repositories.close();await boards.drain();await docs.drain();await agents.close();await providers.close();await catalog.close();}};
}
// Loopback by default. A container must bind its own interface for the published
// port to reach it, so the pilot sets this explicitly while the published port
// stays 127.0.0.1 on the host.
export function bindHost(env:NodeJS.ProcessEnv):string {
  const host=env.DASHBOARD_BIND??'127.0.0.1';
  const octets=host.split('.');
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)||octets.some(part=>Number(part)>255))throw Error('DASHBOARD_BIND must be an IPv4 address literal; the default is 127.0.0.1');
  return host;
}
async function main(){
  const mode=process.env.DASHBOARD_MODE;
  if(mode!=='local'&&mode!=='hosted')throw Error('Set DASHBOARD_MODE to hosted (Access required) or explicit localhost local mode.');
  const port=Number(process.env.PORT??4317);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
  const security=mode==='hosted'?hostedConfig(process.env):localConfig('http://127.0.0.1:'+port),origin=security.origin,bind=bindHost(process.env);
  const app=await createApp({dataRoot:resolve(process.env.DASHBOARD_DATA??homedir()+'/.local/share/project-dashboard'),browseRoots:(process.env.DASHBOARD_ROOTS??'').split(':').filter(Boolean),security,clientRoot:resolve(fileURLToPath(new URL('./client',import.meta.url))),registry:process.env.DASHBOARD_REGISTRY});
  app.server.listen(port,bind,()=>console.log('Dashboard listening at '+origin+' on '+bind+':'+port));
  let stopping=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(stopping)return;stopping=true;app.close().then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;});});
}
// Node resolves the entry module through release symlinks; argv retains the launch path.
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
