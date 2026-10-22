import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { constants,writeSync } from 'node:fs';
import { access,lstat,mkdir,readFile,realpath } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { previewImport,applyImport,documentsSchema,type ImportPreview } from './importer';
import { safePath } from './paths';
import { atomicWrite } from './board-store';
import { z } from 'zod';
import { join,resolve,extname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { BoardStore,HttpError } from './board-store';
import { DocStore } from './docs-store';
import { HarnessHost,type AgentDeliveryPort,type AgentImage,type SessionLifecycleHooks } from './agents/harness-host';
import { MEDIA_CONTAINER_CODE, MediaContainerError, MediaStore } from './media-store';
import { AlertStore,type AlertPayload,type AlertTransport } from './alerts';
import { Catalog } from './catalog';
import { ProviderStore } from './providers';
import { RepositoryStore } from './repositories';
import { browse,within } from './paths';
import { authorize,headers,establishSession,type SecurityConfig } from './security';
import { effectiveConfig } from './effective-config';
import { acquireServiceLock,inspectServiceLock,type ServiceLockHandle } from './service-lock';
import { loadReleaseManifest,observeStorageSchema,resolveRelease,schemaVersionForId,SUPPORTED_SCHEMA_IDS,RELEASE_MANIFEST_ENV,RELEASE_MANIFEST_FILENAME,UNRELEASED_LOCAL,type StorageSchemaObservation } from './release';
import { ControlStore,CONTROL_SCHEMA_VERSION } from './state/control-store';
import { ReleaseStore } from './state/release-store';
import { matchReleaseIdentity,type ReleaseDifference,type ReleaseTarget } from '../shared/releases';
import { ApprovalStore } from './state/approval-store';
import { DeliveryError,DeliveryLedger,type DeliveryReconciliation } from './state/delivery';
import { SessionRegistry,createSessionResourcePort,legacyConversationPort,migrateLegacyConversations,type LegacyConversationPort } from './state/session-registry';
import { SessionLifecycleStore,SessionLifecycleService,adoptRunningSessions } from './state/session-lifecycle';
import { QueueStore,type QueueImageResolver,type QueueResult } from './state/queue-store';
import { RunnerBroker,createProjectWorkspaceResolver,dockerRunnerPort,type RunnerPort } from './state/runner-broker';
import { RunnerError } from '../shared/runner';
import { AcceptanceError, parseAcceptanceActor, type AcceptanceActor } from '../shared/acceptance';
import { AcceptanceStore } from './state/acceptance-store';
import { FORK_ROOT_DIRECTORY, ForkStore, createForkWorktreePort, type ForkTranscriptPort } from './state/fork-store';
import { FORK_MAX_ENTRY_SCAN, ForkError } from '../shared/forks';
import { AgentStore } from './state/agent-store';
import { FileEditTool, FileEditError, type FileEditMode } from './state/file-edit-tool';
import { AgentError, agentScopeVocabulary } from '../shared/agent-registry';
import { ActionError,ActionRegistry,liveActivity,normaliseActionScope,type ActionEnvironment } from './state/action-registry';
import { ApprovalError } from '../shared/approvals';
import { SessionError,legacySessionName } from '../shared/sessions';
import { SessionLifecycleError } from '../shared/session-lifecycle';
import { emptyBoard } from '../shared/model';
import { serializeBoard } from '../shared/markdown';
import { MAX_IMAGES_PER_MESSAGE, MEDIA_ID_PATTERN, TOO_MANY_IMAGES_CODE, inspectImage, tooManyImagesReason } from '../shared/images';
import { QueueError, queueView, type QueueImageRef } from '../shared/queue';
/**
 * Expected-version readiness inputs: the release identity, whether this process holds the lock, and
 * the schema observed from the live store handle. Startup supplies the live observer; a caller that
 * constructs createApp directly falls back to a read-only observation of the data root.
 */
export interface ReadinessOptions {readonly releaseId:string;readonly schemaId:string;readonly manifestValid?:boolean;readonly lockHeld?:()=>boolean;readonly observeSchema?:()=>StorageSchemaObservation;readonly releaseMatch?:()=>ReleasePromotionObservation}
/**
 * What this process knows about the candidate the durable store says is promoted, compared with the
 * identity it was started as. It is a report, never a write: reading it promotes nothing, moves no
 * pointer and starts no service. 'not-promoted' is not a failure by itself (a fresh or local instance
 * has no promotion yet); a mismatch is, because a build must serve the release that was promoted.
 */
export type ReleasePromotionObservation =
  | {readonly state:'not-promoted'}
  | {readonly state:'match';readonly revision:number;readonly target:ReleaseTarget}
  | {readonly state:'mismatch';readonly revision:number;readonly target:ReleaseTarget;readonly differences:readonly ReleaseDifference[]}
  | {readonly state:'unreadable';readonly reason:string};
/** What the running service reports about itself, and the one read-only seam that answers for promotion. */
export interface ReleaseReportOptions {readonly version:string;readonly source:'manifest'|'unreleased-local';readonly buildId?:string;readonly sourceDigest?:string;readonly observe:()=>ReleasePromotionObservation}
export interface AppOptions {dataRoot:string;browseRoots:string[];security:SecurityConfig;allowedHosts?:readonly string[];clientRoot?:string;registry?:string;agents?:'on'|'off';agentPauseMs?:number;alertTransport?:AlertTransport;alertSubject?:string;alertCooldownMs?:number;readiness?:ReadinessOptions;control?:ControlStore;runner?:{readonly enabled?:boolean;readonly port?:RunnerPort};fileEdit?:{readonly enabled?:boolean};release?:ReleaseReportOptions}
/**
 * Approvals answer with a status that says what happened: an invalid request is 422, an approval
 * outside the caller's scope is 403, a missing one is 404, a storage fault is 500, and every
 * lifecycle refusal (expired, revoked, already consumed, wrong kind, wrong target, raced write) is
 * a 409 with the precise reason in the body.
 */
export function approvalHttpStatus(code:ApprovalError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='SCOPE')return 403;
  if(code==='STORAGE')return 500;
  return 409;
}
/**
 * Named sessions answer with a status that says what happened: an invalid request (an unknown field,
 * a malformed id, a name outside the documented rule, a missing revision) is 422, a missing project
 * or session is 404, a link outside the approved roots is 403, a duplicate live name or a stale
 * revision is 409, and a storage or corruption fault is 500. Every message is path-free.
 */
export function sessionHttpStatus(code:SessionError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='OUTSIDE_ROOTS')return 403;
  if(code==='DUPLICATE_NAME'||code==='CONFLICT')return 409;
  return 500;
}
/**
 * Session lifecycle actions answer with the status that says what happened: a malformed request is
 * 422, a missing session is 404, an illegal jump, a stale revision and a refusal that needs an
 * operator are all 409 with the precise, path-free reason, and a storage or corruption fault is 500.
 */
/** The strict body of each queue write operation: exactly the fields that operation reads. */
const QUEUE_BODY_SCHEMAS:Readonly<Record<string,z.ZodTypeAny>>=Object.freeze({
  append:z.strictObject({projectId:z.unknown(),revision:z.unknown(),text:z.unknown().optional(),images:z.unknown().optional()}),
  edit:z.strictObject({projectId:z.unknown(),revision:z.unknown(),entryId:z.unknown(),text:z.unknown()}),
  reorder:z.strictObject({projectId:z.unknown(),revision:z.unknown(),entryId:z.unknown(),position:z.unknown()}),
  remove:z.strictObject({projectId:z.unknown(),revision:z.unknown(),entryId:z.unknown()}),
  clear:z.strictObject({projectId:z.unknown(),revision:z.unknown()}),
  cancel:z.strictObject({projectId:z.unknown(),revision:z.unknown(),entryId:z.unknown()}),
  claim:z.strictObject({projectId:z.unknown(),owner:z.unknown()}),
  release:z.strictObject({projectId:z.unknown(),owner:z.unknown(),entryId:z.unknown()}),
  submit:z.strictObject({projectId:z.unknown(),owner:z.unknown(),entryId:z.unknown()}),
  reconcile:z.strictObject({projectId:z.unknown(),entryId:z.unknown()})
});
/** The image ids one append may carry: stored media ids, and nothing that could be a path. */
function queueImageIds(value:unknown):readonly string[] {
  if(value===undefined||value===null)return Object.freeze([]);
  if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!MEDIA_ID_PATTERN.test(id)))
    throw new HttpError(422,'The images field must be an array of stored image ids (the hex media id of the bytes)','unknown-media');
  return Object.freeze(value as string[]);
}
/**
 * Queue operations answer with the status that says what happened: a malformed request (an unknown
 * field, an empty entry, a position outside the queue) is 422, an entry or session the store does not
 * hold is 404, a stale revision, an illegal transition, a live claim that is not stolen and a queue at
 * its documented bound are all 409 with the precise, path-free reason, and a storage or corruption
 * fault is 500.
 */
export function queueHttpStatus(code:QueueError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 409;
}
/**
 * Coding jobs answer with the status that says what happened: a malformed request, an unknown recipe,
 * a workspace outside the project root or limits this build cannot enforce are 422, a missing project
 * or job is 404, a workspace outside the approved root is 403, a live claim, an expired lease and a
 * terminal job are 409 with the precise, path-free reason, a runner this instance cannot contain a job
 * with is 503, and a storage or corruption fault is 500. A refusal is always path-free: the runtime's
 * own error is logged on the server and never repeated in a response.
 */
/**
 * Acceptance answers with the status that says what happened: a malformed request, a claim that
 * contradicts its own recorded output, an outcome that contradicts the counts its own output carries,
 * or two declared accepting actors that disagree are 422, a missing record is 404, an identity the policy does
 * not permit is 403, a stale policy revision, a second acceptance of one artifact and an artifact
 * that has changed since its evidence was produced are all 409 with the precise, path-free reason,
 * and a storage or corruption fault is 500.
 */
export function acceptanceHttpStatus(code:AcceptanceError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='NOT_PERMITTED')return 403;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 409;
}
export function runnerHttpStatus(code:RunnerError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='OUTSIDE_ROOT')return 403;
  if(code==='UNAVAILABLE')return 503;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 409;
}
export function lifecycleHttpStatus(code:SessionLifecycleError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 409;
}
/**
 * Forks answer with the status that says what happened: a malformed request and a base commit that is
 * not a commit of the project's own repository are 422, a fork target that escapes the designated fork
 * root is 403, a missing fork and a cutoff the parent transcript does not hold are 404, a stale
 * revision, a taken target, a fork at its documented bound, a discard without the force a dirty
 * worktree needs and an illegal state change are 409, a capability this instance lacks is 503, and a
 * storage or corruption fault is 500. Every refusal is path-free: a git error names a path, so it is
 * logged and never repeated in a response.
 */
/**
 * The agent registry's own refusals, each mapped to one HTTP status. A duplicate name and a stale
 * revision are conflicts; a governance refusal is a permission refusal; an unknown agent is not found.
 */
export function agentHttpStatus(code:AgentError['code']):number {
  if(code==='NOT_FOUND')return 404;
  if(code==='DUPLICATE_NAME'||code==='CONFLICT')return 409;
  if(code==='NOT_PERMITTED')return 403;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 422;
}
/** The bounded file-edit capability's own refusals. An escape from the worktree is a permission refusal. */
export function fileEditHttpStatus(code:FileEditError['code']):number {
  if(code==='NOT_FOUND')return 404;
  if(code==='NOT_PERMITTED'||code==='OUTSIDE_WORKTREE')return 403;
  if(code==='BOUNDED')return 413;
  if(code==='UNAVAILABLE')return 503;
  if(code==='CONFLICT')return 409;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 422;
}
export function forkHttpStatus(code:ForkError['code']):number {
  if(code==='INVALID')return 422;
  if(code==='NOT_FOUND')return 404;
  if(code==='OUTSIDE_ROOT')return 403;
  if(code==='UNAVAILABLE')return 503;
  if(code==='CORRUPT'||code==='STORAGE')return 500;
  return 409;
}
/**
 * A strict body parse for a write route: a body the route does not accept is an invalid request in
 * this application's own words (422) with a path-free reason, never a raw schema-library message.
 * The library's own message echoes the offending key and its internal wording, and a caller that sent
 * an unknown field or omitted a required one should read what this route expects instead. Only field
 * names from this route's own schema are ever named in the reason.
 */
function parseBody<T>(schema:z.ZodType<T>,payload:unknown,label:string):T{
  try {return schema.parse(payload);}
  catch(error){
    if(!(error instanceof z.ZodError))throw error;
    const issue=error.issues[0];
    const field=issue&&issue.path.length?issue.path.map(String).join('.'):'';
    const detail=issue===undefined?'it does not match the documented shape'
      :issue.code==='unrecognized_keys'?'it carries a field this route does not accept'
      :field===''?'a field it sends is not of the documented kind'
      :'the '+field+' field is missing or not of the documented kind';
    throw new HttpError(422,label+' is invalid: '+detail);
  }
}
/** The channel-level tag of a question notification: derived from the question id, so a re-send is
 * the same notification at the push service rather than a second one. */
function questionTag(questionId:string):string{return 'pilot-question-'+questionId;}
/** What the alert store reports back for one delivery: the receipt the ledger acknowledges with. */
type AlertReceipt=Awaited<ReturnType<AlertStore['notify']>>;
/**
 * The delivery ledger's live wiring: the one place the running application admits a question,
 * records an answer and acknowledges either delivery.
 *
 * A surfaced question is admitted before its owner notification is sent, and the notification *is*
 * the ledger's outbox step: its receipt is the alert store's own report, so the ledger records what
 * the channel actually did. An answer is recorded before anything reaches the agent, and its outbox
 * step is the agent receiving it, acknowledged with the submission evidence.
 */
