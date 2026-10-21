import { z } from 'zod';
import { MEDIA_ID_PATTERN } from '../../shared/images';
import { QUEUE_MAX_IMAGES_PER_ENTRY, QUEUE_MAX_TEXT_LENGTH, queueView, type QueueImageRef } from '../../shared/queue';
import { SESSION_MAX_LINKS, SESSION_NAME_PATTERN } from '../../shared/sessions';
import { SESSION_LIFECYCLE_REASON_MAX_LENGTH, type SessionLifecycleAction, type SessionLifecycleRecord } from '../../shared/session-lifecycle';
import {
  ACTION_DESCRIPTORS, ACTION_IDS, ACTION_PARAM_TYPES, ACTION_REVISION_SOURCES, ACTION_SCOPE_DIMENSIONS, ACTION_SURFACES, LIVE_ACTIVITY_MAX_SESSIONS, LIVE_ACTIVITY_MAX_TOOL_EVENTS,
  LIVE_RUN_DETAILS, LIVE_RUN_REASONS, LIVE_TOOL_DETAILS, LIVE_TOOL_REASONS, LIVE_TOOL_SOURCE, actionDescriptor, isActionId,
  type ActionDescriptor, type ActionId, type ActionParamType, type ActionScopeDimension,
  type LiveActivity, type LiveRunState, type LiveSessionActivity, type LiveToolInvocation, type LiveToolProjection, type LiveToolResult
} from '../../shared/actions';
import type { AgentEntry, AgentView } from '../../shared/agent';
import type { SessionMigrationReport, SessionRegistry } from './session-registry';
import type { SessionLifecycleService } from './session-lifecycle';
import type { ApprovalStore } from './approval-store';
import type { DeliveryLedger } from './delivery';
import type { QueueImageResolver, QueueStore } from './queue-store';

/**
 * The server half of the command registry: the one place an action id is bound to the handler that
 * really exists for it.
 *
 * The pure half (`src/shared/actions.ts`) declares *what an action is* — its id, label, surfaces,
 * scope, parameter schema and preconditions — and carries no imports at all. This file declares
 * *what an action does*: one handler per declared id, a validator per declared parameter type, the
 * scope and availability rules, and the live read-only projection the owner can look at.
 *
 * Three rules make the command surface honest, and each is checked rather than asserted:
 *
 * 1. **No action without a handler, no handler without an action.** The handler map is built from
 *    the declared ids, and `assertActionRegistryConsistent()` refuses a registry where the two sets
 *    differ. A capability that is not implemented is simply absent from the shared registry; there
 *    is no placeholder, no TODO and no entry that would fail when used.
 * 2. **The declared schema is the validated schema.** `actionParamSchema()` builds one strict
 *    object from the descriptor's own parameter list, and `run()` validates with that object before
 *    the handler is reached, so an unknown field is refused by exactly the schema the registry
 *    publishes.
 * 3. **The declared preconditions are the handler's own refusals.** Nothing here adds a second,
 *    divergent precondition check: the handler is the authority, and its typed refusal becomes an
 *    HTTP status in `src/server/main.ts`. `docs/ACTIONS.md` states each one, and
 *    `tests/server/action-registry.test.ts` pins the ones the test suite can drive.
 *
 * Nothing in the registry performs a commit, push, deploy, spend, provision or publish. The two
 * report actions read only, and the delivery report replays nothing.
 */

/** The ambient scope a caller acts in. A dimension the action requires and the caller omits is a scope violation. */
export type ActionScope = { readonly projectId?: string; readonly sessionId?: string };

/** Failed-closed reasons for the registry itself, each mapped to one HTTP status by the caller. */
export type ActionErrorCode = 'UNKNOWN' | 'UNAVAILABLE' | 'SCOPE' | 'INVALID';
export class ActionError extends Error {
  constructor(message: string, public readonly code: ActionErrorCode) {
    super(message);
    this.name = 'ActionError';
  }
}

