import type { Board,Operation,Project,Snapshot } from '../shared/model';
import type { DocEntry,DocSnapshot } from '../shared/docs';
import type { AgentView } from '../shared/agent';
const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')?.content??'';
let csrf='';
export class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
export async function request<T>(path:string,method='GET',data?:unknown):Promise<T> {
  const res=await fetch('/api'+path,{method,headers:{'x-dashboard-token':token,'x-dashboard-csrf':csrf,...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const value=await res.json();if(!res.ok)throw new ApiError(res.status,value.error??'Request failed');return value;
}
export async function session(){const data=await request<{csrf?:string}>('/session');csrf=data.csrf??'';}
export const api={
  projects:()=>request<Project[]>('/projects'),
  register:(data:unknown)=>request<Project>('/projects','POST',data),
  board:(id:string)=>request<Snapshot>('/projects/'+id+'/board'),
  mutate:(id:string,revision:string,operation:Operation)=>request<Snapshot>('/projects/'+id+'/board','POST',{revision,operation}),
  initialize:(id:string)=>request<Snapshot>('/projects/'+id+'/initialize','POST',{confirm:true}),
  remove:(id:string)=>request('/projects/'+id,'DELETE',{}),
  relocate:(id:string,path:string)=>request('/projects/'+id+'/relocate','POST',{path}),
  docs:(id:string)=>request<{documents:DocEntry[]}>('/projects/'+id+'/docs'),
  doc:(id:string,path:string)=>request<DocSnapshot>('/projects/'+id+'/docs/document?path='+encodeURIComponent(path)),
  saveDoc:(id:string,body:{path:string;text:string;revision?:string})=>request<DocSnapshot>('/projects/'+id+'/docs/document','POST',body),
  searchDocs:(id:string,query:string)=>request<{matches:{path:string;line:number;text:string}[]}>('/projects/'+id+'/docs/search?q='+encodeURIComponent(query)),
  inbox:(id:string)=>request<{questions:{path:string;line:number;text:string;anchor:string|null;id:string}[]}>('/projects/'+id+'/docs/inbox'),
  alerts:()=>request<{enabled:boolean;publicKey:string|null;subscriptions:number}>('/alerts'),
  subscribeAlerts:(body:{endpoint:string;keys:{p256dh:string;auth:string}})=>request<{count:number}>('/alerts/subscribe','POST',body),
  unsubscribeAlerts:(endpoint:string)=>request<{count:number}>('/alerts/unsubscribe','POST',{endpoint}),
  testAlert:()=>request<{sent:number;failed:number;skipped:boolean}>('/alerts/test','POST',{}),
  agents:(id:string)=>request<{enabled:boolean;view:AgentView|null}>('/projects/'+id+'/agents'),
  agentInput:(id:string,body:{text:string;mode:'followUp'|'steer'|'reject';requestId?:string})=>request<{submissionId:string;queued:boolean}>('/projects/'+id+'/agents/input','POST',body),
  agentAbort:(id:string)=>request<{ok:true}>('/projects/'+id+'/agents/abort','POST',{}),
  agentAnswer:(id:string,body:{questionId:string;text:string})=>request<{submissionId:string}>('/projects/'+id+'/agents/answer','POST',body),
};
export function assetUrl(id:string,path:string){return '/api/projects/'+id+'/docs/asset?path='+encodeURIComponent(path);}
/**
 * Documentation assets are fetched with the session header rather than referenced by
 * URL, because an <img> or <iframe> request cannot carry it and would only work where
 * a proxy happens to inject an identity header.
 */
async function assetResponse(id:string,path:string):Promise<Response>{
  const res=await fetch(assetUrl(id,path),{headers:{'x-dashboard-token':token}});
  if(!res.ok)throw new ApiError(res.status,'Asset unavailable');
  return res;
}
export async function assetBlobUrl(id:string,path:string):Promise<string>{
  const res=await assetResponse(id,path);
  return URL.createObjectURL(await res.blob());
}
export async function assetText(id:string,path:string):Promise<string>{
  const res=await assetResponse(id,path);
  return res.text();
}
/**
 * Reads the agent view as server-sent events.
 *
 * EventSource cannot send the dashboard session header, so the same frames are
 * read from a streaming fetch instead; in hosted mode Cloudflare supplies the
 * Access assertion for this same-origin request.
 */
export async function agentStream(id:string,onView:(view:AgentView)=>void,signal:AbortSignal):Promise<void>{
  const res=await fetch('/api/projects/'+id+'/agents/stream',{headers:{'x-dashboard-token':token},signal});
  if(!res.ok||!res.body)throw new ApiError(res.status,'Agent stream unavailable');
  const reader=res.body.getReader(),decoder=new TextDecoder();
  let buffer='';
  for(;;){
    const {value,done}=await reader.read();
    if(done)return;
    buffer+=decoder.decode(value,{stream:true});
    const frames=buffer.split('\n\n');
    buffer=frames.pop()??'';
    for(const frame of frames){
      const line=frame.split('\n').find(entry=>entry.startsWith('data: '));
      if(!line)continue;
      try{onView(JSON.parse(line.slice(6)) as AgentView);}catch{/* a malformed frame is ignored, the next one still applies */}
    }
  }
}
export function download(name:string,text:string,type='text/plain'){
 const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
