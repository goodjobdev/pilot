import type { Board,Operation,Project,Snapshot } from '../shared/model';
import type { DocEntry,DocSnapshot } from '../shared/docs';
import type { AgentView } from '../shared/agent';
import type { ActionDescriptor,LiveActivity } from '../shared/actions';
import type { AgentAuditEntry,AgentModelChoice,AgentRecord } from '../shared/agent-registry';
import type { MediaView } from '../shared/images';
const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')?.content??'';
let csrf='';
export type ApiErrorKind = 'http' | 'session' | 'network';
export class ApiError extends Error {constructor(public status:number,message:string,public kind:ApiErrorKind='http'){super(message);}}
/** True when the request was answered by the sign-in layer rather than the application. */
export function isSessionExpired(error:unknown):boolean{return error instanceof ApiError&&error.kind==='session';}
let onExpiry:(()=>void)|null=null;
/** Registers a single handler so any request can report an expired session. */
export function whenSessionExpires(handler:()=>void){onExpiry=handler;}
export async function request<T>(path:string,method='GET',data?:unknown,retried=false):Promise<T> {
  let res:Response;
  try{
    // A manual redirect matters: an authenticating proxy answers an expired session with a
    // redirect to its login page, and fetch cannot follow a cross-origin redirect. Without
    // this the browser reports a network failure and the real cause is invisible.
    res=await fetch('/api'+path,{method,redirect:'manual',headers:{'x-dashboard-token':token,'x-dashboard-csrf':csrf,...(data===undefined?{}:{'content-type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  }catch{
    throw new ApiError(0,'The server could not be reached. Check your connection and try again.','network');
  }
  if(res.type==='opaqueredirect'||res.status===0){
    onExpiry?.();
    throw new ApiError(0,'Your sign-in has expired. Reload the page to sign in again, then retry.','session');
  }
  let value:any;
  try{value=await res.json();}
  catch{throw new ApiError(res.status,'The server returned an unexpected response. Reload the page and try again.','network');}
  // This code is returned only by authorize(), before body parsing or any side effect.
  // Never retry network failures, generic 403s, conflicts, or admitted mutations.
  if(res.status===403&&value.code==='SESSION_CSRF'&&!retried&&method!=='GET'&&method!=='HEAD'){
    await session();
    return request<T>(path,method,data,true);
  }
  if(!res.ok)throw new ApiError(res.status,value.error??'Request failed');
  return value as T;
}
let renewing:Promise<void>|undefined;
export function session():Promise<void>{
  if(!renewing)renewing=request<{csrf?:string}>('/session').then(data=>{csrf=data.csrf??'';}).finally(()=>{renewing=undefined;});
  return renewing;
}
/** The ambient scope an action runs in. A dimension an action requires and this omits is refused. */
export type ActionScope={projectId?:string;sessionId?:string};
/** The registry as the server offers it: only implemented actions, only ones this scope can use. */
export interface ActionListView{readOnly:true;scope:{projectId:string|null;sessionId:string|null};actions:ActionDescriptor[]}
/** One execution: the id that ran and the handler's own result. */
export interface ActionExecution{action:string;result:unknown}
/** One scope of the closed vocabulary, with the one line that describes what granting it would allow. */
export interface AgentScopeOption{scope:string;description:string;installed:boolean}
/** The registry as the server offers it: every agent, the vocabulary, the offered models and the switch. */
export interface AgentRegistryView{agents:AgentRecord[];scopes:AgentScopeOption[];models:AgentModelChoice[];fileEdit:{enabled:boolean;mode:string|null}}
export interface AgentDetailView{agent:AgentRecord;history:AgentAuditEntry[]}
/** The actor a change is made by. The interface always declares the owner: it is the authenticated session. */
export interface AgentActorBody{kind:'owner'|'agent';identity:string}
/** The projects an agent may act in: every project explicitly, or a named set (never an empty one). */
export type AgentProjectScopeBody = {kind:'all'} | {kind:'projects';projectIds:string[]};
export interface AgentDraftBody{
  name:string;description:string;enabled:boolean;model:AgentModelChoice;
  workspace:{scope:AgentProjectScopeBody;subpath:string};
  budgets:{maxRequests:number|null;maxOutputTokens:number|null;maxJobsPerHour:number|null};
  scopes:string[];
}
/** One session as the overview list reports it: the record plus its agent binding, lifecycle and links. */
export interface SessionOverview{
  id:string;name:string;revision:number;model:{provider:string;modelId:string}|null;
  links:{kind:string;taskId?:string;path?:string;anchor?:string|null}[];
  createdAt:string;updatedAt:string;
  agent:{id:string|null;revision:number;boundAt:string|null;boundBy:{kind:string;identity:string}|null};
  lifecycle:{recorded:boolean;state:string|null;revision:number|null;attempt:number|null;reason:string|null;activityAt:string|null};
}
/** The binding read: the durable record, the authority it puts in force and the live agents to choose from. */
export interface SessionBindingView{
  projectId:string;sessionId:string;
  binding:{version:number;projectId:string;sessionId:string;agentId:string|null;revision:number;boundBy:{kind:string;identity:string};boundAt:string}|null;
  authority:{agentId:string|null;scopes:string[]|null;projects:string[]|null;emptyReason:string|null};
  agents:AgentRecord[];
}
/** One recorded file edit, as the read side reports it, with the diff that proves it. */
export interface FileEditRecordView{
  id:string;projectId:string;agentId:string|null;path:string;mode:'propose-only'|'auto-apply';
  applied:boolean;created:boolean;bytes:number;diff:string;diffBytes:number;diffTruncated:boolean;
  createdAt:string;changedBy:{kind:'owner'|'agent';identity:string};
}
export interface FileEditLedgerView{
  readOnly:true;projectId:string;enabled:boolean;mode:'propose-only'|'auto-apply';
  limits:{fileBytes:number;diffBytes:number;edits:number};edits:FileEditRecordView[];truncated:boolean;
}
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
  /** A message carries text, the ids of stored images, or both. */
  agentInput:(id:string,body:{text:string;mode:'followUp'|'steer'|'reject';requestId?:string;images?:string[]})=>request<{submissionId:string;queued:boolean}>('/projects/'+id+'/agents/input','POST',body),
  agentAbort:(id:string)=>request<{ok:true}>('/projects/'+id+'/agents/abort','POST',{}),
  agentAnswer:(id:string,body:{questionId:string;text:string})=>request<{submissionId:string}>('/projects/'+id+'/agents/answer','POST',body),
  /**
   * One image, through the upload path. The declared name and type travel with it but the server
   * decides what the bytes are; a refusal is answered with the server's own per-image reason and code.
   */
  uploadImage:(id:string,body:{data:string;name?:string;declaredType?:string})=>request<{media:MediaView}>('/projects/'+id+'/agents/media','POST',body),
  /**
   * The command registry, its live read-only projection and one action's execution. The registry is
   * the only source of what the palette may offer: nothing in the client hardcodes a capability.
   */
  sessions:(projectId:string)=>request<{sessions:SessionOverview[]}>('/sessions?projectId='+encodeURIComponent(projectId)),
  /** Create one named session for a project; the server validates the name and reports per-field refusals. */
  createSession:(body:{projectId:string;name:string})=>request<{session:SessionOverview}>('/sessions','POST',body),
  /** The per-session agent binding: read the binding and its authority, or write one revision of it. */
  sessionBinding:(projectId:string,sessionId:string)=>request<SessionBindingView>('/sessions/'+encodeURIComponent(sessionId)+'/agent?projectId='+encodeURIComponent(projectId)),
  bindSession:(projectId:string,sessionId:string,body:{revision:number;agentId:string|null;actor:AgentActorBody})=>request<{binding:SessionBindingView['binding'];authority:SessionBindingView['authority']}>('/sessions/'+encodeURIComponent(sessionId)+'/agent','POST',{projectId,...body}),
  /** A dismissal carries a reason and is recorded as its own durable entry, distinct from an answer. */
  dismissQuestion:(projectId:string,body:{questionId:string;reason:string})=>request<{submissionId:string|null}>('/projects/'+projectId+'/agents/dismiss','POST',body),
  actions:(scope:ActionScope={})=>{
    const query=new URLSearchParams();
    if(scope.projectId)query.set('projectId',scope.projectId);
    if(scope.sessionId)query.set('sessionId',scope.sessionId);
    const suffix=query.toString();
    return request<ActionListView>('/actions'+(suffix?'?'+suffix:''));
  },
  actionActivity:(projectId:string)=>request<LiveActivity>('/actions/activity?projectId='+encodeURIComponent(projectId)),
  /**
   * The agent registry and the bounded file-edit ledger. The interface reads and writes the same
   * authenticated routes as everything else and is never the enforcement point: every rule — the
   * closed vocabulary, the offered model, the workspace scope, the budgets and the governance
   * decision — is decided by the server, and a refusal arrives with the server's own words.
   */
  agentRegistry:()=>request<AgentRegistryView>('/agents'),
  agent:(id:string)=>request<AgentDetailView>('/agents/'+encodeURIComponent(id)),
  createAgent:(body:{draft:AgentDraftBody;actor:AgentActorBody})=>request<{agent:AgentRecord}>('/agents','POST',body),
  updateAgent:(id:string,body:{revision:number;patch:Partial<AgentDraftBody>;actor:AgentActorBody})=>request<{agent:AgentRecord}>('/agents/'+encodeURIComponent(id)+'/update','POST',body),
  archiveAgent:(id:string,body:{revision:number;actor:AgentActorBody})=>request<{agent:AgentRecord}>('/agents/'+encodeURIComponent(id)+'/archive','POST',body),
  fileEdits:(projectId:string)=>request<FileEditLedgerView>('/projects/'+projectId+'/file-edits'),
  writeFileEdit:(projectId:string,body:{request:{agentId:string|null;path:string;content:string;mode?:'propose-only'|'auto-apply'};actor:AgentActorBody})=>request<{edit:FileEditRecordView;written:boolean}>('/projects/'+projectId+'/file-edits','POST',body),
  runAction:(id:string,body:{params?:Record<string,unknown>;scope?:ActionScope}={})=>request<ActionExecution>('/actions/execute','POST',{id,...body}),
};
export function assetUrl(id:string,path:string){return '/api/projects/'+id+'/docs/asset?path='+encodeURIComponent(path);}
/**
 * Stored media is served owner-only, so it is fetched with the session header and shown as a blob
 * URL: an <img src> request cannot carry that header. The URL is the caller's to revoke.
 */
export async function mediaBlobUrl(id:string):Promise<string>{
  const res=await fetch('/api/media/'+id,{headers:{'x-dashboard-token':token}});
  if(!res.ok)throw new ApiError(res.status,'Image unavailable');
  return URL.createObjectURL(await res.blob());
}
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
export async function agentStream(id:string,onView:(view:AgentView)=>void,signal:AbortSignal,sessionId?:string):Promise<void>{
  const qs=sessionId?'?sessionId='+encodeURIComponent(sessionId):'';
  const res=await fetch('/api/projects/'+id+'/agents/stream'+qs,{headers:{'x-dashboard-token':token},signal});
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