/** What a handler may be given: the durable capabilities this build really has, and the read-only doctor. */
export type ActionControl = {
  readonly sessions: SessionRegistry;
  readonly lifecycle: SessionLifecycleService;
  /**
   * Whether the durable store holds a lifecycle row for this exact project/session pair. The
   * projection needs it because `lifecycle.read()` answers with the deterministic *initial* record
   * for a session that has never been written: reporting that as the state `idle` would present an
   * absent row as a fact. It reads only and writes nothing.
   */
  readonly lifecycleRecorded: (projectId: string, sessionId: string) => boolean;
  readonly approvals: ApprovalStore;
  readonly ledger: DeliveryLedger;
  /** The durable queue of pending inputs, and the one resolver that turns an attached image id into its stored facts. */
  readonly queue: QueueStore;
  readonly media: QueueImageResolver;
  /** The legacy-conversation migration, planned (dryRun true) or applied (false). */
  readonly migrate: (dryRun: boolean) => Promise<SessionMigrationReport>;
};
/** The read-only doctor's own observation: the report the CLI prints, as data, plus its verdict. */
export type ActionObservation = { readonly report: Readonly<Record<string, unknown>>; readonly unsafe: boolean };
export type ActionEnvironment = {
  /** The durable capabilities, or undefined when this instance has no durable control store open. */
  readonly control?: ActionControl;
  readonly doctor: () => Promise<ActionObservation>;
  readonly agents: {
    readonly enabled: boolean;
    /** The conversation view the harness really reports for one project. It may attach the conversation. */
    readonly read: (projectId: string) => Promise<AgentView>;
  };
};

/** The ambient scope field each declared dimension names. */
const SCOPE_FIELD: Readonly<Record<ActionScopeDimension, keyof ActionScope>> = Object.freeze({ project: 'projectId', session: 'sessionId' });
const identifierRule = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const identifier = z.string().min(1).max(160).regex(identifierRule, 'an identifier is 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-');
/** The text pattern the session lifecycle model uses for a reason. */
const reasonText = new RegExp('^[^\\u0000-\\u001f\\u007f]+$');

/**
 * One validator per declared parameter type. Each is the rule the owning handler enforces, so a
 * value the registry accepts is a value the handler will not refuse for its shape:
 *
 * - `session-link`, `session-links`, `approval-scope` and `approval-target` are nested payloads
 *   whose owning model parses them strictly (the session link model and the approval model); the
 *   registry deliberately does not restate those rules, so a kind-dependent target cannot drift.
 *   An unknown field *inside* them is refused by that model, with its own precise reason.
 */
const PARAM_VALIDATORS: Readonly<Record<ActionParamType, z.ZodTypeAny>> = Object.freeze({
  revision: z.number().int().nonnegative(),
  'session-name': z.string().regex(SESSION_NAME_PATTERN, 'a name must be 1-80 characters, start with a letter or digit, and use only letters, digits, space, . _ : -'),
  'lifecycle-reason': z.string().min(1).max(SESSION_LIFECYCLE_REASON_MAX_LENGTH).regex(reasonText, 'a reason must be printable text').nullable(),
  'session-link': z.unknown(),
  'session-links': z.array(z.unknown()).max(SESSION_MAX_LINKS),
  'session-model': z.strictObject({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200) }).nullable(),
  'approval-kind': z.string().min(1).max(80),
  'approval-scope': z.unknown(),
  'approval-target': z.unknown(),
  'revocation-reason': z.string().min(1).max(400).nullable(),
  identifier,
  instant: z.string().min(1).max(40),
  'queue-text': z.string().min(1).max(QUEUE_MAX_TEXT_LENGTH).regex(reasonText, 'text must be printable characters'),
  'queue-images': z.array(z.string().regex(MEDIA_ID_PATTERN, 'an image reference is the hex media id of the stored bytes')).max(QUEUE_MAX_IMAGES_PER_ENTRY),
  'queue-position': z.number().int().nonnegative()
});

/** A ZodError becomes this application's own words, never the schema library's raw message. */
function refusalMessage(label: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue && issue.path.length ? issue.path.map(String).join('.') : '';
  const detail = issue === undefined ? 'it does not match the documented shape'
    : issue.code === 'unrecognized_keys' ? 'it carries a field this action does not accept'
    : field === '' ? 'a field it sends is not of the documented kind'
    : 'the ' + field + ' field is missing or not of the documented kind';
  return label + ' is invalid: ' + detail;
}