function createDeliveryPort(input:{ledger:DeliveryLedger;alerts:AlertStore}):AgentDeliveryPort{
  const {ledger,alerts}=input;
  const exact=(projectId:string,sessionId:string)=>({projectId,sessionId});
  /** A durable-record refusal is an HTTP refusal: none of these is a malformed request. */
  const refuse=(error:unknown):never=>{
    if(error instanceof DeliveryError){
      const status=error.code==='STORAGE'?503:error.code==='CORRUPT'?500:error.code==='INVALID'?422:(error.code==='UNKNOWN_QUESTION'||error.code==='NOT_FOUND')?404:409;
      throw new HttpError(status,error.message);
    }
    throw error;
  };
  return {
    async questionSurfaced(question){
      const scope=exact(question.projectId,question.sessionId);
      try {
        ledger.admitQuestion({...scope,questionId:question.questionId,text:question.text,askedAt:question.askedAt??Date.now()});
      } catch(error) {
        // The transcript stays canonical and the question stays visible, so the owner is still told;
        // what is missing is the durable receipt, and that is reported rather than hidden.
        console.error('Question '+question.questionId+' could not be admitted to the delivery ledger ('+(error as Error).message+'); it is notified without a durable receipt');
      }
      const receipt=await alerts.notify({title:'An agent needs an answer',body:[question.projectName,question.text].filter(Boolean).join(' — ').slice(0,240),url:'/?project='+question.projectId+'&view=Agents',tag:questionTag(question.questionId)},{key:question.projectId+':question'});
      // A notification that reached no device is not a delivery, whether the channel deliberately
      // skipped it (no device subscribed, or a repeat inside the cooldown) or it had devices and
      // every send failed — the receipt only proves delivery when it reports at least one send. The
      // row stays outstanding, and the next start re-sends it, which is safe precisely because the
      // tag is derived from the question id.
      if(receipt.skipped||receipt.sent===0)return;
      try {
        ledger.markDelivered(question.questionId,receipt,{kind:'question',scope});
      } catch(error) {
        console.error('The notification for question '+question.questionId+' was sent but its delivery was not acknowledged ('+(error as Error).message+'); the next start re-sends it idempotently');
      }
    },
    async answerRecorded(answer){
      const scope=exact(answer.projectId,answer.sessionId);
      try {
        // A question the transcript holds but the ledger does not (an admission that failed, or a
        // question asked before the ledger was wired) is admitted here first, so the answer is still
        // recorded before it is sent — and it is still never sent without a durable record.
        if(!ledger.hasQuestion(answer.questionId,scope))
          ledger.admitQuestion({...scope,questionId:answer.questionId,text:answer.question.text,askedAt:answer.question.askedAt??answer.answeredAt});
        ledger.answerQuestion({...scope,questionId:answer.questionId,text:answer.text,answeredAt:answer.answeredAt});
      } catch(error) { refuse(error); }
    },
    async answerDelivered(delivered){
      ledger.markDelivered(delivered.questionId,delivered.receipt,{kind:'answer',scope:exact(delivered.projectId,delivered.sessionId)});
    },
    ledgerView(view){return ledger.deliveries(exact(view.projectId,view.sessionId));}
  };
}
/** What one start did about the delivery ledger, and why. Deterministic, and never question text. */
export type DeliveryReconciliationSummary={
  readonly readOnly:false;
  readonly counts:DeliveryReconciliation['counts'];
  readonly actions:{readonly redelivered:number;readonly completed:number;readonly outstanding:number;readonly needsOperatorAttention:number};
  readonly attention:readonly {readonly operationId:string;readonly delivery:string|null;readonly questionId:string|null;readonly reason:string}[];
};
/**
 * The start-time half of the delivery ledger: it reads the ledger's read-only report and performs
 * only what that report licenses.
 *
 * - `redeliver-idempotent` on a question: the owner notification is re-sent with the tag derived
 *   from the question id, so the channel collapses it onto the same notification, and the row is
 *   acknowledged with the receipt the channel reported. A channel that sent nothing leaves the row
 *   outstanding for the next start.
 * - `redeliver-idempotent` on an answer: the agent submission is repeated with the request id
 *   derived from the question — a repeat finds the original submission — and the row is
 *   acknowledged with the submission evidence. When the transcript write never happened, the
 *   ledger's own recorded text completes it first, so the ledger finishes its own record instead of
 *   reporting a question it can hold an answer for as unanswerable.
 * - `complete-acknowledgement`: a crash half-wrote an acknowledgement, so it is completed from the
 *   evidence the outbox already carries, and nothing is re-sent.
 * - everything else — an uncertain row, a payload that no longer matches its delivery, a re-send
 *   that fails — is reported for an operator and never replayed.
 */
export async function reconcileDeliveries(input:{
  ledger:DeliveryLedger;
  notify:(payload:AlertPayload,key:string)=>Promise<AlertReceipt>;
  projectName:(projectId:string)=>string|undefined;
  /**
   * The text the ledger itself recorded for a question's answer, or null. It is read only where the
   * ledger has to finish a record it already committed to — an answer whose transcript write a crash
   * never made — and it is never logged, returned or put in the report summary.
   */
  recordedAnswer?:(scope:{projectId:string;sessionId:string},questionId:string)=>{text:string;answeredAt:string}|null;
  redeliverAnswer?:(scope:{projectId:string;sessionId:string},questionId:string,recorded?:{text:string;answeredAt:string})=>Promise<unknown>;
}):Promise<DeliveryReconciliationSummary>{
  const report=input.ledger.reconcileOnStartup();
  let redelivered=0,completed=0,outstanding=0,needsOperatorAttention=0;
  const attention:{operationId:string;delivery:string|null;questionId:string|null;reason:string}[]=[];
  for(const entry of report.entries){
    const delivery=entry.delivery,questionId=entry.questionId,projectId=entry.projectId,sessionId=entry.sessionId;
    const scoped=delivery!==null&&questionId!==null&&projectId!==null&&sessionId!==null;
    const scope={projectId:projectId??'',sessionId:sessionId??''};
    try {
      if(scoped&&entry.disposition==='complete-acknowledgement'&&delivery!==null&&questionId!==null){
        input.ledger.completeAcknowledgement(questionId,{kind:delivery,scope});
        completed+=1;continue;
      }
      if(scoped&&entry.disposition==='redeliver-idempotent'&&delivery==='question'&&questionId!==null){
        const receipt=await input.notify(questionNotification(questionId,scope.projectId,input.projectName(scope.projectId)),scope.projectId+':question');
        // A re-send that reached no device is not a delivery either: the row stays outstanding.
        if(receipt.skipped||receipt.sent===0){outstanding+=1;continue;}
        input.ledger.markDelivered(questionId,receipt,{kind:'question',scope});
        redelivered+=1;continue;
      }
      if(scoped&&entry.disposition==='redeliver-idempotent'&&delivery==='answer'&&questionId!==null&&input.redeliverAnswer){
        // The ledger's own recorded text lets the harness finish a transcript write a crash never
        // made; when the transcript already holds the answer the harness uses that copy instead.
        const recorded=input.recordedAnswer?input.recordedAnswer(scope,questionId):null;
        const receipt=await input.redeliverAnswer(scope,questionId,recorded??undefined);
        input.ledger.markDelivered(questionId,receipt,{kind:'answer',scope});
        redelivered+=1;continue;
      }
      needsOperatorAttention+=1;
      attention.push({operationId:entry.operationId,delivery,questionId,reason:entry.disposition==='redeliver-idempotent'?'an idempotent re-send was licensed, but this instance cannot perform it':entry.reason});
    } catch(error) {
      needsOperatorAttention+=1;
      attention.push({operationId:entry.operationId,delivery,questionId,reason:'the re-send was refused: '+(error as Error).message});
    }
  }
  const summary:DeliveryReconciliationSummary=Object.freeze({
    readOnly:false as const,counts:report.counts,
    actions:Object.freeze({redelivered,completed,outstanding,needsOperatorAttention}),
    attention:Object.freeze(attention)
  });
  if(report.entries.length)console.log('Delivery reconciliation: '+JSON.stringify(summary));
  return summary;
}
/** One line of context for a re-sent question notification: never the question text, which the
 * ledger's report deliberately does not return. */
