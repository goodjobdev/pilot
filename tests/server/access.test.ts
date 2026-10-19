import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
const fetch=(url:string,init:{method?:string;headers?:Record<string,string>;body?:string}={})=>new Promise<Response>((resolve,reject)=>{const req=httpRequest(url,{method:init.method,headers:init.headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(new Response(body,{status:res.statusCode,headers:res.headers as Record<string,string>})));});req.on('error',reject);req.end(init.body);});
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,jwtVerify} from 'jose';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../src/server/main';
import {hostedConfig} from '../../src/server/security';
test('hosted startup configuration fails closed',()=>{assert.throws(()=>hostedConfig({}));assert.throws(()=>hostedConfig({DASHBOARD_ORIGIN:'http://example.com',CF_ACCESS_TEAM:'https://test.cloudflareaccess.com',CF_ACCESS_AUD:'test',DASHBOARD_OWNER:'john@example.com'}));});
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
 const accepted=await fetch(origin+'/api/projects',{method:'POST',headers:{...write,'x-dashboard-csrf':session.csrf},body:JSON.stringify({name:'Owner fixture',managed:true,confirm:true})});assert.equal(accepted.status,201);
 assert.equal((await fetch(origin+'/api/projects',{method:'POST',headers:{...write,origin:'https://evil.example','x-dashboard-csrf':session.csrf},body:'{}'})).status,403);
 assert.equal((await fetch(origin+'/api/projects',{headers:{...auth,host:'evil.example'}})).status,403);
 }finally{await app.close();}
});
