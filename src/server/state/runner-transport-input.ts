import {z} from 'zod';
import {parseRunnerServiceRequest,type RunnerServiceRequest} from './runner-service-admission';
import {validateRunnerSnapshot} from './runner-snapshot';

/** Limits the wire document, not peak memory use or concurrent request processing. */
export const RUNNER_TRANSPORT_MAX_BODY_BYTES=16*1024*1024;
export const RUNNER_TRANSPORT_MAX_DEPTH=48;
export const RUNNER_TRANSPORT_MAX_VALUES=10000;
const envelope=z.strictObject({request:z.unknown(),snapshot:z.unknown()});
const inspectionEnvelope=z.strictObject({request:z.unknown()});
export const RUNNER_INSPECTION_MAX_BODY_BYTES=4096;

/**
 * Reject duplicate JSON object keys (including equivalent escaped spellings) and excessive nesting
 * before JSON.parse. JSON.parse remains the authority on string and number syntax. This is not an
 * HTTP framing parser and must only receive an already byte-bounded, complete document.
 */
function validateStructure(source:string):void{
 let at=0,values=0;
 const bad=():never=>{throw new Error('Invalid runner transport JSON.');};
 const whitespace=()=>{while(at<source.length&&(source[at]===' '||source[at]==='\n'||source[at]==='\r'||source[at]==='\t'))at++;};
 const string=():string=>{
  if(source[at]!=='"')return bad();
  const start=at++;
  while(at<source.length){
   const c=source.charCodeAt(at++);
   if(c===34){try{return JSON.parse(source.slice(start,at)) as string;}catch{return bad();}}
   if(c<32)return bad();
   if(c===92){if(at>=source.length)return bad();at++;}
  }
  return bad();
 };
 const value=(depth:number):void=>{
  if(depth>RUNNER_TRANSPORT_MAX_DEPTH||++values>RUNNER_TRANSPORT_MAX_VALUES)return bad();
  whitespace();const c=source[at];
  if(c==='"'){string();return;}
  if(c==='{'){
   at++;whitespace();const keys=new Set<string>();
   if(source[at]==='}'){at++;return;}
   for(;;){
    whitespace();const name=string();if(keys.has(name))return bad();keys.add(name);
    whitespace();if(source[at++]!==':')return bad();value(depth+1);whitespace();
    const end=source[at++];if(end==='}')return;if(end!==',')return bad();
   }
  }
  if(c==='['){
   at++;whitespace();if(source[at]===']'){at++;return;}
   for(;;){value(depth+1);whitespace();const end=source[at++];if(end===']')return;if(end!==',')return bad();}
  }
  for(const literal of ['true','false','null'])if(source.startsWith(literal,at)){at+=literal.length;return;}
  const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
  if(!match)return bad();at+=match[0].length;
 };
 value(0);whitespace();if(at!==source.length)bad();
}

function parseDocument(bytes:Uint8Array,maxBytes:number):unknown{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>maxBytes)throw new Error('Invalid runner transport document.');
 // Reject a byte-order mark instead of allowing the decoder to silently strip one.
 if(bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)throw new Error('Invalid runner transport document.');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('Invalid runner transport document.');}
 validateStructure(text);return JSON.parse(text);
}
/** Parse an exact fixed-job envelope; does not authenticate a peer or execute a job. */
export function parseRunnerTransportInput(bytes:Uint8Array):{request:RunnerServiceRequest;snapshot:unknown}{
 const parsed=envelope.parse(parseDocument(bytes,RUNNER_TRANSPORT_MAX_BODY_BYTES)),request=parseRunnerServiceRequest(parsed.request),snapshot=validateRunnerSnapshot(parsed.snapshot);
 if(request.snapshotDigest!==snapshot.digest)throw new Error('Runner snapshot identity does not match.');
 return {request,snapshot:parsed.snapshot};
}
/** Inspection takes the full exact request, but never receives workspace bytes or starts a job. */
export function parseRunnerInspectionInput(bytes:Uint8Array):RunnerServiceRequest{
 return parseRunnerServiceRequest(inspectionEnvelope.parse(parseDocument(bytes,RUNNER_INSPECTION_MAX_BODY_BYTES)).request);
}