function questionNotification(questionId:string,projectId:string,projectName:string|undefined):AlertPayload{
  const body=projectName?projectName+' — a question is still waiting for an answer':'A question is still waiting for an answer';
  return {title:'An agent needs an answer',body:body.slice(0,240),url:'/?project='+projectId+'&view=Agents',tag:questionTag(questionId)};
}
export async function createApp(options:AppOptions){
  // The release identity this process reports, and the read-only observation of which release the
  // store says is promoted. Both are reports: neither promotes, points or starts anything.
  const releaseReport=options.release??null;
  const releaseIdentity={releaseId:options.readiness?.releaseId??UNRELEASED_LOCAL,schemaId:options.readiness?.schemaId??SUPPORTED_SCHEMA_IDS[0]};
  const observeRelease:()=>ReleasePromotionObservation=releaseReport?.observe??(()=>({state:'not-promoted' as const}));
  const readinessForReport:ReadinessOptions={...(options.readiness??{releaseId:releaseIdentity.releaseId,schemaId:releaseIdentity.schemaId}),releaseMatch:observeRelease};
  /** The authenticated, path-free report of the release identity and the schema this build expects. */
  const releaseView=()=>{
    const observed=observeRelease();
    const reasons:string[]=[];
    if(observed.state==='mismatch')reasons.push('release-identity-mismatch');
    if(observed.state==='unreadable')reasons.push('release-promotion-unreadable');
    const promotion=observed.state==='not-promoted'
      ?{state:'not-promoted' as const,revision:0,candidate:null,differences:[] as string[],reason:null}
      :{state:observed.state,revision:observed.state==='unreadable'?0:observed.revision,
        candidate:observed.state==='unreadable'?null:{candidateId:observed.target.candidateId,releaseId:observed.target.releaseId,schemaId:observed.target.schemaId,sourceDigest:observed.target.sourceDigest,artifact:observed.target.artifact},
        differences:observed.state==='mismatch'?observed.differences.map(difference=>difference.field):[],
        reason:observed.state==='unreadable'?observed.reason:null};
    return Object.freeze({ok:true,release:Object.freeze({
      releaseId:releaseIdentity.releaseId,schemaId:releaseIdentity.schemaId,expectedSchemaVersion:schemaVersionForId(releaseIdentity.schemaId)??null,
      version:releaseReport?.version??'0.0.0-unreleased',source:releaseReport?.source??'unreleased-local',
      sourceDigest:releaseReport?.sourceDigest??null,buildId:releaseReport?.buildId??null
    }),promotion:Object.freeze(promotion),reasons:Object.freeze(reasons)});
  };
  // The Host check is exactly the canonical origin's host. Startup passes the set that
  // effective-config derived from that same validated origin; a caller that constructs
  // createApp directly reads the same single value from its security config per request, so
  // the allowed set never widens and a late origin assignment still applies.
  const allowedHosts=()=>options.allowedHosts??[new URL(options.security.origin).host];
  const boards=new BoardStore(options.dataRoot),docs=new DocStore(),catalog=new Catalog(options.dataRoot,options.browseRoots,boards);await catalog.init();
  // The immutable media store: accepted images live under the data root, keyed by the hash of their
  // stored bytes. It validates and processes (decode, orient, resize, re-encode) with the documented
  // ImageProcessor the pinned packages ship; see docs/MEDIA.md for the rules and the honest limits.
  const media=new MediaStore(options.dataRoot);
  const providers=new ProviderStore(catalog.root),repositories=new RepositoryStore(catalog.root);
  const alerts=new AlertStore(options.dataRoot,{subject:options.alertSubject??(process.env.DASHBOARD_OWNER?'mailto:'+process.env.DASHBOARD_OWNER:undefined),transport:options.alertTransport,cooldownMs:options.alertCooldownMs});
  await alerts.init();
  // The delivery ledger is the durable half of the question and answer flow, and it exists exactly
  // when a durable control store is open. Without one the harness keeps its pre-ledger behaviour:
  // the transcript stays the only record and the routes that need a ledger refuse rather than guess.
  const ledger=options.control?new DeliveryLedger(options.control):undefined;
  const delivery=ledger?createDeliveryPort({ledger,alerts}):undefined;
  // The durable session lifecycle lives in the same control store as the registry, the ledger and
  // the approvals; it introduces no persistence of its own. A live generation is recorded durably
  // only where a named session exists for the conversation, so a project without a registry writes
  // no lifecycle row at all; the migration below fills the holder in, and the check reads it at call
  // time rather than at construction.
  const lifecycle=options.control?new SessionLifecycleStore(options.control):undefined;
  const sessionHolder:{sessions?:SessionRegistry}={};
  const lifecycleHooks:SessionLifecycleHooks|undefined=lifecycle?{
    began:({projectId,sessionId,requestId})=>{if(sessionHolder.sessions?.has(projectId,sessionId))lifecycle.markRunning({projectId,sessionId,requestId});},
    settled:({projectId,sessionId,outcome})=>{if(sessionHolder.sessions?.has(projectId,sessionId))lifecycle.markSettled({projectId,sessionId,outcome});}
  }:undefined;
  // The agent registry, the privilege scopes in force and the bounded file-edit capability. The
  // registry is deployment-level state over the same control store; the harness is created before it,
  // so the two holders below are read at call time rather than captured at construction.
  const agentHolder:{store?:AgentStore}={};
  const fileEditModeHolder:{mode:()=>FileEditMode}={mode:()=>'propose-only'};
  const fileEditEnabled=options.fileEdit?.enabled??process.env.DASHBOARD_FILE_EDIT==='on';
  const fileEdit=options.control&&fileEditEnabled?new FileEditTool(options.control,{
    enabled:true,
    // The connected repository worktree is the registered project's own folder and nothing else.
    projectRoot:(projectId:string)=>catalog.projects.find(candidate=>candidate.id===projectId)?.path,
    dataRoot:options.dataRoot,
    // The mode comes from the acceptance policy in force, never from an assumption.
    policy:{mode:()=>fileEditModeHolder.mode()}
  }):undefined;
  // The agent harness is the only execution surface. It is off unless the instance enables it explicitly.
  const agents=new HarnessHost({
    dataRoot:options.dataRoot,providers,delivery,lifecycle:lifecycleHooks,
    enabled:(options.agents??(process.env.DASHBOARD_AGENTS==='on'?'on':'off'))==='on',
    pauseMs:options.agentPauseMs??Number(process.env.DASHBOARD_AGENT_PAUSE_MS??2500),
    // The authoritative dispatch path reads this on every tool call, so an agent's scopes are
    // re-checked server-side however a call was crafted. With no registry open, the owner's own
    // dispatch is in force and nothing is narrowed.
    // Read **per session**, on every tool call: the session id is the conversation the call belongs
    // to, and its durable binding (written through this same store) decides the authority, so a
    // binding or scope change takes effect at the next dispatch with no restart. With no registry
    // open, the owner's own dispatch is in force and nothing is narrowed.
    privileges:{authority:async({projectId,sessionId})=>agentHolder.store?agentHolder.store.authorityForSession({projectId,sessionId:sessionId??''}):Object.freeze({agentId:null,scopes:null,projects:null,emptyReason:null})},
    fileEdit,
    onEvent:event=>{
      // A question is notified by the ledger's own outbox step, which tags the notification by the
      // question id so a later re-send collapses onto the same one. Without a ledger the plain alert
      // stands in, and a notification still says which project needs attention and where to go,
      // never what it says.
      if(event.kind==='question'&&delivery)return;
      const title=event.kind==='question'?'An agent needs an answer':event.kind==='error'?'An agent run failed':'An agent finished';
      const body=[event.projectName,event.detail].filter(Boolean).join(' — ').slice(0,240);
      void alerts.notify({title,body,url:'/?project='+event.projectId+'&view=Agents',tag:'dashboard-'+event.projectId+'-'+event.kind},{key:event.projectId+':'+event.kind}).catch(()=>{/* a failed alert never breaks a run */});
    }
  });
  // Approvals are scoped, single-use grants over the durable control store. Without a live store
  // there is nothing to scope them to, so the routes refuse with 503 rather than guessing.
  const approvals=options.control?new ApprovalStore(options.control):undefined;
  // The named-session registry and the two ports it needs. Link validation reuses the stores that
  // already exist -- the board store, the documentation store and the contained-path helper -- and
  // never writes anything; a project that is not registered has no board and no documents, so a
  // link to it is refused instead of guessed at.
  const sessionResources=createSessionResourcePort({
    browseRoots:options.browseRoots,
    project:projectId=>catalog.projects.find(p=>p.id===projectId),
    taskIds:async projectId=>{
      const project=catalog.projects.find(p=>p.id===projectId);
      if(!project)return [];
      try {return (await boards.read(project)).board.tasks.map(task=>task.id);}
      catch(error) {if(error instanceof HttpError&&error.status===404)return [];throw error;}
    },
    documentServable:async(projectId,path)=>{
      const project=catalog.projects.find(p=>p.id===projectId);
      if(!project)return false;
      try {await docs.read(project,path);return true;}
      catch(error) {if(error instanceof HttpError&&error.status===404)return false;throw error;}
    }
  });
  const sessions=options.control?new SessionRegistry(options.control,sessionResources):undefined;
  sessionHolder.sessions=sessions;
  // The five owner actions: reconnect (attach only), resume (continue under the original request
  // identity), retry (a new attempt under an identity derived from the revision it writes), stop
  // (cancel, idempotent) and pause (cancel but keep resumable). The only effects are the harness calls
  // below; reconnect performs none at all, and a stop or a pause cancels a harness that is already
  // open rather than opening one. A dispatching action is checked for capability first and then writes
  // its transition before it dispatches, so the durable write is the single serialisation point; a
  // cancelling action cancels first and writes after, because its effect ends work rather than spending.
  const lifecycleService=lifecycle?new SessionLifecycleService(lifecycle,{
    // Asked before a dispatching action writes anything, so an instance that cannot dispatch refuses
    // without claiming a revision. It performs no model work and opens no harness: opening one would
    // resume unfinished work, which is itself a model request.
    authoriseDispatch:({projectId})=>{if(!agents.enabled)throw new HttpError(503,'Agents are disabled on this instance');catalog.get(projectId);},
    resume:async({projectId,requestId})=>{if(!agents.enabled)throw new HttpError(503,'Agents are disabled on this instance');await agents.dispatchLifecycle(catalog.get(projectId),requestId);},
    retry:async({projectId,requestId})=>{if(!agents.enabled)throw new HttpError(503,'Agents are disabled on this instance');await agents.dispatchLifecycle(catalog.get(projectId),requestId);},
    // A cancel on an instance with no harness has nothing to stop, so it is a harmless no-op; a
    // resume or a retry, which would have to dispatch, refuse instead (above).
    cancel:async({projectId})=>{if(!agents.enabled)return;await agents.cancelLifecycle(catalog.get(projectId));}
  }):undefined;
  // Which projects already have a conversation, and what to call the adopted session.
  const legacy:LegacyConversationPort=legacyConversationPort({dataRoot:options.dataRoot,projects:async()=>catalog.projects.map(p=>({id:p.id,name:p.name,path:p.path}))});
  // The start-time reconciliation of the delivery ledger: the read-only report plus the only acts
  // that report licenses. It runs before the server listens, so a row a crash left behind is
  // re-sent (and only where the stored payload proves the effect idempotent) before anything is
  // served. A failure to reconcile is reported and never stops the process from serving.
  if(ledger) {
    try {
      await reconcileDeliveries({
        ledger,
        notify:(payload,key)=>alerts.notify(payload,{key}),
        // The name is cosmetic context for one line of the notification; an unregistered or invalid
        // project id is not a reason to withhold the re-send.
        projectName:id=>{try{return catalog.get(id).name;}catch{return undefined;}},
        // An answer is re-delivered through the live harness, and only when the instance has agents:
        // without them there is nothing to deliver to, which is reported for an operator instead.
        // The ledger's recorded text is handed over so a transcript write a crash never made is
        // completed; it stays inside this call and appears in no view, log line or report.
        recordedAnswer:(scope,questionId)=>ledger.recordedAnswer({...scope,questionId}),
        redeliverAnswer:agents.enabled?async(scope,questionId,recorded)=>agents.redeliverAnswer(catalog.get(scope.projectId),questionId,recorded):undefined
      });
    } catch(error) {console.error('The delivery ledger could not be reconciled (nothing was replayed): '+(error as Error).message);}
  }
  // The legacy-conversation migration runs before anything listens, so every project that already
  // has an agent conversation is adopted as a named session once, deterministically. It opens no
  // harness, reads and writes no transcript and sends nothing to a provider: a project without a
  // conversation is left exactly as it is. A migration that fails is reported and never stops the
  // process from serving.
  if(sessions) {
    try {
      const migration=await migrateLegacyConversations({registry:sessions,legacy,dryRun:false});
      if(migration.counts.conversations>0||migration.counts.refused>0)console.log('Session migration: '+JSON.stringify(migration));
    } catch(error) {console.error('The legacy conversation migration could not run (nothing was adopted): '+(error as Error).message);}
  }
  // The startup adoption of sessions whose durable state says running but whose process is gone: each
  // is marked interrupted with a reason, deterministically and idempotently, with no browser attached.
  // It runs before anything listens and is deliberately distinct from the delivery reconciliation:
  // it moves no outbox row, re-sends nothing and replays no effect.
  if(lifecycle) {
    try {
      const adoption=adoptRunningSessions(lifecycle,new Date());
      if(adoption.adopted>0)console.log('Session lifecycle adoption: '+JSON.stringify(adoption));
    } catch(error) {console.error('The session lifecycle adoption could not run (nothing was adopted): '+(error as Error).message);}
  }
  /**
   * The queue of pending inputs: one durable, revisioned list per named session, with dispatcher
   * claims and stable submission reconciliation. It records *intent* only; what was really submitted
   * is the durable transcript's business, and the queue's dispatcher port is the one place a
   * submission can happen.
   *
   * - \`authorise\` reports whether this instance can dispatch at all, and it is asked **before** a claim
   *   writes anything, so an instance with the harness off refuses without claiming a revision. It
   *   opens no harness and performs no model work.
   * - \`submit\` hands the entry to the harness under the stable request identity the claim recorded, so
   *   every window around the write reconciles to one submission rather than two: Pi collapses a
   *   repeat of one request id onto the submission it already holds.
   * - \`lookup\` is deliberately absent. The installed harness exposes no read-back of a submission by
   *   request id, so this instance cannot prove from the transcript what an entry's outcome was; a
   *   reconciliation here, and equally a submission the harness did not report back, reports the named
   *   operator-attention state \`submission-not-readable\` rather than asserting a refusal, guessing or
   *   re-sending. \`docs/QUEUE.md\` states that limit.
   */
  const queueImages:QueueImageResolver={resolve:async(ids)=>{
    const refs:QueueImageRef[]=[];
    for(const id of ids){
      const stored=await media.get(id);
      if(!stored)throw new HttpError(422,'An attached image is not in the media store. Remove it and send again.','unknown-media');
      const inspected=inspectImage(stored.bytes);
      if(!inspected)throw new HttpError(422,'A stored image could not be read back as an image. Remove it and send again.','unknown-media');
      refs.push(Object.freeze({id,mimeType:inspected.type,bytes:stored.bytes.byteLength,width:inspected.width,height:inspected.height}));
    }
    return Object.freeze(refs);
  }};
  const queueStore=options.control?new QueueStore(options.control,{
    authorise:({projectId})=>{if(!agents.enabled)throw new HttpError(503,'Agents are disabled on this instance');catalog.get(projectId);},
    submit:async({projectId,requestId,entryId,text,images})=>{
      if(!agents.enabled)throw new HttpError(503,'Agents are disabled on this instance');
      const attached:AgentImage[]=[];
      for(const image of images){
        const stored=await media.get(image.id);
        if(!stored)throw new HttpError(422,'An attached image is not in the media store. Remove it and send again.','unknown-media');
        attached.push({mimeType:stored.mimeType,data:Buffer.from(stored.bytes).toString('base64')});
      }
      const submission=await agents.submit(catalog.get(projectId),{text,mode:'followUp',requestId,images:attached});
      return {requestId,entryId,submissionId:submission.submissionId,acceptedAt:new Date().toISOString()};
    }
  }):undefined;
  /**
   * The forks of this instance: a child transcript branched from a parent at one entry, a paused child
   * session, and a child worktree created from a recorded commit.
   *
   * A fork needs the agent harness — it branches a transcript and reads the parent's entries — so with
   * the harness off the store is absent rather than present-and-failing, exactly as the coding runner
   * is when it is switched off. Nothing here opens a second persistence: a fork is one control-store
   * operation per revision inside the child session's own scope.
   *
   * - `projectFolder` is the repository a child worktree is added to: the registered project's own
   *   folder. A project this instance does not know has none, and the store refuses rather than guess.
   * - `forkRootParent` is the designated fork root's parent inside the data root, so every child
   *   worktree lives under this instance's own data and nowhere else.
   * - the worktree port is the only git this build runs for a fork: one `git worktree add` from the
   *   recorded commit, one `git worktree remove`, and one read of the child's own status. Hooks are
   *   off, submodule recursion is off, no network command is ever issued, both file and external
   *   protocols are refused, and no stash is created, read or applied anywhere.
   * - the transcript port is the harness: the parent conversation, a bounded search for the cutoff
   *   entry, Pi Durable's own `fork(at)` (which makes no model request) and — only for a fork the
   *   store has already found active — one submission to the child under a stable request identity.
   */
  const forkTranscripts:ForkTranscriptPort={
    parentSession:async({projectId,parentSessionId})=>{
      const project=catalog.projects.find(candidate=>candidate.id===projectId);
      return project!==undefined&&await agents.hasSession(project,parentSessionId);
    },
    hasEntry:async({projectId,parentSessionId,cutoffEntryId})=>{
      const project=catalog.projects.find(candidate=>candidate.id===projectId);
      if(project===undefined)return false;
      return await agents.hasEntry(project,parentSessionId,cutoffEntryId,FORK_MAX_ENTRY_SCAN);
    },
    fork:async({projectId,parentSessionId,cutoffEntryId})=>{
      const project=catalog.projects.find(candidate=>candidate.id===projectId);
      if(project===undefined)throw new HttpError(404,'Unknown project');
      return await agents.forkTranscript(project,parentSessionId,cutoffEntryId);
    },
    dispatch:async({projectId,childSessionId,requestId,text})=>{
      const project=catalog.projects.find(candidate=>candidate.id===projectId);
      if(project===undefined)throw new HttpError(404,'Unknown project');
      await agents.dispatchToSession(project,childSessionId,{requestId,text});
    }
  };
  const forks=options.control&&agents.enabled&&sessions!==undefined?new ForkStore(options.control,{
    projectFolder:(projectId:string)=>catalog.projects.find(candidate=>candidate.id===projectId)?.path,
    forkRootParent:join(options.dataRoot,FORK_ROOT_DIRECTORY),
    worktrees:createForkWorktreePort(),
    transcripts:forkTranscripts,
    sessions
  }):undefined;
  /**
   * The bounded coding runner: one typed job per submission, run in a container created from
   * deploy/runner/Dockerfile, under the documented containment. It is **disabled by default** behind
   * an explicit switch (DASHBOARD_RUNNER=on), and while it is disabled its actions are absent from the
   * offered registry rather than present-and-failing.
   *
   * - `createProjectWorkspaceResolver` turns a job's relative workspace reference into the one host
   *   path a container may see, and refuses anything that is not an existing directory inside the
   *   registered project's own root with no symlink in it.
   * - `dockerRunnerPort` is the only execution path this build ships: it builds one `docker run`
   *   command line with no network, a read-only root filesystem, a non-root user, all capabilities
   *   dropped, no-new-privileges, no runtime socket, exactly one mount and hard limits. It refuses
   *   every job when the runtime or the image is missing, and there is no fallback anywhere in this
   *   build to running a job in this process, in the application container or on the host.
   * - An injected port is for tests only: the unit suite never starts a container.
   */
  const runnerEnabled=options.runner?.enabled??process.env.DASHBOARD_RUNNER==='on';
  const runner=options.control&&runnerEnabled?new RunnerBroker(options.control,options.runner?.port??dockerRunnerPort({image:process.env.DASHBOARD_RUNNER_IMAGE,docker:process.env.DASHBOARD_RUNNER_DOCKER}),{
    workspace:createProjectWorkspaceResolver({projectRoot:projectId=>catalog.projects.find(candidate=>candidate.id===projectId)?.path}),
    projectKnown:projectId=>catalog.projects.some(candidate=>candidate.id===projectId)
  }):undefined;
  if(runnerEnabled&&!options.control)console.error('The coding runner is enabled but no durable control store is open, so no job can be submitted; nothing was started.');
  if(runner&&options.runner?.port===undefined&&!(process.env.DASHBOARD_RUNNER_IMAGE??'').trim())console.error('The coding runner is enabled but DASHBOARD_RUNNER_IMAGE is not set, so every job will be refused until it names the image built from deploy/runner/Dockerfile.');
  /**
   * The start-time reconciliation of the coding runner: a job a previous process left running is
   * settled from what the durable record proves — its recorded result when there is one, and otherwise
   * the named operator-attention state — deterministically and idempotently, before anything listens.
   * It never re-runs a job, and a failure to reconcile is reported rather than stopping the process.
   */
  /**
   * The acceptance record: the durable policy, one frozen completion record per unit of work with
   * its Markdown rendering written inside the project, and the single-use, revision-bound acceptance
   * of an artifact. It is a decision ledger and a record: it commits, pushes, deploys, spends,
   * provisions and publishes nothing.
   *
   * - `projectRoot` resolves the registered project's own root, which is the only place the Markdown
   *   record is written (through the same contained-path helper and atomic write every other
   *   repository write uses); a project it cannot resolve is refused before anything is recorded.
   * - An owner acceptance made through the owner-authenticated routes uses the authenticated owner
   *   identity; an agent acceptance declares its own identity, and the policy decides whether it may
   *   accept. `docs/ACCEPTANCE.md` states exactly what that does and does not prove.
   */
  const ownerActor:AcceptanceActor=Object.freeze({kind:'owner' as const,identity:options.security.mode==='hosted'?(options.security.owner??'owner'):'local'});
  const acceptance=options.control?new AcceptanceStore(options.control,{
    projectRoot:(projectId:string)=>catalog.projects.find(candidate=>candidate.id===projectId)?.path
  }):undefined;
  /**
   * The agent registry: a durable, revision-checked record per agent, with an explicit scope
   * allowlist, a declared model this instance really offers, a workspace scope inside a registered
   * project, bounded budgets, and the governance rule that refuses an agent widening its own scopes.
   * It introduces no persistence of its own: one control-store operation per record revision.
   */
  const agentStore=options.control?new AgentStore(options.control,{
    models:()=>agents.offeredModels(),
    projectKnown:(projectId)=>catalog.projects.some(candidate=>candidate.id===projectId)
  }):undefined;
  agentHolder.store=agentStore;
  /**
   * One session as the overview list reports it: the durable record plus the agent binding, the
   * lifecycle state it reads at and the linked work the record holds. Pure reads of existing stores:
   * nothing here opens a harness, writes a row or sends anything.
   */
  const sessionOverview=(record:{readonly projectId:string;readonly id:string;readonly name:string;readonly revision:number;readonly model:unknown;readonly links:unknown;readonly createdAt:string;readonly updatedAt:string})=>{
    const binding=agentStore?.binding(record.projectId,record.id)??null;
    let state:string|null=null,stateRevision:number|null=null,attempt:number|null=null,reason:string|null=null,activityAt:string|null=null;
    if(lifecycleService!==undefined){
      try{const read=lifecycleService.read(record.projectId,record.id);state=read.state;stateRevision=read.revision;attempt=read.attempt;reason=read.reason;activityAt=read.activityAt;}
      catch{/* an unreadable lifecycle row is a named absence below, never a failed overview */}
    }
    return {
      id:record.id,name:record.name,revision:record.revision,model:record.model,links:record.links,
      createdAt:record.createdAt,updatedAt:record.updatedAt,
      agent:{id:binding?.agentId??null,revision:binding?.revision??0,boundAt:binding?.boundAt??null,boundBy:binding?.boundBy??null},
      lifecycle:{recorded:lifecycle?.has(record.projectId,record.id)??false,state,revision:stateRevision,attempt,reason,activityAt}
    };
  };
  // The one owner switch that decides the file-edit mode: the acceptance policy in force. The
  // documented default is owner-only, which is propose-only; only agent-may-accept permits auto-apply.
  fileEditModeHolder.mode=()=>acceptance!==undefined&&acceptance.readPolicy().mode==='agent-may-accept'?'auto-apply':'propose-only';
  if(runner) {
    try {
      const reconciliation=await runner.reconcile();
      if(reconciliation.settled+reconciliation.attention+reconciliation.unchanged>0)console.log('Coding runner reconciliation: '+JSON.stringify(reconciliation));
    } catch(error) {console.error('The coding runner could not be reconciled (nothing was re-run): '+(error as Error).message);}
  }
  // The command registry: one typed action per capability this build really has, with the handler
  // that owns it. It is assembled here, from the stores the process already holds, so an action
  // whose capability this instance lacks (no durable control store) is reported as unavailable and
  // is never offered. Nothing in the registry commits, pushes, deploys, spends, provisions or
  // publishes; the two report actions read only.
  const actionEnvironment:ActionEnvironment={
    control:sessions&&lifecycle&&lifecycleService&&approvals&&ledger&&queueStore&&agentStore?{
      sessions,lifecycle:lifecycleService,approvals,ledger,queue:queueStore,media:queueImages,runner,acceptance,forks,agents:agentStore,fileEdit,
      // Whether the store really holds a lifecycle row for one session, read-only. The projection
      // needs it because the lifecycle store answers an unwritten session with its initial record,
      // and that must not be reported as the state it reads at.
      lifecycleRecorded:(projectId:string,sessionId:string)=>lifecycle.has(projectId,sessionId),
      migrate:(dryRun:boolean)=>migrateLegacyConversations({registry:sessions,legacy,dryRun})
    }:undefined,
    doctor:()=>doctorReport(process.env),
    // Reading the conversation view is the only surface this build exposes for tool activity, and it
    // attaches the conversation exactly as the Agents view does; the projection reports that source.
    agents:{enabled:agents.enabled,read:(projectId:string)=>agents.view(catalog.get(projectId))}
  };
  const actions=new ActionRegistry(actionEnvironment);
  const previews=new Map<string,{projectId:string;revision:string;preview:ImportPreview;documents:{name:string;content:string}[];expires:number}>();
  const server=createServer(async(req,res)=>{
    headers(res);
    // Operational visibility without secrets: method, path and status only.
    const logged=(req.url??'/').split('?')[0];
    res.on('finish',()=>console.log(req.method+' '+logged+' -> '+res.statusCode));
    try {
      const url=new URL(req.url??'/',options.security.origin),path=url.pathname;
      if(!allowedHosts().includes(req.headers.host??''))throw new HttpError(403,'Untrusted Host');
      const json=(data:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
      if(path==='/healthz'){json({ok:true});return;}
      // Authenticated readiness: expected-version, not liveness. It reports app-known facts only,
      // takes no lock and mutates nothing. A failure is a machine-readable list of reasons.
      if(path==='/readyz'){
        if(!['GET','HEAD'].includes(req.method??''))throw new HttpError(405,'Method not allowed');
        await authorize(req,options.security);
        const report=await readinessReport({dataRoot:options.dataRoot,readiness:readinessForReport});
        json(report,report.ok?200:503);return;
      }
      if(path.startsWith('/api/')){
        const subject=await authorize(req,options.security);
        let payload:any={};
        if(!['GET','HEAD'].includes(req.method??'')){
          let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>8*1024*1024)throw new HttpError(413,'Request too large');}
          try{payload=JSON.parse(body);}catch{throw new HttpError(400,'Invalid JSON');}
        }
        // The release identity this process runs as, the storage schema it expects and which
        // candidate the durable store says is promoted. Read-only, authenticated, path-free.
        if(path==='/api/release'&&req.method==='GET'){json(releaseView());return;}
        if(path==='/api/settings/providers'&&req.method==='GET'){json(await providers.view());return;}
        if(path==='/api/settings/models'&&req.method==='POST'){json(await providers.savePreferences(payload));return;}
        const providerRoute=path.match(/^\/api\/settings\/providers\/([a-z0-9-]+)(?:\/(key|login))?$/);
        if(providerRoute){
          if(providerRoute[2]==='key'&&req.method==='POST'){await providers.saveKey(providerRoute[1],payload);json({ok:true});return;}
          if(providerRoute[2]==='login'&&req.method==='POST'){json(await providers.startLogin(providerRoute[1]));return;}
          if(!providerRoute[2]&&req.method==='DELETE'){await providers.logout(providerRoute[1]);json({ok:true});return;}
        }
        const loginRoute=path.match(/^\/api\/settings\/logins\/([a-f0-9-]{36})$/);
        if(loginRoute){
          if(req.method==='GET'){json(providers.login(loginRoute[1]));return;}
          if(req.method==='POST'){json(providers.reply(loginRoute[1],payload));return;}
          if(req.method==='DELETE'){await providers.cancel(loginRoute[1]);json({ok:true});return;}
        }
        const repositoryRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/repository(?:\/(key|test|connect))?$/);
        if(repositoryRoute){
          const p=catalog.get(repositoryRoute[1]),action=repositoryRoute[2];
          if(!action&&req.method==='GET'){json(await repositories.view(p));return;}
          if(action==='key'&&req.method==='POST'){json(await repositories.generate(p));return;}
          if(action==='key'&&req.method==='DELETE'){json(await repositories.removeKey(p));return;}
          if(action==='test'&&req.method==='POST'){json(await repositories.test(p));return;}
          if(action==='connect'&&req.method==='POST'){
            if(payload.confirm!==true)throw new HttpError(422,'Explicit confirmation required');
            json(await repositories.connect(p,async()=>{await boards.drain();await docs.drain();await agents.detach(p);},async()=>catalog.attachWorktree(p.id)));return;
          }
        }
        const scopedProject=path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/|$)/)?.[1];
        if(scopedProject&&repositories.isConnecting(scopedProject))throw new HttpError(409,'Repository connection in progress. Retry after it finishes.');
        if(path==='/api/session' && req.method==='GET'){json(establishSession(req,res,options.security,subject));return;}
        if(path==='/api/roots' && req.method==='GET'){json(options.browseRoots);return;}
        // Media: owner-only like every other route, behind the same Host check. A media id is the hex
        // hash of the stored bytes, so it is never a path; the response carries the type sniffed from
        // the bytes, nosniff, and an immutable cache header. Nothing outside the media directory is
        // served and a symlink is refused, because the helper refuses one at every path component.
        if(path.startsWith('/api/media/')){
          const route=path.match(/^\/api\/media\/([a-f0-9]{64})$/);
          if(!route)throw new HttpError(404,'Unknown media');
          if(!['GET','HEAD'].includes(req.method??''))throw new HttpError(405,'Method not allowed');
          const stored=await media.get(route[1]);
          if(!stored)throw new HttpError(404,'Unknown media');
          res.statusCode=200;
          res.setHeader('Content-Type',stored.mimeType);
          res.setHeader('X-Content-Type-Options','nosniff');
          res.setHeader('Content-Length',String(stored.bytes.byteLength));
          res.setHeader('Cache-Control','private, max-age=31536000, immutable');
          res.end(Buffer.from(stored.bytes));return;
        }
        if(path==='/api/alerts' && req.method==='GET'){json({enabled:alerts.enabled,publicKey:alerts.publicKey,subscriptions:alerts.count});return;}
        if(path==='/api/alerts/subscribe' && req.method==='POST'){json(await alerts.subscribe(payload));return;}
        if(path==='/api/alerts/unsubscribe' && req.method==='POST'){json(await alerts.unsubscribe((payload as {endpoint?:unknown}).endpoint));return;}
        if(path==='/api/alerts/test' && req.method==='POST'){json(await alerts.notify({title:'Project dashboard',body:'Test alert — alerts reach this device.',url:'/',tag:'dashboard-test'}));return;}
        // Approvals: create, list pending, read, consume, revoke. Owner-only like every other
        // route, behind the same Host check, and consuming performs no commit, push, deploy, spend,
        // provision or publish — it records who consumed what and returns the exact target.
        if(path.startsWith('/api/approvals')){
          if(!approvals)throw new HttpError(503,'Approvals are unavailable: no durable control store is open');
          const route=path.match(/^\/api\/approvals(?:\/([a-f0-9-]{36})(?:\/(consume|revoke))?)?$/);
          if(!route)throw new HttpError(404,'Unknown API route');
          const scopeFromQuery=()=>{
            const scope:{projectId?:string;sessionId?:string;operation?:string}={};
            for(const dimension of ['projectId','sessionId','operation'] as const){const value=url.searchParams.get(dimension);if(value!==null)scope[dimension]=value;}
            return scope;
          };
          const identifier=z.string().min(1).max(160);
          try{
            // A listing is a discovery aid, not a credential store: the single-use nonce stays in
            // the create response, which is the only response that hands it out.
            if(route[1]===undefined&&req.method==='GET'){json({approvals:approvals.listPending(scopeFromQuery()).map(({nonce,...approval})=>approval)});return;}
            if(route[1]===undefined&&req.method==='POST'){
              const data=z.strictObject({kind:z.string().min(1).max(80),scope:z.unknown(),target:z.unknown(),expiresAt:z.string().min(1).max(40)}).parse(payload);
              json({approval:approvals.create(data)},201);return;
            }
            if(route[1]!==undefined&&route[2]===undefined&&req.method==='GET'){json({approval:approvals.read(scopeFromQuery(),route[1])});return;}
            if(route[1]!==undefined&&route[2]==='consume'&&req.method==='POST'){
              const data=z.strictObject({scope:z.unknown(),kind:z.string().min(1).max(80),target:z.unknown(),consumedBy:identifier}).parse(payload);
              json(approvals.consume({id:route[1],scope:data.scope,kind:data.kind,target:data.target,consumedBy:data.consumedBy}));return;
            }
            if(route[1]!==undefined&&route[2]==='revoke'&&req.method==='POST'){
              const data=z.strictObject({scope:z.unknown(),revokedBy:identifier,reason:z.string().min(1).max(400).nullable().optional()}).parse(payload);
              json({approval:approvals.revoke({id:route[1],scope:data.scope,revokedBy:data.revokedBy,reason:data.reason??null})});return;
            }
            throw new HttpError(405,'Method not allowed');
          }catch(error){
            if(error instanceof ApprovalError)throw new HttpError(approvalHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // Named sessions: list, read, create, rename, link, unlink and the legacy-conversation
        // migration. Owner-only like every other route, behind the same Host check, with the same
        // origin/CSRF enforcement for writes. The session id a write acts on is the one in the path;
        // the body carries only the fields that change.
        if(path.startsWith('/api/sessions')){
          if(!sessions)throw new HttpError(503,'Sessions are unavailable: no durable control store is open');
          try {
            if(path==='/api/sessions'){
              // The listing is the session overview the owner asked for: the record plus, for each
              // session, the durable agent binding, the lifecycle state it reads at, and the linked
              // work the record already holds. Every field is a read of an existing store; nothing
              // here opens a harness or writes anything.
              if(req.method==='GET'){json({sessions:sessions.list(url.searchParams.get('projectId')).map(record=>sessionOverview(record))});return;}
              if(req.method==='POST'){json({session:await sessions.create(payload)},201);return;}
              throw new HttpError(405,'Method not allowed');
            }
            if(path==='/api/sessions/migrate'){
              if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
              const data=z.strictObject({dryRun:z.boolean().default(false)}).parse(payload);
              json(await migrateLegacyConversations({registry:sessions,legacy,dryRun:data.dryRun}));return;
            }
            const sessionRoute=path.match(/^\/api\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})(?:\/(rename|link|unlink|agent))?$/);
            if(sessionRoute){
              const action=sessionRoute[2];
              if(action===undefined){
                if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
                json({session:sessions.read(url.searchParams.get('projectId'),sessionRoute[1])});return;
              }
              // The per-session agent binding: the one owner action that joins an agent record to a
              // session. A read reports the binding, the authority it puts in force and the live
              // agents to choose from; a write is revision-checked, durable and in the audit trail.
              if(action==='agent'){
                if(!agentStore)throw new HttpError(503,'The agent registry is unavailable: no durable control store is open on this instance');
                const identity=sessionRoute[1];
                if(req.method==='GET'){
                  const projectId=url.searchParams.get('projectId');
                  if(projectId===null)throw new HttpError(422,'projectId is required');
                  const project=catalog.get(projectId);
                  json({projectId:project.id,sessionId:identity,binding:agentStore.binding(projectId,identity),authority:agentStore.authorityForSession({projectId,sessionId:identity}),agents:agentStore.live()});return;
                }
                if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
                const bound=parseBody(z.strictObject({projectId:z.unknown(),revision:z.unknown(),agentId:z.unknown(),actor:z.unknown()}),payload,'The session binding request');
                const project=catalog.get(String(bound.projectId));
                // The running conversation of a project is Pi's reserved root conversation, which the
                // legacy migration adopts as a named session only when its SQLite file already exists at
                // start. A session that exists only as a live conversation is therefore adopted here, so
                // the conversation the owner is looking at is bindable and appears in the session list.
                if(!sessions.has(project.id,identity)&&agents.enabled&&await agents.hasSession(project,identity)){
                  try{await sessions.adopt({projectId:project.id,sessionId:identity,name:legacySessionName(project.name)});}
                  catch(error){if(!(error instanceof SessionError&&error.code==='DUPLICATE_NAME'))throw error;await sessions.adopt({projectId:project.id,sessionId:identity,name:'Conversation '+identity});}
                }
                sessions.read(project.id,identity);
                const binding=agentStore.bindSession({projectId:project.id,sessionId:identity,revision:bound.revision,agentId:bound.agentId,actor:bound.actor});
                json({binding,authority:agentStore.authorityForSession({projectId:project.id,sessionId:identity})});return;
              }
              if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
              const identity=sessionRoute[1];
              if(action==='rename'){
                const data=z.strictObject({projectId:z.unknown(),name:z.unknown(),revision:z.unknown()}).parse(payload);
                json({session:sessions.rename({...data,sessionId:identity})});return;
              }
              const data=z.strictObject({projectId:z.unknown(),link:z.unknown(),revision:z.unknown()}).parse(payload);
              json({session:action==='link'?await sessions.link({...data,sessionId:identity}):sessions.unlink({...data,sessionId:identity})});return;
            }
            // The durable session lifecycle: one read route and the five owner actions. Owner-only
            // like every other route, behind the same Host check, with the same origin/CSRF
            // enforcement for writes. The session a write acts on is the one in the path; the body
            // carries only the revision it read and, for a pause, an optional reason.
            const lifecycleRoute=path.match(/^\/api\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/lifecycle(?:\/(reconnect|resume|retry|stop|pause))?$/);
            if(lifecycleRoute){
              if(!lifecycleService)throw new HttpError(503,'Session lifecycle is unavailable: no durable control store is open');
              const sessionId=lifecycleRoute[1],lifecycleAction=lifecycleRoute[2];
              if(lifecycleAction===undefined){
                if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
                const projectId=url.searchParams.get('projectId');
                if(projectId===null)throw new HttpError(422,'projectId is required');
                sessions.read(projectId,sessionId);
                json({lifecycle:lifecycleService.read(projectId,sessionId)});return;
              }
              if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
              const data=parseBody(z.strictObject({projectId:z.unknown(),revision:z.unknown().optional(),reason:z.unknown().optional()}),payload,'The lifecycle request');
              sessions.read(data.projectId,sessionId);
              const result=await lifecycleService.run(data.projectId,sessionId,lifecycleAction,{revision:data.revision,reason:data.reason});
              json({lifecycle:result.record,dispatched:result.dispatched,cancelled:result.cancelled,unchanged:result.unchanged});return;
            }
            // The queue of pending inputs: one read route and the ten write operations. Owner-only
            // like every other route, behind the same Host check, with the same origin/CSRF
            // enforcement for writes. The session a write acts on is the one in the path and the body
            // carries only what changes; a stale revision is a conflict that writes nothing, and no
            // refusal carries a path or a secret.
            const queueRoute=path.match(/^\/api\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/queue(?:\/(append|edit|reorder|remove|clear|cancel|claim|release|submit|reconcile))?$/);
            if(queueRoute){
              if(!queueStore||!sessions)throw new HttpError(503,'The queue is unavailable: no durable control store is open');
              const sessionId=queueRoute[1],queueOperation=queueRoute[2];
              if(queueOperation===undefined){
                if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
                const projectId=url.searchParams.get('projectId');
                if(projectId===null)throw new HttpError(422,'projectId is required');
                sessions.read(projectId,sessionId);
                json(queueView(queueStore.read(projectId,sessionId)));return;
              }
              if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
              const queueBody=parseBody(QUEUE_BODY_SCHEMAS[queueOperation],payload,'The queue request') as Record<string,unknown>;
              const projectId=queueBody.projectId as string;
              sessions.read(projectId,sessionId);
              const queueScope={projectId,sessionId};
              // A fork's child transcript is a forked conversation of its own, and this project's queue
              // dispatcher submits into the project's root conversation. A child's queued input would
              // therefore reach the wrong transcript entirely, so claiming or submitting one is refused
              // rather than silently misdirected; a fork's own guarded dispatch is the path for a child.
              if((queueOperation==='claim'||queueOperation==='submit')&&forks!==undefined&&forks.read(projectId,sessionId)!==null)
                throw new HttpError(409,'Session '+sessionId+' is the child of a fork: this project\'s queue dispatches into the project\'s own root conversation, so a child\'s queued input is refused rather than submitted to the wrong transcript. Resume the fork and dispatch into the child through the fork itself.','fork-child');
              let queueResult:QueueResult;
              if(queueOperation==='append')queueResult=await queueStore.append({...queueScope,revision:queueBody.revision,text:queueBody.text,images:queueBody.images===undefined?undefined:await queueImages.resolve(queueImageIds(queueBody.images))});
              else if(queueOperation==='edit')queueResult=await queueStore.edit({...queueScope,revision:queueBody.revision,entryId:queueBody.entryId,text:queueBody.text});
              else if(queueOperation==='reorder')queueResult=await queueStore.reorder({...queueScope,revision:queueBody.revision,entryId:queueBody.entryId,position:queueBody.position});
              else if(queueOperation==='remove')queueResult=await queueStore.remove({...queueScope,revision:queueBody.revision,entryId:queueBody.entryId});
              else if(queueOperation==='clear')queueResult=await queueStore.clear({...queueScope,revision:queueBody.revision});
              else if(queueOperation==='cancel')queueResult=await queueStore.cancel({...queueScope,revision:queueBody.revision,entryId:queueBody.entryId});
              else if(queueOperation==='claim')queueResult=await queueStore.claim({...queueScope,owner:queueBody.owner});
              else if(queueOperation==='release')queueResult=await queueStore.release({...queueScope,entryId:queueBody.entryId,owner:queueBody.owner});
              else if(queueOperation==='submit')queueResult=await queueStore.submit({...queueScope,entryId:queueBody.entryId,owner:queueBody.owner});
              else queueResult=await queueStore.reconcile({...queueScope,entryId:queueBody.entryId});
              json({queue:queueResult.record,entry:queueResult.entry,outcome:queueResult.outcome,changed:queueResult.changed,removed:queueResult.removed});return;
            }
            throw new HttpError(404,'Unknown API route');
          } catch(error) {
            if(error instanceof SessionError)throw new HttpError(sessionHttpStatus(error.code),error.message);
            if(error instanceof SessionLifecycleError)throw new HttpError(lifecycleHttpStatus(error.code),error.message);
            if(error instanceof QueueError)throw new HttpError(queueHttpStatus(error.code),error.message);
            if(error instanceof AgentError)throw new HttpError(agentHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The command registry, the live projection and action execution: owner-only like every other
        // route, behind the same Host check, with the same origin/CSRF enforcement for the write. The
        // registry answers only what this instance can really do, executing validates the parameters
        // against the very schema the registry published, enforces the declared scope, and returns the
        // handler's own result or its own refusal. No action here commits, pushes, deploys, spends,
        // provisions or publishes.
        if(path==='/api/actions'||path==='/api/actions/activity'||path==='/api/actions/execute'){
          const scopeFromQuery=()=>{
            const scope:{projectId?:string;sessionId?:string}={};
            for(const dimension of ['projectId','sessionId'] as const){const value=url.searchParams.get(dimension);if(value!==null)scope[dimension]=value;}
            return scope;
          };
          const actionStatus=(code:ActionError['code'])=>code==='UNKNOWN'?404:code==='UNAVAILABLE'?503:code==='SCOPE'?403:422;
          try{
            if(path==='/api/actions'&&req.method==='GET'){json(actions.list(normaliseActionScope(scopeFromQuery())));return;}
            if(path==='/api/actions/activity'&&req.method==='GET'){
              // The order is the one every other project route uses: an invalid request first, then an
              // instance that cannot answer at all, then a project this instance does not know.
              // Only the validated identifier reaches the projection: normaliseActionScope refuses a
              // value that is not an identifier, and there is no fallback to the raw query parameter.
              const exact=normaliseActionScope({projectId:url.searchParams.get('projectId')});
              if(exact.projectId===undefined)throw new HttpError(422,'projectId is required');
              if(!actionEnvironment.control)throw new HttpError(503,'The live projection needs the durable control store, which is not open on this instance');
              catalog.get(exact.projectId);
              json(await liveActivity(actionEnvironment,{projectId:exact.projectId}));return;
            }
            if(path==='/api/actions/execute'&&req.method==='POST'){
              const envelope=parseBody(z.strictObject({id:z.unknown(),params:z.unknown().optional(),scope:z.unknown().optional()}),payload,'The action request');
              const descriptor=actions.describe(envelope.id);
              const availability=actions.availability(descriptor);
              if(!availability.available)throw new ActionError('Action '+descriptor.id+' is unavailable on this instance: '+availability.reason,'UNAVAILABLE');
              const scope=normaliseActionScope(envelope.scope);
              actions.assertScope(descriptor,scope);
              json({action:descriptor.id,result:await actions.run(descriptor.id,envelope.params??{},scope)});return;
            }
            throw new HttpError(405,'Method not allowed');
          }catch(error){
            // The registry's own refusals, then the handler's: a session, lifecycle or approval refusal
            // keeps the status it has everywhere else, so one refusal reads the same on every surface.
            if(error instanceof ActionError)throw new HttpError(actionStatus(error.code),error.message,error.code);
            if(error instanceof SessionError)throw new HttpError(sessionHttpStatus(error.code),error.message);
            if(error instanceof SessionLifecycleError)throw new HttpError(lifecycleHttpStatus(error.code),error.message);
            if(error instanceof ApprovalError)throw new HttpError(approvalHttpStatus(error.code),error.message);
            if(error instanceof AcceptanceError)throw new HttpError(acceptanceHttpStatus(error.code),error.message);
            if(error instanceof QueueError)throw new HttpError(queueHttpStatus(error.code),error.message);
            if(error instanceof AgentError)throw new HttpError(agentHttpStatus(error.code),error.message);
            if(error instanceof FileEditError)throw new HttpError(fileEditHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The bounded coding runner: one read route, one submission and the three lifecycle
        // operations. Owner-only like every other route, behind the same Host check, with the same
        // origin/CSRF enforcement for writes. While the runner is disabled these routes refuse with a
        // named reason — and while it is disabled its actions are absent from the registry, rather than
        // listed and failing.
        const runnerJobs=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/runner\/jobs$/);
        const runnerClaim=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/runner\/jobs\/claim$/);
        const runnerJob=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/runner\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/(run|settle)$/);
        if(runnerJobs||runnerClaim||runnerJob){
          if(!runner)throw new HttpError(503,'The coding runner is disabled on this instance: set DASHBOARD_RUNNER=on and point DASHBOARD_RUNNER_IMAGE at the image built from deploy/runner/Dockerfile before any job can be submitted');
          const projectId=(runnerJobs??runnerClaim??runnerJob)![1];
          catalog.get(projectId);
          try{
            if(runnerJobs&&req.method==='GET'){json(runner.read(projectId));return;}
            if(runnerJobs&&req.method==='POST'){
              const body=parseBody(z.strictObject({recipe:z.unknown(),workspace:z.unknown(),limits:z.unknown().optional()}),payload,'The coding job request');
              json({job:await runner.submit({projectId,recipe:body.recipe,workspace:body.workspace,limits:body.limits})},201);return;
            }
            if(runnerClaim&&req.method==='POST'){
              const body=parseBody(z.strictObject({owner:z.unknown()}),payload,'The coding job claim');
              json({job:await runner.claim({projectId,owner:body.owner})});return;
            }
            if(runnerJob&&req.method==='POST'){
              const jobId=runnerJob[2];
              if(runnerJob[3]==='run'){
                const body=parseBody(z.strictObject({owner:z.unknown()}),payload,'The coding job run');
                json({job:await runner.run({projectId,jobId,owner:body.owner})});return;
              }
              const settled=await runner.settle({projectId,jobId});
              json({job:settled.record,outcome:settled.outcome,changed:settled.changed});return;
            }
            throw new HttpError(405,'Method not allowed');
          }catch(error){
            if(error instanceof RunnerError)throw new HttpError(runnerHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The acceptance record: the policy in force, one project's completion records with their
        // Markdown state and their acceptances, one recorded completion record, one acceptance and one
        // policy change. Owner-only like every other route, behind the unchanged Host check, with the
        // same origin/CSRF enforcement for the three writes. The policy write always acts as the
        // authenticated owner, because only an owner may set it. The acceptance records the actor the
        // body **declares** — beside the request or inside it — and the authenticated owner only when
        // the body declares none; see the accept branch below. The completion record is written to
        // Markdown inside the project the scope names.
        if(path==='/api/acceptance'||path==='/api/acceptance/policy'||path==='/api/acceptance/evidence'||path==='/api/acceptance/accept'){
          if(!acceptance)throw new HttpError(503,'Acceptance is unavailable: no durable control store is open on this instance');
          try{
            const projectScope=()=>{const projectId=url.searchParams.get('projectId');if(projectId===null)throw new HttpError(422,'projectId is required');catalog.get(projectId);return projectId;};
            if(path==='/api/acceptance'){
              if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
              json(await acceptance.readProject({projectId:projectScope()}));return;
            }
            if(path==='/api/acceptance/policy'){
              if(req.method==='GET'){json({policy:acceptance.readPolicy()});return;}
              if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
              const body=parseBody(z.strictObject({revision:z.unknown(),policy:z.unknown()}),payload,'The acceptance policy request');
              json({policy:acceptance.updatePolicy({revision:body.revision,policy:body.policy,actor:ownerActor})});return;
            }
            if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
            if(path==='/api/acceptance/evidence'){
              const body=parseBody(z.strictObject({projectId:z.unknown(),evidence:z.unknown()}),payload,'The completion record request');
              catalog.get(String(body.projectId));
              const recorded=await acceptance.recordEvidence({projectId:body.projectId,evidence:body.evidence});
              json({evidence:recorded.evidence,written:recorded.written},201);return;
            }
            // The accepting identity is **declared**, never assumed. A caller may declare it beside the
            // request (this route's own documented form) or inside it (the shape the registry publishes
            // and the palette sends); both are honoured, and a body that carries both and disagrees is
            // refused as an invalid request rather than silently overriding one of them. Only a body
            // that declares no actor at all is recorded as the authenticated owner.
            const body=parseBody(z.strictObject({projectId:z.unknown(),request:z.unknown(),actor:z.unknown().optional()}),payload,'The acceptance request');
            catalog.get(String(body.projectId));
            const plain=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
            const requestBody=plain(body.request);
            const declared=requestBody===null?undefined:requestBody.actor;
            let accepting:unknown;
            if(declared!==undefined&&body.actor!==undefined){
              const inside=parseAcceptanceActor(declared,'the actor declared inside the request');
              const beside=parseAcceptanceActor(body.actor,'the actor declared beside the request');
              if(inside.kind!==beside.kind||inside.identity!==beside.identity)
                throw new HttpError(422,'Which identity is accepting is ambiguous: this body declares '+inside.kind+' `'+inside.identity+'` inside the request and '+beside.kind+' `'+beside.identity+'` beside it. Send one of them, or the same value in both.');
              accepting=inside;
            } else if(declared!==undefined)accepting=declared;
            else if(body.actor!==undefined)accepting=body.actor;
            else accepting=ownerActor;
            const request=requestBody===null?body.request:{...requestBody,actor:accepting};
            json(await acceptance.accept({projectId:body.projectId,request}));return;
          }catch(error){
            if(error instanceof AcceptanceError)throw new HttpError(acceptanceHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The forks of one project: one read route and the three writes. Owner-only like every other
        // route, behind the unchanged Host check, with the same origin/CSRF enforcement for the writes.
        // The fork a write acts on is the one in the path — its child session, which *is* the fork's
        // identity — so a caller addresses a fork and never a path: the worktree it removes is the one
        // the durable record carries, re-checked against the designated fork root by the store itself.
        // While this instance has no fork capability (the agent harness is off) these routes refuse
        // with a named reason rather than pretending, exactly as the runner's do.
        const forkList=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/forks$/);
        const forkAction=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/forks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/(resume|discard)$/);
        if(forkList||forkAction){
          if(!forks)throw new HttpError(503,'The fork capability needs the agent harness, which is not enabled on this instance: enable agents before a fork is created, resumed or discarded');
          const projectId=(forkList??forkAction)![1];
          catalog.get(projectId);
          try{
            if(forkList&&req.method==='GET'){json(forks.view(projectId));return;}
            if(forkList&&req.method==='POST'){
              const body=parseBody(z.strictObject({parentSessionId:z.unknown(),baseCommit:z.unknown(),cutoffEntryId:z.unknown(),target:z.unknown().optional()}),payload,'The fork request');
              const created=await forks.create({projectId,parentSessionId:body.parentSessionId,baseCommit:body.baseCommit,cutoffEntryId:body.cutoffEntryId,target:body.target});
              json({fork:created.fork,created:created.created,adopted:created.adopted},created.created?201:200);return;
            }
            if(forkAction&&req.method==='POST'){
              const childSessionId=forkAction[2];
              if(forkAction[3]==='resume'){
                const body=parseBody(z.strictObject({revision:z.unknown()}),payload,'The fork resume request');
                const resumed=await forks.resume({projectId,childSessionId,revision:body.revision});
                json({fork:resumed.fork,outcome:resumed.outcome});return;
              }
              const body=parseBody(z.strictObject({revision:z.unknown(),force:z.unknown().optional()}),payload,'The fork discard request');
              const discarded=await forks.discard({projectId,childSessionId,revision:body.revision,force:body.force});
              json({fork:discarded.fork,outcome:discarded.outcome,removed:discarded.removed});return;
            }
            throw new HttpError(405,'Method not allowed');
          }catch(error){
            if(error instanceof ForkError)throw new HttpError(forkHttpStatus(error.code),error.message);
            if(error instanceof SessionError)throw new HttpError(sessionHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The agent registry: the list, one record with its durable audit trail, one creation, one
        // change and one archive. Owner-only like every other route, behind the unchanged Host check,
        // with the same origin/CSRF enforcement for writes. Governance is enforced by the store, not
        // by this route or by the interface: the owner may change any scope, and an agent may not
        // create an agent, edit its own record or widen another agent beyond the scopes it holds.
        if(path==='/api/agents'||path.startsWith('/api/agents/')){
          if(!agentStore)throw new HttpError(503,'The agent registry is unavailable: no durable control store is open on this instance');
          try{
            if(path==='/api/agents'){
              if(req.method==='GET'){json({agents:agentStore.list(),scopes:agentScopeVocabulary(),models:agentStore.offeredModels(),fileEdit:{enabled:fileEdit!==undefined&&fileEdit.enabled,mode:fileEdit===undefined||!fileEdit.enabled?null:await fileEdit.mode()}});return;}
              if(req.method==='POST'){
                const body=parseBody(z.strictObject({draft:z.unknown(),actor:z.unknown()}),payload,'The agent request');
                json({agent:agentStore.create({draft:body.draft,actor:body.actor})},201);return;
              }
              throw new HttpError(405,'Method not allowed');
            }
            const agentRoute=path.match(/^\/api\/agents\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})(?:\/(update|archive))?$/);
            if(!agentRoute)throw new HttpError(404,'Unknown API route');
            const agentId=agentRoute[1];
            if(agentRoute[2]===undefined){
              if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
              json({agent:agentStore.read(agentId),history:agentStore.history(agentId)});return;
            }
            if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
            if(agentRoute[2]==='update'){
              const body=parseBody(z.strictObject({revision:z.unknown(),patch:z.unknown(),actor:z.unknown()}),payload,'The agent change request');
              json({agent:agentStore.update({agentId,revision:body.revision,patch:body.patch,actor:body.actor})});return;
            }
            const body=parseBody(z.strictObject({revision:z.unknown(),actor:z.unknown()}),payload,'The agent archive request');
            json({agent:agentStore.archive({agentId,revision:body.revision,actor:body.actor})});return;
          }catch(error){
            if(error instanceof AgentError)throw new HttpError(agentHttpStatus(error.code),error.message);
            throw error;
          }
        }
        // The bounded file-edit capability: one read of the recorded changes and one propose-or-apply
        // write, contained to the project's connected repository worktree. Owner-only like every other
        // route, behind the unchanged Host check, with the same origin/CSRF enforcement for the write.
        // While the capability is disabled this route refuses with a named reason, and while it is
        // disabled its actions are absent from the registry rather than listed and failing.
        const fileEditRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/file-edits$/);
        if(fileEditRoute){
          if(!fileEdit)throw new HttpError(503,'The bounded file-edit capability is disabled on this instance: set DASHBOARD_FILE_EDIT=on before a file is proposed or written');
          catalog.get(fileEditRoute[1]);
          try{
            if(req.method==='GET'){json(await fileEdit.view(fileEditRoute[1]));return;}
            if(req.method!=='POST')throw new HttpError(405,'Method not allowed');
            const body=parseBody(z.strictObject({request:z.unknown(),actor:z.unknown()}),payload,'The file-edit request');
            const request=body.request as {agentId?:unknown;path?:unknown;content?:unknown;mode?:unknown};
            const actor=body.actor as {kind:'owner'|'agent';identity:string};
            const outcome=await fileEdit.edit({
              projectId:fileEditRoute[1],
              agentId:(request.agentId??null) as string|null,
              path:request.path as string,
              content:request.content as string,
              mode:(request.mode??null) as FileEditMode|null,
              actor
            });
            json({edit:outcome.record,written:outcome.written},201);return;
          }catch(error){
            if(error instanceof FileEditError)throw new HttpError(fileEditHttpStatus(error.code),error.message);
            throw error;
          }
        }
        if(path==='/api/browse' && req.method==='GET'){json(await browse(url.searchParams.get('path')??options.browseRoots[0]??'',options.browseRoots));return;}
        if(path==='/api/preview' && req.method==='POST'){json(await catalog.preview(payload.path));return;}
        if(path==='/api/suggestions' && req.method==='GET'){
          if(!options.registry){json([]);return;}
          const r=JSON.parse(await readFile(options.registry,'utf8'));json([...(r.repos??[]),...(r.nestedRepos??[]),...(r.localOnly??[])].map(p=>({name:p.name,path:p.path,remote:p.remote??''})));return;
        }
        if(path==='/api/projects'){
          if(req.method==='GET'){json(await catalog.list());return;}
          if(req.method==='POST'){json(await catalog.register(payload),201);return;}
        }
        const agentsRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/agents(?:\/(stream|input|abort|answer|dismiss|model|media))?$/);
        if(agentsRoute){
          const p=catalog.get(agentsRoute[1]);
          if(!agents.enabled){
            if(agentsRoute[2]===undefined&&req.method==='GET'){json({enabled:false,view:null});return;}
            throw new HttpError(503,'Agents are disabled on this instance');
          }
          if(agentsRoute[2]===undefined&&req.method==='GET'){const viewSessionId=url.searchParams.get('sessionId');const viewResult=viewSessionId?(await agents.sessionView(p,viewSessionId))??{conversationId:viewSessionId,entries:[],questions:[],inbox:[],working:false,usage:{input:0,output:0}}:await agents.view(p);json({enabled:true,view:viewResult,delivery:await agents.deliveryView(p)});return;}
          if(agentsRoute[2]==='model'&&req.method==='POST'){const c=z.strictObject({model:z.strictObject({provider:z.string().min(1).max(100),modelId:z.string().min(1).max(200)}).nullable()}).parse(payload);json(await agents.setModel(p,c.model));return;}
          if(agentsRoute[2]==='media'&&req.method==='POST'){
            // Admission. An image is refused before anything is stored when the session's selected
            // model does not accept image input, so no bytes are kept for a model that would ignore them.
            const data=z.strictObject({data:z.string().min(1).max(8*1024*1024),name:z.string().max(200).optional(),declaredType:z.string().max(100).optional()}).parse(payload);
            const vision=await agents.vision(p);
            if(!vision.acceptsImages)throw new HttpError(422,'The model '+vision.provider+' / '+vision.modelId+' does not accept image input, so this image was refused. Choose a model that accepts images, then try again.','vision');
            // The declared name and type are deliberately ignored: the bytes decide what this is.
            // A data root whose media container is a symlink, is not a directory, or cannot be written is
            // a named refusal with its own code and reason, never an unclassified failure. The container
            // is checked before any byte is decoded, so nothing is stored for it either.
            const accepted=await media.accept(Buffer.from(data.data,'base64')).catch((error:unknown)=>{
              if(error instanceof MediaContainerError)throw new HttpError(503,error.message,MEDIA_CONTAINER_CODE);
              throw error;
            });
            if(!accepted.ok)throw new HttpError(422,accepted.reason,accepted.code);
            const {ok:stored,...view}=accepted;void stored;
            json({media:view},201);return;
          }
          if(agentsRoute[2]==='input'&&req.method==='POST'){
            // A message carries text, images, or both. An attached image is resolved to its stored
            // bytes here; the dispatch-time vision check inside the harness re-checks the model that
            // will actually run, and refuses the whole submission rather than dropping the image.
            const data=z.strictObject({
              text:z.string().max(8000).optional(),
              mode:z.enum(['followUp','steer','reject']).default('followUp'),
              requestId:z.string().min(1).max(200).optional(),
              images:z.array(z.string().regex(MEDIA_ID_PATTERN)).optional()
            }).superRefine((value,context)=>{
              if((value.text??'').trim()===''&&!(value.images??[]).length)context.addIssue({code:'custom',message:'a message needs text or an image'});
            }).parse(payload);
            // The per-message count is a domain refusal with its own reason and code, like every other
            // media refusal: it is refused before any id is resolved, so nothing is looked up for it.
            const attached=data.images??[];
            if(attached.length>MAX_IMAGES_PER_MESSAGE)
              throw new HttpError(422,tooManyImagesReason(attached.length),TOO_MANY_IMAGES_CODE);
            const images:AgentImage[]=[];
            for(const id of attached){
              const image=await media.get(id);
              if(!image)throw new HttpError(422,'An attached image is not in the media store. Remove it and send again.','unknown-media');
              images.push({mimeType:image.mimeType,data:Buffer.from(image.bytes).toString('base64')});
            }
            json(await agents.submit(p,{text:data.text??'',mode:data.mode,requestId:data.requestId,images}));return;
          }
          if(agentsRoute[2]==='answer'&&req.method==='POST'){
            const data=z.strictObject({questionId:z.string().min(1).max(100),text:z.string().min(1).max(4000)}).parse(payload);
            json(await agents.answer(p,data));return;
          }
          if(agentsRoute[2]==='dismiss'&&req.method==='POST'){
            // A dismissal is deliberately distinct from an answer: it carries a reason, is recorded as
            // its own durable transcript entry (who, when, why), and tells the agent the question was
            // dismissed rather than silently ignored.
            const data=z.strictObject({questionId:z.string().min(1).max(100),reason:z.string().min(1).max(400)}).parse(payload);
            json(await agents.dismissQuestion(p,{...data,dismissedBy:subject||'owner'}));return;
          }
          if(agentsRoute[2]==='abort'&&req.method==='POST'){await agents.abort(p);json({ok:true});return;}
          if(agentsRoute[2]==='stream'&&req.method==='GET'){
            res.statusCode=200;res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-store');res.setHeader('Connection','keep-alive');
            res.write('retry: 3000\n\n');
            // Accept optional sessionId so the owner can switch between per-session transcripts.
            const streamSessionId=url.searchParams.get('sessionId')||undefined;
            let closed=false,dispose:()=>Promise<void>=async()=>{};
            try{
              dispose=await agents.subscribe(p,view=>{if(!closed)res.write('data: '+JSON.stringify(view)+'\n\n');},streamSessionId);
            }catch(e){
              res.write('event: error\ndata: '+JSON.stringify({error:(e as Error).message})+'\n\n');res.end();return;
            }
            const keepAlive=setInterval(()=>{if(!closed)res.write(': keep-alive\n\n');},20000);
            req.on('close',()=>{closed=true;clearInterval(keepAlive);void dispose();});
            return;
          }
        }
        const docsRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/docs(?:\/(document|search|asset|inbox))?$/);
        if(docsRoute){
          const p=catalog.get(docsRoute[1]);
          if(!docsRoute[2]&&req.method==='GET'){json({documents:await docs.list(p)});return;}
          if(docsRoute[2]==='document'&&req.method==='GET'){
            const target=url.searchParams.get('path');if(!target)throw new HttpError(400,'Document path is required');
            json(await docs.read(p,target));return;
          }
          if(docsRoute[2]==='search'&&req.method==='GET'){json({matches:await docs.search(p,url.searchParams.get('q')??'')});return;}
          if(docsRoute[2]==='inbox'&&req.method==='GET'){json({questions:await docs.inbox(p)});return;}
          if(docsRoute[2]==='asset'&&req.method==='GET'){
            const target=url.searchParams.get('path');if(!target)throw new HttpError(400,'Asset path is required');
            const asset=await docs.asset(p,target);
            res.statusCode=200;res.setHeader('Content-Type',asset.type);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
            if(asset.sandboxed)res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
            res.end(asset.bytes);return;
          }
          if(docsRoute[2]==='document'&&req.method==='POST'){
            const data=z.strictObject({path:z.string().min(1).max(1000),text:z.string().max(2*1024*1024),revision:z.string().min(1).max(200).optional()}).parse(payload);
            const saved=data.revision===undefined?await docs.create(p,data.path,data.text):await docs.write(p,data.path,data.revision,data.text);
            json(saved,data.revision===undefined?201:200);return;
          }
        }
        const importRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/import\/(preview|apply)$/);
        if(importRoute&&req.method==='POST'){
          const p=catalog.get(importRoute[1]);
          if(importRoute[2]==='preview'){
            const documents=documentsSchema.parse(payload.documents),current=await boards.read(p),preview=previewImport(current.board,documents),token=randomUUID();
            for(const [id,item] of previews)if(item.expires<Date.now())previews.delete(id);
            if(previews.size>=5)throw new HttpError(429,'Too many pending imports');
            previews.set(token,{projectId:p.id,revision:current.revision,preview,documents,expires:Date.now()+900000});json({preview,token});return;
          }
          const data=z.strictObject({token:z.string().uuid(),selected:z.array(z.string()).max(5000),edgeIds:z.array(z.string().uuid()).max(20000)}).parse(payload),pending=previews.get(data.token);
          if(!pending||pending.projectId!==p.id||pending.expires<Date.now())throw new HttpError(409,'Import preview expired; preview again');
          const current=await boards.read(p);if(current.revision!==pending.revision)throw new HttpError(409,'Board changed since preview');
          const board=applyImport(current.board,pending.preview,data.selected,data.edgeIds);
          for(const candidate of pending.preview.candidates.filter(c=>data.selected.includes(c.id))){
            const doc=pending.documents.find(d=>d.name===candidate.documentName)!;
            const file=await safePath(p.path,candidate.source.path,true);await atomicWrite(file,doc.content);
          }
          const result=await boards.mutate(p,current.revision,{op:'restore',board});previews.delete(data.token);json(result);return;
        }
        const sourceRoute=path.match(/^\/api\/projects\/([a-f0-9-]{36})\/sources\/([a-f0-9-]{36})$/);
        if(sourceRoute&&req.method==='GET'){
          const p=catalog.get(sourceRoute[1]),board=await boards.read(p),source=board.board.sources.find(s=>s.id===sourceRoute[2]);
          if(!source)throw new HttpError(404,'Source not registered');
          json({text:await readFile(await safePath(p.path,source.path),'utf8'),source});return;
        }
        const match=path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(board|initialize|export|relocate))?$/);
        if(match){
          const p=catalog.get(match[1]),action=match[2];
          if(!action&&req.method==='DELETE'){await catalog.remove(p.id);json({ok:true});return;}
          if(action==='relocate'&&req.method==='POST'){await catalog.relocate(p.id,payload.path);json(catalog.get(p.id));return;}
          if(action==='initialize'&&req.method==='POST'){if(payload.confirm!==true)throw Error('Confirmation required');json(await boards.initialize(p,serializeBoard(emptyBoard())));return;}
          if(action==='export'&&req.method==='GET'){res.setHeader('Content-Type','text/markdown; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="board.md"');res.end(await boards.raw(p));return;}
          if(action==='board'&&req.method==='GET'){json(await boards.read(p));return;}
          if(action==='board'&&req.method==='POST'){json(await boards.mutate(p,payload.revision,payload.operation));return;}
        }
        throw new HttpError(404,'Unknown API route');
      }
      if(req.method!=='GET')throw new HttpError(405,'Method not allowed');
      if(options.security.mode==='hosted')await authorize(req,options.security);
      if(!options.clientRoot)throw new HttpError(404,'Client not built');
      const relative=decodeURIComponent(path==='/'?'/index.html':path),file=resolve(options.clientRoot,'.'+relative);
      if(!within(options.clientRoot,file))throw new HttpError(403,'Unsafe asset path');
      let data=await readFile(file);
      if(file.endsWith('index.html')&&options.security.mode==='local')data=Buffer.from(data.toString().replace('</head>','<meta name="dashboard-token" content="'+options.security.token+'"></head>'));
      const type:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
      res.setHeader('Content-Type',type[extname(file)]??'application/octet-stream');res.end(data);
    }catch(e){
      const err=e as Error;const code=e instanceof HttpError?e.status:(e as NodeJS.ErrnoException).code==='ENOENT'?404:400;
      console.error(req.method+' '+logged+' -> '+code+' '+err.message);
      res.statusCode=code;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:err.message,...(e instanceof HttpError&&e.code?{code:e.code}:{})}));
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,catalog,boards,docs,agents,alerts,providers,repositories,sessions,lifecycle,actions,media,queue:queueStore,runner,acceptance,forks,agentStore,fileEdit,close:async()=>{
    // A server that never opened reports ERR_SERVER_NOT_RUNNING, which means "already closed", not
    // "close failed". A failed start (for example a port already in use) must still drain and
    // release the lock that this same start created, and must report the original failure instead.
    // Any other close error stays fatal and remains, with the deadline, the only retention cause.
    await new Promise<void>((ok,fail)=>server.close(error=>{
      if(!error||(error as NodeJS.ErrnoException).code==='ERR_SERVER_NOT_RUNNING')ok();else fail(error);
    }));
    await repositories.close();await boards.drain();await docs.drain();await agents.close();await providers.close();await catalog.close();}};
}
/** A server that cannot drain must not be able to hold the data root forever. */
const DEFAULT_SHUTDOWN_DEADLINE_MS=10_000;
/** An operator knob for how long one drain may take, not an unbounded wait: the lock stays without it. */
const MAX_SHUTDOWN_DEADLINE_MS=60_000;
/** The lock record is durable evidence, so its operator-supplied identity is a bounded opaque token. */
const LOCK_IDENTITY=/^[A-Za-z0-9._:-]{1,120}$/;
const LOCK_IDENTITY_RULE='must be 1-120 characters from A-Za-z0-9._:- because it is recorded in the service lock';
function boundedIdentity(name:string,value:string):string {
  if(!LOCK_IDENTITY.test(value))throw new Error(name+' '+LOCK_IDENTITY_RULE);
  return value;
}
/** Validated before the data root is touched: an invalid deadline must not create or lock anything. */
function shutdownDeadlineMs(env:NodeJS.ProcessEnv):number {
  const text=env.DASHBOARD_SHUTDOWN_DEADLINE_MS;
  if(text===undefined)return DEFAULT_SHUTDOWN_DEADLINE_MS;
  if(!/^[0-9]+$/.test(text))throw new Error('DASHBOARD_SHUTDOWN_DEADLINE_MS must be a positive whole number of milliseconds');
  const value=Number(text);
  if(!Number.isInteger(value)||value<1||value>MAX_SHUTDOWN_DEADLINE_MS)throw new Error('DASHBOARD_SHUTDOWN_DEADLINE_MS must be between 1 and '+MAX_SHUTDOWN_DEADLINE_MS+' milliseconds; the lock is retained when a drain misses it');
  return value;
}
export function lockReleaseId(env:NodeJS.ProcessEnv):string {
  return boundedIdentity('DASHBOARD_RELEASE',env.DASHBOARD_RELEASE??UNRELEASED_LOCAL);
}
function namedLockRootId(env:NodeJS.ProcessEnv):string|undefined {
  const named=env.DASHBOARD_ROOT_ID;
  return named===undefined?undefined:boundedIdentity('DASHBOARD_ROOT_ID',named);
}
/** Logical root identity: the canonical data root path, unless the operator names one. */
function lockRootIdFor(canonicalRoot:string,namedRootId:string|undefined):string {
  return namedRootId??createHash('sha256').update(canonicalRoot).digest('hex').slice(0,16);
}
async function dataRootWritable(root:string):Promise<boolean> {
  try {await access(root,constants.W_OK);return true;} catch {return false;}
}
/**
 * Expected-version readiness, reported without secrets or filesystem paths. It observes only:
 * the release manifest is valid, this process holds the lock, the data root is writable, and the
 * storage schema matches the expected schemaId. Every unmet condition becomes a reason.
 */
