import type { SessionLifecycleState } from './session-lifecycle';

/**
 * The command surface of this build: one closed, frozen registry of the actions that genuinely
 * exist, and nothing else.
 *
 * An action is a capability with an id, an owner-visible label, the surfaces that offer it, the
 * scope it needs, a strict parameter schema and the preconditions its handler really enforces. The
 * point of the registry is that the command surface cannot drift from the implementation: an
 * action is listed only when a handler for it is implemented and reachable, so a capability that is
 * planned but absent is *absent* from this file rather than present-and-failing. There is no
 * placeholder, no TODO and no "coming soon" entry, and this module is the only place an action id
 * is declared.
 *
 * This module is pure: it has no runtime imports at all — no Node built-ins, no schema library and
 * no framework, and its one type-only import is erased at build time — so the client can read
 * exactly the registry and exactly the projection contract the server serves. A parameter's *type*
 * names the kind of value it is; the server half (`src/server/state/action-registry.ts`) maps each
 * type to the one validator its handler uses, and the descriptor's per-parameter `description`
 * states the rule that validator enforces.
 *
 * Nothing here performs anything. An action describes what the owner may ask for; the server half
 * runs the handler, and no action in this registry performs a commit, push, deploy, spend,
 * provision or publish.
 */

/** The closed set of surfaces an action may belong to. A surface is only ever declared when it really offers the action. */
export const ACTION_SURFACES = ['slash', 'palette', 'button'] as const;
export type ActionSurface = (typeof ACTION_SURFACES)[number];

/**
 * The closed set of scope dimensions an action may require. The caller supplies the scope it is
 * acting in (a project id and/or a session id); an action whose declared dimensions the caller
 * cannot fill is not offered to it, and asking for it anyway is refused as a scope violation.
 */
export const ACTION_SCOPE_DIMENSIONS = ['project', 'session'] as const;
export type ActionScopeDimension = (typeof ACTION_SCOPE_DIMENSIONS)[number];

/**
 * The closed set of parameter types. Each names a rule the server validates exactly; a value of a
 * type marked `validatedBy` in the descriptor is a nested payload whose owning model parses it
 * strictly, so an unknown field inside it is refused by that model rather than here.
 */
export const ACTION_PARAM_TYPES = [
  'revision',
  'session-name',
  'lifecycle-reason',
  'session-link',
  'session-links',
  'session-model',
  'approval-kind',
  'approval-scope',
  'approval-target',
  'revocation-reason',
  'identifier',
  'instant',
  'queue-text',
  'queue-images',
  'queue-position',
  'runner-recipe',
  'runner-workspace',
  'runner-limits',
  'acceptance-evidence',
  'acceptance-request',
  'acceptance-policy',
  'acceptance-actor'
] as const;
export type ActionParamType = (typeof ACTION_PARAM_TYPES)[number];

/**
 * The closed set of reads a `revision` parameter's value comes from. A revision cannot be guessed:
 * the caller must send the one the store really holds, so the descriptor names the read that
 * carries it and a client pre-fills exactly that value — or asks for it when the read is not
 * available — instead of assuming a number the server will refuse.
 */
export const ACTION_REVISION_SOURCES = ['session-lifecycle-revision', 'session-record-revision', 'queue-revision', 'acceptance-policy-revision'] as const;
export type ActionRevisionSource = (typeof ACTION_REVISION_SOURCES)[number];

/** One declared parameter: what it is called, which rule it obeys, and whether it must be present. */
export type ActionParameter = {
  readonly name: string;
  readonly type: ActionParamType;
  readonly required: boolean;
  readonly description: string;
  /** Set when the value is parsed by the model that owns it, rather than by the parameter rule alone. */
  readonly validatedBy?: string;
  /**
   * Set on every `revision` parameter and on nothing else: the read whose value the store will
   * compare the parameter against. It is declared here so no client decides for itself which
   * revision an action checks.
   */
  readonly revisionSource?: ActionRevisionSource;
};

/** Something the handler really refuses, with the code the test suite pins it by. */
export type ActionPrecondition = {
  readonly code: ActionPreconditionCode;
  readonly description: string;
};

/** One action, exactly as the owner is offered it. Every field is required and frozen. */
export type ActionDescriptor = {
  readonly id: ActionId;
  readonly label: string;
  readonly description: string;
  readonly surfaces: readonly ActionSurface[];
  /** The scope dimensions the caller must supply; an empty list means the action needs no scope. */
  readonly requires: readonly ActionScopeDimension[];
  readonly parameters: readonly ActionParameter[];
  readonly preconditions: readonly ActionPrecondition[];
  /**
   * Requests a handler answers with a no-op instead of a refusal, documented so that a legal
   * "nothing changed" result is never mistaken for a missing effect.
   */
  readonly noops: readonly string[];
  /** Whether the handler can write durable state. False means the handler only reads or reports. */
  readonly writes: boolean;
  /** One line describing the effect the handler performs. */
  readonly effect: string;
};

/** The closed id set. There is no action id outside this list, and no entry in it without a handler. */
export const ACTION_IDS = [
  'session.lifecycle.reconnect',
  'session.lifecycle.resume',
  'session.lifecycle.retry',
  'session.lifecycle.stop',
  'session.lifecycle.pause',
  'session.create',
  'session.rename',
  'session.link',
  'session.unlink',
  'session.migration.plan',
  'session.migration.apply',
  'approval.create',
  'approval.consume',
  'approval.revoke',
  'doctor.report',
  'delivery.reconciliation.report',
  'queue.read',
  'queue.append',
  'queue.edit',
  'queue.reorder',
  'queue.remove',
  'queue.clear',
  'queue.cancel',
  'queue.claim',
  'queue.release',
  'queue.submit',
  'queue.reconcile',
  'runner.read',
  'runner.submit',
  'runner.claim',
  'runner.run',
  'runner.settle',
  'acceptance.read',
  'acceptance.evidence.record',
  'acceptance.accept',
  'acceptance.policy.update'
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

/** Whether a value is one of the declared action ids. An unknown id is refused, never guessed at. */
export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && (ACTION_IDS as readonly string[]).includes(value);
}