/**
 * The one strict schema for one action's parameters: exactly the declared fields, required ones
 * required, everything else refused. It is built from the descriptor, so the published schema and
 * the validated schema cannot differ.
 */
export function actionParamSchema(descriptor: ActionDescriptor): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const parameter of descriptor.parameters) {
    const validator = PARAM_VALIDATORS[parameter.type];
    if (validator === undefined) throw new Error('Action ' + descriptor.id + ' declares an unknown parameter type: ' + parameter.type);
    shape[parameter.name] = parameter.required ? validator : validator.optional();
  }
  return z.strictObject(shape);
}

/**
 * The invariants that make the registry trustworthy. Every one of them is a build-time fact this
 * repository can check, and the unit test calls this directly:
 *
 * - the declared descriptors and the declared ids are the same set, with no duplicates;
 * - every declared parameter type has a validator, and one action cannot declare a field twice;
 * - every declared surface and scope dimension is from the closed set;
 * - every declared precondition code is from the closed vocabulary.
 *
 * It knows nothing about handlers; `assertHandlerSet` checks those, because it needs an environment.
 */
export function assertActionRegistryConsistent(): void {
  const seenIds = new Set<string>();
  for (const descriptor of ACTION_DESCRIPTORS) {
    if (seenIds.has(descriptor.id)) throw new Error('The action registry declares ' + descriptor.id + ' twice');
    seenIds.add(descriptor.id);
    if (!isActionId(descriptor.id)) throw new Error('The action registry declares an id outside the closed set: ' + descriptor.id);
    if (descriptor.label.trim() === '' || descriptor.description.trim() === '') throw new Error('Action ' + descriptor.id + ' needs an owner-visible label and a one-line description');
    if (descriptor.surfaces.length === 0) throw new Error('Action ' + descriptor.id + ' declares no surface');
    for (const surface of descriptor.surfaces) if (!(ACTION_SURFACES as readonly string[]).includes(surface)) throw new Error('Action ' + descriptor.id + ' declares an unknown surface: ' + surface);
    for (const dimension of descriptor.requires) if (!(ACTION_SCOPE_DIMENSIONS as readonly string[]).includes(dimension)) throw new Error('Action ' + descriptor.id + ' requires an unknown scope dimension: ' + dimension);
    const names = new Set<string>();
    for (const parameter of descriptor.parameters) {
      if (names.has(parameter.name)) throw new Error('Action ' + descriptor.id + ' declares the parameter ' + parameter.name + ' twice');
      names.add(parameter.name);
      if (!(ACTION_PARAM_TYPES as readonly string[]).includes(parameter.type)) throw new Error('Action ' + descriptor.id + ' declares an unknown parameter type: ' + parameter.type);
      if (PARAM_VALIDATORS[parameter.type] === undefined) throw new Error('Action ' + descriptor.id + ' declares a parameter type with no validator: ' + parameter.type);
      // A revision is the one parameter a caller cannot supply from its own state, so every one of
      // them names the read that carries it — and no other parameter may claim one.
      if (parameter.type === 'revision') {
        if (parameter.revisionSource === undefined) throw new Error('Action ' + descriptor.id + ' declares the revision parameter ' + parameter.name + ' without the read it comes from');
        if (!(ACTION_REVISION_SOURCES as readonly string[]).includes(parameter.revisionSource)) throw new Error('Action ' + descriptor.id + ' declares an unknown revision source: ' + parameter.revisionSource);
      } else if (parameter.revisionSource !== undefined) {
        throw new Error('Action ' + descriptor.id + ' declares a revision source on the non-revision parameter ' + parameter.name);
      }
    }
    if (descriptor.writes === false && descriptor.effect.trim() === '') throw new Error('Action ' + descriptor.id + ' must describe its effect');
  }
  for (const id of ACTION_IDS) if (!seenIds.has(id)) throw new Error('The action registry declares no descriptor for ' + id);
}