async function readinessReport(input:{dataRoot:string;readiness?:ReadinessOptions}){
  const releaseId=input.readiness?.releaseId??UNRELEASED_LOCAL;
  const schemaId=input.readiness?.schemaId??SUPPORTED_SCHEMA_IDS[0];
  const manifestValid=input.readiness?.manifestValid??true;
  const lockHeld=input.readiness?.lockHeld?.()??false;
  const reasons:string[]=[];
  // The stores are open by the time a request is served; a request cannot arrive otherwise.
  if(!manifestValid)reasons.push('release-manifest-invalid');
  if(!lockHeld)reasons.push('service-lock-not-held');
  const writable=await dataRootWritable(input.dataRoot);
  if(!writable)reasons.push('data-root-not-writable');
  // The live handle is the authority: opening a second connection beside it would report a
  // different, possibly transiently locked, view of the same schema. The promotion report is read
  // from the durable chain alone, so it never opens a second connection and never waits on a lock.
  const schema=input.readiness?.observeSchema?input.readiness.observeSchema():observeStorageSchema(input.dataRoot);
  const expected=schemaVersionForId(schemaId);
  if(schema.state==='absent')reasons.push('storage-schema-absent');
  else if(schema.state==='busy')reasons.push('storage-schema-busy');
  else if(schema.state==='malformed')reasons.push('storage-schema-unreadable');
  else if(expected===undefined||schema.version!==expected)reasons.push('storage-schema-mismatch');
  // A release identity that is not the candidate the store says is promoted is a reason too, never a
  // silent difference: an unpromoted instance (a fresh or local root) reports no such reason.
  const releaseMatch=input.readiness?.releaseMatch?.();
  if(releaseMatch?.state==='mismatch')reasons.push('release-identity-mismatch');
  else if(releaseMatch?.state==='unreadable')reasons.push('release-promotion-unreadable');
  return {ok:reasons.length===0,releaseId,schemaId,lockHeld,dataRootWritable:writable,reasons};
}
/** Bounded, read-only TCP probe: does anything appear to be listening on the configured endpoint. */
function probeServer(bindHost:string,port:number):Promise<'listening'|'not-listening'|'unknown'> {
  const host=bindHost==='0.0.0.0'?'127.0.0.1':bindHost;
  return new Promise(done=>{
    const socket=createConnection({host,port});
    let settled=false;
    const finish=(result:'listening'|'not-listening'|'unknown')=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();done(result);};
    const timer=setTimeout(()=>finish('unknown'),1500);
    socket.once('connect',()=>finish('listening'));
    socket.once('error',(error)=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'?'not-listening':'unknown'));
  });
}
/** Conditions that block the next start even though the doctor itself changes nothing. */
export type StartBlocker='restore-not-promoted'|'service-lock-active'|'service-lock-proven-dead'|'service-lock-present'|'port-in-use';
/** The marker a restore writes into a restored root (scripts/data-tools.mjs). Startup never clears it. */
const RESTORE_PAUSE_MARKER='RESTORE-PAUSED.json';
const RESTORE_PAUSE_FORMAT='pilot-restore-pause';
const RESTORE_PAUSE_MARKER_MAX_BYTES=4096;
/**
 * Read-only: does this data root carry the restore pause marker, and if so why must it not be served?
 *
 * The marker's presence is the signal and its contents are only context, so an unreadable or malformed
 * marker still refuses the start: a restored root is never served until an operator promotes it with
 * 'node scripts/data-tools.mjs promote <data root>'. Nothing here removes, renames or rewrites the
 * marker; promotion is a deliberate operator action.
 */
