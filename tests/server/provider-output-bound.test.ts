import {test} from 'node:test';
import {normalizeContext, type Provider} from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
import {anthropicProvider} from '@earendil-works/pi-ai/providers/anthropic';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {openrouterProvider} from '@earendil-works/pi-ai/providers/openrouter';
import {googleProvider} from '@earendil-works/pi-ai/providers/google';
import {assertProviderOutputBound,supportsBoundedProviderApi} from '../../src/server/agents/provider-output-bound';

test('payload bound requires a present, numeric cap in the supported adapter shape',()=>{
 for(const [api,payload] of [
  ['openai-responses',{max_output_tokens:300}],['openai-completions',{max_completion_tokens:300}],['anthropic-messages',{max_tokens:300}],['google-generative-ai',{config:{maxOutputTokens:300}}]
 ] as const){assert.doesNotThrow(()=>assertProviderOutputBound(api,payload,300));}
 for(const [api,payload] of [
  ['openai-responses',{}],['openai-responses',{max_output_tokens:301}],['openai-completions',{max_tokens:100,max_completion_tokens:301}],
  ['anthropic-messages',{max_tokens:'10'}],['google-generative-ai',{config:{}}],['openai-codex-responses',{max_output_tokens:10}]
 ] as const){assert.throws(()=>assertProviderOutputBound(api,payload,300),/cannot be verified/);}
 assert.equal(supportsBoundedProviderApi('openai-codex-responses'),false);
 assert.throws(()=>assertProviderOutputBound('openai-responses',{get max_output_tokens(){return 1;}},300),/cannot be verified/);
 assert.throws(()=>assertProviderOutputBound('openai-responses',{max_output_tokens:1,toJSON(){return {};}},300),/cannot be verified/);
});

test('actual Google and OpenAI-compatible adapters expose checkable caps before dispatch',async()=>{
 for(const provider of [googleProvider(),openrouterProvider()] as Provider[]){
  const model=provider.getModels().find(model=>model.api===(provider.id==='google'?'google-generative-ai':'openai-completions'))!;
  assert.ok(model);let seen=0,fetches=0;
  const stream=provider.streamSimple(model,normalizeContext({messages:[]}),{apiKey:'sk-fixture',maxTokens:300,maxRetries:0,
   ...(provider.id==='google'?{}:{fetch:async()=>{fetches++;throw Error('must not send');}}),
   onPayload:payload=>{seen++;assertProviderOutputBound(model.api,payload,300);throw Error('deliberately stop before network');}
  });
  await stream.result();assert.equal(seen,1,provider.id);assert.equal(fetches,0);
 }
});

test('actual Anthropic reasoning adapter cannot send an expanded bound',async()=>{
 const provider=anthropicProvider(),model=provider.getModels().find(model=>model.id==='claude-haiku-4-5')!;
 assert.ok(model);let payloadMax:unknown,fetchCalls=0;
 const stream=provider.streamSimple(model,normalizeContext({messages:[]}),{apiKey:'fake-test-key',maxTokens:321,reasoning:'low',maxRetries:0,
  fetch:async()=>{fetchCalls++;throw Error('network must not be reached');},
  onPayload:payload=>{payloadMax=(payload as {max_tokens?:unknown}).max_tokens;assertProviderOutputBound(model.api,payload,321);}
 });
 await stream.result();assert.equal(fetchCalls,0);assert.ok(typeof payloadMax==='number'&&payloadMax>321,'adapter inflated the requested cap');
});

test('actual OpenAI Responses adapter cannot raise a low configured cap to 16',async()=>{
 const provider=openaiProvider(),model=provider.getModels().find(model=>model.id==='gpt-4.1-mini')!;
 assert.ok(model);let payloadMax:unknown,fetchCalls=0;
 const stream=provider.streamSimple(model,normalizeContext({messages:[]}),{apiKey:'sk-fake-test-key',maxTokens:1,maxRetries:0,
  fetch:async()=>{fetchCalls++;throw Error('network must not be reached');},
  onPayload:payload=>{payloadMax=(payload as {max_output_tokens?:unknown}).max_output_tokens;assertProviderOutputBound(model.api,payload,1);}
 });
 await stream.result();assert.equal(payloadMax,16);assert.equal(fetchCalls,0);
});
