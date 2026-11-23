/**
 * The locked provider adapters invoke onPayload immediately before dispatch. A requested bound is
 * not enough: adapters may omit it or expand it when enabling reasoning. Unknown APIs refuse.
 * This validates a request, not provider compliance, billing, or the number of internal retries.
 */
const SHAPES = new Set(['openai-responses','openai-completions','anthropic-messages','google-generative-ai']);
export function supportsBoundedProviderApi(api: string): boolean {
 // Faux is an in-process scripted test adapter; its generated API id has a per-instance suffix.
 return SHAPES.has(api) || api.startsWith('faux:');
}
function plain(value: unknown): value is Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value))return false;
 const proto=Object.getPrototypeOf(value);
 return (proto===Object.prototype||proto===null)&&!('toJSON' in value);
}
function ownValue(value:Record<string,unknown>,key:string):unknown {
 const descriptor=Object.getOwnPropertyDescriptor(value,key);
 if(!descriptor)return undefined;
 if(!('value' in descriptor))throw new Error('The provider output bound cannot be verified.');
 return descriptor.value;
}
export function assertProviderOutputBound(api: string, payload: unknown, maximum: number): void {
 if (!Number.isSafeInteger(maximum) || maximum < 1 || !SHAPES.has(api) || !plain(payload))
  throw new Error('The provider output bound cannot be verified.');
 const p=payload as Record<string,unknown>;
 let fields: unknown[];
 switch(api) {
  case 'openai-responses': fields=[ownValue(p,'max_output_tokens')]; break;
  case 'anthropic-messages': fields=[ownValue(p,'max_tokens')]; break;
  case 'openai-completions':
   fields=[ownValue(p,'max_tokens'),ownValue(p,'max_completion_tokens')].filter(value=>value!==undefined);
   break;
  case 'google-generative-ai': {
   const config=ownValue(p,'config');
   fields=[plain(config)?ownValue(config,'maxOutputTokens'):undefined];
   break;
  }
  default: throw new Error('The provider output bound cannot be verified.');
 }
 if (!fields.length || fields.some(value=>typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>maximum))
  throw new Error('The provider output bound cannot be verified.');
}
