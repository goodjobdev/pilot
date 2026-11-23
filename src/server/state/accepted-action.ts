import { createHash } from 'node:crypto';
import { ControlStore, ControlStoreError } from './control-store';
import type { OperationState } from '../../shared/control-state';
import { ACCEPTANCE_ACTION_CLASSES, parseArtifactIdentity, type AcceptanceActionClass, type AcceptancePolicy, type AcceptanceRecord, type ArtifactIdentity } from '../../shared/acceptance';
import { parseAgentIdentifier } from '../../shared/agent-registry';

export type AcceptedActionIntent = { projectId: string; sessionId: string; agentId: string; evidenceId: string; acceptanceId: string; actionClass: AcceptanceActionClass; artifact: ArtifactIdentity; contentRevision: string; targetId: string; targetRevision: number; targetDigest: string; resourceKey?: string };

/**
 * Acceptance is project/class/artifact-bound, but does not otherwise name an action target. Bind the
 * exact owner-configured target revision and adapter-specific content identity into the artifact
 * revision before evidence is recorded. Target definitions themselves must be immutable per revision;
 * the adapter still has to validate their full semantics and current authority at execution time.
 */
export function targetBoundArtifact(input: { projectId: string; actionClass: AcceptanceActionClass; targetId: string; targetRevision: number; targetDigest: string; contentRevision: string; commit: string | null }): ArtifactIdentity {
  const projectId = parseAgentIdentifier(input.projectId), targetId = parseAgentIdentifier(input.targetId);
  if (!(ACCEPTANCE_ACTION_CLASSES as readonly string[]).includes(input.actionClass) || !Number.isSafeInteger(input.targetRevision) || input.targetRevision < 1 || !/^[a-f0-9]{64}$/.test(input.targetDigest))
    throw new Error('Invalid action class, target revision or target definition digest.');
  const content = parseArtifactIdentity({ revision: input.contentRevision, commit: input.commit });
  const digest = createHash('sha256').update(JSON.stringify(['pilot-accepted-target-v2', projectId, input.actionClass, targetId, input.targetRevision, input.targetDigest, content.revision, content.commit])).digest('hex');
  return Object.freeze({ revision: 'action-' + digest, commit: content.commit });
}
type Intent = AcceptedActionIntent;
/** The durable intent for one exact bound effect, read without executing or admitting anything. */
export type AcceptedActionRecord = { readonly operationId: string; readonly state: OperationState; readonly receipt: unknown };
export type AcceptedActionAuthorization = { acceptance: AcceptanceRecord; policy: AcceptancePolicy; allowed: boolean };
type Authorization = AcceptedActionAuthorization;
/** The verified receipt an adapter returns and the executor records: read it back through `find`. */
export type AcceptedActionReceipt = { targetId: string; artifact: ArtifactIdentity; externalId: string };
type Receipt = AcceptedActionReceipt;
/** Internal, typed ports only. No caller may supply a command, filesystem path or adapter over HTTP. */
export type AcceptedActionPort = {
  authorize(intent: Intent): Promise<Authorization>;
  /** Read-only target and exact-artifact verification, against the owner-configured target revision. */
  check(intent: Intent): Promise<void>;
  /** Revalidate immediately before the consequential effect; this is admission, not a lease. */
  execute(intent: Intent, signal: AbortSignal | undefined, revalidate: () => Promise<void>): Promise<Receipt>;
};

/**
 * Durable single-use admission for a separately implemented effect adapter. This class is not an
 * action adapter, is not installed as a tool, and never executes a command itself. It fails closed
 * on uncertainty and never retries an effect. Only a live named agent's own full-auto acceptance is
 * accepted here; owner-reviewed target-specific actions need a separate authorization design.
 */
export class AcceptedActionExecutor {
  constructor(private readonly store: ControlStore) {}

  /**
   * Read the durable intent keyed by this exact artifact, if one exists. This never creates an
   * intent and never executes anything: an adapter uses it to answer a repeat with the recorded
   * receipt, and to refuse a repeat whose earlier attempt is pending or unknown instead of replaying
   * it. The key derivation is the same one `run` uses, so the two cannot drift apart.
   */
  find(input: { projectId: string; artifact: ArtifactIdentity }): AcceptedActionRecord | null {
    const projectId = parseAgentIdentifier(input.projectId), artifact = parseArtifactIdentity(input.artifact);
    const key = 'accepted-action.' + createHash('sha256').update(artifact.revision).digest('hex');
    const row = this.store.db.prepare('SELECT id,state FROM operations WHERE project_id=? AND session_id=? AND idempotency_key=?').get(projectId, 'accepted-actions', key) as { id: string; state: OperationState } | undefined;
    if (row === undefined) return null;
    const operation = this.store.getOperation(row.id, { projectId, sessionId: 'accepted-actions' });
    if (operation.state !== row.state) throw new Error('The accepted action intent changed while it was being read.');
    return { operationId: operation.id, state: operation.state, receipt: operation.receipt };
  }