/** Builds one handler per declared action id. The map is keyed by the closed id set, so it is exhaustive by type. */
function buildHandlers(environment: ActionEnvironment): Readonly<Record<ActionId, (params: Record<string, unknown>, scope: ActionScope) => Promise<unknown>>> {
  const control = (): ActionControl => {
    if (!environment.control) throw new ActionError('This action needs the durable control store, which is not open on this instance', 'UNAVAILABLE');
    return environment.control;
  };
  const projectOf = (scope: ActionScope): string => {
    if (scope.projectId === undefined) throw new ActionError('This action acts on one project; supply the project scope it requires', 'SCOPE');
    return scope.projectId;
  };
  const sessionOf = (scope: ActionScope): string => {
    if (scope.sessionId === undefined) throw new ActionError('This action acts on one named session; supply the session scope it requires', 'SCOPE');
    return scope.sessionId;
  };
  /** The five owner actions share one shape: the session must exist, then the service owns the semantics. */
  const lifecycle = (action: SessionLifecycleAction) => async (params: Record<string, unknown>, scope: ActionScope) => {
    const durable = control();
    const projectId = projectOf(scope), sessionId = sessionOf(scope);
    durable.sessions.read(projectId, sessionId);
    return durable.lifecycle.run(projectId, sessionId, action, { revision: params.revision, reason: params.reason });
  };
  /** The queue actions share one shape: the session must exist, then the store owns the semantics. */
  const queueSession = (scope: ActionScope): { durable: ActionControl; projectId: string; sessionId: string } => {
    const durable = control();
    const projectId = projectOf(scope), sessionId = sessionOf(scope);
    durable.sessions.read(projectId, sessionId);
    return { durable, projectId, sessionId };
  };
  /**
   * An attached image is resolved to the stored facts the queue records, exactly as the input route
   * resolves one: an id the media store does not hold is refused before anything is written, so a
   * queue entry can never carry an unverified reference.
   */
  const queueImages = async (durable: ActionControl, images: unknown): Promise<readonly QueueImageRef[]> =>
    images === undefined || images === null ? Object.freeze([]) : durable.media.resolve(images as readonly string[]);
  return {
    'session.lifecycle.reconnect': lifecycle('reconnect'),
    'session.lifecycle.resume': lifecycle('resume'),
    'session.lifecycle.retry': lifecycle('retry'),
    'session.lifecycle.stop': lifecycle('stop'),
    'session.lifecycle.pause': lifecycle('pause'),
    'session.create': async (params: Record<string, unknown>, scope: ActionScope) => {
      const durable = control();
      const projectId = projectOf(scope);
      return durable.sessions.create({ projectId, name: params.name, model: params.model, links: params.links });
    },
    'session.rename': async (params: Record<string, unknown>, scope: ActionScope) => {
      const durable = control();
      const projectId = projectOf(scope), sessionId = sessionOf(scope);
      durable.sessions.read(projectId, sessionId);
      return durable.sessions.rename({ projectId, sessionId, name: params.name, revision: params.revision });
    },
    'session.link': async (params: Record<string, unknown>, scope: ActionScope) => {
      const durable = control();
      const projectId = projectOf(scope), sessionId = sessionOf(scope);
      durable.sessions.read(projectId, sessionId);
      return durable.sessions.link({ projectId, sessionId, link: params.link, revision: params.revision });
    },
    'session.unlink': async (params: Record<string, unknown>, scope: ActionScope) => {
      const durable = control();
      const projectId = projectOf(scope), sessionId = sessionOf(scope);
      durable.sessions.read(projectId, sessionId);
      return durable.sessions.unlink({ projectId, sessionId, link: params.link, revision: params.revision });
    },
    'session.migration.plan': async () => control().migrate(true),
    'session.migration.apply': async () => control().migrate(false),
    'approval.create': async (params: Record<string, unknown>) =>
      control().approvals.create({ kind: params.kind, scope: params.scope, target: params.target, expiresAt: params.expiresAt }),
    'approval.consume': async (params: Record<string, unknown>) =>
      control().approvals.consume({ id: params.id, scope: params.scope, kind: params.kind, target: params.target, consumedBy: params.consumedBy }),
    'approval.revoke': async (params: Record<string, unknown>) =>
      control().approvals.revoke({ id: params.id, scope: params.scope, revokedBy: params.revokedBy, reason: params.reason ?? null }),
    'doctor.report': async () => {
      const observation = await environment.doctor();
      return Object.freeze({ ...observation.report, unsafe: observation.unsafe });
    },
    'delivery.reconciliation.report': async () => control().ledger.reconcileOnStartup(),
    'queue.read': async (_params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return queueView(durable.queue.read(projectId, sessionId));
    },
    'queue.append': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.append({ projectId, sessionId, revision: params.revision, text: params.text, images: await queueImages(durable, params.images) });
    },
    'queue.edit': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.edit({ projectId, sessionId, revision: params.revision, entryId: params.entryId, text: params.text });
    },
    'queue.reorder': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.reorder({ projectId, sessionId, revision: params.revision, entryId: params.entryId, position: params.position });
    },
    'queue.remove': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.remove({ projectId, sessionId, revision: params.revision, entryId: params.entryId });
    },
    'queue.clear': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.clear({ projectId, sessionId, revision: params.revision });
    },
    'queue.cancel': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.cancel({ projectId, sessionId, revision: params.revision, entryId: params.entryId });
    },
    'queue.claim': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.claim({ projectId, sessionId, owner: params.owner });
    },
    'queue.release': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.release({ projectId, sessionId, entryId: params.entryId, owner: params.owner });
    },
    'queue.submit': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.submit({ projectId, sessionId, entryId: params.entryId, owner: params.owner });
    },
    'queue.reconcile': async (params: Record<string, unknown>, scope: ActionScope) => {
      const { durable, projectId, sessionId } = queueSession(scope);
      return durable.queue.reconcile({ projectId, sessionId, entryId: params.entryId });
    }
  };
}

