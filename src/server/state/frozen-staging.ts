import {createHash} from 'node:crypto';
import {canonicalJson} from '../../shared/control-state';
import {validateRunnerSnapshot, type RunnerSnapshot} from './runner-snapshot';

/**
 * Uninstalled broker-staging prototype: an in-memory, target-bound manifest over validated bytes.
 * The target must be supplied by trusted owner configuration, not request/model input. This module
 * does not authenticate that provenance, copy bytes into protected storage, or create a Git tree.
 */
export type FrozenStagingTarget={readonly projectId:string;readonly targetId:string;readonly revision:number;readonly targetDigest:string;readonly branch:string};
export type FrozenStagingArtifact={readonly target:Readonly<FrozenStagingTarget>;readonly targetFingerprint:string;readonly digest:string;readonly snapshot:RunnerSnapshot};
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function validateTarget(value:unknown):FrozenStagingTarget {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Frozen staging target is invalid.');
 const target=value as Record<string,unknown>;
 // Match the action-target store's conservative syntax subset; this is not full Git ref validation.
 if(Object.keys(target).sort().join(',')!=='branch,projectId,revision,targetDigest,targetId'||typeof target.projectId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(target.projectId)||typeof target.targetId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(target.targetId)||!Number.isSafeInteger(target.revision)||Number(target.revision)<1||typeof target.targetDigest!=='string'||! /^[a-f0-9]{64}$/.test(target.targetDigest)||typeof target.branch!=='string'||target.branch.length<12||target.branch.length>200||! /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target.branch)||target.branch.includes('..')||target.branch.endsWith('/')||target.branch.endsWith('.')||target.branch.endsWith('.lock')||target.branch.includes('//'))throw Error('Frozen staging target is invalid.');
 return Object.freeze({projectId:target.projectId,targetId:target.targetId,revision:target.revision as number,targetDigest:target.targetDigest,branch:target.branch});
}

/** Validate and bind a normalized file-byte manifest to the immutable owner-selected target revision. */
export function createFrozenStagingArtifact(targetInput:unknown,manifestInput:unknown):FrozenStagingArtifact {
 const target=validateTarget(targetInput);
 if(!manifestInput||typeof manifestInput!=='object'||Array.isArray(manifestInput)||!Array.isArray((manifestInput as {files?:unknown}).files))throw Error('Frozen staging manifest is invalid.');
 // Apply all count, encoded-byte, path-length and file-byte bounds before the additional scans below.
 const snapshot=validateRunnerSnapshot(manifestInput);
 const files=new Set<string>(),directories=new Set<string>();
 for(const file of snapshot.files){
  const path=file.path;
  if(!/^[A-Za-z0-9._/-]+$/.test(path))throw Error('Frozen staging supports ASCII paths using letters, digits, dot, underscore, slash and hyphen only.');
  const key=path.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32));
  if(files.has(key))throw Error('Frozen staging manifest contains ASCII case collisions.');
  // Check both directions: an existing file may not become a parent directory, or vice versa.
  if(directories.has(key))throw Error('Frozen staging manifest contains ASCII case file/directory collisions.');
  const parts=key.split('/');
  for(let i=1;i<parts.length;i++)if(files.has(parts.slice(0,i).join('/')))throw Error('Frozen staging manifest contains ASCII case file/directory collisions.');
  files.add(key);
  for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/'));
 }
 const targetFingerprint=sha256(canonicalJson(target));
 const digest=sha256(canonicalJson({version:1,targetFingerprint,snapshotDigest:snapshot.digest}));
 return Object.freeze({target,targetFingerprint,digest,snapshot});
}