/** The vocabulary every descriptor's preconditions are written in, so two actions cannot mean two things by one code. */
export const ACTION_PRECONDITION_CODES = [
  'SESSION_EXISTS',
  'REVISION_MATCHES',
  'STATE_PAUSED_OR_INTERRUPTED',
  'INTERRUPTION_CERTAIN',
  'STATE_FAILED',
  'STATE_RUNNING',
  'DISPATCH_AVAILABLE',
  'REASON_BOUNDED',
  'PROJECT_REGISTERED',
  'NAME_VALID',
  'NAME_UNIQUE',
  'LINK_TARGET_RESOLVES',
  'SESSION_LIMIT',
  'LINK_LIMIT',
  'APPROVAL_EXISTS',
  'SCOPE_EXACT',
  'KIND_MATCHES',
  'TARGET_EXACT',
  'APPROVAL_PENDING',
  'APPROVAL_NOT_CONSUMED',
  'REQUEST_KIND_VALID',
  'REQUEST_SCOPE_NAMED',
  'REQUEST_TARGET_VALID',
  'EXPIRY_IN_THE_FUTURE',
  'ENTRY_EXISTS',
  'ENTRY_EDITABLE',
  'ENTRY_REMOVABLE',
  'TRANSITION_LEGAL',
  'POSITION_IN_QUEUE',
  'IN_FLIGHT_PRESERVED',
  'HEAD_CLAIMABLE',
  'CLAIM_OWNED',
  'LEASE_LIVE',
  'QUEUE_BOUNDED',
  'RUNNER_ENABLED',
  'RECIPE_ALLOWED',
  'WORKSPACE_IN_ROOT',
  'LIMITS_BOUNDED',
  'RUNNER_JOB_LIMIT',
  'JOB_EXISTS',
  'JOB_CLAIMABLE',
  'EVIDENCE_SOURCE_READABLE',
  'EVIDENCE_HONEST',
  'DIFF_BOUNDED',
  'EVIDENCE_EXISTS',
  'ARTIFACT_UNCHANGED',
  'ARTIFACT_NOT_ACCEPTED',
  'ACCEPTOR_PERMITTED',
  'ACTION_CLASS_DECIDED',
  'POLICY_OWNER_ONLY'
] as const;
export type ActionPreconditionCode = (typeof ACTION_PRECONDITION_CODES)[number];

const surfaces: readonly ActionSurface[] = Object.freeze(['palette'] as const);
const projectScope: readonly ActionScopeDimension[] = Object.freeze(['project'] as const);
const sessionScope: readonly ActionScopeDimension[] = Object.freeze(['project', 'session'] as const);
const noScope: readonly ActionScopeDimension[] = Object.freeze([] as const);

function lifecycleParameters(): readonly ActionParameter[] {
  return Object.freeze([
    Object.freeze({ name: 'revision', type: 'revision' as const, required: true, revisionSource: 'session-lifecycle-revision' as const, description: 'the lifecycle revision the caller read; a stale one is refused as a conflict and changes nothing. Read it from the live projection (/api/actions/activity), which reports the durable record of this session' }),
    Object.freeze({ name: 'reason', type: 'lifecycle-reason' as const, required: false, description: 'an optional 1-240 character printable reason; a state that requires one is given the documented text when none is supplied' })
  ]);
}
function sessionParameters(extra: readonly ActionParameter[]): readonly ActionParameter[] {
  return Object.freeze([...extra]);
}
const sessionLinkParameter: ActionParameter = Object.freeze({
  name: 'link',
  type: 'session-link' as const,
  required: true,
  description: 'one link to a task (taskId), a document (path, anchor) or a workspace (path); an unknown kind or field is refused',
  validatedBy: 'the session link model (src/shared/sessions.ts)'
});
const revisionParameter: ActionParameter = Object.freeze({
  name: 'revision',
  type: 'revision' as const,
  required: true,
  revisionSource: 'session-record-revision' as const,
  description: 'the session revision the caller read; a stale one is refused as a conflict and writes nothing. Read it from the session list (/api/sessions), which reports the record revision'
});
const nameParameter: ActionParameter = Object.freeze({
  name: 'name',
  type: 'session-name' as const,
  required: true,
  description: 'a name of 1-80 characters, first character alphanumeric, letters, digits, space, . _ : - only'
});
const approvalScopeParameter: ActionParameter = Object.freeze({
  name: 'scope',
  type: 'approval-scope' as const,
  required: true,
  description: 'the approval scope: at least one of projectId, sessionId, operation (each an identifier)',
  validatedBy: 'the approval model (src/shared/approvals.ts)'
});
const approvalTargetParameter: ActionParameter = Object.freeze({
  name: 'target',
  type: 'approval-target' as const,
  required: true,
  description: "the exact target for the kind: commit {repository, branch, treeDigest}, push {remote, branch, commitSha}, deploy {endpoint, releaseId}, spend {amountMinor, currency}, provision {resource, region} or publish {channel, artifact}",
  validatedBy: 'the approval model (src/shared/approvals.ts)'
});
const approvalKindParameter: ActionParameter = Object.freeze({
  name: 'kind',
  type: 'approval-kind' as const,
  required: true,
  description: 'one of the closed approval kinds: commit, push, deploy, spend, provision, publish'
});
const approvalIdParameter: ActionParameter = Object.freeze({
  name: 'id',
  type: 'identifier' as const,
  required: true,
  description: 'the approval id, 1-160 characters starting alphanumeric from A-Za-z0-9._:-'
});

const queueRevisionParameter: ActionParameter = Object.freeze({
  name: 'revision',
  type: 'revision' as const,
  required: true,
  revisionSource: 'queue-revision' as const,
  description: 'the queue revision the caller read; a stale one is refused as a conflict and writes nothing. Read it from the queue itself (GET /api/sessions/<sessionId>/queue)'
});
const queueEntryParameter: ActionParameter = Object.freeze({
  name: 'entryId',
  type: 'identifier' as const,
  required: true,
  description: 'the stable id of one queued input, 1-160 characters starting alphanumeric from A-Za-z0-9._:-'
});
const queueOwnerParameter: ActionParameter = Object.freeze({
  name: 'owner',
  type: 'identifier' as const,
  required: true,
  description: 'the named dispatcher that claims or holds the entry: 1-160 characters starting alphanumeric from A-Za-z0-9._:-'
});
const queueTextParameter: ActionParameter = Object.freeze({
  name: 'text',
  type: 'queue-text' as const,
  required: true,
  description: 'the new text of a queued input: 1-2000 characters of printable text'
});
const queueAppendTextParameter: ActionParameter = Object.freeze({
  name: 'text',
  type: 'queue-text' as const,
  required: false,
  description: 'optional text of 1-2000 printable characters; an entry that carries neither text nor an image is refused, because there would be nothing to submit'
});
const queueImagesParameter: ActionParameter = Object.freeze({
  name: 'images',
  type: 'queue-images' as const,
  required: false,
  description: 'up to 6 stored image ids (the hex media id of the bytes, as the media route reports it); each is resolved against the media store and an unknown id is refused, so a reference is never a path and never an unverified claim'
});
const runnerJobParameter: ActionParameter = Object.freeze({
  name: 'jobId',
  type: 'identifier' as const,
  required: true,
  description: 'the stable id of one coding job, 1-160 characters starting alphanumeric from A-Za-z0-9._:-; read it from the job list (GET /api/projects/<id>/runner/jobs) or from the job a claim returned'
});
const queuePositionParameter: ActionParameter = Object.freeze({
  name: 'position',
  type: 'queue-position' as const,
  required: true,
  description: 'the position the entry moves to: a whole number inside the queue (0 to the number of entries minus one)'
});

