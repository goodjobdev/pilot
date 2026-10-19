import type { IncomingMessage,ServerResponse } from 'node:http';
import { randomBytes,timingSafeEqual,createHmac } from 'node:crypto';
import { createRemoteJWKSet,jwtVerify,type JWTPayload } from 'jose';
import { HttpError } from './board-store';
export interface SecurityConfig {mode:'local'|'hosted';origin:string;token:string;team?:string;audience?:string;owner?:string;verify?:(jwt:string)=>Promise<JWTPayload>}
export function localConfig(origin:string):SecurityConfig{return {mode:'local',origin,token:randomBytes(32).toString('hex')};}
export function hostedConfig(env:NodeJS.ProcessEnv):SecurityConfig {
 const origin=env.DASHBOARD_ORIGIN,team=env.CF_ACCESS_TEAM,audience=env.CF_ACCESS_AUD,owner=env.DASHBOARD_OWNER;
 if(!origin||!team||!audience||!owner)throw Error('Hosted mode requires DASHBOARD_ORIGIN, CF_ACCESS_TEAM, CF_ACCESS_AUD and DASHBOARD_OWNER');
 if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))throw Error('Access team must be its HTTPS cloudflareaccess.com origin');
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw Error('Hosted public origin must be an exact HTTPS origin');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw Error('Owner must be the allowed Access email');
 return {mode:'hosted',origin,team,audience,owner:owner.toLowerCase(),token:randomBytes(32).toString('hex')};
}
export function headers(res:ServerResponse) {
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
 // Documentation images are loaded as blob URLs after an authenticated fetch, so blob: is
 // allowed for images; frames stay srcdoc-sandboxed under default-src.
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 res.setHeader('Cache-Control','no-store');
}
export function equal(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
const verifiers=new WeakMap<SecurityConfig,(jwt:string)=>Promise<JWTPayload>>();
function verifier(config:SecurityConfig){
 if(config.verify)return config.verify;
 if(!config.team||!config.audience||!config.owner)throw new HttpError(503,'Hosted authentication not configured');
 let verify=verifiers.get(config);if(!verify){const keys=createRemoteJWKSet(new URL(config.team+'/cdn-cgi/access/certs'),{timeoutDuration:5000});verify=async token=>(await jwtVerify(token,keys,{issuer:config.team,audience:config.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub']})).payload;verifiers.set(config,verify);}return verify;
}
export function sessionId(req:IncomingMessage){const value=req.headers.cookie?.match(/(?:^|;\s*)dashboard_session=([a-f0-9]{64})(?:;|$)/)?.[1];return value;}
export function csrf(config:SecurityConfig,session:string,subject:string){return createHmac('sha256',config.token).update(session+'\n'+subject).digest('hex');}
export function establishSession(req:IncomingMessage,res:ServerResponse,config:SecurityConfig,subject:string){
 if(config.mode==='local')return {mode:'local'};
 const id=sessionId(req)??randomBytes(32).toString('hex');res.setHeader('Set-Cookie','dashboard_session='+id+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400');return {mode:'hosted',csrf:csrf(config,id,subject)};
}
export async function authorize(req:IncomingMessage,config:SecurityConfig):Promise<string>{
 if(req.headers.host!==new URL(config.origin).host)throw new HttpError(403,'Untrusted Host');
 let subject='local';
 if(config.mode==='local'){
   if(!equal(String(req.headers['x-dashboard-token']??''),config.token))throw new HttpError(401,'Session required');
 }else{
   const token=req.headers['cf-access-jwt-assertion'];if(typeof token!=='string'||token.length>16000)throw new HttpError(401,'Cloudflare Access sign-in required');
   let claims:JWTPayload;try{claims=await verifier(config)(token);}catch{throw new HttpError(401,'Invalid Access assertion');}
   if(typeof claims.email!=='string'||claims.email.toLowerCase()!==config.owner)throw new HttpError(403,'Owner identity required');subject=String(claims.sub);
 }
 if(!['GET','HEAD'].includes(req.method??'')) {
   if(req.headers.origin!==config.origin)throw new HttpError(403,'Same-origin request required');
   if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'JSON request required');
   if(config.mode==='hosted'){const id=sessionId(req);if(!id||!equal(String(req.headers['x-dashboard-csrf']??''),csrf(config,id,subject)))throw new HttpError(403,'Session CSRF token required');}
 }
 return subject;
}