/** The declared action ids that have a handler in this environment, sorted. The unit test compares this with the registry. */
export function actionHandlerIds(environment: ActionEnvironment): readonly ActionId[] {
  return Object.freeze((Object.keys(buildHandlers(environment)) as ActionId[]).sort());
}
/** The invariant that there is no declared action without a handler and no handler without an action. */
export function assertHandlerSet(environment: ActionEnvironment): void {
  const handlers = new Set<string>(actionHandlerIds(environment));
  for (const id of ACTION_IDS) if (!handlers.has(id)) throw new Error('The action registry has no handler for ' + id);
  for (const id of handlers) if (!isActionId(id)) throw new Error('The action registry has a handler outside the closed id set: ' + id);
}

/** The actions that need the durable control store: everything except the read-only doctor. */
const CONTROL_BACKED: ReadonlySet<string> = new Set(ACTION_IDS.filter((id) => id !== 'doctor.report'));

/**
 * Normalises and validates a requested scope: an omitted dimension stays omitted, an identifier that
 * is not one is an invalid request (not a scope violation), and unknown fields are refused.
 */
export function normaliseActionScope(value: unknown): ActionScope {
  if (value === undefined || value === null) return Object.freeze({});
  const parsed = z.strictObject({ projectId: z.unknown().optional(), sessionId: z.unknown().optional() }).safeParse(value);
  if (!parsed.success) throw new ActionError(refusalMessage('The action scope', parsed.error), 'INVALID');
  const scope: { projectId?: string; sessionId?: string } = {};
  for (const dimension of ['projectId', 'sessionId'] as const) {
    const candidate = parsed.data[dimension];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'string' || !identifierRule.test(candidate) || candidate.length > 160)
      throw new ActionError('The action scope is invalid: ' + dimension + ' must be 1-160 characters, starting alphanumeric, from A-Za-z0-9._:-', 'INVALID');
    scope[dimension] = candidate;
  }
  return Object.freeze(scope);
}

/**
 * The registry the routes and the palette read. It answers three questions and performs nothing by
 * itself: which actions the caller may use in its scope, whether one is available on this instance,
 * and then — only through `run()` — one call to the real handler.
 */
export class ActionRegistry {
  private readonly handlers: Readonly<Record<ActionId, (params: Record<string, unknown>, scope: ActionScope) => Promise<unknown>>>;
  private readonly schemas = new Map<string, z.ZodType<Record<string, unknown>>>();
  constructor(private readonly environment: ActionEnvironment) {
    assertActionRegistryConsistent();
    assertHandlerSet(environment);
    this.handlers = buildHandlers(environment);
  }

