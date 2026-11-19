import {test} from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import {request as httpRequest} from 'node:http';
const fetch=(url:string,init:{method?:string;headers?:Record<string,string>;body?:string}={})=>new Promise<Response>((resolve,reject)=>{const req=httpRequest(url,{method:init.method,headers:init.headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(new Response(body,{status:res.statusCode,headers:res.headers as Record<string,string>})));});req.on('error',reject);req.end(init.body);});
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,jwtVerify} from 'jose';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server/main';
import {hostedConfig} from '../../src/server/security';
test('hosted startup configuration fails closed and keeps Cloudflare as the default',()=>{assert.throws(()=>hostedConfig({}));assert.throws(()=>hostedConfig({DASHBOARD_ORIGIN:'http://example.com',CF_ACCESS_TEAM:'https://test.cloudflareaccess.com',CF_ACCESS_AUD:'test',DASHBOARD_OWNER:'john@example.com'}));assert.equal(hostedConfig({DASHBOARD_ORIGIN:'https://dashboard.example.com',CF_ACCESS_TEAM:'https://test.cloudflareaccess.com',CF_ACCESS_AUD:'dashboard',DASHBOARD_OWNER:'john@example.com'}).provider,'cloudflare');});
test('tailnet gateway identity is explicit and validates its independent trust anchor',()=>{
 const publicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
 const base={DASHBOARD_MODE:'hosted',DASHBOARD_ORIGIN:'https://dashboard.example.com',DASHBOARD_OWNER:'owner@example.com'};
 assert.throws(()=>hostedConfig({...base,DASHBOARD_IDENTITY_PROVIDER:'tailnet-gateway'}),/TAILNET_GATEWAY_ISSUER/);
 const config=hostedConfig({...base,DASHBOARD_IDENTITY_PROVIDER:'tailnet-gateway',TAILNET_GATEWAY_ISSUER:'pilot-gateway',TAILNET_GATEWAY_AUD:'pilot-dashboard',TAILNET_GATEWAY_PUBLIC_KEY:publicKey});
 assert.equal(config.provider,'tailnet-gateway');assert.equal(config.team,undefined);assert.equal(config.audience,'pilot-dashboard');
 assert.throws(()=>hostedConfig({...base,DASHBOARD_IDENTITY_PROVIDER:'tailnet-gateway',TAILNET_GATEWAY_ISSUER:'issuer',TAILNET_GATEWAY_AUD:'aud',TAILNET_GATEWAY_PUBLIC_KEY:'not-a-key'}),/valid Ed25519/);
 assert.throws(()=>hostedConfig({...base,DASHBOARD_IDENTITY_PROVIDER:'tailnet-gateway',TAILNET_GATEWAY_ISSUER:'issuer',TAILNET_GATEWAY_AUD:'aud',TAILNET_GATEWAY_PUBLIC_KEY:publicKey,CF_ACCESS_TEAM:'https://test.cloudflareaccess.com'}),/Cloudflare settings/);
});
test('tailnet gateway assertions require an exact owner and are single-use without bypassing sessions',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const config=hostedConfig({DASHBOARD_ORIGIN:'https://dashboard.example.com',DASHBOARD_OWNER:'owner@example.com',DASHBOARD_IDENTITY_PROVIDER:'tailnet-gateway',TAILNET_GATEWAY_ISSUER:'https://gateway.example.test',TAILNET_GATEWAY_AUD:'pilot-dashboard',TAILNET_GATEWAY_PUBLIC_KEY:publicKey.export({type:'spki',format:'pem'}).toString()});
 const app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-tailnet-access-')),browseRoots:[],security:config});await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
 const origin='http://127.0.0.1:'+(app.server.address() as any).port;
 const assertion=(jti:string)=>new SignJWT({owner:'owner@example.com'}).setProtectedHeader({alg:'EdDSA'}).setIssuer(config.gatewayIssuer!).setAudience(config.audience!).setSubject('owner@example.com').setJti(jti).setIssuedAt().setExpirationTime('30s').sign(privateKey);
 try{
  const token=await assertion('one-time-assertion-01'),headers={host:'dashboard.example.com','x-pilot-gateway-assertion':token};
  const sessionResponse=await fetch(origin+'/api/session',{headers});assert.equal(sessionResponse.status,200);
  const session=await sessionResponse.json() as {csrf:string};assert.ok(session.csrf);
  assert.equal((await fetch(origin+'/api/session',{headers})).status,401,'same assertion cannot be replayed');
  assert.equal((await fetch(origin+'/api/session',{headers:{host:'dashboard.example.com','cf-access-jwt-assertion':token}})).status,401,'Cloudflare assertions are not accepted in tailnet mode');
 }finally{await app.close();}
});
test('signed Access identity, expiry, audience, CSRF and untrusted requests',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='test';const keys=createLocalJWKSet({keys:[jwk]});
 const security=hostedConfig({DASHBOARD_ORIGIN:'https://dashboard.example.com',CF_ACCESS_TEAM:'https://test.cloudflareaccess.com',CF_ACCESS_AUD:'dashboard',DASHBOARD_OWNER:'john@example.com'});
 security.verify=async token=>(await jwtVerify(token,keys,{issuer:security.team,audience:security.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub']})).payload;
 const app=await createApp({dataRoot:await mkdtemp(join(tmpdir(),'dashboard-access-')),browseRoots:[],security});await new Promise<void>(ok=>app.server.listen(0,'127.0.0.1',ok));
 const origin='http://127.0.0.1:'+(app.server.address() as any).port;
 const sign=(email='john@example.com',aud='dashboard',exp='5m')=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(security.team!).setAudience(aud).setSubject('owner-123').setIssuedAt().setExpirationTime(exp).sign(privateKey);
 try{
 const host={host:'dashboard.example.com'};
 assert.equal((await fetch(origin+'/api/projects',{headers:host})).status,401);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...host,'cf-access-jwt-assertion':'forged'}})).status,401);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...host,'cf-access-jwt-assertion':await sign('other@example.com')}})).status,403);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...host,'cf-access-jwt-assertion':await sign('john@example.com','wrong')}})).status,401);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...host,'cf-access-jwt-assertion':await sign('john@example.com','dashboard','-1s')}})).status,401);
 const auth={...host,'cf-access-jwt-assertion':await sign()},res=await fetch(origin+'/api/session',{headers:auth}),session=await res.json() as any,cookie=res.headers.get('set-cookie')!.split(';')[0];
 const write={...auth,origin:security.origin,'content-type':'application/json',cookie};
 assert.equal((await fetch(origin+'/api/projects',{method:'POST',headers:write,body:'{}'})).status,403);
 const sensitive=await fetch(origin+'/api/settings/providers/openai/key',{method:'POST',headers:write,body:JSON.stringify({key:'fake-not-live'})});
 assert.equal(sensitive.status,403);assert.equal((await sensitive.json() as any).code,'SESSION_CSRF');
 const accepted=await fetch(origin+'/api/projects',{method:'POST',headers:{...write,'x-dashboard-csrf':session.csrf},body:JSON.stringify({name:'Owner fixture',managed:true,confirm:true})});assert.equal(accepted.status,201);
 assert.equal((await fetch(origin+'/api/projects',{method:'POST',headers:{...write,origin:'https://evil.example','x-dashboard-csrf':session.csrf},body:'{}'})).status,403);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...auth,host:'evil.example'}})).status,403);
 // A backend restart rotates the HMAC secret but the old tab and cookie survive.
 security.token='new-boot-secret';
 const stale=await fetch(origin+'/api/projects',{method:'POST',headers:{...write,'x-dashboard-csrf':session.csrf},body:JSON.stringify({name:'Restart fixture',managed:true,confirm:true})});
 assert.equal(stale.status,403);assert.equal((await stale.json() as any).code,'SESSION_CSRF');
 assert.equal(app.catalog.projects.length,1); // rejection happened before a write
 const renewed=await (await fetch(origin+'/api/session',{headers:{...auth,cookie}})).json() as any;
 const retry=await fetch(origin+'/api/projects',{method:'POST',headers:{...write,'x-dashboard-csrf':renewed.csrf},body:JSON.stringify({name:'Restart fixture',managed:true,confirm:true})});
 assert.equal(retry.status,201);assert.equal(app.catalog.projects.length,2);
 }finally{await app.close();}
});