export async function restorePauseRefusal(dataRoot:string):Promise<string|null>{
 const path=join(dataRoot,RESTORE_PAUSE_MARKER);
 let info;
 try {info=await lstat(path);}
 catch(error) {
  if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
  return 'the restore pause marker '+path+' cannot be inspected ('+(error as Error).message+'), so this root cannot be served as restored data.';
 }
 let detail='';
 try {
  if(info.isFile()&&!info.isSymbolicLink()&&info.size<=RESTORE_PAUSE_MARKER_MAX_BYTES){
   const marker=JSON.parse(await readFile(path,'utf8')) as {format?:unknown;created?:unknown};
   if(marker.format===RESTORE_PAUSE_FORMAT&&typeof marker.created==='string')
    detail=' It was written at '+marker.created+' by the restore that produced this root.';
  }
 } catch { /* an unreadable marker is still a marker: its presence is what refuses the start */ }
 return path+' marks '+dataRoot+' as a restored backup that has not been promoted, so nothing is served from it.'+detail
  +' Review the restored data deliberately, then promote it and start again: node scripts/data-tools.mjs promote '+dataRoot
  +'. Startup never promotes a restored root by itself.';
}
/**
 * The start blockers implied by the observations. Any existing lock blocks the next acquisition,
 * so a well-formed record for this root is a blocker even when the recorded process cannot be
 * classified; a listening port blocks the next bind.
 */