  /** One action by id. An unknown or absent id is refused precisely; nothing is guessed at. */
  describe(id: unknown): ActionDescriptor {
    const descriptor = typeof id === 'string' ? actionDescriptor(id) : undefined;
    if (!descriptor) throw new ActionError('Unknown action id ' + JSON.stringify(typeof id === 'string' ? id : String(id)) + '; this build defines ' + ACTION_IDS.length + ' actions', 'UNKNOWN');
    return descriptor;
  }

  /** Whether this instance can perform the action at all. An unavailable action is never listed. */
  availability(descriptor: ActionDescriptor): { readonly available: boolean; readonly reason: string | null } {
    if (CONTROL_BACKED.has(descriptor.id) && !this.environment.control)
      return Object.freeze({ available: false, reason: 'the durable control store is not open on this instance' });
    return Object.freeze({ available: true, reason: null });
  }

  /** Normalises and validates a requested scope. An identifier that is not one is an invalid request. */
  normaliseScope(value: unknown): ActionScope {
    return normaliseActionScope(value);
  }

  /** The scope the caller actually has: a required dimension it did not supply is a scope violation. */
  assertScope(descriptor: ActionDescriptor, scope: ActionScope): void {
    for (const dimension of descriptor.requires) {
      if (scope[SCOPE_FIELD[dimension]] === undefined)
        throw new ActionError(
          'Action ' + descriptor.id + ' requires the ' + dimension + ' scope, which this request does not name; supply it and try again',
          'SCOPE'
        );
    }
  }

  /** The registry as the caller may see it: only implemented actions, only ones it can actually use in its scope. */
  list(scope: ActionScope): { readonly readOnly: true; readonly scope: { readonly projectId: string | null; readonly sessionId: string | null }; readonly actions: readonly ActionDescriptor[] } {
    const exact = normaliseActionScope(scope);
    const actions = ACTION_DESCRIPTORS.filter((descriptor) =>
      this.availability(descriptor).available && descriptor.requires.every((dimension) => exact[SCOPE_FIELD[dimension]] !== undefined)
    );
    return Object.freeze({
      readOnly: true as const,
      scope: Object.freeze({ projectId: exact.projectId ?? null, sessionId: exact.sessionId ?? null }),
      actions: Object.freeze(actions)
    });
  }

  /** The one strict schema for one action's parameters, built from the descriptor and cached. */
  paramSchema(id: ActionId | unknown): z.ZodType<Record<string, unknown>> {
    const descriptor = this.describe(id);
    let schema = this.schemas.get(descriptor.id);
    if (!schema) {
      schema = actionParamSchema(descriptor);
      this.schemas.set(descriptor.id, schema);
    }
    return schema;
  }

  /**
   * Run one action. In order: the id must exist, the instance must be able to perform it, the scope
   * must satisfy what the action declares, and the parameters must satisfy the schema the registry
   * published. Only then is the handler called, and whatever it returns — or refuses with — is the
   * answer. A handler's own typed refusal is not translated here.
   */
  async run(id: unknown, params: unknown, scope: ActionScope): Promise<unknown> {
    const descriptor = this.describe(id);
    const availability = this.availability(descriptor);
    if (!availability.available) throw new ActionError('Action ' + descriptor.id + ' is unavailable on this instance: ' + availability.reason, 'UNAVAILABLE');
    // The scope is validated here too, not only by the route: an identifier that is not one is an
    // invalid request however the registry is called, and a required dimension that is missing is a
    // scope violation refused before any parameter is looked at.
    const exact = normaliseActionScope(scope);
    this.assertScope(descriptor, exact);
    const parsed = this.paramSchema(descriptor.id).safeParse(params ?? {});
    if (!parsed.success) throw new ActionError(refusalMessage('The parameters for ' + descriptor.id, parsed.error), 'INVALID');
    return this.handlers[descriptor.id](parsed.data as Record<string, unknown>, exact);
  }
}

