import { z } from 'zod';

export const CONTROL_RECORD_VERSION = 1 as const;
export const CONTROL_MAX_JSON_BYTES = 64 * 1024;

export type ControlScope = { projectId: string; sessionId: string };
export type OperationState = 'pending' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
export type OutboxState = 'pending' | 'delivered';

export type OperationRecord = {
  version: 1; id: string; projectId: string; sessionId: string; idempotencyKey: string;
  kind: string; inputDigest: string; input: unknown; state: OperationState; revision: number;
  receipt: unknown | null; receiptPresent: boolean; createdAt: string; updatedAt: string;
};
export type OutboxRecord = {
  version: 1; id: string; operationId: string; projectId: string; sessionId: string;
  kind: string; payload: unknown; state: OutboxState; revision: number;
  receipt: unknown | null; receiptPresent: boolean; createdAt: string; updatedAt: string;
};

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const kind = z.string().min(1).max(80).regex(/^[a-z][a-z0-9.-]*$/);
const operationStates = ['pending','succeeded','failed','interrupted','unknown'] as const;
const outboxStates = ['pending','delivered'] as const;

export function validateScope(value: unknown): ControlScope {
  const parsed = z.strictObject({projectId:id,sessionId:id}).parse(value);
  return parsed;
}
export function validateOperationRecord(value: unknown): OperationRecord {
  const parsed = z.strictObject({
    version:z.literal(1),id,projectId:id,sessionId:id,idempotencyKey:id,kind,
    inputDigest:z.string().regex(/^[a-f0-9]{64}$/),input:z.unknown(),
    state:z.enum(operationStates),revision:z.number().int().positive(),receipt:z.unknown().nullable(),receiptPresent:z.boolean(),
    createdAt:z.string().datetime(),updatedAt:z.string().datetime()
  }).parse(value) as OperationRecord;
  boundedJson(parsed.input); boundedJson(parsed.receipt); return parsed;
}
export function validateOutboxRecord(value: unknown): OutboxRecord {
  const parsed = z.strictObject({
    version:z.literal(1),id,operationId:id,projectId:id,sessionId:id,kind,payload:z.unknown(),
    state:z.enum(outboxStates),revision:z.number().int().positive(),receipt:z.unknown().nullable(),receiptPresent:z.boolean(),
    createdAt:z.string().datetime(),updatedAt:z.string().datetime()
  }).parse(value) as OutboxRecord;
  boundedJson(parsed.payload); boundedJson(parsed.receipt); return parsed;
}
/**
 * Whether a serialized JSON text is larger than the control cap. Stored columns are checked with
 * this before they are handed to a parser, so an oversized record is refused as corrupt instead
 * of being decoded first.
 */
export function exceedsJsonLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > CONTROL_MAX_JSON_BYTES;
}
export function boundedJson(value: unknown): string {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { throw new Error('Value is not bounded JSON data'); }
  if (exceedsJsonLimit(encoded)) throw new Error('JSON payload exceeds 65536 byte limit');
  return encoded;
}
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) {
      if (seen.has(v)) throw new Error('cyclic JSON'); seen.add(v);
      const keys=Object.keys(v);
      if (keys.length!==v.length || keys.some((key,index)=>key!==String(index)) || Object.getOwnPropertySymbols(v).length)
        throw new Error('non-JSON array properties');
      const out:unknown[]=[];
      for(let index=0;index<v.length;index++) {
        if(!Object.hasOwn(v,index)) throw new Error('sparse JSON array');
        const descriptor=Object.getOwnPropertyDescriptor(v,String(index));
        if(!descriptor || !Object.hasOwn(descriptor,'value')) throw new Error('accessor JSON array index');
        out.push(normalize(descriptor.value));
      }
      seen.delete(v); return out;
    }
    if (typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      if (seen.has(v)) throw new Error('cyclic JSON'); seen.add(v);
      if(Object.getOwnPropertySymbols(v).length) throw new Error('symbol JSON keys');
      const out:Record<string,unknown> = Object.create(null) as Record<string,unknown>;
      for (const key of Object.keys(v).sort()) {
        const descriptor=Object.getOwnPropertyDescriptor(v,key);
        if(!descriptor || !Object.hasOwn(descriptor,'value')) throw new Error('accessor JSON property');
        Object.defineProperty(out, key, {value:normalize(descriptor.value), enumerable:true, configurable:true, writable:true});
      }
      seen.delete(v); return out;
    }
    throw new Error('non-JSON value');
  };
  return JSON.stringify(normalize(value));
}
export function isLegalOperationTransition(from: OperationState, to: OperationState): boolean {
  if (from === to) return false;
  if (from === 'pending') return to !== 'pending';
  if (from === 'unknown') return to === 'succeeded' || to === 'failed' || to === 'interrupted';
  return false;
}
