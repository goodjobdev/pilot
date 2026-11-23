import type { IncomingMessage,ServerResponse } from 'node:http';
import { randomBytes,timingSafeEqual,createHmac,createPublicKey } from 'node:crypto';
import { createRemoteJWKSet,importSPKI,jwtVerify,type JWTPayload } from 'jose';
import { HttpError } from './board-store';
export interface SecurityConfig {mode:'local'|'hosted';origin:string;token:string;provider?:'cloudflare'|'tailnet-gateway';team?:string;audience?:string;owner?:string;gatewayIssuer?:string;gatewayPublicKey?:string;verify?:(jwt:string)=>Promise<JWTPayload>}
export function localConfig(origin:string):SecurityConfig{return {mode:'local',origin,token:randomBytes(32).toString('hex')};}
export function hostedConfig(env:NodeJS.ProcessEnv):SecurityConfig {
 const origin=env.DASHBOARD_ORIGIN,owner=env.DASHBOARD_OWNER,provider=env.DASHBOARD_IDENTITY_PROVIDER??'cloudflare';
 if(!origin||!owner)throw Error('Hosted mode requires DASHBOARD_ORIGIN and DASHBOARD_OWNER');
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw Error('Hosted public origin must be an exact HTTPS origin');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner))throw Error('Owner must be a valid owner email');
 const base={mode:'hosted' as const,origin,owner:owner.toLowerCase(),token:randomBytes(32).toString('hex')};
 if(provider==='cloudflare'){
  if(env.TAILNET_GATEWAY_ISSUER!==undefined||env.TAILNET_GATEWAY_AUD!==undefined||env.TAILNET_GATEWAY_PUBLIC_KEY!==undefined)throw Error('Tailnet gateway settings require DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway');
  const team=env.CF_ACCESS_TEAM,audience=env.CF_ACCESS_AUD;
  if(!team||!audience)throw Error('Cloudflare hosted mode requires CF_ACCESS_TEAM and CF_ACCESS_AUD');
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team))throw Error('Access team must be its HTTPS cloudflareaccess.com origin');
  return {...base,provider:'cloudflare',team,audience};
 }
 if(provider==='tailnet-gateway'){
  const issuer=env.TAILNET_GATEWAY_ISSUER,audience=env.TAILNET_GATEWAY_AUD,key=env.TAILNET_GATEWAY_PUBLIC_KEY;
  if(!issuer||!audience||!key)throw Error('Tailnet gateway mode requires TAILNET_GATEWAY_ISSUER, TAILNET_GATEWAY_AUD and TAILNET_GATEWAY_PUBLIC_KEY');
  if(env.CF_ACCESS_TEAM!==undefined||env.CF_ACCESS_AUD!==undefined)throw Error('Cloudflare settings are not allowed in tailnet gateway mode');
  if(issuer.length>512||audience.length>512||/[\s\x00-\x1f]/.test(issuer)||/[\s\x00-\x1f]/.test(audience))throw Error('Tailnet gateway issuer and audience must be exact non-empty identifiers');
  try{if(!key.startsWith('-----BEGIN PUBLIC KEY-----'))throw Error();const publicKey=createPublicKey(key);if(publicKey.asymmetricKeyType!=='ed25519')throw Error();}catch{throw Error('TAILNET_GATEWAY_PUBLIC_KEY must be a valid Ed25519 public key in PEM format');}
  return {...base,provider:'tailnet-gateway',gatewayIssuer:issuer,audience,gatewayPublicKey:key};
 }
 throw Error('DASHBOARD_IDENTITY_PROVIDER must be cloudflare or tailnet-gateway');
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
 if(config.provider==='tailnet-gateway'){
  // This trust anchor validates the gateway's assertion only; the gateway must independently bind the owner to the requesting node.
  if(!config.gatewayIssuer||!config.audience||!config.gatewayPublicKey)throw new HttpError(503,'Tailnet gateway authentication not configured');
  let verify=verifiers.get(config);if(!verify){const key=importSPKI(config.gatewayPublicKey,'EdDSA');verify=async token=>(await jwtVerify(token,await key,{issuer:config.gatewayIssuer,audience:config.audience,algorithms:['EdDSA'],requiredClaims:['exp','iat','sub','jti','owner']})).payload;verifiers.set(config,verify);}return verify;
 }
 if(!config.team||!config.audience||!config.owner)throw new HttpError(503,'Hosted authentication not configured');
 let verify=verifiers.get(config);if(!verify){const keys=createRemoteJWKSet(new URL(config.team+'/cdn-cgi/access/certs'),{timeoutDuration:5000});verify=async token=>(await jwtVerify(token,keys,{issuer:config.team,audience:config.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub']})).payload;verifiers.set(config,verify);}return verify;
}
export function sessionId(req:IncomingMessage){const value=req.headers.cookie?.match(/(?:^|;\s*)dashboard_session=([a-f0-9]{64})(?:;|$)/)?.[1];return value;}
export function csrf(config:SecurityConfig,session:string,subject:string){return createHmac('sha256',config.token).update(session+'\n'+subject).digest('hex');}
export function establishSession(req:IncomingMessage,res:ServerResponse,config:SecurityConfig,subject:string){
 if(config.mode==='local')return {mode:'local'};
 const id=sessionId(req)??randomBytes(32).toString('hex');res.setHeader('Set-Cookie','dashboard_session='+id+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400');return {mode:'hosted',csrf:csrf(config,id,subject)};
}
const usedGatewayAssertions=new WeakMap<SecurityConfig,Map<string,number>>();
function singleHeader(req:IncomingMessage,name:string):string|undefined{
 const matching:string[]=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)matching.push(req.rawHeaders[i+1]);
 if(matching.length>1)throw new HttpError(401,'Duplicate identity assertion header');
 return matching[0];
}
export async function authorize(req:IncomingMessage,config:SecurityConfig):Promise<string>{
 if(req.headers.host!==new URL(config.origin).host)throw new HttpError(403,'Untrusted Host');
 let subject='local';
 if(config.mode==='local'){
   if(!equal(String(req.headers['x-dashboard-token']??''),config.token))throw new HttpError(401,'Session required');
 }else if(config.provider==='tailnet-gateway'){
   if(singleHeader(req,'cf-access-jwt-assertion')!==undefined)throw new HttpError(401,'Cloudflare assertion is not accepted in tailnet gateway mode');
   const token=singleHeader(req,'x-pilot-gateway-assertion');if(!token||token.length>16000)throw new HttpError(401,'Tailnet gateway assertion required');
   let claims:JWTPayload;try{claims=await verifier(config)(token);}catch{throw new HttpError(401,'Invalid tailnet gateway assertion');}
   const now=Math.floor(Date.now()/1000);
   if(typeof claims.owner!=='string'||claims.owner!==config.owner||claims.sub!==config.owner||typeof claims.jti!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(claims.jti)||typeof claims.iat!=='number'||typeof claims.exp!=='number'||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat>now+5||now-claims.iat>60||claims.exp<=now||claims.exp<=claims.iat||claims.exp-claims.iat>60)throw new HttpError(403,'Owner identity required');
   let seen=usedGatewayAssertions.get(config);if(!seen){seen=new Map();usedGatewayAssertions.set(config,seen);}
   for(const [id,until] of seen)if(until<=now)seen.delete(id);
   if(seen.has(claims.jti))throw new HttpError(401,'Replayed tailnet gateway assertion');
   if(seen.size>=10000)throw new HttpError(503,'Tailnet gateway assertion replay cache is full');
   seen.set(claims.jti,claims.exp);subject=claims.sub;
 }else{
   if(singleHeader(req,'x-pilot-gateway-assertion')!==undefined)throw new HttpError(401,'Tailnet assertion is not accepted in Cloudflare mode');
   const token=singleHeader(req,'cf-access-jwt-assertion');if(typeof token!=='string'||token.length>16000)throw new HttpError(401,'Cloudflare Access sign-in required');
   let claims:JWTPayload;try{claims=await verifier(config)(token);}catch{throw new HttpError(401,'Invalid Access assertion');}
   if(typeof claims.email!=='string'||claims.email.toLowerCase()!==config.owner)throw new HttpError(403,'Owner identity required');subject=String(claims.sub);
 }
 if(!['GET','HEAD'].includes(req.method??'')) {
   if(req.headers.origin!==config.origin)throw new HttpError(403,'Same-origin request required');
   if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'JSON request required');
   if(config.mode==='hosted'){const id=sessionId(req);if(!id||!equal(String(req.headers['x-dashboard-csrf']??''),csrf(config,id,subject)))throw new HttpError(403,'Session CSRF token required','SESSION_CSRF');}
 }
 return subject;
}