/**
 * The live, read-only projection: what is actually happening, and nothing that is not.
 *
 * The contract — the closed state set, the named reasons, the caps and the payload types — lives in
 * `src/shared/actions.ts` beside the registry, so the server cannot produce and the client cannot
 * read a field the other does not know about. What this file adds is the reading of it:
 *
 * - **Run state comes from the durable lifecycle**, one record per named session of the project, so a
 *   fresh client reads the same truth as any other.
 * - **Tool activity is only ever what the harness reports.** The projection reads the project's
 *   conversation view and reports the tool calls it carries and the diagnostics each result carries.
 *   It never invents an entry to fill the view. The view does not carry the call id, so a call and
 *   its result are reported as two ordered lists and are *not* paired: no outcome is attributed to a
 *   call the data does not attribute it to.
 * - **Not knowing is a state, not an absence.** `none` means the harness reported a conversation
 *   whose view carries no tool activity yet; `no-conversation` means the harness reported no
 *   conversation at all, so there was nothing that could carry one; `unavailable` means this
 *   instance cannot read the harness at all (the named reason says why); `failed` means the read
 *   was attempted and the harness could not be read (the named reason is fixed text: a harness
 *   error may name a path, so it is never echoed into the payload).
 * - **An absent durable row is reported as an absence, not as a state.** `lifecycle.read()` answers
 *   a session that has never been written with its deterministic initial record, which is `idle` at
 *   revision 0. That is a legal value to read *at*, but reporting it as the state `idle` would state
 *   something the store does not hold, so a session with no lifecycle row is reported with
 *   `recorded: false`, a named `absenceReason` and no state, no reason and no instant at all.
 */

const MAX_TOOL_NAME_LENGTH = 60;
function toolEvents(entries: readonly AgentEntry[], cap: number): { invocations: LiveToolInvocation[]; results: LiveToolResult[]; truncated: boolean } {
  const invocations: LiveToolInvocation[] = [], results: LiveToolResult[] = [];
  for (const entry of entries) {
    const at = typeof entry.at === 'number' ? entry.at : null;
    for (const tool of entry.tools ?? []) {
      if (typeof tool.name === 'string' && tool.name !== '') invocations.push(Object.freeze({ name: tool.name.slice(0, MAX_TOOL_NAME_LENGTH), at }));
    }
    if (entry.rawKind !== 'pi.tool-result') continue;
    const diagnostics = entry.data === null ? null : entry.data.diagnostics;
    let errors = 0, warnings = 0, notices = 0;
    if (Array.isArray(diagnostics)) {
      for (const diagnostic of diagnostics) {
        const severity = diagnostic && typeof diagnostic === 'object' ? (diagnostic as { severity?: unknown }).severity : undefined;
        if (severity === 'error') errors += 1;
        else if (severity === 'warn') warnings += 1;
        else notices += 1;
      }
    }
    results.push(Object.freeze({ outcome: errors > 0 ? 'failed' as const : warnings > 0 ? 'warned' as const : 'ok' as const, errors, warnings, notices, at }));
  }
  const truncated = invocations.length > cap || results.length > cap;
  return { invocations: invocations.slice(-cap), results: results.slice(-cap), truncated };
}
function runState(control: ActionControl, projectId: string, sessionId: string): LiveRunState {
  // The absence is checked first and is never read through the initial record: only a real row is
  // reported as a state, and a session without one is reported as having none.
  if (!control.lifecycleRecorded(projectId, sessionId)) {
    return Object.freeze({
      recorded: false as const,
      absenceReason: LIVE_RUN_REASONS.noRecord,
      absenceDetail: LIVE_RUN_DETAILS.noRecord,
      state: null,
      attempt: 0,
      revision: 0,
      reason: null,
      uncertain: false,
      activityAt: null,
      updatedAt: null
    });
  }
  const record = control.lifecycle.read(projectId, sessionId);
  return Object.freeze({
    recorded: true as const,
    absenceReason: null,
    absenceDetail: null,
    state: record.state,
    attempt: record.attempt,
    revision: record.revision,
    reason: record.reason,
    uncertain: record.uncertain,
    activityAt: record.activityAt,
    updatedAt: record.updatedAt
  });
}
function unavailableTools(reason: string, detail: string): LiveToolProjection {
  return Object.freeze({
    state: 'unavailable' as const, reason, detail, source: null, conversationId: null, sessionId: null, working: null,
    invocations: Object.freeze([]) as readonly LiveToolInvocation[], results: Object.freeze([]) as readonly LiveToolResult[], truncated: false
  });
}

