import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ControlStore, ControlStoreError } from './control-store';
import { parseAgentIdentifier } from '../../shared/agent-registry';

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const definition = z.strictObject({ name, revision: z.number().int().min(1).max(32), fields: z.array(field).min(1).max(16).refine(x => new Set(x).size === x.length), agentId: z.string(), projectId: z.string() });
export type ReusableDefinition = z.infer<typeof definition>;
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const bucket = (agentId:string) => 'reusable.' + hash(agentId);
const kind = 'reusable.definition';

/** Restrict JSON number tokens to exactly representable integer literals, including nested values. */
function validateJsonNumbers(json:string):void {
  let inString=false,escaped=false;
  for(let i=0;i<json.length;i++) {
    const ch=json[i];
    if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue;}
    if(ch==='"'){inString=true;continue;}
    if(ch==='-'||(ch>='0'&&ch<='9')){
      const token=json.slice(i).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
      if(!token||token==='-0'||! /^-?(?:0|[1-9][0-9]*)$/.test(token)||!Number.isSafeInteger(Number(token)))throw new Error('JSON numbers must be safe integer literals; decimals and exponents are not supported.');
      i+=token.length-1;
    }
  }
}

/** Project/agent-scoped immutable revisions in the existing control store. */
export class ReusableToolStore {
  constructor(private readonly store:ControlStore) {}
  private records(projectId:string, agentId:string):ReusableDefinition[] {
    parseAgentIdentifier(projectId); parseAgentIdentifier(agentId);
    const scope={projectId,sessionId:bucket(agentId)};
    const rows=this.store.db.prepare('SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind=? ORDER BY rowid LIMIT 1025').all(projectId,scope.sessionId,kind) as {id:string}[];
    if(rows.length>1024) throw new Error('Reusable definition limit exceeded.');
    return rows.map(row=>{
      const op=this.store.getOperation(row.id,scope);
      const record=definition.parse(op.input);
      if(record.projectId!==projectId||record.agentId!==agentId)throw new Error('Invalid reusable definition scope.');
      return record;
    });
  }
  list(projectId:string,agentId:string):ReusableDefinition[] {
    const latest=new Map<string,ReusableDefinition>();
    for(const record of this.records(projectId,agentId)) {
      const previous=latest.get(record.name);
      if(record.revision!==(previous?.revision??0)+1)throw new Error('Invalid reusable definition history.');
      latest.set(record.name,record);
    }
    return [...latest.values()];
  }
  write(input:{projectId:string;agentId:string;name:string;revision:number;fields:string[];guard:()=>void}):ReusableDefinition {
    const proposed=definition.parse({projectId:input.projectId,agentId:input.agentId,name:input.name,revision:input.revision+1,fields:input.fields});
    const scope={projectId:input.projectId,sessionId:bucket(input.agentId)};
    const admitted=this.store.admit({scope,idempotencyKey:'definition.'+hash(input.name)+'.r'+proposed.revision,kind,input:proposed,outbox:{kind:'reusable.definition',payload:{name:input.name,revision:proposed.revision}},guard:()=>{
      input.guard();
      const all=this.list(input.projectId,input.agentId), current=all.find(item=>item.name===input.name);
      if((current?.revision??0)!==input.revision)throw new ControlStoreError('Reusable definition revision conflict.','CONFLICT');
      if(!current&&all.length>=32)throw new Error('Reusable definition count limit reached.');
    }});
    if(admitted.existing)throw new ControlStoreError('Reusable definition revision conflict.','CONFLICT');
    return proposed;
  }
  invoke(projectId:string,agentId:string,toolName:string,json:string):{revision:number;json:string} {
    name.parse(toolName);
    if(typeof json!=='string'||Buffer.byteLength(json)>8192)throw new Error('Input exceeds 8192 bytes.');
    const input:unknown=JSON.parse(json);
    validateJsonNumbers(json);
    if(input===null||typeof input!=='object'||Array.isArray(input))throw new Error('Input must be a JSON object.');
    const tool=this.list(projectId,agentId).find(item=>item.name===toolName);
    if(!tool)throw new Error('Reusable definition not found.');
    const output:Record<string,unknown>=Object.create(null);
    for(const key of tool.fields)if(Object.hasOwn(input,key))output[key]=(input as Record<string,unknown>)[key];
    const result=JSON.stringify(output);
    if(Buffer.byteLength(result)>8192)throw new Error('Output exceeds 8192 bytes.');
    return {revision:tool.revision,json:result};
  }
}
