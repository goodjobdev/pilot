export interface ModelChoice { provider:string; modelId:string }
export const modelKey=(choice:ModelChoice)=>choice.provider+'/'+choice.modelId;
export interface ModelOption extends ModelChoice { name:string; configured:boolean }
export interface ProviderOption { id:string; name:string; configured:boolean; credentialType?:'api_key'|'oauth'; apiKey:boolean; oauth:boolean }
export interface ModelPreferences { defaultModel:ModelChoice|null; favourites:ModelChoice[]; allowRealModels:boolean }
export interface ProviderSettings { providers:ProviderOption[]; models:ModelOption[]; preferences:ModelPreferences }
export interface LoginView {
 id:string; provider:string; status:'pending'|'done'|'failed'|'cancelled'; message:string;
 url?:string; userCode?:string;
 prompt?:{id:string;type:'text'|'secret'|'select'|'manual_code';message:string;options?:{id:string;label:string}[]};
}
export interface RepositoryConnection {
 repository:string; publicKey:string|null; fingerprint:string|null; connected:boolean; branch:string|null;
}