export function doctorStartBlockers(input:{readonly lockClassification:string;readonly lockNamedForRoot:boolean;readonly probe:'listening'|'not-listening'|'unknown';readonly restorePaused?:boolean}):StartBlocker[]{
  const blockers:StartBlocker[]=[];
  if(input.restorePaused)blockers.push('restore-not-promoted');
  if(input.lockClassification==='active')blockers.push('service-lock-active');
  else if(input.lockClassification==='proven-dead')blockers.push('service-lock-proven-dead');
  else if(input.lockNamedForRoot)blockers.push('service-lock-present');
  if(input.probe==='listening')blockers.push('port-in-use');
  return blockers;
}
/**
 * The start blockers for one data root, for the release tool's read-only 'status'. It reuses the
 * same observations and the same doctorStartBlockers mapping the doctor uses, so the command an
 * operator uses to decide names exactly the conditions that would make the next start fail closed:
 * an existing service lock (any classification but absent), a restored root's pause marker, and an
 * endpoint something already accepts connections on. It reads only: it creates nothing, removes
 * nothing and takes no lock.
 */
export async function dataRootStartBlockers(dataRoot:string,env:NodeJS.ProcessEnv=process.env):Promise<StartBlocker[]>{
  let canonical:string|null=null,lockNamedForRoot=false,restorePaused=false,lockClassification='absent';
  try {
    const info=await lstat(dataRoot);
    if(!info.isSymbolicLink()&&info.isDirectory())canonical=await realpath(dataRoot);
  } catch { /* an absent or unreadable root can carry neither a lock nor a pause marker */ }
  if(canonical!==null){
    const lock=await inspectServiceLock(canonical);
    lockClassification=lock.classification;
    lockNamedForRoot=lock.metadata!==undefined&&lock.metadata.root===canonical;
    restorePaused=(await restorePauseRefusal(canonical))!==null;
  }
  let probe:'listening'|'not-listening'|'unknown'='unknown';
  try {const config=effectiveConfig(env);probe=await probeServer(config.bindHost,config.port);}
  catch { /* an invalid configuration is diagnosed by the doctor, not by the release tool */ }
  return doctorStartBlockers({lockClassification,lockNamedForRoot,probe,restorePaused});
}
/**
 * Read-only diagnostics, as data. It acquires no lock, creates, deletes or rewrites nothing and
 * starts no server. Exit 0 means neither an unsafe condition nor a start blocker was found: a
 * malformed, foreign or untrusted lock, an unsupported or unreadable storage schema, an invalid
 * release manifest (or a missing one in hosted mode), an invalid configuration, an active or
 * proven-dead lock, or an occupied port all exit non-zero.
 *
 * The report is returned rather than printed, so exactly one implementation answers both the CLI
 * (below) and the owner-only `doctor.report` action: a diagnosis cannot differ between them. It
 * names the canonical data root, as the CLI does, because it is owner-visible diagnostics.
 */