const acceptanceEvidenceParameter: ActionParameter = Object.freeze({
  name: 'evidence',
  type: 'acceptance-evidence' as const,
  required: true,
  description: 'the completion record: subject {kind: job|session, id}, artifact {revision, commit or null}, the commands run, diff {files, linesAdded, linesRemoved, text or null, reference or null}, tests [{command, outcome, output or null, counts or null}], an optional review and producedAt; the counts a record carries are read from its own recorded output',
  validatedBy: 'the acceptance model (src/shared/acceptance.ts)'
});
const acceptanceRequestParameter: ActionParameter = Object.freeze({
  name: 'request',
  type: 'acceptance-request' as const,
  required: true,
  description: 'the acceptance: evidenceId, the exact artifact {revision, commit or null} it accepts, actionClass (commit, push, deploy, spend, provision, publish) and the actor {kind: owner|agent, identity}',
  validatedBy: 'the acceptance model (src/shared/acceptance.ts)'
});
const acceptancePolicyParameter: ActionParameter = Object.freeze({
  name: 'policy',
  type: 'acceptance-policy' as const,
  required: true,
  description: 'the new policy: mode (owner-only or agent-may-accept) and actionClasses, with one of ask or full-auto for each of commit, push, deploy, spend, provision and publish',
  validatedBy: 'the acceptance model (src/shared/acceptance.ts)'
});
const acceptanceActorParameter: ActionParameter = Object.freeze({
  name: 'actor',
  type: 'acceptance-actor' as const,
  required: true,
  description: 'who is changing the policy: kind (owner or agent) and identity; only an owner may change it',
  validatedBy: 'the acceptance model (src/shared/acceptance.ts)'
});
const acceptancePolicyRevisionParameter: ActionParameter = Object.freeze({
  name: 'revision',
  type: 'revision' as const,
  required: true,
  revisionSource: 'acceptance-policy-revision' as const,
  description: 'the policy revision the caller read; a stale one is refused as a conflict and writes nothing. Read it from the policy in force (GET /api/acceptance/policy), which reports its revision'
});

function describe(value: Omit<ActionDescriptor, 'surfaces'> & { readonly surfaces?: readonly ActionSurface[] }): ActionDescriptor {
  return Object.freeze({
    ...value,
    surfaces: value.surfaces ?? surfaces
  }) as ActionDescriptor;
}

/**
 * The registry itself. Ordering is deliberate and stable: lifecycle actions, session records, the
 * migration, approvals, the two read-only reports, the queue, the bounded coding runner, then the
 * acceptance record.
 */
