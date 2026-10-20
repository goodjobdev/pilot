import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Credential,CredentialStore,AuthPrompt,Provider,Models,MutableModels } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { PrivateStore } from './private-store';
import { HttpError } from './board-store';
import { modelKey,type ModelChoice,type ModelPreferences,type ProviderSettings,type LoginView } from '../shared/settings';

const choice=z.strictObject({provider:z.string().min(1).max(100),modelId:z.string().min(1).max(200)});
const preferences=z.strictObject({defaultModel:choice.nullable(),favourites:z.array(choice).max(100),allowRealModels:z.boolean()});
const credential=z.union([
 z.object({type:z.literal('api_key'),key:z.string().max(16000).optional(),env:z.record(z.string(),z.string()).optional()}),
 z.object({type:z.literal('oauth'),access:z.string(),refresh:z.string(),expires:z.number()}).passthrough()
]);
export class FileCredentials implements CredentialStore {
 private store:PrivateStore<Record<string,Credential>>;
 constructor(root:string){this.store=new PrivateStore(root,'credentials/providers.json',()=>({}),v=>z.record(z.string(),credential).parse(v));}
 async read(id:string){return (await this.store.read())[id];}
 async list(){return Object.entries(await this.store.read()).map(([providerId,c])=>({providerId,type:c.type}));}
 async modify(id:string,fn:(current:Credential|undefined)=>Promise<Credential|undefined>){
  return this.store.update(async value=>{const next=await fn(value[id]);if(next)value[id]=structuredClone(next);return value[id];});
 }
 async delete(id:string){await this.store.update(async value=>{delete value[id];});}
 async close(){await this.store.drain();}
}
interface LoginJob {
 view:LoginView; controller:AbortController; timer:ReturnType<typeof setTimeout>;
 pending?:{id:string;resolve:(answer:string)=>void;reject:(error:Error)=>void;cleanup:()=>void};
 task:Promise<void>;
}
export class ProviderStore {
 readonly credentials:FileCredentials;
 readonly models:MutableModels;
 private prefs:PrivateStore<ModelPreferences>;
 private jobs=new Map<string,LoginJob>();
 private installation:PrivateStore<{id:string}>;
 constructor(root:string,providers:Provider[]=[openaiProvider(),openaiCodexProvider(),anthropicProvider(),googleProvider(),openrouterProvider()]){
  this.credentials=new FileCredentials(root);
  this.installation=new PrivateStore(root,'settings/installation.json',()=>({id:randomUUID()}),v=>z.strictObject({id:z.string().uuid()}).parse(v));
  this.models=createModels({credentials:this.credentials,authContext:{env:async()=>undefined,fileExists:async()=>false}});
  for(const p of providers)this.models.setProvider(p);
  this.prefs=new PrivateStore(root,'settings/models.json',()=>({defaultModel:null,favourites:[],allowRealModels:false}),v=>preferences.parse(v));
 }
 private provider(id:string){const p=this.models.getProvider(id);if(!p)throw new HttpError(422,'Unsupported provider');return p;}
 async view():Promise<ProviderSettings>{
  const prefs=await this.prefs.read(),info=await this.credentials.list(),configured=new Map(info.map(v=>[v.providerId,v.type]));
  const favourites=new Set(prefs.favourites.map(modelKey));
  const models=this.models.getModels().map(m=>({provider:m.provider,modelId:m.id,name:m.name,configured:configured.has(m.provider)}))
   .sort((a,b)=>Number(favourites.has(modelKey(b)))-Number(favourites.has(modelKey(a)))||a.name.localeCompare(b.name)||modelKey(a).localeCompare(modelKey(b)));
  return {preferences:prefs,models,providers:this.models.getProviders().map(p=>({id:p.id,name:p.name,configured:configured.has(p.id),credentialType:configured.get(p.id),apiKey:Boolean(p.auth.apiKey?.login),oauth:Boolean(p.auth.oauth)&&['openai','openai-codex'].includes(p.id)}))};
 }
 async saveKey(id:string,input:unknown){
  const p=this.provider(id);if(!p.auth.apiKey?.login)throw new HttpError(422,'This provider requires sign-in');
  const {key}=z.strictObject({key:z.string().trim().min(1).max(16000)}).parse(input);
  if(this.hasLogin(id))throw new HttpError(409,'Cancel the pending sign-in first');
  await this.credentials.modify(id,async()=>({type:'api_key',key}));
 }
 async logout(id:string){
  this.provider(id);await this.cancelProvider(id);await this.models.logout(id);
 }
 async savePreferences(input:unknown){
  const parsed=preferences.parse(input);
  for(const c of [...parsed.favourites,...(parsed.defaultModel?[parsed.defaultModel]:[])])this.assertModel(c);
  const unique=new Map(parsed.favourites.map(c=>[modelKey(c),c]));parsed.favourites=[...unique.values()];
  await this.prefs.update(async value=>Object.assign(value,parsed));
  return parsed;
 }
 private assertModel(c:ModelChoice){if(!this.models.getModel(c.provider,c.modelId))throw new HttpError(422,'Unknown model');}
 async defaultModel(){return (await this.prefs.read()).defaultModel;}
 async assertUsable(c:ModelChoice){
  this.assertModel(c);
  if(!(await this.prefs.read()).allowRealModels)throw new HttpError(409,'Enable real model calls in Providers & models first. Provider charges or subscription quota may apply.');
  if(!await this.models.checkAuth(c.provider))throw new HttpError(409,'Connect this provider in Providers & models first');
 }
 private hasLogin(id:string){return [...this.jobs.values()].some(job=>job.view.provider===id&&job.view.status==='pending');}
 async startLogin(id:string):Promise<LoginView> {
  const deviceId=await this.installation.update(async v=>v.id);
  const p=this.provider(id);
  if(!p.auth.oauth||!['openai','openai-codex'].includes(id))throw new HttpError(422,'Browser sign-in is not enabled for this provider; use its API key');
  if([...this.jobs.values()].some(job=>job.view.status==='pending'))throw new HttpError(409,'Finish or cancel the pending provider sign-in first');
  // Only one live job, with a bounded history. Never persist codes, URLs or prompts.
  for(const [key,job] of this.jobs)if(job.view.status!=='pending')this.jobs.delete(key);
  const controller=new AbortController(),jobId=randomUUID();
  const view:LoginView={id:jobId,provider:id,status:'pending',message:'Starting sign-in…'};
  const timer=setTimeout(()=>controller.abort(),15*60*1000);timer.unref();
  const job:LoginJob={view,controller,timer,task:Promise.resolve()};this.jobs.set(jobId,job);
  job.task=this.models.login(id,'oauth',{
   signal:controller.signal,
   notify:event=>{
    if(controller.signal.aborted)return;
    if(event.type==='device_code'){view.url=event.verificationUri;view.userCode=event.userCode;view.message='Open the provider and enter this device code.';}
    else if(event.type==='auth_url'){view.url=event.url;view.message=event.instructions??'Complete sign-in with the provider.';}
    else view.message=event.message;
   },
   prompt:async prompt=>this.prompt(job,prompt)
  },{agentName:'Pilot',getDeviceId:()=>deviceId}).then(()=>{view.status='done';view.message='Provider connected.';},()=>{
   view.status=controller.signal.aborted?'cancelled':'failed';
   view.message=controller.signal.aborted?'Sign-in cancelled or expired.':'Provider sign-in failed. Retry, or choose another login method. No credential details are shown.';
  }).finally(()=>{clearTimeout(timer);job.pending?.cleanup();delete job.pending;delete view.prompt;delete view.url;delete view.userCode;});
  return structuredClone(view);
 }
 private prompt(job:LoginJob,prompt:AuthPrompt):Promise<string>{
  const id=randomUUID();
  job.view.prompt={id,type:prompt.type,message:prompt.message,...(prompt.type==='select'?{options:prompt.options.map(o=>({id:o.id,label:o.label}))}:{})};
  return new Promise((resolve,reject)=>{
   const abort=()=>{cleanup();reject(Error('Sign-in cancelled'));};
   const cleanup=()=>{job.controller.signal.removeEventListener('abort',abort);prompt.signal?.removeEventListener('abort',abort);if(job.pending?.id===id){delete job.pending;delete job.view.prompt;}};
   job.pending={id,resolve:value=>{cleanup();resolve(value);},reject,cleanup};
   job.controller.signal.addEventListener('abort',abort,{once:true});prompt.signal?.addEventListener('abort',abort,{once:true});
   if(job.controller.signal.aborted||prompt.signal?.aborted)abort();
  });
 }
 login(id:string){const j=this.jobs.get(id);if(!j)throw new HttpError(404,'Sign-in expired. Start again.');return structuredClone(j.view);}
 reply(id:string,input:unknown){
  const data=z.strictObject({promptId:z.string().uuid(),answer:z.string().min(1).max(16000)}).parse(input),job=this.jobs.get(id);
  if(!job||job.view.status!=='pending'||job.pending?.id!==data.promptId)throw new HttpError(409,'This sign-in prompt has changed');
  if(job.view.prompt?.options&&!job.view.prompt.options.some(o=>o.id===data.answer))throw new HttpError(422,'Choose a listed login method');
  job.pending.resolve(data.answer);return {ok:true};
 }
 async cancel(id:string){const job=this.jobs.get(id);if(!job)throw new HttpError(404,'Unknown sign-in');job.controller.abort();await job.task;}
 private async cancelProvider(id:string){for(const job of this.jobs.values())if(job.view.provider===id&&job.view.status==='pending'){job.controller.abort();await job.task;}}
 async close(){for(const job of this.jobs.values())job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.task));await this.credentials.close();await this.prefs.drain();await this.installation.drain();}
}