export type DoctorObservation={readonly report:Readonly<Record<string,unknown>>;readonly unsafe:boolean};
export async function doctorReport(env:NodeJS.ProcessEnv):Promise<DoctorObservation> {
  const report:Record<string,unknown>={readOnly:true,guarantee:'The doctor reads only: it acquires no lock, creates, deletes or rewrites nothing, and starts no server.'};
  let config:ReturnType<typeof effectiveConfig>;
  try {config=effectiveConfig(env);}
  catch(error){
    report.configuration={error:(error as Error).message};
    return Object.freeze({report:Object.freeze({...report}),unsafe:true});
  }
  report.configuration={mode:config.mode,exposure:config.exposure,bind:config.bindHost,allowedHost:config.allowedHosts[0]};
  let unsafe=false,canonical:string|undefined,lockNamedForRoot=false,restorePaused=false;
  try {
    const info=await lstat(config.dataRoot);
    if(info.isSymbolicLink()){report.dataRoot={state:'symbolic-link',path:config.dataRoot};unsafe=true;}
    else if(!info.isDirectory()){report.dataRoot={state:'not-a-directory',path:config.dataRoot};unsafe=true;}
    else {
      canonical=await realpath(config.dataRoot);
      const loose=(info.mode&0o077)!==0;
      report.dataRoot={path:canonical,permissions:'0'+(info.mode&0o777).toString(8),groupOrOtherAccessible:loose};
      if(loose)unsafe=true;
    }
  } catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    report.dataRoot=code==='ENOENT'?{state:'absent',path:config.dataRoot}:{state:'error',path:config.dataRoot,reason:(error as Error).message};
  }
  // An unresolvable manifest path (a traversal segment in the environment, for example) is a
  // diagnosis, not a crash: the doctor still prints its full report and exits non-zero.
  let releaseInvalid=false,releaseMissingForHosted=false;
  try {
    const release=await loadReleaseManifest(env);
    if(release.status==='present'){
      report.release={status:'present',path:release.path,valid:true,releaseId:release.manifest.releaseId,schemaId:release.manifest.schemaId,version:release.manifest.version,createdAt:release.manifest.createdAt};
    } else if(release.status==='absent'){
      report.release={status:'absent',path:release.path};
      releaseMissingForHosted=config.mode==='hosted';
    } else {
      report.release={status:'invalid',path:release.path,reason:release.reason};
      releaseInvalid=true;
    }
  } catch(error) {
    report.release={status:'invalid',reason:(error as Error).message};
    releaseInvalid=true;
  }
  if(releaseInvalid||releaseMissingForHosted)unsafe=true;
  if(canonical){
    const lock=await inspectServiceLock(canonical);
    report.serviceLock={classification:lock.classification,reason:lock.reason,metadata:lock.metadata??null};
    // A well-formed lock whose process status is merely unknown is reported, not unsafe; a lock we
    // cannot trust (malformed, non-regular, or naming another canonical root) is unsafe.
    if(lock.classification==='ambiguous'&&(lock.metadata===undefined||lock.metadata.root!==canonical))unsafe=true;
    // A private boolean still counts: the metadata view is readonly, so it is only read here.
    lockNamedForRoot=lock.metadata!==undefined&&lock.metadata.root===canonical;
    const schema=observeStorageSchema(canonical);
    const expected=schemaVersionForId(SUPPORTED_SCHEMA_IDS[0]);
    report.storageSchema=schema;
    if(schema.state==='malformed')unsafe=true;
    else if(schema.state==='present'&&(expected===undefined||schema.version!==expected))unsafe=true;
    // A restored root is reported as a start blocker, not as unsafe evidence: the pause is a
    // deliberate state that an operator ends by promoting the root.
    const pause=await restorePauseRefusal(canonical);
    restorePaused=pause!==null;
    report.restorePause=restorePaused?{marker:RESTORE_PAUSE_MARKER,paused:true,detail:pause}:{marker:RESTORE_PAUSE_MARKER,paused:false};
  } else {
    report.serviceLock={classification:'unavailable',reason:'the data root is absent or unreadable, so no lock could be inspected'};
    report.storageSchema={state:'absent'};
    report.restorePause={marker:RESTORE_PAUSE_MARKER,paused:false,reason:'the data root is absent or unreadable'};
  }
  const probe=await probeServer(config.bindHost,config.port);
  report.server={bind:config.bindHost,port:config.port,probe};
  const lockClassification=((report.serviceLock??{}) as {classification?:string}).classification??'unavailable';
  report.startBlockers=doctorStartBlockers({lockClassification,lockNamedForRoot,probe,restorePaused});
  return Object.freeze({report:Object.freeze({...report}),unsafe});
}
/** The CLI form: print the very same observation and set the very same exit code. */
async function runDoctor():Promise<void> {
  const {report,unsafe}=await doctorReport(process.env);
  console.log(JSON.stringify({...report,unsafe},null,2));
  process.exitCode=unsafe||((report.startBlockers as StartBlocker[]|undefined)?.length??0)>0?1:0;
}
/**
 * Open the durable control store, or report why the start must not continue. The store is the
 * authority for readiness as well as for records, so an unopenable or unexpected schema fails
 * closed here instead of serving 503s from an already-degraded process.
 */