export const ACTION_DESCRIPTORS: readonly ActionDescriptor[] = Object.freeze([
  describe({
    id: 'session.lifecycle.reconnect' as const,
    label: 'Reconnect session',
    description: 'Attach to a session and report its durable execution state without changing it.',
    requires: sessionScope,
    parameters: lifecycleParameters(),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project; an unknown one is refused as not found' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and changes nothing' })
    ],
    noops: Object.freeze(['a reconnect always changes nothing: it attaches, reports the record and dispatches nothing']),
    writes: false,
    effect: 'reads the durable lifecycle record of one session and returns it unchanged'
  }),
  describe({
    id: 'session.lifecycle.resume' as const,
    label: 'Resume session',
    description: 'Continue a paused or interrupted generation under its original request identity.',
    requires: sessionScope,
    parameters: lifecycleParameters(),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and dispatches nothing' }),
      Object.freeze({ code: 'STATE_PAUSED_OR_INTERRUPTED' as const, description: "the session is paused or interrupted; an idle, running or failed session is refused with 'Only a paused or interrupted session can be resumed'" }),
      Object.freeze({ code: 'INTERRUPTION_CERTAIN' as const, description: 'an interrupted session whose effect cannot be proven idempotent is refused and nothing is replayed' }),
      Object.freeze({ code: 'DISPATCH_AVAILABLE' as const, description: 'this instance can dispatch: the agent harness is enabled and the project is registered; otherwise the request is refused before any revision is claimed' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes the running transition and then dispatches the generation under the request identity the record already carries'
  }),
  describe({
    id: 'session.lifecycle.retry' as const,
    label: 'Retry session',
    description: 'Start a new attempt for a failed generation under an identity derived from the revision it writes.',
    requires: sessionScope,
    parameters: lifecycleParameters(),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and dispatches nothing' }),
      Object.freeze({ code: 'STATE_FAILED' as const, description: "the session is failed; any other state is refused with 'Only a failed session can be retried'" }),
      Object.freeze({ code: 'DISPATCH_AVAILABLE' as const, description: 'this instance can dispatch: the agent harness is enabled and the project is registered' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes a new attempt and then dispatches it under an identity derived from the revision, never minted at random'
  }),
  describe({
    id: 'session.lifecycle.stop' as const,
    label: 'Stop session',
    description: 'Cancel the running generation of a session and leave it idle.',
    requires: sessionScope,
    parameters: lifecycleParameters(),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict' })
    ],
    noops: Object.freeze(['stopping a session that is not running cancels nothing, writes nothing and returns the record unchanged']),
    writes: true,
    effect: 'asks the harness to cancel the current generation and then writes the idle transition'
  }),
  describe({
    id: 'session.lifecycle.pause' as const,
    label: 'Pause session',
    description: 'Cancel the running generation but keep the session resumable under its original identity.',
    requires: sessionScope,
    parameters: lifecycleParameters(),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict' }),
      Object.freeze({ code: 'STATE_RUNNING' as const, description: "the session is running; any other state is refused with 'Only a running session can be paused'" }),
      Object.freeze({ code: 'REASON_BOUNDED' as const, description: 'a reason, when supplied, is 1-240 characters of printable text' })
    ],
    noops: Object.freeze(['pausing a session that is already paused changes nothing and returns the record unchanged']),
    writes: true,
    effect: 'asks the harness to cancel the current generation and then writes the paused transition with its reason'
  }),
  describe({
    id: 'session.create' as const,
    label: 'Create session',
    description: 'Create a named session for a project.',
    requires: projectScope,
    parameters: sessionParameters([
      nameParameter,
      Object.freeze({ name: 'model', type: 'session-model' as const, required: false, description: 'an optional declared {provider, modelId} choice, or null; it is recorded with the session and applied to no running agent' }),
      Object.freeze({ name: 'links', type: 'session-links' as const, required: false, description: 'an optional array of at most 32 links, each resolved against the board, the documentation store and the approved roots', validatedBy: 'the session link model (src/shared/sessions.ts)' })
    ]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project' }),
      Object.freeze({ code: 'NAME_VALID' as const, description: 'the name satisfies the documented rule' }),
      Object.freeze({ code: 'NAME_UNIQUE' as const, description: 'no live session of that project already carries the name' }),
      Object.freeze({ code: 'LINK_TARGET_RESOLVES' as const, description: 'every link supplied resolves, exactly as a link written later would' }),
      Object.freeze({ code: 'SESSION_LIMIT' as const, description: 'the project holds fewer than 200 sessions' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new session record with a generated id'
  }),
  describe({
    id: 'session.rename' as const,
    label: 'Rename session',
    description: 'Change the owner-visible name of a session under a revision check.',
    requires: sessionScope,
    parameters: sessionParameters([nameParameter, revisionParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision' }),
      Object.freeze({ code: 'NAME_VALID' as const, description: 'the name satisfies the documented rule' }),
      Object.freeze({ code: 'NAME_UNIQUE' as const, description: 'no other live session of that project carries the name' })
    ],
    noops: Object.freeze(['renaming a session to the name it already has returns the record unchanged']),
    writes: true,
    effect: 'writes one new revision of the session record with the new name'
  }),
  describe({
    id: 'session.link' as const,
    label: 'Link work to session',
    description: 'Link one task, document or workspace to a session.',
    requires: sessionScope,
    parameters: sessionParameters([sessionLinkParameter, revisionParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision' }),
      Object.freeze({ code: 'LINK_TARGET_RESOLVES' as const, description: 'the link resolves: the board holds the task, the documentation store serves the path inside the roots, and the workspace directory exists inside the roots' }),
      Object.freeze({ code: 'LINK_LIMIT' as const, description: 'the session holds fewer than 32 links' })
    ],
    noops: Object.freeze(['linking a link the session already has returns the record unchanged']),
    writes: true,
    effect: 'writes one new revision of the session record with the resolved link added'
  }),
  describe({
    id: 'session.unlink' as const,
    label: 'Unlink work from session',
    description: 'Remove one stored link from a session.',
    requires: sessionScope,
    parameters: sessionParameters([sessionLinkParameter, revisionParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one with a present link is refused' })
    ],
    noops: Object.freeze(['unlinking a link the session does not have returns the record unchanged; the stored value is matched exactly, so no filesystem access is needed']),
    writes: true,
    effect: 'writes one new revision of the session record with the link removed'
  }),
  describe({
    id: 'session.migration.plan' as const,
    label: 'Plan the legacy session migration',
    description: 'Report what the legacy-conversation migration would adopt, writing nothing.',
    requires: noScope,
    parameters: Object.freeze([]),
    preconditions: Object.freeze([]),
    noops: Object.freeze(['a project with no conversation on disk and an already adopted session both plan no change']),
    writes: false,
    effect: 'reads the registered projects, resolves each legacy conversation and returns the deterministic plan'
  }),
  describe({
    id: 'session.migration.apply' as const,
    label: 'Apply the legacy session migration',
    description: 'Adopt every project conversation that is not yet a named session.',
    requires: noScope,
    parameters: Object.freeze([]),
    preconditions: Object.freeze([]),
    noops: Object.freeze(['a second application adopts nothing: an already registered session is left alone']),
    writes: true,
    effect: 'adopts each unregistered conversation as one named session, with the project folder as its workspace link'
  }),
  describe({
    id: 'approval.create' as const,
    label: 'Record an approval',
    description: 'Record a scoped, single-use authorisation for an exact target; it performs the action itself nowhere.',
    requires: noScope,
    parameters: sessionParameters([
      approvalKindParameter,
      approvalScopeParameter,
      approvalTargetParameter,
      Object.freeze({ name: 'expiresAt', type: 'instant' as const, required: true, description: 'an ISO instant strictly in the future and at most one hour away' })
    ]),
    preconditions: [
      Object.freeze({ code: 'REQUEST_KIND_VALID' as const, description: 'the kind is one of the closed set: commit, push, deploy, spend, provision, publish' }),
      Object.freeze({ code: 'REQUEST_SCOPE_NAMED' as const, description: 'the scope names at least one of projectId, sessionId, operation' }),
      Object.freeze({ code: 'REQUEST_TARGET_VALID' as const, description: 'the target carries exactly the fields its kind requires, and no others, within the 4096 byte bound' }),
      Object.freeze({ code: 'EXPIRY_IN_THE_FUTURE' as const, description: 'expiresAt is strictly in the future and the requested lifetime is at most 60 minutes' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one pending approval with a generated id and a single-use nonce, and returns it with the nonce'
  }),
  describe({
    id: 'approval.consume' as const,
    label: 'Consume an approval',
    description: 'Spend a single-use approval against its exact target, recording who consumed it.',
    requires: noScope,
    parameters: sessionParameters([
      approvalIdParameter,
      approvalScopeParameter,
      approvalKindParameter,
      approvalTargetParameter,
      Object.freeze({ name: 'consumedBy', type: 'identifier' as const, required: true, description: 'who consumes it: 1-160 characters starting alphanumeric from A-Za-z0-9._:-' })
    ]),
    preconditions: [
      Object.freeze({ code: 'APPROVAL_EXISTS' as const, description: 'the id names a stored approval' }),
      Object.freeze({ code: 'SCOPE_EXACT' as const, description: 'the supplied scope matches the approval scope dimension for dimension, not by intersection' }),
      Object.freeze({ code: 'KIND_MATCHES' as const, description: 'the supplied kind is the kind the approval authorises' }),
      Object.freeze({ code: 'TARGET_EXACT' as const, description: 'the supplied target matches the granted target field for field; a mismatch is refused and the approval is not spent' }),
      Object.freeze({ code: 'APPROVAL_PENDING' as const, description: 'the approval is pending and unexpired; a revoked, consumed or expired approval is refused' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'records the consumption and returns the exact target it authorised; it performs no commit, push, deploy, spend, provision or publish'
  }),
  describe({
    id: 'approval.revoke' as const,
    label: 'Revoke an approval',
    description: 'Withdraw a pending approval so it can never be consumed.',
    requires: noScope,
    parameters: sessionParameters([
      approvalIdParameter,
      approvalScopeParameter,
      Object.freeze({ name: 'revokedBy', type: 'identifier' as const, required: true, description: 'who revokes it: 1-160 characters starting alphanumeric from A-Za-z0-9._:-' }),
      Object.freeze({ name: 'reason', type: 'revocation-reason' as const, required: false, description: 'an optional null or 1-400 character reason' })
    ]),
    preconditions: [
      Object.freeze({ code: 'APPROVAL_EXISTS' as const, description: 'the id names a stored approval' }),
      Object.freeze({ code: 'SCOPE_EXACT' as const, description: 'the supplied scope matches the approval scope dimension for dimension' }),
      Object.freeze({ code: 'APPROVAL_NOT_CONSUMED' as const, description: 'a consumed approval cannot be revoked, because the action it authorised may already have happened' })
    ],
    noops: Object.freeze(['revoking an already revoked approval returns that record unchanged']),
    writes: true,
    effect: 'writes the revocation receipt and leaves the record unspendable'
  }),
  describe({
    id: 'doctor.report' as const,
    label: 'Run the read-only doctor',
    description: 'Report the read-only startup diagnosis: configuration, lock, storage schema, restore pause and port.',
    requires: noScope,
    parameters: Object.freeze([]),
    preconditions: Object.freeze([]),
    noops: Object.freeze(['a diagnosis always answers: a configuration or manifest that is invalid is reported as data, not as a refusal of this action']),
    writes: false,
    effect: 'reads configuration, the service lock, the storage schema and the endpoint; it acquires no lock, writes nothing and starts no server'
  }),
  describe({
    id: 'delivery.reconciliation.report' as const,
    label: 'Read the delivery reconciliation report',
    description: 'Report the pending and undelivered question and answer deliveries, and what may be re-sent idempotently.',
    requires: noScope,
    parameters: Object.freeze([]),
    preconditions: Object.freeze([]),
    noops: Object.freeze(['a ledger with nothing pending reports empty counts and no entries']),
    writes: false,
    effect: 'reads the delivery ledger read-only: it replays nothing, moves no row and acknowledges nothing'
  }),
  describe({
    id: 'queue.read' as const,
    label: 'Read the queued inputs',
    description: 'Read the durable queue of one session, with its revision, and dispatch nothing.',
    requires: sessionScope,
    parameters: Object.freeze([]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' })
    ],
    noops: Object.freeze(['a session whose queue was never written reads at revision 0 with no entries: that is the queue itself, not an absence of one']),
    writes: false,
    effect: 'reads the durable queue of one session with its revision, its entries and the bounds this build enforces; it claims nothing and submits nothing'
  }),
  describe({
    id: 'queue.append' as const,
    label: 'Queue an input',
    description: 'Append one input — text, images or both — to the end of a session queue.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter, queueAppendTextParameter, queueImagesParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and appends nothing' }),
      Object.freeze({ code: 'QUEUE_BOUNDED' as const, description: 'the queue holds fewer than the documented maximum of 50 entries, and the record stays inside its documented byte bound' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the entry appended at the tail, in the queued state; nothing is dispatched'
  }),
  describe({
    id: 'queue.edit' as const,
    label: 'Edit a queued input',
    description: 'Replace the text of one queued entry under a revision check.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter, queueEntryParameter, queueTextParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and writes nothing' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue; an unknown one is refused as not found' }),
      Object.freeze({ code: 'ENTRY_EDITABLE' as const, description: "only a queued entry's text can be edited: a claimed, submitted, settled, failed or cancelled entry is refused, because its text is no longer the input a dispatcher would read" })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the entry text replaced; nothing is dispatched'
  }),
  describe({
    id: 'queue.reorder' as const,
    label: 'Reorder a queued input',
    description: 'Move one entry to another position inside its session queue.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter, queueEntryParameter, queuePositionParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and writes nothing' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'POSITION_IN_QUEUE' as const, description: 'the target position is inside the queue: 0 to the number of entries minus one; a position outside it is refused' }),
      Object.freeze({ code: 'IN_FLIGHT_PRESERVED' as const, description: 'the move keeps an entry that is claimed or submitted ahead of every pending entry: such an entry is the queue\'s effective head until it settles or is explicitly reconciled, so a reorder that would let a later input dispatch before it is refused' })
    ],
    noops: Object.freeze(['moving an entry to the position it already holds returns the record unchanged at the same revision']),
    writes: true,
    effect: 'writes one new queue revision with the entry at its new position and every entry whose position changed stamped; an entry that is claimed or submitted stays the effective head, and nothing is dispatched'
  }),
  describe({
    id: 'queue.remove' as const,
    label: 'Remove a queued input',
    description: 'Take one entry that is not in flight out of the queue entirely.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter, queueEntryParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and writes nothing' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'ENTRY_REMOVABLE' as const, description: 'the entry is queued, cancelled or failed, so removing it can lose no claim and no submission; a claimed entry is released first, a submitted one is reconciled, and a settled one is cleared' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the entry gone and the order compacted; nothing is dispatched'
  }),
  describe({
    id: 'queue.clear' as const,
    label: 'Clear the finished entries',
    description: 'Remove every settled and failed entry from a session queue.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and writes nothing' })
    ],
    noops: Object.freeze(['a queue with no settled or failed entry clears nothing and returns the record unchanged at the same revision']),
    writes: true,
    effect: 'writes one new queue revision with every settled and failed entry removed and the order compacted; nothing is dispatched'
  }),
  describe({
    id: 'queue.cancel' as const,
    label: 'Cancel a queued input',
    description: 'Withdraw one entry that is not in flight so it can never be dispatched.',
    requires: sessionScope,
    parameters: sessionParameters([queueRevisionParameter, queueEntryParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the stored revision; a stale one is refused as a conflict and writes nothing' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the entry can become cancelled: a queued or failed entry can. A claimed entry cannot — a submission of it may be in flight, so its claim is released first — and a submitted entry cannot, because its input may already be in the transcript; settled and cancelled are terminal' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the entry cancelled; nothing that is in flight is withdrawn, so a cancelled entry is never claimed and never dispatched, and no submission can be left with nothing to reconcile it'
  }),
  describe({
    id: 'queue.claim' as const,
    label: 'Claim the next queued input',
    description: 'Claim the head entry of a session queue for one named dispatcher, with a lease.',
    requires: sessionScope,
    parameters: sessionParameters([queueOwnerParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'HEAD_CLAIMABLE' as const, description: 'the queue has a pending head and it can be claimed: it is waiting, or this owner already holds it, or the claim\'s lease has expired so it is reclaimable. A claim whose lease is live is never stolen — the lease is this build\'s only liveness evidence — and a head awaiting reconciliation is never skipped over' }),
      Object.freeze({ code: 'DISPATCH_AVAILABLE' as const, description: 'this instance can dispatch: the agent harness is enabled and the project is registered; otherwise the request is refused before any claim is written' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the head entry claimed by the named owner for the instance lease, recording the intent and the stable request identity it authorises before any submission starts; it submits nothing and sends nothing to a provider'
  }),
  describe({
    id: 'queue.release' as const,
    label: 'Release a claimed input',
    description: 'Give a claimed entry back to the queue without submitting it.',
    requires: sessionScope,
    parameters: sessionParameters([queueEntryParameter, queueOwnerParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'CLAIM_OWNED' as const, description: 'the caller holds the entry\'s claim, so it is the only party that may give it back; another owner\'s claim is never released by this one' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the entry is claimed, so it can become queued again; any other state is refused' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one new queue revision with the entry queued again and its claim dropped; nothing is dispatched'
  }),
  describe({
    id: 'queue.submit' as const,
    label: 'Submit a claimed input',
    description: 'Hand one claimed entry to the dispatcher under its stable request identity.',
    requires: sessionScope,
    parameters: sessionParameters([queueEntryParameter, queueOwnerParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'CLAIM_OWNED' as const, description: 'the caller holds the entry\'s claim; another owner\'s claim is never submitted by this one' }),
      Object.freeze({ code: 'LEASE_LIVE' as const, description: 'the claim\'s lease has not expired; the queue never submits on an expired lease, because the entry may already belong to another dispatcher' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the entry is claimed, so it can become submitted; any other state is refused' }),
      Object.freeze({ code: 'DISPATCH_AVAILABLE' as const, description: 'this instance can dispatch: the agent harness is enabled and the project is registered' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'submits the entry through the dispatcher under the stable request identity the claim recorded, then writes the submitted state; the durable transcript stays authoritative, a repeat under that identity is the same submission rather than a second one, and a submission the dispatcher does not report back is resolved from the transcript — never recorded as a refusal the queue cannot establish'
  }),
  describe({
    id: 'queue.reconcile' as const,
    label: 'Reconcile a dispatched input',
    description: 'Compare one entry against the durable transcript, by its stable request identity.',
    requires: sessionScope,
    parameters: sessionParameters([queueEntryParameter]),
    preconditions: [
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'the session id names a live session of that project' }),
      Object.freeze({ code: 'ENTRY_EXISTS' as const, description: 'the entry id names an entry of that queue' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the entry is claimed, submitted or failed, so reconciliation can decide it; a queued, settled or cancelled entry is refused, because there is nothing in flight to compare' })
    ],
    noops: Object.freeze(['a reconciliation always answers: an entry the transcript cannot be matched against becomes a named operator-attention state rather than a refusal, and nothing is re-sent']),
    writes: true,
    effect: 'reads what the durable transcript holds for the entry\'s stable request identity and writes settled on a match, or a named operator-attention state on an absence, a mismatch or an unreadable transcript; it never re-sends and never overwrites the transcript'
  }),
  describe({
    id: 'runner.read' as const,
    label: 'Read the coding jobs',
    description: 'Read one project\'s bounded coding jobs, with the recipe allowlist and the limits this build enforces.',
    requires: projectScope,
    parameters: Object.freeze([]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project; an unknown one is refused as not found' })
    ],
    noops: Object.freeze(['a project with no coding jobs reads as an empty list at the documented bounds: that is the project\'s runner state, not an absence of one']),
    writes: false,
    effect: 'reads the bounded coding jobs of one project, oldest first, with the recipe allowlist and the limits this build enforces; it runs nothing and claims nothing'
  }),
  describe({
    id: 'runner.submit' as const,
    label: 'Submit a coding job',
    description: 'Submit one bounded coding job: a fixed recipe, a contained workspace and stated limits.',
    requires: projectScope,
    parameters: Object.freeze([
      Object.freeze({ name: 'recipe', type: 'runner-recipe' as const, required: true, description: 'one recipe from the fixed allowlist (test-run, noop-probe); it is a name for one constant command line, and a caller supplies no argument, no shell text and no environment' }),
      Object.freeze({ name: 'workspace', type: 'runner-workspace' as const, required: true, description: 'a relative path inside the registered project root (for example . or packages/api); an absolute path, a parent segment or a symlink is refused, and the directory must exist' }),
      Object.freeze({ name: 'limits', type: 'runner-limits' as const, required: false, description: 'optional bounded limits: timeoutMs (100-300000), outputBytes (256-8192), memoryBytes (16MiB-1GiB), cpus (1-2) and pids (8-128); an absent field takes the documented default and a value outside its bound is refused rather than reduced', validatedBy: 'the coding job model (src/shared/runner.ts)' })
    ]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project, so the job has an approved root to resolve its workspace in' }),
      Object.freeze({ code: 'RECIPE_ALLOWED' as const, description: 'the recipe is one of the fixed allowlist; an unknown one is refused and no command line is composed at all' }),
      Object.freeze({ code: 'WORKSPACE_IN_ROOT' as const, description: 'the workspace reference is a relative path that resolves to an existing directory inside the registered project root, with no symlink in it; anything else is refused rather than resolved and rewritten' }),
      Object.freeze({ code: 'LIMITS_BOUNDED' as const, description: 'every limit is inside the documented bounds; a limit this build cannot enforce is refused, never quietly reduced' }),
      Object.freeze({ code: 'RUNNER_JOB_LIMIT' as const, description: 'the project holds fewer than the documented maximum of 50 coding jobs' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one pending coding job holding the recipe, the contained workspace reference and the bounded limits; it starts no container and runs nothing'
  }),
  describe({
    id: 'runner.claim' as const,
    label: 'Claim the next coding job',
    description: 'Claim the oldest unclaimed job for one named owner, with a lease, and start nothing.',
    requires: projectScope,
    parameters: sessionParameters([queueOwnerParameter]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project' }),
      Object.freeze({ code: 'JOB_CLAIMABLE' as const, description: 'the oldest job that is not terminal is pending, or is claimed with an expired lease and so is reclaimable; a claim whose lease is live is never stolen, and a running, settled or attention job is never claimed' }),
      Object.freeze({ code: 'RUNNER_ENABLED' as const, description: 'this instance can contain a job: the container properties are established before the claim is written, so an instance that cannot contain a job leaves it unclaimed rather than claiming work it cannot run' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes the claim and its lease on the oldest unclaimed job and starts no container; a job that is merely claimed has provably not run, because a run writes the running state first'
  }),
  describe({
    id: 'runner.run' as const,
    label: 'Run a claimed coding job',
    description: 'Run one claimed job in a contained container, collect its bounded result and settle it.',
    requires: projectScope,
    parameters: sessionParameters([runnerJobParameter, queueOwnerParameter]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project' }),
      Object.freeze({ code: 'JOB_EXISTS' as const, description: 'the job id names a job of that project; an unknown one is refused as not found' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the job is claimed, so it can run; a pending, running, settled or attention job is refused, and a settled or attention job is never run again' }),
      Object.freeze({ code: 'CLAIM_OWNED' as const, description: 'the caller holds the job\'s claim; another owner\'s claim is never run by this one' }),
      Object.freeze({ code: 'LEASE_LIVE' as const, description: 'the claim has not expired; the runner never runs on an expired lease, because the job may already belong to another owner by then' }),
      Object.freeze({ code: 'WORKSPACE_IN_ROOT' as const, description: 'the workspace is resolved again at the moment it is mounted, so a reference that stopped being contained is refused rather than mounted' }),
      Object.freeze({ code: 'RUNNER_ENABLED' as const, description: 'the container properties are established and exact before the running state is written; when they cannot be, nothing is run — there is no fallback to this process, the application container or the host' }),
      Object.freeze({ code: 'LIMITS_BOUNDED' as const, description: 'the runtime reports it can enforce the job\'s limits; when it cannot, nothing is run and the job is left exactly as it is' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes the running state, runs the job in one container with no network, a read-only root, a non-root user, no capabilities and hard limits, then writes the bounded result and settles the job; a conflict on the running write executes nothing'
  }),
  describe({
    id: 'runner.settle' as const,
    label: 'Settle a coding job',
    description: 'Settle one job from its durable record, or name why it needs an operator.',
    requires: projectScope,
    parameters: sessionParameters([runnerJobParameter]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project' }),
      Object.freeze({ code: 'JOB_EXISTS' as const, description: 'the job id names a job of that project' }),
      Object.freeze({ code: 'TRANSITION_LEGAL' as const, description: 'the job is claimed or running, so it can be settled; a pending job has not been claimed and has nothing to settle, and a settled or attention job is a no-op' })
    ],
    noops: Object.freeze(['settling a job that is already settled or awaiting an operator returns the record unchanged at its own revision, and settling a running job with no recorded result always answers with the named operator-attention state rather than a refusal']),
    writes: true,
    effect: 'settles one job from what the durable record proves — the recorded result when there is one, and otherwise the named operator-attention state — and executes nothing at all'
  }),
  describe({
    id: 'acceptance.read' as const,
    label: 'Read the completion records',
    description: 'Read the acceptance policy in force and one project\'s completion records with their acceptances.',
    requires: projectScope,
    parameters: Object.freeze([]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project; an unknown one is refused as not found' })
    ],
    noops: Object.freeze(['a project with no completion record and no written policy reads as an empty list of evidence with the documented default policy (owner-only, every class asking) at revision 0; that is the project\'s acceptance state, not an absence of one']),
    writes: false,
    effect: 'reads the acceptance policy in force and the project\'s completion records in order, each with the state of its durable Markdown file and the acceptance it holds; it records and accepts nothing'
  }),
  describe({
    id: 'acceptance.evidence.record' as const,
    label: 'Record completion evidence',
    description: 'Record one unit of work\'s completion evidence, freeze it and write its Markdown record.',
    requires: projectScope,
    parameters: Object.freeze([acceptanceEvidenceParameter]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project, so the record has a root to be written in' }),
      Object.freeze({ code: 'SESSION_EXISTS' as const, description: 'when the record names a session, that session is a live session of that project; an unknown one is refused as not found' }),
      Object.freeze({ code: 'EVIDENCE_SOURCE_READABLE' as const, description: 'a claimed count has a recorded output to be checked against: the output is present and inside the documented byte bound. An output that is absent or carries no count line is stored as a named absence instead, never assumed good' }),
      Object.freeze({ code: 'EVIDENCE_HONEST' as const, description: 'the evidence agrees with what it records: every result names a command the record says was run, no claimed count contradicts the count lines of its own recorded output, no result claims a pass or fail count for a command it also says was not run, the outcome agrees with the counts that same output carries (passed beside a failure, and failed beside a run with no failure, are refused), and a not-run command stores the named absence command-not-run instead of counts no run of it produced' }),
      Object.freeze({ code: 'DIFF_BOUNDED' as const, description: 'the diff carries a complete summary and the full diff either inlined inside the documented byte bound or referenced by a contained relative reference; an inlined diff over the bound or a diff with neither is refused' })
    ],
    noops: Object.freeze(['recording the same evidence again is the same record — its identity is derived from the canonical request — and it rewrites that record\'s Markdown so a file a crash never wrote is repaired']),
    writes: true,
    effect: 'validates and freezes one completion record (the work it belongs to, the exact revision it was produced from, the commands, the diff summary with the full diff referenced or inlined, the test evidence with the counts read from its own output, and the review verdict when there is one), writes it once in the durable store and renders it to Markdown inside the project'
  }),
  describe({
    id: 'acceptance.accept' as const,
    label: 'Accept an artifact',
    description: 'Accept one artifact exactly once, under the acceptance policy in force.',
    requires: projectScope,
    parameters: Object.freeze([acceptanceRequestParameter]),
    preconditions: [
      Object.freeze({ code: 'PROJECT_REGISTERED' as const, description: 'the project scope names a registered project' }),
      Object.freeze({ code: 'EVIDENCE_EXISTS' as const, description: 'the evidence id names a completion record of that project; an unknown one is refused as not found, and there is nothing to bind an acceptance to' }),
      Object.freeze({ code: 'ARTIFACT_UNCHANGED' as const, description: 'the artifact identity the request accepts is the exact revision (and commit) the evidence was produced from; an artifact that has changed since the evidence was produced is refused and needs new evidence' }),
      Object.freeze({ code: 'ARTIFACT_NOT_ACCEPTED' as const, description: 'the artifact has not already been accepted: an acceptance is single use, and a second one — in this process, from another handle, or after a crash and reopen — is refused and names the acceptance that already exists' }),
      Object.freeze({ code: 'ACCEPTOR_PERMITTED' as const, description: 'the policy mode permits this accepting identity: under owner-only an agent acceptance is refused outright, and the owner accepts instead' }),
      Object.freeze({ code: 'ACTION_CLASS_DECIDED' as const, description: 'the action class is decided for this accepting identity: the owner may always decide, and an agent only where the policy sets that class to full-auto; a class set to ask needs the owner\'s decision' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes one durable, single-use acceptance that names the exact artifact identity it accepted, the identity the request declares as accepting it (an owner identity, or an agent identity with the policy rule that permitted it), the policy revision and class decision in force, and when; it then rewrites the evidence\'s Markdown record so the repository copy carries the verdict, and reports the state of that file as it is read back, so a render that could not be written is reported as the file\'s own state rather than as a refusal after the decision is durable. It commits, pushes, deploys, spends, provisions and publishes nothing'
  }),
  describe({
    id: 'acceptance.policy.update' as const,
    label: 'Update the acceptance policy',
    description: 'Set the acceptance mode and the per-action-class ask-or-full-auto decision. Owner only.',
    requires: noScope,
    parameters: Object.freeze([acceptancePolicyRevisionParameter, acceptancePolicyParameter, acceptanceActorParameter]),
    preconditions: [
      Object.freeze({ code: 'REVISION_MATCHES' as const, description: 'the revision the caller read is the policy revision in force; a stale one is refused as a conflict and writes nothing' }),
      Object.freeze({ code: 'POLICY_OWNER_ONLY' as const, description: 'the actor is the owner; an agent identity is refused, because the policy that decides what an agent may accept is not something an agent may set' })
    ],
    noops: Object.freeze([]),
    writes: true,
    effect: 'writes the next revision of the acceptance policy — the mode and one ask-or-full-auto decision per action class — and reports the policy now in force'
  })
]);

const byId: Readonly<Record<string, ActionDescriptor>> = Object.freeze(
  Object.fromEntries(ACTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))
);
/** The descriptor for one id, or undefined. Lookup never invents an entry. */
export function actionDescriptor(id: string): ActionDescriptor | undefined {
  return byId[id];
}

/**
 * The live projection contract: what the owner-visible "what is actually happening" payload holds.
 *
 * It is declared here, beside the registry, because the projection is read-only and public to the
 * same authenticated owner: the server half produces exactly these fields and the client reads
 * exactly these fields, so neither can widen them quietly.
 *
 * The honesty rules the types encode:
 *
 * - `state` is a closed set, and the non-answers are distinct: `reported` (the harness reported
 *   tool activity), `none` (the harness reported a conversation with no tool activity yet),
 *   `no-conversation` (the harness reported no conversation at all, so there was nothing to read),
 *   `unavailable` (this instance cannot read the harness at all) and `failed` (the read was
 *   attempted and failed). Every non-`reported` state carries a named `reason`, so a conversation
 *   that does not exist is never reported as a conversation with nothing in it.
 * - A **run state** is only reported where the durable store holds a lifecycle row for that session.
 *   Where it holds none, the projection says so by name (`recorded: false` and an `absenceReason`)
 *   and reports no state at all: an absent row is never presented as the fact `idle`. `revision` is
 *   then 0 because that is the revision a first write must claim, not because a write happened.
 * - A **call** and a **result** are two lists, never one paired list: the conversation view this
 *   build can read does not carry the call id, so pairing them would assert something the data does
 *   not. Nothing here fabricates an entry to fill a view.
 * - No field carries a filesystem path, a token, a request identity or conversation text: a call is
 *   a name and an instant, a result is its diagnostic counts and the outcome they imply.
 */
export const LIVE_ACTIVITY_MAX_SESSIONS = 200;
export const LIVE_ACTIVITY_MAX_TOOL_EVENTS = 50;
/** The named reasons a tool projection may carry. Stable strings, safe to assert on. */
export const LIVE_TOOL_REASONS = Object.freeze({
  agentsDisabled: 'agents-disabled-on-this-instance',
  harnessReadFailed: 'harness-could-not-be-read',
  noToolActivity: 'no-tool-activity-reported-yet',
  noConversation: 'no-conversation-reported'
});
/** The fixed, path-free sentences that go with those reasons. */
export const LIVE_TOOL_DETAILS = Object.freeze({
  agentsDisabled: 'The agent harness is disabled on this instance, so no tool activity is reported.',
  harnessReadFailed: 'The agent harness could not be read in this process, so no tool activity is reported.',
  noToolActivity: 'The harness reports this project conversation with no tool invocation or result in its view yet.',
  noConversation: 'The harness reports no conversation for this project, so there is nothing that could carry tool activity yet.'
});
/** The one source a reported tool projection comes from. */
export const LIVE_TOOL_SOURCE = 'harness-conversation-view';
/** The named absence reasons a run-state projection may carry. Stable strings, safe to assert on. */
export const LIVE_RUN_REASONS = Object.freeze({
  noRecord: 'no-durable-lifecycle-record-yet'
});
/** The fixed, path-free sentences that go with those reasons. */
export const LIVE_RUN_DETAILS = Object.freeze({
  noRecord: 'The durable store holds no lifecycle row for this session yet, so no execution state is reported; the first lifecycle write is accepted at revision 0.'
});
/** The closed state set of the tool projection. */
export const LIVE_TOOL_STATES = ['reported', 'none', 'no-conversation', 'unavailable', 'failed'] as const;
export type LiveToolState = (typeof LIVE_TOOL_STATES)[number];

/**
 * The run state of one named session, as the durable lifecycle reports it — or the honest absence of
 * one. `recorded` is false only when the store holds no lifecycle row for this session; `state` is
 * then null, `absenceReason` and `absenceDetail` name why nothing is reported, and no instant is
 * invented. A session that really reads `idle` is `recorded: true` with `state: 'idle'`.
 */
export type LiveRunState = {
  readonly recorded: boolean;
  readonly absenceReason: string | null;
  readonly absenceDetail: string | null;
  readonly state: SessionLifecycleState | null;
  readonly attempt: number;
  readonly revision: number;
  readonly reason: string | null;
  readonly uncertain: boolean;
  readonly activityAt: string | null;
  readonly updatedAt: string | null;
};
/** One tool call the harness recorded: its name and when it was recorded. Never its arguments. */
export type LiveToolInvocation = { readonly name: string; readonly at: number | null };
/** One tool result the harness recorded: the diagnostics it carries, as counts, and the outcome they imply. */
export type LiveToolResult = {
  readonly outcome: 'failed' | 'warned' | 'ok';
  readonly errors: number;
  readonly warnings: number;
  readonly notices: number;
  readonly at: number | null;
};
export type LiveToolProjection = {
  readonly state: LiveToolState;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly source: string | null;
  readonly conversationId: string | null;
  /** The named session this conversation is recorded under, or null when it is none of them. */
  readonly sessionId: string | null;
  readonly working: boolean | null;
  readonly invocations: readonly LiveToolInvocation[];
  readonly results: readonly LiveToolResult[];
  readonly truncated: boolean;
};
export type LiveSessionActivity = { readonly sessionId: string; readonly name: string; readonly run: LiveRunState };
export type LiveActivity = {
  readonly readOnly: true;
  readonly projectId: string;
  readonly sessions: readonly LiveSessionActivity[];
  readonly harness: LiveToolProjection;
  readonly limits: { readonly sessions: number; readonly toolEvents: number };
  readonly truncated: boolean;
};