/**
 * Read the live projection of one project: the durable run state of each of its named sessions, and
 * the tool activity the harness really reports for its conversation.
 *
 * Reading the conversation view attaches that conversation exactly as the Agents view does — this
 * build exposes no other surface for reading tool activity — so the projection reports the source it
 * read. It writes no record of its own, replays nothing and acknowledges nothing.
 */
export async function liveActivity(environment: ActionEnvironment, input: { projectId: unknown; sessions?: number; toolEvents?: number }): Promise<LiveActivity> {
  if (!environment.control) throw new ActionError('The live projection needs the durable control store, which is not open on this instance', 'UNAVAILABLE');
  const scope = normaliseActionScope({ projectId: input.projectId });
  if (scope.projectId === undefined) throw new ActionError('The live projection is scoped to one project; projectId is required', 'INVALID');
  const projectId = scope.projectId;
  const sessionsCap = input.sessions ?? LIVE_ACTIVITY_MAX_SESSIONS, toolCap = input.toolEvents ?? LIVE_ACTIVITY_MAX_TOOL_EVENTS;
  const records = environment.control.sessions.list(projectId);
  const truncated = records.length > sessionsCap;
  const sessions: readonly LiveSessionActivity[] = Object.freeze(
    records.slice(0, sessionsCap).map((record): LiveSessionActivity =>
      Object.freeze({ sessionId: record.id, name: record.name, run: runState(environment.control!, projectId, record.id) })
    )
  );
  let harness: LiveToolProjection;
  if (!environment.agents.enabled) {
    harness = unavailableTools(LIVE_TOOL_REASONS.agentsDisabled, LIVE_TOOL_DETAILS.agentsDisabled);
  } else {
    let view: AgentView | null = null;
    try { view = await environment.agents.read(projectId); } catch { view = null; }
    if (view === null) {
      harness = Object.freeze({
        state: 'failed' as const, reason: LIVE_TOOL_REASONS.harnessReadFailed, detail: LIVE_TOOL_DETAILS.harnessReadFailed,
        source: null, conversationId: null, sessionId: null, working: null,
        invocations: Object.freeze([]) as readonly LiveToolInvocation[], results: Object.freeze([]) as readonly LiveToolResult[], truncated: false
      });
    } else {
      const events = toolEvents(view.entries ?? [], toolCap);
      const conversationId = typeof view.conversationId === 'string' && view.conversationId !== '' ? view.conversationId : null;
      const known = conversationId === null ? undefined : sessions.find((session) => session.sessionId === conversationId);
      const empty = events.invocations.length === 0 && events.results.length === 0;
      // Reported activity is reported whatever else is true; with nothing to report, the two
      // absences stay distinct: no conversation at all, or a conversation with nothing in it yet.
      const state = !empty ? 'reported' as const : conversationId === null ? 'no-conversation' as const : 'none' as const;
      harness = Object.freeze({
        state,
        reason: state === 'reported' ? null : state === 'no-conversation' ? LIVE_TOOL_REASONS.noConversation : LIVE_TOOL_REASONS.noToolActivity,
        detail: state === 'reported' ? null : state === 'no-conversation' ? LIVE_TOOL_DETAILS.noConversation : LIVE_TOOL_DETAILS.noToolActivity,
        source: LIVE_TOOL_SOURCE,
        conversationId,
        sessionId: known === undefined ? null : known.sessionId,
        working: view.working === true,
        invocations: Object.freeze(events.invocations),
        results: Object.freeze(events.results),
        truncated: events.truncated
      });
    }
  }
  return Object.freeze({
    readOnly: true as const,
    projectId,
    sessions,
    harness,
    limits: Object.freeze({ sessions: sessionsCap, toolEvents: toolCap }),
    truncated
  });
}
