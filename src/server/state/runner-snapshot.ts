import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../../shared/control-state';
import {isWorkspacePath} from '../../shared/workspace';

/**
 * Experimental, in-memory snapshot validation. No filesystem, transport or execution is provided.
 * A snapshot digest identifies exactly these bytes and modes; it does NOT prove they came from a
 * particular Git commit or the live worktree, nor does path filtering detect secrets. The caller
 * must disclose that dependencies/generated files are excluded and enforce a service-local policy.
 */
export const RUNNER_SNAPSHOT_MAX_FILES=1000;
export const RUNNER_SNAPSHOT_MAX_FILE_BYTES=2*1024*1024;
export const RUNNER_SNAPSHOT_MAX_BYTES=8*1024*1024;
export const RUNNER_SNAPSHOT_MAX_DEPTH=32;
export const RUNNER_SNAPSHOT_MAX_DIRECTORIES=4000;
const maxEncodedFile=4*Math.ceil(RUNNER_SNAPSHOT_MAX_FILE_BYTES/3);
const inputSchema=z.strictObject({version:z.literal(1),files:z.array(z.strictObject({path:z.string().min(1).max(500),mode:z.enum(['100644','100755']),base64:z.string().max(maxEncodedFile)})).min(1).max(RUNNER_SNAPSHOT_MAX_FILES)});
export type RunnerSnapshotFile={readonly path:string;readonly mode:'100644'|'100755';readonly base64:string;readonly bytes:number;readonly sha256:string};
export type RunnerSnapshot={readonly digest:string;readonly totalBytes:number;readonly files:readonly RunnerSnapshotFile[]};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');

/** Validate every file before handing any bytes to a future materializer. No partial snapshot exists. */
export function validateRunnerSnapshot(input:unknown):RunnerSnapshot{
 const parsed=inputSchema.parse(input),files:RunnerSnapshotFile[]=[],paths=new Set<string>(),directories=new Set<string>();let totalBytes=0,totalEncoded=0;
 for(const file of parsed.files){
  if(!isWorkspacePath(file.path))throw Error('Snapshot contains a refused path.');
  const segments=file.path.split('/');if(segments.length>RUNNER_SNAPSHOT_MAX_DEPTH)throw Error('Snapshot path is too deep.');
  for(let i=1;i<segments.length;i++){directories.add(segments.slice(0,i).join('/'));if(directories.size>RUNNER_SNAPSHOT_MAX_DIRECTORIES)throw Error('Snapshot has too many directories.');}
  if(paths.has(file.path))throw Error('Snapshot contains duplicate paths.');paths.add(file.path);
  totalEncoded+=file.base64.length;
  if(totalEncoded>4*Math.ceil(RUNNER_SNAPSHOT_MAX_BYTES/3)+4*RUNNER_SNAPSHOT_MAX_FILES)throw Error('Snapshot encoding exceeds its bound.');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))throw Error('Snapshot content is not canonical base64.');
  const bytes=Buffer.from(file.base64,'base64');
  if(bytes.toString('base64')!==file.base64||bytes.length>RUNNER_SNAPSHOT_MAX_FILE_BYTES)throw Error('Snapshot file exceeds its bound or is not canonical.');
  totalBytes+=bytes.length;if(totalBytes>RUNNER_SNAPSHOT_MAX_BYTES)throw Error('Snapshot exceeds its byte bound.');
  files.push({path:file.path,mode:file.mode,base64:file.base64,bytes:bytes.length,sha256:hash(bytes)});
 }
 for(const path of paths){let slash=path.indexOf('/');while(slash!==-1){if(paths.has(path.slice(0,slash)))throw Error('Snapshot has a file/directory collision.');slash=path.indexOf('/',slash+1);}}
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const manifest=files.map(file=>({path:file.path,mode:file.mode,bytes:file.bytes,sha256:file.sha256}));
 const digest=hash(canonicalJson({version:1,files:manifest}));
 // Strings are immutable and each entry is frozen, but this is not an immutable OS snapshot.
 return Object.freeze({digest,totalBytes,files:Object.freeze(files.map(file=>Object.freeze(file)))});
}
