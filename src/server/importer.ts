import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Board,Task,Source,Milestone,Relationship } from '../shared/model';
import { newTask } from '../shared/model';
import { hash } from './board-store';
import { validateBoard } from '../shared/schema';
export const documentSchema=z.strictObject({name:z.string().min(1).max(300).refine(n=>!n.startsWith('/')&&!n.includes('\\')&&!n.split('/').some(p=>p==='..')&&!n.startsWith('.'),'Use a relative public document name'),content:z.string().max(2*1024*1024)});
export const documentsSchema=z.array(documentSchema).min(1).max(100);
export interface Candidate {id:string;task:Task;source:Source;change:'new'|'changed'|'unchanged'|'duplicate';reason:string;previous?:Task;documentName:string}
export interface ImportPreview {candidates:Candidate[];milestones:Milestone[];relationships:Relationship[];removed:string[];warnings:string[]}
function clean(text:string){return text.replace(/\*\*|`/g,'').replace(/#(?:stream|due):\S+|#(?:high|med|low|critical)\b/g,'').trim();}
function area(title:string):string {
 const groups:[string,RegExp][]=[['mobile',/android|ios|mobile|testflight|pixel/i],['devices',/device|enrollment/i],['sync',/sync|peer|relay|pairing|automerge/i],['storage',/storage|sqlite|persist|serializer|history|draft|export|opfs/i],['desktop',/tauri|native|desktop|sidecar|restart|quit/i],['frontend',/ui\b|editor|timeline|preview|theme|sidebar|wysiwyg/i],['release',/release|signing|ci\b|documentation|notari/i]];
 return groups.find(([,rx])=>rx.test(title))?.[0]??'backend';
}
function digestId(key:string):string {const h=hash(key);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
// Inspect inert raw-text blocks; never execute HTML, and ignore commented-out examples.
function legacyData(html:string):unknown {
 const starts=/<!--|<(script|style|textarea|title)\b([^>]*)>/gi,blocks:string[]=[];
 let match:RegExpExecArray|null;
 while((match=starts.exec(html))){
   if(match[0]==='<!--'){const end=html.indexOf('-->',starts.lastIndex);if(end<0)break;starts.lastIndex=end+3;continue;}
   const close=new RegExp('</'+match[1]+'\\s*>','i').exec(html.slice(starts.lastIndex));
   if(!close)break;
   const end=starts.lastIndex+close.index;
   if(match[1].toLowerCase()==='script'&&/\bid\s*=\s*(["'])dash-data\1/i.test(match[2]))blocks.push(html.slice(starts.lastIndex,end));
   starts.lastIndex=end+close[0].length;
 }
 if(blocks.length!==1)throw Error('Legacy HTML must contain exactly one uncommented dash-data JSON block');
 return JSON.parse(blocks[0]);
}
export function previewImport(board:Board,input:unknown):ImportPreview {
 const docs=documentsSchema.parse(input),candidates:Candidate[]=[],milestones=[...board.milestones],relationships:Relationship[]=[],warnings:string[]=[],seen=new Set<string>();
 const milestoneTasks=new Map<string,string>(),dependencySuggestions:{target:string;milestones:string[]}[]=[];
 function candidate(name:string,locator:string,title:string,status:Task['status'],description:string,scope:Task['scope']='active',milestone:string|null=null){
   const key=name+':'+locator,id=digestId(key),priorSource=board.sources.find(s=>s.id===id);
   const fingerprint=hash(description+'\n'+title+'\n'+status);
   const source:Source={id,name,path:'docs/dashboard/sources/'+id+'-'+hash(docs.find(d=>d.name===name)!.content)+'.md',locator,fingerprint,captured:new Date().toISOString()};
   const existing=board.tasks.find(t=>t.sources.includes(id)),duplicate=[...board.tasks,...candidates.map(c=>c.task)].find(t=>t.title.toLowerCase()===title.toLowerCase()&&t.id!==existing?.id);
   const task:Task={...(existing??newTask(randomUUID(),title)),title:title.slice(0,500),description:description.slice(0,20000),status,domain:existing?.domain??area(title),scope:existing?.scope??scope,milestone:existing?.milestone??milestone,sources:[...new Set([...(existing?.sources??[]),id])]};
   const change=existing?(priorSource?.fingerprint===fingerprint?'unchanged':'changed'):duplicate?'duplicate':'new';
   candidates.push({id:key,task,source,change,documentName:name,reason:change==='changed'?'Source changed; applying replaces imported title/status/description. Keep unchecked to preserve your edits.':change==='duplicate'?'Similar title already exists; review before adding.':'Review area, completion and acceptance claims before applying.',previous:existing});
   seen.add(id);return task;
 }
 for(const doc of docs){
   if(!/\.(md|mdx|html)$/i.test(doc.name))throw Error('Only markdown and legacy dashboard HTML are supported');
   if(/\.html$/i.test(doc.name)){
     const data=z.object({tasks:z.array(z.object({id:z.union([z.string(),z.number()]).optional(),title:z.string().default('Untitled'),status:z.enum(['todo','doing','done','blocked']).catch('todo'),note:z.string().optional(),stream:z.string().optional()}).passthrough()).max(5000)}).passthrough().parse(legacyData(doc.content));
     if(data.tasks.length>5000)throw Error('Legacy import exceeds task limit');
     warnings.push(doc.name+': legacy status may be obsolete; current release documents take precedence.');
     for(const t of data.tasks)candidate(doc.name,String(t.id??hash(String(t.title))),clean(String(t.title??'Untitled')),t.status,String(t.note??t.title??''),'historical',milestones.some(m=>m.id===t.stream)?t.stream!:null);
     continue;
   }
   const milestoneMatch=doc.content.match(/^#\s+(M[1-9]\d*)\s+[—–-]\s+(.+)$/m);
   if(milestoneMatch){
     const mid=milestoneMatch[1],name=mid+' · '+milestoneMatch[2];if(!milestones.some(m=>m.id===mid))milestones.push({id:mid,name,order:Number(mid.slice(1))});
     const statusLine=doc.content.match(/^(?:\*\*)?Status:\s*(.+?)(?:\*\*)?$/m)?.[1]??'pending';
     const status:Task['status']=/design-only deliverable complete|^complete\b|^done\b/i.test(statusLine)?'done':/in progress/i.test(statusLine)?'doing':/blocked/i.test(statusLine)?'blocked':'todo';
     const task=candidate(doc.name,'milestone:'+mid,name,status,doc.content,mid==='M6'?'design-only':'active',mid);
     if(mid==='M3'||mid==='M4'||mid==='M5')task.acceptance='Implementation/packaging evidence is not installed or real-device acceptance. See source.';
     if(mid==='M6')task.acceptance='Design deliverable only; sharing implementation remains unauthorized.';
     const dep=doc.content.match(/Depends:\s*([^\n.]+)/i)?.[1]??statusLine.match(/blocked by\s+(M[1-9]\d*[^.\n]*)/i)?.[1];if(dep)dependencySuggestions.push({target:task.id,milestones:[...dep.matchAll(/\bM[1-9]\d*/g)].map(m=>m[0])});
     const gateText=doc.content.match(/^External blockers:\s*([\s\S]*?)(?=\n(?:Evidence|Checks|Limitations):|(?![\s\S]))/m)?.[1];
     if(gateText&&!task.gates.length)task.gates=[{id:randomUUID(),label:gateText.trim().slice(0,500),state:'open',evidence:'Source import; verify prerequisites individually.'}];
     milestoneTasks.set(mid,task.id);
   }
   let heading='',historical=false;const count=new Map<string,number>(),lines=doc.content.split('\n');
   for(let index=0;index<lines.length;index++){
     const text=lines[index];
     if(/Legacy checklist below is historical/i.test(text))historical=true;
     const h=text.match(/^#{1,6}\s+(.+)/);if(h)heading=clean(h[1]);
     const m=text.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);if(!m)continue;
     let body=m[2];
     for(let next=index+1;next<lines.length;next++){
       const continuation=lines[next].match(/^\s{2,}(\S.*)$/);
       if(!continuation||/^\s*[-*]\s+\[/.test(lines[next]))break;
       body+=' '+continuation[1].trim();
     }
     const title=clean(body).split(' :: ')[0];if(!title)continue;
     const key=heading+':'+title,ordinal=count.get(key)??0;count.set(key,ordinal+1);
     const scope:Task['scope']=historical?'historical':/backlog|later|deferred/i.test(heading)?'deferred':/historical|legacy/i.test(heading)?'historical':'active';
     candidate(doc.name,'checkbox:'+key+':'+ordinal,title,m[1]===' '?'todo':'done',body,scope,milestoneMatch?.[1]??null);
   }
 }
 for(const dep of dependencySuggestions)for(const mid of new Set(dep.milestones)){
   const from=milestoneTasks.get(mid)??board.tasks.find(t=>t.milestone===mid)?.id;
   if(from&&from!==dep.target&&!board.relationships.some(e=>e.source===from&&e.target===dep.target&&e.kind==='blocks'))relationships.push({id:randomUUID(),source:from,target:dep.target,kind:'blocks'});
 }
 const removed=board.tasks.filter(t=>t.sources.some(id=>{const s=board.sources.find(s=>s.id===id);return s&&!seen.has(id)&&docs.some(d=>digestId(d.name+':'+s.locator)===id);})).map(t=>t.id);
 return {candidates,milestones,relationships,removed,warnings};
}
export function applyImport(board:Board,preview:ImportPreview,selected:string[],edgeIds:string[]):Board {
 const b=structuredClone(board),chosen=preview.candidates.filter(c=>selected.includes(c.id));
 if(chosen.length!==new Set(selected).size)throw Error('Unknown import selection');
 b.milestones=preview.milestones;
 for(const c of chosen){const index=b.tasks.findIndex(t=>t.id===c.task.id);if(index<0)b.tasks.push(c.task);else b.tasks[index]=c.task;
   const s=b.sources.findIndex(s=>s.id===c.source.id);if(s<0)b.sources.push(c.source);else b.sources[s]=c.source;
 }
 for(const e of preview.relationships.filter(e=>edgeIds.includes(e.id)))b.relationships.push(e);
 if(edgeIds.some(id=>!preview.relationships.some(e=>e.id===id)))throw Error('Unknown dependency selection');
 return validateBoard(b);
}