  async run(input: Intent, port: AcceptedActionPort, signal?: AbortSignal): Promise<
    | { status: 'succeeded'; receipt: Receipt; operationId: string }
    | { status: 'refused' | 'uncertain'; operationId: string; message: string }
  > {
    const intent: Intent = {
      projectId: parseAgentIdentifier(input.projectId), sessionId: parseAgentIdentifier(input.sessionId), agentId: parseAgentIdentifier(input.agentId),
      evidenceId: parseAgentIdentifier(input.evidenceId), acceptanceId: parseAgentIdentifier(input.acceptanceId), actionClass: input.actionClass,
      artifact: parseArtifactIdentity(input.artifact), contentRevision: parseArtifactIdentity({ revision: input.contentRevision, commit: null }).revision,
      targetId: parseAgentIdentifier(input.targetId), targetRevision: input.targetRevision, targetDigest: input.targetDigest,
      ...(input.resourceKey === undefined ? {} : { resourceKey: input.resourceKey })
    };
    // The trusted adapter must derive this key from a canonical provider resource, not a model
    // input or target alias. It prevents overlapping *Pilot* deploys and pushes, not external writers.
    if ((['deploy', 'push'].includes(intent.actionClass) && !intent.resourceKey) || (intent.resourceKey !== undefined && !/^resource-[a-f0-9]{64}$/.test(intent.resourceKey))) throw new Error('The canonical action resource key is unavailable.');
    const bound = targetBoundArtifact({ projectId: intent.projectId, actionClass: intent.actionClass, targetId: intent.targetId, targetRevision: intent.targetRevision, targetDigest: intent.targetDigest, contentRevision: intent.contentRevision, commit: intent.artifact.commit });
    if (bound.revision !== intent.artifact.revision) throw new Error('The accepted artifact does not bind this exact action target and content.');
    const authorize = async () => {
      const auth = await port.authorize(intent), accepted = auth.acceptance;
      if (!auth.allowed || !accepted || accepted.id !== intent.acceptanceId || accepted.evidenceId !== intent.evidenceId || accepted.projectId !== intent.projectId || accepted.sessionId !== intent.sessionId || accepted.actionClass !== intent.actionClass || accepted.acceptedBy.kind !== 'agent' || accepted.acceptedBy.identity !== intent.agentId || accepted.artifact.revision !== intent.artifact.revision || accepted.artifact.commit !== intent.artifact.commit || accepted.policy?.revision !== auth.policy.revision || accepted.policy.mode !== 'agent-may-accept' || accepted.policy.classDecision !== 'full-auto' || auth.policy.mode !== 'agent-may-accept' || auth.policy.actionClasses[intent.actionClass] !== 'full-auto')
        throw new Error('The current scope, acceptance or policy does not authorize this exact action.');
    };
    signal?.throwIfAborted();
    await authorize(); await port.check(intent); signal?.throwIfAborted();
    const scope = { projectId: intent.projectId, sessionId: 'accepted-actions' };
    // One intent per bound effect, not merely per acceptance: new evidence cannot automatically
    // replay an uncertain attempt for the same target revision and exact content.
    const key = 'accepted-action.' + createHash('sha256').update(intent.artifact.revision).digest('hex');
    let operationId: string;
    try {
      const admitted = this.store.admit({ scope, idempotencyKey: key, kind: 'accepted.action', input: intent, outbox: { kind: 'accepted.action', payload: { version: 1, acceptanceId: intent.acceptanceId } } });
      if (admitted.existing) throw new Error('This acceptance already has an action intent; inspect it before doing anything else.');
      operationId = admitted.operation.id;
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'CONFLICT') throw new Error('This exact accepted effect already has an action intent; inspect it before doing anything else.');
      throw error;
    }
    try {
      signal?.throwIfAborted(); await authorize(); await port.check(intent); signal?.throwIfAborted();
    } catch {
      try { this.store.updateOperation(operationId, scope, 1, 'failed', { status: 'not-started' }); } catch { /* inspect durable intent */ }
      return { status: 'refused', operationId, message: 'The action was not started; inspect its durable intent before retrying.' };
    }
    try {
      // A port may ignore cancellation or never settle. Stop waiting on abort, but never infer that
      // its effect stopped: retain the unknown intent/barriers. Promise.race observes any later
      // rejection, and only this executor writes the terminal operation state.
      let removeAbort = () => {};
      const aborted = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error('Action cancellation is unconfirmed.'));
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
      });
      let receipt: Awaited<ReturnType<AcceptedActionPort['execute']>>;
      try {
        const execution = Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return port.execute(intent, signal, authorize);
        });
        receipt = await (aborted === undefined ? execution : Promise.race([execution, aborted]));
      } finally { removeAbort(); }
      if (signal?.aborted || !receipt || receipt.targetId !== intent.targetId || receipt.artifact?.revision !== intent.artifact.revision || receipt.artifact?.commit !== intent.artifact.commit || typeof receipt.externalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(receipt.externalId)) throw new Error('Unverified receipt');
      const verified: Receipt = { targetId: receipt.targetId, artifact: parseArtifactIdentity(receipt.artifact), externalId: receipt.externalId };
      this.store.updateOperation(operationId, scope, 1, 'succeeded', verified);
      return { status: 'succeeded', operationId, receipt: verified };
    } catch {
      try { this.store.updateOperation(operationId, scope, 1, 'unknown'); } catch { /* pending remains uncertain */ }
      return { status: 'uncertain', operationId, message: 'The action may have happened. Inspect the target and durable intent; do not retry automatically.' };
    }
  }
}