function openControlStore(canonicalRoot:string,expectedSchemaVersion:number|undefined,schemaId:string):ControlStore|undefined {
  let store:ControlStore|undefined;
  try {
    store=new ControlStore(canonicalRoot);
    const observed=store.schemaVersion();
    if(expectedSchemaVersion===undefined||observed!==expectedSchemaVersion||observed!==CONTROL_SCHEMA_VERSION)
      throw new Error('the control schema version '+observed+' does not match the expected '+schemaId);
    return store;
  } catch(error) {
    try {store?.close();} catch { /* the open failure is the reportable cause */ }
    console.error('Refusing to start: the control store in the data root could not be opened: '+(error as Error).message+'. Nothing is served and the service lock is released; inspect or restore the control database before starting again.');
    return undefined;
  }
}
/** Resolves on 'listening', rejects on a listen error, so a failed start still drains and releases. */
function listen(app:Awaited<ReturnType<typeof createApp>>,port:number,host:string):Promise<void> {
  return new Promise<void>((ok,fail)=>{
    const listening=()=>{app.server.off('error',onError);ok();};
    const onError=(error:Error)=>{app.server.off('listening',listening);fail(error);};
    app.server.once('listening',listening);app.server.once('error',onError);
    app.server.listen(port,host);
  });
}
function waitForSignal():Promise<NodeJS.Signals> {
  // First signal wins; later signals are ignored while the drain runs.
  let stopping=false;
  return new Promise<NodeJS.Signals>(ok=>{for(const name of ['SIGTERM','SIGINT'] as const)process.on(name,()=>{if(stopping)return;stopping=true;ok(name);});});
}
async function closeWithinDeadline(app:Awaited<ReturnType<typeof createApp>>,deadlineMs:number):Promise<'closed'|'failed'|'timeout'> {
  let timer:NodeJS.Timeout|undefined;
  const expired=new Promise<'timeout'>(ok=>{timer=setTimeout(()=>ok('timeout'),deadlineMs);});
  try {return await Promise.race([app.close().then(()=>'closed' as const,()=>'failed' as const),expired]);}
  finally {if(timer)clearTimeout(timer);}
}
async function main(){
  // Every startup value is validated here, before the data root is touched and before any
  // store opens. Loopback is the default exposure; a container that must bind its own
  // interface says so explicitly, while the published port stays 127.0.0.1 on the host.
  const env=process.env,config=effectiveConfig(env);
  // Resolve the immutable release identity before the data root is touched. Hosted mode refuses a
  // missing or invalid manifest; local mode may run as the explicit 'unreleased-local' identity.
  const release=await resolveRelease(env,config.mode);
  if(release.state==='missing'||release.state==='invalid'){
    console.error('Refusing to start: '+release.reason+'. A hosted Pilot requires an immutable release manifest; set '+RELEASE_MANIFEST_ENV+' or stage '+RELEASE_MANIFEST_FILENAME+' beside the build.');
    process.exitCode=1;return;
  }
  // The remaining startup values are validated here too, before the data root is touched: the
  // lock identity is durable evidence and the shutdown deadline bounds one drain. Invalid values
  // fail closed with a clear message and create nothing.
  const namedRootId=namedLockRootId(env),deadlineMs=shutdownDeadlineMs(env);
  // A manifest's releaseId/schemaId become the lock record's values; the bounded DASHBOARD_RELEASE
  // and 'pilot-state-1' remain the durable identity for the unreleased case. The fallback identity
  // is computed only when no manifest supplied one, so an invalid DASHBOARD_RELEASE cannot abort a
  // start that a valid manifest already identifies.
  const releaseId=release.state==='released'?release.identity.releaseId:lockReleaseId(env);
  const schemaId=release.state==='released'?release.identity.schemaId:SUPPORTED_SCHEMA_IDS[0];
  const expectedSchemaVersion=schemaVersionForId(schemaId);
  // What this build reports about itself: the manifest's own version and identity, or the explicit
  // unreleased identity. The source digest is compared only when a manifest declared one.
  const identityVersion=release.state==='released'?release.identity.version:'0.0.0-unreleased';
  const identityBuildId=release.state==='released'?release.identity.buildId:undefined;
  const identitySourceDigest=release.state==='released'?release.identity.sourceDigest:undefined;
  // Install the stop handlers before the lock is created. A SIGTERM/SIGINT during startup must be
  // captured and drained like a normal stop; with the default disposition a stop that arrives while
  // the data root or the lock is being created — the systemctl --user stop / container stop during
  // boot case — terminates the process before the finally can run and strands service.lock. The
  // promise is created here, not after listen, and awaited below where the stop reason is taken.
  const stopped=waitForSignal();
  await mkdir(config.dataRoot,{recursive:true,mode:0o700});
  const canonicalRoot=await realpath(config.dataRoot),lockPath=join(canonicalRoot,'service.lock');
  // A restored root is paused until an operator promotes it. The check precedes the lock, so a pause
  // leaves no lock evidence behind, opens no store and never reaches a listener: the operator reads one
  // clear message and decides deliberately.
  const pauseRefusal=await restorePauseRefusal(canonicalRoot);
  if(pauseRefusal!==null){console.error('Refusing to start: '+pauseRefusal);process.exitCode=1;return;}
  let lock:ServiceLockHandle;
  let lockHeld=false;
  try {
    lock=await acquireServiceLock({root:canonicalRoot,purpose:'service',rootId:lockRootIdFor(canonicalRoot,namedRootId),releaseId,schemaId});
    lockHeld=true;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    // Fail closed. The lock is evidence: nothing here deletes, renames, truncates or rewrites it.
    console.error('Refusing to start: '+lockPath+' is already locked. No automatic recovery is performed; confirm that no Pilot process is running, then remove that file deliberately as the operator.');
    process.exitCode=1;return;
  }
  let retain=false,control:ControlStore|undefined;
  try {
    // The durable control store is opened here — after the lock, before anything listens — and its
    // handle is kept for the life of the process. A store that cannot be opened, or whose schema is
    // not the one the release names, must not serve: fail closed, release the lock, exit non-zero.
    const store=openControlStore(canonicalRoot,expectedSchemaVersion,schemaId);
    if(!store){process.exitCode=1;return;}
    control=store;
    // The candidate the durable store says is promoted is evidence, so the identity this process was
    // started as must be that release: a build serving a release nobody promoted, or a promotion
    // history that cannot be read, is refused here, before anything listens, and the lock is released.
    const releaseStore=new ReleaseStore(store);
    const manifestIdentity={releaseId,schemaId,...(identitySourceDigest===undefined?{}:{sourceDigest:identitySourceDigest})};
    // The report reads the promotion chain and nothing else: readiness and this report must not open
    // a second connection beside the live store handle, and must not wait on a writer's lock.
    const observeRelease=():ReleasePromotionObservation=>{
      try {
        const status=releaseStore.promotionStatus();
        if(status.target===null)return {state:'not-promoted' as const};
        const match=matchReleaseIdentity(manifestIdentity,status.target);
        if(match.state==='not-promoted')return {state:'not-promoted' as const};
        if(match.state==='match')return {state:'match' as const,revision:status.revision,target:status.target};
        return {state:'mismatch' as const,revision:status.revision,target:status.target,differences:match.differences};
      } catch(error) {return {state:'unreadable' as const,reason:(error as Error).message};}
    };
    const startupRelease=observeRelease();
    if(startupRelease.state==='mismatch'){
      console.error('Refusing to start: this process runs as '+releaseId+' ('+schemaId+') but the control store says the promoted release is '+startupRelease.target.releaseId+' ('+startupRelease.target.schemaId+'), differing in '+startupRelease.differences.map(difference=>difference.field).join(', ')+'. A build must serve the release that was promoted: nothing is served and the service lock is released. Promote this build deliberately, or start the promoted release. See docs/RELEASES.md.');
      process.exitCode=1;return;
    }
    if(startupRelease.state==='unreadable'){
      console.error('Refusing to start: the promotion history in the control store could not be read, so this build cannot prove which release is promoted: '+startupRelease.reason+'. Nothing is served and the service lock is released. See docs/RELEASES.md.');
      process.exitCode=1;return;
    }
    // The delivery ledger lives in the app the store is handed to: createApp owns the reconciliation
    // of rows a crash left behind (below, before anything listens) because it is the layer that also
    // holds the notification channel and the harness.
    // Readiness reports the schema observed from this live handle, never from a second connection.
    const app=await createApp({dataRoot:canonicalRoot,browseRoots:[...config.browseRoots],security:config.security,allowedHosts:[...config.allowedHosts],clientRoot:resolve(fileURLToPath(new URL('./client',import.meta.url))),registry:env.DASHBOARD_REGISTRY,control:store,release:{version:identityVersion,source:release.state==='released'?'manifest':'unreleased-local',...(identityBuildId===undefined?{}:{buildId:identityBuildId}),...(identitySourceDigest===undefined?{}:{sourceDigest:identitySourceDigest}),observe:observeRelease},readiness:{releaseId,schemaId,manifestValid:true,lockHeld:()=>lockHeld,observeSchema:()=>{
      try {return {state:'present' as const,version:store.schemaVersion()};}
      catch(error) {return {state:'malformed' as const,reason:(error as Error).message};}
    }}});
    let reason:NodeJS.Signals|null=null,failure:unknown=null;
    try {
      await listen(app,config.port,config.bindHost);
      console.log('Dashboard listening at '+config.origin+' on '+config.bindHost+':'+config.port);
      reason=await stopped;
    } catch(error) {failure=error;}
    // A failed start still owes us a drained close, so the lock is only released after close.
    const outcome=await closeWithinDeadline(app,deadlineMs);
    if(outcome!=='closed'){
      // The writers may not be closed, so the lock stays: it is the evidence a later start refuses on.
      retain=true;process.exitCode=1;
      // This one diagnostic precedes process.exit(1), so it is written synchronously: on a pipe
      // (systemd journal, docker logs) a pending console.error write can be truncated by the exit.
      const retention=outcome==='timeout'
        ?'Shutdown did not finish within '+deadlineMs+'ms'+(reason?' after '+reason:'')+'; the service lock at '+lockPath+' is intentionally retained and no automatic recovery is performed.'
        :'Shutdown failed'+(reason?' after '+reason:'')+'; the service lock at '+lockPath+' is intentionally retained and no automatic recovery is performed.';
      writeSync(2,retention+'\n');
      process.exit(1);
    }
    if(failure)throw failure;
    process.exitCode=0;
  } finally {
    if(!retain){
      // The store is closed before the lock is released: the lock must outlive every writer, and a
      // close failure is reported rather than hidden behind a successful exit.
      try {control?.close();}
      catch(error){console.error('Could not close the control store: '+(error as Error).message);process.exitCode=1;}
      try {await lock.release();lockHeld=false;}
      catch(error){console.error('Could not release '+lockPath+': '+(error as Error).message);process.exitCode=1;}
    }
  }
}
// Node resolves the entry module through release symlinks; argv retains the launch path.
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href){
  // The one diagnostics flag. It shares the bundle but runs no server and takes no lock.
  if(process.argv.slice(2).includes('--doctor'))runDoctor().catch(e=>{console.error(e.message);process.exitCode=1;});
  else main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
