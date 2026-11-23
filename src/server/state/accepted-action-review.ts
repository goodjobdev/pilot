import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parseAgentActor,parseAgentIdentifier} from '../../shared/agent-registry';
import {ControlStore,ControlStoreError,operationDigest} from './control-store';
import {readAcceptedActionItem} from './accepted-action-history';

export const ACTION_OBSERVATIONS=['checked-uncertain','checked-no-effect-visible','checked-effect-visible'] as const;
const observation=z.enum(ACTION_OBSERVATIONS);
const actor=z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const recordSchema=z.strictObject({version:z.literal(1),projectId:z.string().min(1),actionId:z.string().uuid(),actionRevision:z.number().int().positive().safe(),actionState:z.enum(['uncertain','not-started','receipt-recorded']),artifactRevision:z.string().regex(/^action-[a-f0-9]{64}$/),revision:z.number().int().positive().max(100),observation,observedBy:actor,observedAt:z.string().datetime()});
const payloadSchema=z.strictObject({version:z.literal(1),actionId:z.string().uuid(),revision:z.number().int().positive().max(100)});
export type ActionReview=z.infer<typeof recordSchema>;
export class ActionReviewConflict extends Error{}
/**
 * Owner observations are attestations, not provider evidence or action reconciliation. This store
 * never changes an action, releases a resource barrier, executes a target or permits a replay.
 * Callers must authenticate the owner and supply the actor server-side.
 */
export class AcceptedActionReviewStore{
 constructor(private readonly store:ControlStore){}
 private scope(projectId:string,actionId:string){return {projectId,sessionId:'action-review.'+createHash('sha256').update(actionId).digest('hex')};}
 private verifyHistory(reviews:ActionReview[],target:ReturnType<typeof readAcceptedActionItem>){
  if(reviews.some(review=>review.artifactRevision!==target.artifact.revision||review.actionRevision>target.revision||(review.actionRevision===target.revision&&review.actionState!==target.state)))throw Error('Action observation does not match its action.');
 }
 private rows(projectId:string,actionId:string):ActionReview[]{
  const scope=this.scope(projectId,actionId),rows=this.store.db.prepare("SELECT id FROM operations WHERE project_id=? AND session_id=? AND kind='accepted.review' ORDER BY rowid LIMIT 101").all(scope.projectId,scope.sessionId) as {id:string}[];
  if(rows.length>100)throw Error('Action observation history is too large.');
  return rows.map(({id},index)=>{
   const op=this.store.getOperation(id,scope),record=recordSchema.parse(op.input);
   if(record.projectId!==projectId||record.actionId!==actionId||record.revision!==index+1||op.kind!=='accepted.review'||op.idempotencyKey!=='review.r'+record.revision||op.state!=='pending'||op.receiptPresent)throw Error('Invalid action observation.');
   const links=this.store.db.prepare('SELECT id FROM outboxes WHERE operation_id=? LIMIT 2').all(op.id) as {id:string}[];
   if(links.length!==1)throw Error('Invalid action observation evidence.');
   const out=this.store.getOutbox(links[0].id,scope),payload=payloadSchema.parse(out.payload);
   if(out.operationId!==op.id||out.kind!=='accepted.review'||out.state!=='pending'||out.receiptPresent||payload.actionId!==actionId||payload.revision!==record.revision||op.inputDigest!==operationDigest(op.kind,{input:op.input,outbox:{kind:out.kind,payload:out.payload}}))throw Error('Invalid action observation evidence.');
   return record;
  });
 }
 read(project:unknown,action:unknown){
  const projectId=parseAgentIdentifier(project),actionId=z.string().uuid().parse(action);
  this.store.db.exec('BEGIN');
  try{const target=readAcceptedActionItem(this.store,projectId,actionId),reviews=this.rows(projectId,actionId);this.verifyHistory(reviews,target);this.store.db.exec('COMMIT');return {action:target,reviews,limit:100};}
  catch(error){try{this.store.db.exec('ROLLBACK');}catch{}throw error;}
 }
 record(input:{projectId:unknown;actionId:unknown;actionRevision:unknown;revision:unknown;observation:unknown;actor:unknown}){
  const projectId=parseAgentIdentifier(input.projectId),actionId=z.string().uuid().parse(input.actionId),who=parseAgentActor(input.actor),observed=observation.parse(input.observation);
  if(who.kind!=='owner')throw Error('Only an authenticated owner can record an observation.');
  const actionRevision=z.number().int().positive().safe().parse(input.actionRevision),revision=z.number().int().nonnegative().max(99).parse(input.revision);
  // Project the action and observation history from one snapshot; a concurrent receipt must not
  // make a valid operation/outbox pair look corrupt before the transactional admission check.
  const {action:current,reviews:existing}=this.read(projectId,actionId);
  if(current.revision!==actionRevision||existing.length!==revision)throw new ActionReviewConflict('The action or observations changed; reload before recording.');
  const record:ActionReview={version:1,projectId,actionId,actionRevision,actionState:current.state,artifactRevision:current.artifact.revision,revision:revision+1,observation:observed,observedBy:who.identity,observedAt:new Date().toISOString()};
  try{
   this.store.admit({scope:this.scope(projectId,actionId),idempotencyKey:'review.r'+record.revision,kind:'accepted.review',input:record,outbox:{kind:'accepted.review',payload:{version:1,actionId,revision:record.revision}},guard:()=>{
    const live=readAcceptedActionItem(this.store,projectId,actionId),history=this.rows(projectId,actionId);this.verifyHistory(history,live);
    if(live.revision!==actionRevision||live.state!==current.state||live.artifact.revision!==current.artifact.revision||history.length!==revision)throw new ControlStoreError('Action or observation changed.','CONFLICT');
   }});
  }catch(error){if(error instanceof ControlStoreError&&error.code==='CONFLICT')throw new ActionReviewConflict('The action or observations changed; reload before recording.');throw error;}
  return this.read(projectId,actionId);
 }
}
