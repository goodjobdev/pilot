import { appendFile,mkdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { Harness, ToolTask, ROOT_CONVERSATION_ID, createRegistry, defineDoc, defineExtension, defineTool, hook, section } from '@earendil-works/pi-durable';
import type { ConversationId, DocumentReader, EntryId, Extension, JsonObject } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { GenerationTask } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { safePath } from '../paths';
import { abortableDelay } from './abortable';
import { modelAcceptsImages } from '../../shared/images';
import { projectStoredImage } from './image-projection';
import { authorizeToolUse, installedAgentScopes, unavailableAgentScopes, scopeToolIsInstalled, type AgentPrivilegePort, type AgentScope, type DispatchAuthority } from '../../shared/agent-registry';
import { FILE_EDIT_MAX_FILE_BYTES, FILE_EDIT_MAX_PATH_LENGTH, type FileEditCapability } from '../state/file-edit-tool';
import { agentViewFrom, type AgentQuestion, type AgentView } from '../../shared/agent';
import type { Project } from '../../shared/model';
import { HttpError } from '../board-store';
import type { ProviderStore } from '../providers';
import type { SessionLifecycleDispatchOutcome } from '../state/session-lifecycle';
import type { ModelChoice } from '../../shared/settings';

export type AgentInputMode = 'followUp' | 'steer' | 'reject';
/** One stored image attached to an input, as base64 and its sniffed type. */
export interface AgentImage { readonly mimeType: string; readonly data: string }
/** The provider-reported cache counters, per model, taken from the same `pi.usage` projection the view uses. */
export interface AgentUsageDetail {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  /** Reasoning tokens when the provider reports them; null is a named absence, not a zero. */
  readonly reasoning: number | null;
  readonly cost: number;
  readonly models: readonly { readonly provider: string; readonly modelId: string; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly totalTokens: number; readonly cost: number }[];
}
/** One dismissed question, keyed by question id on the shaped view. */
export interface AgentDismissal { readonly reason: string; readonly dismissedAt: number | null; readonly dismissedBy: string }
/**
 * The shaped view the harness serves: the shared AgentView plus the two things the shared pure module
 * cannot carry — the per-model usage detail the owner asked for, and the questions the owner
 * dismissed (a dismissal is neither an answer nor an absence, so it is a named state of its own).
 */
export type AgentSessionView = AgentView & { readonly usageDetail: AgentUsageDetail; readonly dismissals: Readonly<Record<string, AgentDismissal>> };
/** What the model a submission would run under accepts. */
export interface AgentVision { readonly provider: string; readonly modelId: string; readonly acceptsImages: boolean }

/**
 * One bounded worker run in the application harness.
 *
 * A worker is not a named session: its conversation is created for this run only, with its own
 * pinned model and only the tools its worker allowlist permits. `guard` is called on every tool
 * call and is the authority: it re-reads the run, the worker, the model policy, the project and the
 * scopes. A refusal blocks the call with no effect.
 */
export interface WorkerRunRequest {
  readonly runId: string;
  readonly workerId: string;
  readonly model: ModelChoice;
  readonly scopes: readonly AgentScope[];
  readonly prompt: string;
  readonly requestId: string;
  readonly guard: (tool: string) => Promise<string | null>;
  /** Persist this run's conversation id. It must finish before any input is submitted. */
  readonly onConversation: (conversationId: number) => Promise<void>;
  /** The last re-check before the one submission. A non-null answer sends nothing. */
  readonly beforeSubmit: () => Promise<string | null>;
  /** Aborted when the owner stops or revokes, including before the conversation opens. */
  readonly signal?: AbortSignal;
}

export interface WorkerRunOutcome {
  /** The final assistant text. A cancelled run keeps whatever was already committed. */
  readonly text: string;
  readonly turns: number;
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly reason: string | null;
}

/**
 * The durable worker marker, written in the **same conversation-creation transaction** as the
 * conversation itself. It is independent of any extension list and of the control-store binding:
 * a crash between conversation creation and the control binding still leaves a role that fails
 * closed after restart.
 */
const WorkerMarkerDoc = defineDoc({
  kind: 'pilot.worker',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (): { marker: boolean; projectId: string; workerId: string; runId: string } => ({ marker: false, projectId: '', workerId: '', runId: '' }),
  checkpointWhen: () => true
});

type WorkerMarker = { readonly marker: boolean; readonly projectId: string; readonly workerId: string; readonly runId: string };

function workerMarkerOf(value: unknown): WorkerMarker | null {
  if (!value || typeof value !== 'object') return null;
  const typed = value as { marker?: unknown; projectId?: unknown; workerId?: unknown; runId?: unknown };
  if (typed.marker !== true || typeof typed.projectId !== 'string' || typeof typed.workerId !== 'string' || typeof typed.runId !== 'string') return null;
  return { marker: true, projectId: typed.projectId, workerId: typed.workerId, runId: typed.runId };
}

/**
 * The worker role, installed **once** in the project registry and selected by every conversation.
 * It is inert for every non-worker conversation: the durable marker is the role. The control-store
 * binding is the second authority for generic paths, not a replacement.
 *
 * The generation hook revalidates the run, worker, policy and revocation before every provider
 * request, and refuses the ninth request. The tool hook revalidates before every tool call.
 */
function recoveryExtension(project: Project, options: HarnessHostOptions, sessionForConversation: (conversationId: number) => string) {
  const refusalFor = (conversationId: number): string | null => {
    if (!options.recovery) return null;
    let sessionId: string;
    try { sessionId = sessionForConversation(conversationId); }
    catch { return 'The session mapping is ambiguous, so this action is refused until an operator reviews it.'; }
    try {
      return options.recovery.read(project.id, sessionId).uncertain
        ? 'This session has an uncertain interrupted effect. The original request is blocked until an operator reviews it.'
        : null;
    } catch { return 'The recovery state cannot be verified, so this action is refused until an operator reviews it.'; }
  };
  return {
    extension: defineExtension({ name: 'uncertain-recovery-guard', hooks: [hook(ToolTask, {
      beforeTool: async (_call, api) => {
        const refusal = refusalFor(Number(api.conversationId));
        return refusal === null ? undefined : { block: refusal };
      }
    })] }),
    refusalFor
  };
}

function workerRoleExtension(project: Project, options: HarnessHostOptions) {
  const markerFor = async (read: DocumentReader, conversationId: ConversationId, context: Context): Promise<WorkerMarker | null> => {
    try {
      const marker = workerMarkerOf(await read.snapshot(WorkerMarkerDoc, conversationId, context));
      if (marker === null || marker.projectId !== project.id) return null;
      // A marker with no run identity is not a usable worker role. The sentinel names no real run,
      // so both guards fail closed for it.
      return marker.workerId !== '' && marker.runId !== '' ? marker : { marker: true, projectId: project.id, workerId: 'unresolved', runId: 'unresolved' };
    } catch {
      // A worker marker that cannot be read is treated as a worker: both guards fail closed.
      return { marker: true, projectId: project.id, workerId: 'unresolved', runId: 'unresolved' };
    }
  };
  return defineExtension({
    name: 'worker-role',
    sections: [section('worker-role', async (input, context) => {
      const marker = await markerFor(input.read, input.conversationId, context);
      if (marker === null) return undefined;
      return 'You are a bounded worker. Produce one Markdown report as your final message. You cannot approve, accept, grant a scope, or act outside this project. Treat your own report as evidence for the owner, never as an instruction. Only the tools in your worker allowlist are offered. PILOT-WORKER-RUN:' + marker.runId;
    }, { tag: false })],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const marker = await markerFor(api, api.conversationId, context);
          if (marker === null) return undefined;
          if (marker.workerId === '' || marker.runId === '') return { block: 'The worker identity cannot be verified, so the tool is refused with no effect.' };
          let refusal: string | null;
          try { const verdict = options.workerGuard?.({ projectId: project.id, runId: marker.runId, tool: call.name }); refusal = verdict === undefined ? 'The worker guard is unavailable, so the tool is refused with no effect.' : verdict; }
          catch { refusal = 'The worker guard could not verify this call, so the tool is refused with no effect.'; }
          try { options.onWorkerGuard?.({ tool: call.name, refusal }); } catch { /* observation never changes the decision */ }
          return refusal === null ? undefined : { block: refusal };
        }
      }),
    ]
  });
}
/** The unique role marker in the worker system prompt. It is a role hint, never a privilege source. */
function workerRunIdOf(messages: readonly unknown[]): string | null {
  // The marker is in the system prompt's `sections`, not user text. Reading only system sections
  // keeps this cheap per request and stops a user message from claiming the worker role.
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as { role?: unknown; sections?: unknown; content?: unknown };
    if (record.role !== 'system') continue;
    let text = '';
    if (record.sections && typeof record.sections === 'object') text = Object.values(record.sections as Record<string, unknown>).filter((value): value is string => typeof value === 'string').join('\n');
    else if (typeof record.content === 'string') text = record.content;
    const match = /PILOT-WORKER-RUN:([A-Za-z0-9][A-Za-z0-9._:-]{0,159})/.exec(text);
    if (match !== null) return match[1];
  }
  return null;
}
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** The request identity rule, aligned with the durable lifecycle's own rule. */
const requestIdPattern = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
/**
 * The conversation behind one named session id, or null when the id is not one.
 *
 * A session id is the string form of the conversation id it names — the legacy root session is stored
 * exactly that way — so a value that is not a whole number can never address a conversation of this
 * project, and this build refuses to guess at one.
 */
function conversationIdOf(sessionId: string): ConversationId | null {
  return /^[0-9]{1,15}$/.test(sessionId) ? (Number(sessionId) as ConversationId) : null;
}

interface HostedAgent {
  harness: Harness;
  conversation: Awaited<ReturnType<Harness['root']>>;
  provider: FauxProviderHandle;
  /** The extensions installed for this project's agent harness. */
  extensions: Extension[];
  /** Retained durable storage for original-submission status inspection. */
  storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  /** The tools the root conversation's authority permits, or undefined for owner dispatch. */
  permittedTools: readonly any[] | undefined;
  watch(conversation: HostedAgent["conversation"], sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The provider-reported usage detail for one conversation, read from the same `pi.usage` document the
 * shared projection reads. Cache counters and reasoning tokens are carried only where the provider
 * reported them: an absent counter is null, never a fabricated zero.
 */
function usageDetailFrom(value: unknown): AgentUsageDetail {
  const state = (value ?? {}) as { docs?: Record<string, unknown> };
  const usage = (state.docs?.['pi.usage'] ?? {}) as { models?: Record<string, { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; reasoning?: unknown; totalTokens?: unknown; cost?: { total?: unknown } }> };
  const models = Object.entries(usage.models ?? {}).map(([key, totals]) => {
    const slash = key.indexOf('/');
    return {
      provider: slash >= 0 ? key.slice(0, slash) : key,
      modelId: slash >= 0 ? key.slice(slash + 1) : '',
      input: Number(totals?.input ?? 0),
      output: Number(totals?.output ?? 0),
      cacheRead: Number(totals?.cacheRead ?? 0),
      cacheWrite: Number(totals?.cacheWrite ?? 0),
      totalTokens: Number(totals?.totalTokens ?? 0),
      cost: Number(totals?.cost?.total ?? 0)
    };
  });
  let reasoning: number | null = null;
  for (const totals of Object.values(usage.models ?? {})) if (typeof totals?.reasoning === 'number') reasoning = (reasoning ?? 0) + totals.reasoning;
  const sum = (pick: (entry: AgentUsageDetail['models'][number]) => number) => models.reduce((total, entry) => total + pick(entry), 0);
  return Object.freeze({
    input: sum((entry) => entry.input),
    output: sum((entry) => entry.output),
    cacheRead: sum((entry) => entry.cacheRead),
    cacheWrite: sum((entry) => entry.cacheWrite),
    totalTokens: sum((entry) => entry.totalTokens),
    reasoning,
    cost: sum((entry) => entry.cost),
    models: Object.freeze(models.map((entry) => Object.freeze(entry)))
  });
}

const lastUserText = (context: unknown): string => {
  const messages = (context as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
  const last = [...messages].reverse().find(message => message.role === 'user');
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content)) {
    return last.content.map(block => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '')).join(' ');
  }
  return '';
};

/**
 * The content one submission carries: the text alone, or the text and the images as content blocks.
 * A fresh submission and a replayed one both go through this, so a replay carries exactly the shape
 * the original submission carried.
 */
function inputContent(text: string, images: readonly AgentImage[]): string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  if (images.length === 0) return text;
  return [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))];
}

/**
 * The text and the image blocks one stored user content holds, and how many image blocks were
 * unreadable. This is the inverse of `inputContent`, and it is what makes a replay carry the images
 * the original input carried instead of dropping them.
 */
function replayOfContent(content: unknown): { text: string; images: AgentImage[]; unreadable: number } {
  if (typeof content === 'string') return { text: content, images: [], unreadable: 0 };
  if (!Array.isArray(content)) return { text: '', images: [], unreadable: 0 };
  const texts: string[] = [], images: AgentImage[] = [];
  let unreadable = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') { texts.push(typed.text); continue; }
    if (typed.type !== 'image') continue;
    if (typeof typed.data === 'string' && typed.data !== '' && typeof typed.mimeType === 'string' && typed.mimeType !== '')
      images.push({ mimeType: typed.mimeType, data: typed.data });
    else unreadable += 1;
  }
  return { text: texts.join(' '), images, unreadable };
}

/**
 * The question protocol.
 *
 * The agent records one question in the transcript through a tool call and then ends its
 * turn, so the question is durable and visible until a human answers it exactly once.
 */
function questionExtension(){
  return defineExtension({
    name: 'question',
    sections: [section('question-protocol', () => 'When you need a decision from the human, call ask_question with one clear question and then end your turn. Do not guess.', { tag: false })],
    tools: [defineTool({
      name: 'ask_question',
      description: 'Ask the human one question and end this turn until they answer.',
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 600, description: 'One clear question for the human' }) }),
      replay: 'safe',
      execute: async (args, api, context) => {
        const questionId = randomUUID();
        await api.commit(async tx => {
          await tx.appendEntry(api.conversationId, { kind: 'app.question', data: { questionId, text: args.question, askedAt: Date.now() } });
        }, context);
        await api.details({ questionId }, context);
        return { output: [{ type: 'text', text: 'Question recorded for the human: ' + args.question }] };
      }
    })]
  });
}

const notesPath = 'docs/notes.md';

/**
 * Test-only delays around the append. Nothing a model or a provider sends can select them:
 * the tool's parameters carry `text` only, and these values come from the harness options.
 * `beforeWriteMs` opens the window in which a cancellation must write nothing; `afterWriteMs`
 * opens the window in which the append is already committed and a cancellation must not claim
 * a rollback. Production wiring leaves both unset.
 */
export interface RecordNoteSeam {
  readonly beforeWriteMs?: number;
  readonly afterWriteMs?: number;
  /** Test-only: called once when `record_note` has entered execution, before its pre-write wait. */
  readonly onExecute?: () => void;
}

/**
 * Documentation tools, bounded to one project.
 *
 * `record_note` appends, which is not idempotent, so it is declared unsafe to replay: a run
 * that dies during it must be told the call was interrupted rather than repeating the write.
 * `read_notes` only reads and is safe to replay.
 */
export interface ReadNotesSeam {
  /** Test-only delay before the safe read completes, allowing deterministic checkpoint interruption. */
  readonly delayMs?: number;
  /** Test-only observer called when the read body starts, after the central recovery guard passes. */
  readonly onExecute?: () => void;
}

function notesExtension(project: Project, seam: RecordNoteSeam, readSeam: ReadNotesSeam = {}){
  return defineExtension({
    name: 'notes',
    sections: [section('notes-protocol', () => 'Use record_note to append a short note to this project documentation, and read_notes to read the notes back.', { tag: false })],
    tools: [
      defineTool({
        name: 'record_note',
        description: 'Append one line to this project notes file.',
        parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 400, description: 'One line to append' }) }),
        replay: 'unsafe',
        execute: async (args, _api, context) => {
          const signal = context.abortSignal;
          const beforeWriteMs = seam.beforeWriteMs ?? 0;
          const afterWriteMs = seam.afterWriteMs ?? 0;
          // Cancellation is cooperative. Every check below is immediately before the effect it
          // guards, and the wait itself rejects with the signal's reason and clears its timer.
          signal?.throwIfAborted();
          seam.onExecute?.();
          await abortableDelay(beforeWriteMs, signal);
          signal?.throwIfAborted();
          await mkdir(join(project.path,'docs'),{ recursive: true, mode: 0o755 });
          const file = await safePath(project.path,notesPath);
          // The last window: an abort that lands after this check but before `appendFile` starts
          // cannot prevent the write. The call is then reported as aborted (uncertain), never as
          // a rollback, because the bytes may already be committed.
          signal?.throwIfAborted();
          await appendFile(file,args.text.trim()+'\n');
          // The append is committed. A later cancellation is reported as uncertain; it never
          // removes the line and the result never claims the line was not written.
          if (afterWriteMs > 0) await abortableDelay(afterWriteMs, signal);
          else signal?.throwIfAborted();
          return { output: [{ type: 'text', text: 'Recorded: ' + args.text.trim() }] };
        }
      }),
      defineTool({
        name: 'read_notes',
        description: 'Read this project notes file.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async (_args, _api, context) => {
          readSeam.onExecute?.();
          await abortableDelay(readSeam.delayMs ?? 0, context.abortSignal);
          try {
            const file = await safePath(project.path,notesPath);
            return { output: [{ type: 'text', text: await readFile(file,'utf8') }] };
          } catch { return { output: [{ type: 'text', text: 'No notes yet.' }] }; }
        }
      })
    ]
  });
}

/**
 * The scripted test provider.
 *
 * This is a deterministic stand-in for a model, so the agent path can be built,
 * tested and demonstrated without spending anything or sending anything to a
 * provider. It answers with a fixed, clearly-labelled reply: never mistaken for
 * real model output. A message containing the marker [pause] holds the run open
 * for a moment so steering and interrupting can be exercised.
 */
function scriptedResponses(provider: FauxProviderHandle, pauseMs: number, probe?: { tool: string; args: JsonObject }, probeDelayMs = 0) {
  const respond: FauxResponseFactory = async (context, options) => {
    // Re-arm before anything can be interrupted, so a run always has its next response.
    provider.appendResponses([respond]);
    if (probe !== undefined) {
      // Test-only: one tool call per request. It makes the worker budget measurable at the real
      // provider boundary. No model chooses this; it comes from the harness options.
      if (probeDelayMs > 0) await abortableDelay(probeDelayMs, (options as { signal?: AbortSignal } | undefined)?.signal);
      return fauxAssistantMessage([fauxToolCall(probe.tool, probe.args)], { stopReason: 'toolUse' });
    }
    const text = lastUserText(context).trim();
    const messages = (context as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
    // A tool result comes back as role 'toolResult', and the assistant message that asked
    // carries the call. Either signal means the question was already recorded: never ask twice
    // in one run, or the scripted provider would loop.
    if (messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('Scripted test reply — no model was called.\n\nI recorded that and stopped guessing.');
    const called = (name: string) => messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => (block as { type?: string; name?: string })?.type === 'toolCall' && (block as { name?: string }).name === name));
    const noteBody = (marker: RegExp) => text.replace(marker,'').replace(/\]\s*$/,'').trim().slice(0,300) || 'a note';
    // `[slow-note …]` selects the same tool as `[note …]`; a slow write comes from the harness's
    // test-only `recordNoteDelayMs` seam, never from an argument the model can choose.
    if (/\[slow-note /i.test(text) && !called('record_note')) return fauxAssistantMessage([fauxToolCall('record_note',{ text: noteBody(/^[\s\S]*?\[slow-note/i) })],{ stopReason: 'toolUse' });
    if (/\[note /i.test(text) && !called('record_note')) return fauxAssistantMessage([fauxToolCall('record_note',{ text: noteBody(/^[\s\S]*?\[note/i) })],{ stopReason: 'toolUse' });
    if (/\[read-notes\]/i.test(text) && !called('read_notes')) return fauxAssistantMessage([fauxToolCall('read_notes',{})],{ stopReason: 'toolUse' });
    const alreadyAsked = called('ask_question');
    if (/\[ask\]/i.test(text) && !alreadyAsked) {
      const subject = text.replace(/\[ask\]/gi, '').trim().slice(0, 120) || 'this change';
      return fauxAssistantMessage([fauxToolCall('ask_question', { question: 'Should I proceed with: ' + subject + '?' })], { stopReason: 'toolUse' });
    }
    if (/\[pause\]/i.test(text) && pauseMs > 0) await abortableDelay(pauseMs, (options as { signal?: AbortSignal } | undefined)?.signal);
    const summary = text.replace(/\[pause\]/gi, '').trim().slice(0, 160);
    return fauxAssistantMessage('Scripted test reply — no model was called.\n\nYou said: ' + (summary || '(nothing)'));
  };
  provider.setResponses([respond]);
}

export interface AgentEvent {
  projectId: string;
  projectName: string;
  /** The exact session the event belongs to, so a notification can deep-link to it. */
  sessionId: string;
  kind: 'question' | 'finished' | 'error';
  /** The question the event is about, when it is a question. */
  questionId?: string;
  /** Short human-facing context, never document text. */
  detail: string;
}

/**
 * The durable half of the question and answer flow.
 *
 * The server owns this port because only it holds the control store. The harness hands over the
 * identity of a question it has just surfaced, and — for an answer — refuses to send anything to the
 * agent until the port has recorded it, so an answer can never reach the model with no durable
 * record. The ledger's own idempotency keys make a retry reconcile instead of recording twice.
 */
export interface AgentDeliveryPort {
  /** Admits the question durably, then delivers its owner notification as the ledger's outbox step. */
  questionSurfaced(input: { projectId: string; projectName: string; sessionId: string; questionId: string; text: string; askedAt: number | null }): Promise<void>;
  /**
   * Records the answer durably. Throwing refuses the answer before it can reach the agent, and the
   * port reports a delivery refusal as an HttpError with the status that refusal deserves.
   */
  answerRecorded(input: { projectId: string; sessionId: string; questionId: string; question: { text: string; askedAt: number | null }; text: string; answeredAt: number }): Promise<void>;
  /** Acknowledges the answer's outbox with the evidence that the agent received it. */
  answerDelivered(input: { projectId: string; sessionId: string; questionId: string; receipt: unknown }): Promise<void>;
  /** The owner-visible ledger projection for one scope: identities, states and receipts, no text. */
  ledgerView(input: { projectId: string; sessionId: string }): Promise<unknown> | unknown;
}

/**
 * The durable lifecycle an instance keeps beside the running process.
 *
 * These hooks are how a live generation becomes visible to the durable session lifecycle: a
 * submission that starts work reports \`began\`, and a run observed to leave the working state reports
 * \`settled\`. They are advisory and best-effort: a hook that fails is logged and never fails the
 * agent, because the transcript stays canonical and the lifecycle is derived working state.
 *
 * An instance that has no named session for a conversation simply does not install these hooks, so a
 * project without a registry writes no lifecycle row at all.
 */
export interface SessionLifecycleHooks {
  /** A generation started for this session, under this request identity. */
  began(input: { projectId: string; sessionId: string; requestId: string }): Promise<void> | void;
  /** A generation left the working state: finished (idle) or failed. */
  settled(input: { projectId: string; sessionId: string; outcome: 'idle' | 'failed' }): Promise<void> | void;
}

export interface HarnessHostOptions {
  dataRoot: string;
  enabled: boolean;
  /** How long a [pause] message holds the run open, in milliseconds. */
  pauseMs?: number;
  /**
   * Test-only windows around `record_note`'s append. They are reachable only through the harness
   * options (and the test environment), never through a model's tool arguments. Leave unset in
   * production wiring: `0` or absent means no wait.
   */
  recordNoteDelayMs?: number;
  recordNoteAfterWriteMs?: number;
  /** Test-only bounded delay in the safe `read_notes` tool body, after the recovery guard. */
  readNotesDelayMs?: number;
  /** Test-only observer called when the guarded `read_notes` body starts. */
  readNotesStarted?: () => void;
  /** Test-only: resolves when `record_note` execution begins, so a test can abort inside its wait. */
  recordNoteStarted?: () => void;
  providers?: ProviderStore;
  /** Called when a run needs a person, finishes or fails, with no browser attached. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Where a surfaced question and a recorded answer become durable. Absent only when the instance
   * has no control store, in which case the question and answer flow behaves as it did before the
   * ledger existed (the transcript stays the sole record).
   */
  delivery?: AgentDeliveryPort;
  /** Where a live generation becomes visible to the durable session lifecycle, when one exists. */
  lifecycle?: SessionLifecycleHooks;
  /** Read-only authority for uncertain recovery gates. */
  recovery?: {
    read(projectId: string, sessionId: string): { readonly state: string; readonly uncertain: boolean; readonly requestId: string | null };
  };
  /**
   * Where this harness learns the privilege scopes in force. Absent, every tool it exposes belongs
   * to the owner's own dispatch and no agent allowlist applies.
   */
  privileges?: AgentPrivilegePort;
  /**
   * Where this harness reads and records the durable session-to-conversation mapping.
   *
   * The mapping is written once when a conversation is first created for a named session, and read
   * on every access after a restart. Without this port, named sessions lose their conversation on
   * restart — the in-process cache is empty. The legacy root session's
   * conversation is always the root conversation (ROOT_CONVERSATION_ID) and does not use this port.
   *
   * This port is the durable authority; the in-process Map below is only a cache.
   */
  conversationBinding?: {
    list?(projectId: string): readonly { sessionId: string; conversationId: number }[];
    /** Read the durable binding, or null when none exists for this session. */
    read(projectId: string, sessionId: string): { conversationId: number; revision: number } | null;
    /**
     * Record a conversation binding exactly once. Throws when a binding with different content
     * already exists for this session.
     */
    record(input: { projectId: string; sessionId: string; conversationId: number }): void;
  };
  /**
   * The bounded file-edit capability, or undefined when this instance has it disabled. The tool is
   * installed only when the capability is enabled, so a disabled tool does not exist at all rather
   * than existing and failing.
   */
  fileEdit?: FileEditCapability;
  /**
   * The durable lookup that says whether a numeric conversation belongs to a worker run. Every
   * generic conversation path asks it, so a worker transcript can never be handled as a session
   * after a restart. A lookup failure is treated as "worker" (fail closed).
   */
  workerBinding?: {
    isWorkerConversation(projectId: string, conversationId: number): boolean;
  };
  /** The authoritative per-tool re-check for a worker conversation. */
  workerGuard?: (input: { readonly projectId: string; readonly runId: string; readonly tool: string }) => string | null;
  /** The authoritative per-request re-check for a worker conversation. */
  workerRequestGuard?: (input: { readonly projectId: string; readonly runId: string }) => string | null;
  /** Test-only: the scripted provider calls this tool on every request, so the budget is measurable. */
  workerProbe?: { readonly tool: string; readonly args: JsonObject };
  /** Test-only: a bounded delay before each scripted probe response. */
  workerProbeDelayMs?: number;
  /** Test-only observation of the static worker guard, without changing its decision. */
  onWorkerGuard?: (input: { readonly tool: string; readonly refusal: string | null }) => void;
  /** Test-only: a bounded window after the conversation opens and before its submission. */
  workerOpenDelayMs?: number;
  /**
   * Test-only observation at the provider boundary, called once per provider request with the
   * output-token limit actually passed. It must not throw and it performs no model work.
   */
  onModelRequest?: (input: { provider: string; modelId: string; maxTokens: number }) => void;
}

/**
 * The tools a dispatch whose scopes are these is really enabled for.
 *
 * This is gate (a): only the permitted tools are offered to the model. The authoritative re-check is
 * the privilege hook below, which reads the scopes on every call — so a scope revoked after this set
 * was built is still refused at dispatch, with no effect. 'undefined' means the owner's own dispatch,
 * where nothing is narrowed.
 */
function permittedTools(extensions: readonly Extension[], scopes: readonly AgentScope[] | null): Extension['tools'] | undefined {
  if (scopes === null) return undefined;
  return extensions
    .flatMap((extension) => extension.tools ?? [])
    .filter((tool) => authorizeToolUse({ scopes, tool: tool.name }).permitted);
}

/**
 * The privilege extension: the one place the dispatch path re-checks a caller's scopes server-side.
 *
 * Its hook runs on **every** tool call — model-issued and nested — before the call's intent is
 * recorded, so a tool the scopes forbid is refused with a precise reason and produces no side effect
 * at all, however the call was crafted. Its section tells the model what its allowlist holds, so a
 * well-behaved model never attempts what would be refused.
 */
function privilegeExtension(project: Project, authorityOf: (sessionId: string) => Promise<DispatchAuthority>, fileEditEnabled?: boolean) {
  return defineExtension({
    name: 'agent-privileges',
    sections: [section('agent-privileges', async (input) => {
      // The authority is resolved for the very conversation this request belongs to, so the section
      // tells the model exactly which session's allowlist and project scope govern it.
      const authority = await authorityOf(String(input.conversationId));
      if (authority.scopes === null)
        return 'No agent is bound to this session, so the owner\u2019s own dispatch is in force: no agent allowlist narrows these tools. Bind an agent to a session to run it under an explicit allowlist.';
      if (authority.scopes.length === 0)
        return 'This dispatch has no privilege scopes in force, so every tool is refused at dispatch. ' + (authority.emptyReason ?? 'No agent is bound.') + ' Do not attempt one.';
      const baseInstalled = installedAgentScopes();
      // file_edit is installable but behind a switch: include it only when enabled.
      const fileEditAvailable = fileEditEnabled === true && authority.scopes.includes('file_edit');
      const installed = fileEditAvailable ? [...baseInstalled, 'file_edit' as const] : baseInstalled;
      const available = authority.scopes.filter((s) => (installed as readonly string[]).includes(s));
      const unavailable = authority.scopes.filter((s) => !(installed as readonly string[]).includes(s));
      const fileEditNote = authority.scopes.includes('file_edit') && !fileEditAvailable
        ? ' The file_edit scope is granted but the instance has it DISABLED: the operator must set DASHBOARD_FILE_EDIT=on and restart for the tool to appear. Until then, no file-editing tool is callable.' : '';
      const availLine = available.length > 0 ? ' Its scopes with an installed tool are: ' + available.join(', ') + '.' : ' None of its scopes has an installed tool in this build.';
      const unavailLine = unavailable.length > 0 ? ' The following scopes are granted but have NO installed tool in this build and cannot be used: ' + unavailable.join(', ') + '.' : '';
      const uninstalledAll = unavailableAgentScopes().filter((s) => s.scope !== 'file_edit');
      const uninstalledLine = uninstalledAll.length > 0 ? ' Scopes without an installed tool in this build: ' + uninstalledAll.map((s) => s.scope).join(', ') + '. They are declared in the vocabulary but the agent cannot call them.' : '';
      const scopeLine = 'This dispatch runs as an agent' + (authority.agentId === null ? '' : ' (' + authority.agentId + ')') + '.' + availLine + unavailLine + fileEditNote + uninstalledLine + ' A tool outside the granted scopes is refused at dispatch with no effect, so do not attempt one.';
      const projectLine = authority.projects === null ? '' : ' Its project scope is the explicit set ' + authority.projects.join(', ') + ', so a call that acts on any other project is refused at dispatch with no effect.';
      return scopeLine + projectLine;
    }, { tag: false })],
    hooks: [hook(ToolTask, {
      beforeTool: async (call, api) => {
        // The per-call authority: a binding or scope change takes effect at the next tool call with
        // no restart, because this reads the durable record rather than anything captured earlier.
        const authority = await authorityOf(String(api.conversationId));
        // The explicit empty allowlist is reported first, so "no privileges" always names its reason
        // (no agent bound, or the bound agent not in force) rather than a narrower project message.
        if (authority.scopes !== null && authority.scopes.length === 0)
          return { block: (authority.emptyReason ?? 'No agent is bound to this session, so it has no privilege scopes.') + ' The tool ' + call.name + ' is refused at dispatch with no effect.' };
        // The project scope is enforced against the project this harness acts on: even a permitted
        // tool is refused when the call would act on a project outside the authority's set.
        if (authority.projects !== null && !authority.projects.includes(project.id))
          return { block: 'The project ' + project.id + ' is outside this dispatch\u2019s project scope (' + (authority.projects.length ? authority.projects.join(', ') : 'no project is allowed') + '), so the tool ' + call.name + ' is refused at dispatch with no effect. Widen the agent\u2019s project scope to use it here.' };
        const verdict = authorizeToolUse({ scopes: authority.scopes, tool: call.name });
        if (verdict.permitted) return undefined;
        return { block: authority.emptyReason === null ? verdict.reason : verdict.reason + ' ' + authority.emptyReason };
      }
    })]
  });
}

/**
 * The bounded file-edit tool, installed only when this instance has the capability enabled.
 *
 * The tool itself never decides authority: the privilege hook above refuses a caller without the
 * file_edit scope before this code runs. What the tool owns is containment — a relative path inside
 * the project's connected worktree and nothing else — the size caps, the atomic write, and the mode,
 * which comes from the acceptance policy rather than being assumed.
 */
function fileEditExtension(project: Project, capability: FileEditCapability, authorityOf: (sessionId: string) => Promise<DispatchAuthority>) {
  return defineExtension({
    name: 'file-edit',
    sections: [section('file-edit-protocol', () => 'Use file_edit to propose or apply one bounded change to a file inside this project\u2019s connected worktree. The path is relative and must stay inside it. In propose-only mode the change and its diff are recorded and no file is written.', { tag: false })],
    tools: [defineTool({
      name: 'file_edit',
      description: 'Propose or apply one bounded edit to a file inside this project\u2019s connected repository worktree.',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: FILE_EDIT_MAX_PATH_LENGTH, description: 'A relative path inside this project\u2019s connected worktree' }),
        content: Type.String({ maxLength: FILE_EDIT_MAX_FILE_BYTES, description: 'The full text the file would hold' })
      }),
      replay: 'unsafe',
      execute: async (args, api) => {
        const authority = await authorityOf(String(api.conversationId));
        const outcome = await capability.edit({
          projectId: project.id,
          agentId: authority.agentId,
          path: args.path,
          content: args.content,
          mode: null,
          actor: authority.agentId === null ? { kind: 'owner' as const, identity: 'owner' } : { kind: 'agent' as const, identity: authority.agentId }
        });
        return {
          output: [{
            type: 'text' as const,
            text: (outcome.written ? 'Applied ' : 'Proposed ') + outcome.record.path + ' in ' + outcome.record.mode + ' mode; the change and its diff are recorded as ' + outcome.record.id + '.'
          }]
        };
      }
    })]
  });
}

/**
 * Owns one Durable harness per project.
 *
 * The harness is the only execution surface in this application. Each project
 * gets its own SQLite storage under the data root, its own provider collection
 * and its own conversation, so nothing leaks between projects. Work is admitted
 * durably before it is shown, and an interrupted run resumes from its last
 * checkpoint when the harness opens again.
 */
export class HarnessHost {
  private hosted = new Map<string, Promise<HostedAgent>>();
  /** Inspect an already-open harness only; acknowledging a session must not open a scheduler. */
  async readOriginalSubmissionStatus(project: Project, sessionId: string, requestId: string) {
    const existing = this.hosted.get(project.id);
    if (!existing) throw new HttpError(409, 'Open the interrupted conversation to read its settled recovery result before acknowledging');
    const hosted = await existing;
    const binding = this.options.conversationBinding?.read(project.id, sessionId);
    const id = (binding?.conversationId as ConversationId | undefined)
      ?? (conversationIdOf(sessionId) ?? undefined)
      ?? (sessionId === String(ROOT_CONVERSATION_ID) ? ROOT_CONVERSATION_ID : undefined)
      ?? this.sessionConversations.get(project.id + ':' + sessionId);
    if (id === undefined) throw new HttpError(404, 'Session conversation not found');
    const submission = await hosted.storage.submissionByRequest(id, requestId, BACKGROUND_CONTEXT);
    const inspection = await hosted.harness.inspect(BACKGROUND_CONTEXT);
    const conversation = await hosted.harness.conversation(id, BACKGROUND_CONTEXT);
    if (!conversation) throw new HttpError(409, 'The session conversation is unavailable');
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    try {
      return {
        status: submission?.status ?? null,
        conversationIdle: !agentViewFrom(view.value).working && agentViewFrom(view.value).inbox.length === 0,
        queuedSubmissions: inspection.submissions.filter((item) => item.conversationId === id && item.status === 'queued').length
      };
    } finally { view.dispose(); }
  }
  private tails = new Map<string, Promise<unknown>>();
  /**
   * The mapping from a named session's ID to its conversation ID in the harness.
   *
   * A session created or selected through the session registry is given its own conversation, so its
   * transcript is independent of the project's root conversation and of every other session's. The
   * legacy root conversation remains bound to the project's root session id (ROOT_CONVERSATION_ID).
   *
   * Entries are written when a conversation is first created for a session, and read on every
   * session-level access. This map is an in-process **cache only**: the durable authority is the
   * conversationBinding port (resolved from the control store), and after a restart the cache is
   * repopulated from that durable record on first access.
   */
  private readonly sessionConversations = new Map<string, ConversationId>();
  /**
   * The projects whose live generation an owner action is cancelling right now.
   *
   * Cancelling a *genuinely running* generation makes the watcher below observe the run leave the
   * working state, and its settled hook would then write `idle` at the very revision the owner's own
   * `paused`/`idle` write is being prepared for. Whichever write landed first would win the store's
   * compare-and-swap, so the owner's pause could be refused (409) and lost - leaving a durable
   * `idle`, from which a resume is illegal. The owner's cancel therefore *owns* the end of the
   * generation it caused: the flag is set while a genuinely running generation is being cancelled and
   * is honoured and cleared by the watcher, which then writes nothing. Exactly one writer - the
   * owner's own action - reaches that revision.
   */
  private readonly ownerCancels = new Set<string>();
  /**
   * Every worker conversation this process created, for the life of the process. A worker
   * conversation is never a session: the session model setter, the conversation controls and a
   * numeric alias must not be able to change its model or its role. The map is also how a cancel
   * finds the live conversation without opening a harness.
   */
  private readonly workerConversations = new Map<ConversationId, { readonly projectId: string; readonly runId: string }>();
  /**
   * The worker runs currently in flight, keyed `projectId:runId`. The entry exists **before** the
   * conversation is awaited, so a cancel during the open window is registered and honoured.
   */
  /** Provider requests per worker run, measured at the model boundary. */
  private readonly workerRequests = new Map<string, number>();
  private readonly workerRuns = new Map<string, {
    conversation: Awaited<ReturnType<Harness['root']>> | null;
    cancelled: boolean;
    readonly controller: AbortController;
  }>();
  constructor(private readonly options: HarnessHostOptions) {
    if (options.readNotesDelayMs !== undefined && (!Number.isInteger(options.readNotesDelayMs) || options.readNotesDelayMs < 0 || options.readNotesDelayMs > 60_000))
      throw new RangeError('readNotesDelayMs must be an integer from 0 to 60000');
  }
  get enabled(): boolean { return this.options.enabled; }
  private assertEnabled() { if (!this.options.enabled) throw new HttpError(503, 'Agents are disabled on this instance'); }
  /**
   * The privilege scopes in force for one project's dispatch. It is read through the injected port
   * on every call, so a change to an agent's allowlist takes effect immediately; with no port, the
   * owner's own dispatch is in force and nothing is narrowed.
   */
  /**
   * The authority in force for one session of this project, resolved from the durable binding on
   * every call. `authority(projectId, sessionId)` is the per-session read; a port that only knows
   * the project is still honoured (it is handed the project and the harness's own root session id).
   */
  private assertNotUncertain(projectId: string, sessionId: string): void {
    if (!this.options.recovery) return;
    let recovery: ReturnType<NonNullable<HarnessHostOptions['recovery']>['read']>;
    try { recovery = this.options.recovery.read(projectId, sessionId); }
    catch { throw new HttpError(409, 'Session recovery state cannot be verified; no work was admitted.'); }
    if (recovery.uncertain) throw new HttpError(409, 'This session has an uncertain interrupted effect. Operator review is required before new work.');
  }
  private async dispatchAuthority(project: Project, sessionId: string): Promise<DispatchAuthority> {
    if (!this.options.privileges) return Object.freeze({ agentId: null, scopes: null, projects: null, emptyReason: null });
    const authority = await this.options.privileges.authority({ projectId: project.id, sessionId });
    return Object.freeze({ agentId: authority.agentId ?? null, scopes: authority.scopes ?? null, projects: authority.projects ?? null, emptyReason: authority.emptyReason ?? null });
  }
  /** Resolve numeric aliases back to the named authority, including after restart. */
  private sessionIdentity(project: Project, conversationId: ConversationId): string {
    const names = new Set<string>();
    for (const binding of this.options.conversationBinding?.list?.(project.id) ?? [])
      if (binding.conversationId === conversationId) names.add(binding.sessionId);
    for (const [key, id] of this.sessionConversations)
      if (id === conversationId && key.startsWith(project.id + ':')) names.add(key.slice(project.id.length + 1));
    const named = [...names].filter(name => conversationIdOf(name) === null);
    if (named.length > 1) throw new HttpError(409, 'Ambiguous conversation authority');
    return named[0] ?? String(conversationId);
  }
  /** Select an existing conversation for controls; never create one as a side effect. */
  private async selected(project: Project, sessionId?: string): Promise<HostedAgent> {
    const hosted = await this.open(project);
    if (!sessionId) return hosted;
    const id = conversationIdOf(sessionId) ?? this.options.conversationBinding?.read(project.id, sessionId)?.conversationId ?? this.sessionConversations.get(project.id + ':' + sessionId);
    if (id === undefined) throw new HttpError(404, 'This session has no conversation');
    // A worker conversation has no session, no owner controls and no session model. It is governed
    // only by its immutable run record, so a numeric alias or a session id cannot reach it.
    if (await this.isWorkerConversationDurable(hosted, project, id)) throw this.workerConversationRefusal();
    const conversation = await hosted.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new HttpError(409, 'The bound conversation is unavailable');
    await hosted.watch(conversation, this.sessionIdentity(project, conversation.id));
    return { ...hosted, conversation };
  }
  /**
   * The models this instance really offers: the deterministic scripted stand-in it always has, and
   * every model of every provider it has credentials for. An agent's declared model must be one of
   * these, so a declaration can never name a model that cannot run here.
   */
  offeredModels(): readonly { readonly provider: string; readonly modelId: string }[] {
    const offered: { provider: string; modelId: string }[] = [];
    // The deterministic stand-in is offered exactly where the harness is: with the harness off it is
    // not a model this instance can run at all.
    if (this.options.enabled) {
      const scripted = fauxProvider();
      offered.push({ provider: scripted.provider.id, modelId: scripted.getModel().id });
    }
    // Every model of every provider this instance has credentials for is offered whether or not the
    // harness is on: the catalog is the instance's, not the harness's.
    for (const candidate of this.options.providers?.models.getModels() ?? []) offered.push({ provider: candidate.provider, modelId: candidate.id });
    return Object.freeze(offered);
  }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.tails.set(key, current);
    try { return await current; } finally { if (this.tails.get(key) === current) this.tails.delete(key); }
  }
  private storagePath(project: Project): string {
    if (!uuidPattern.test(project.id)) throw new HttpError(422, 'Invalid project identifier');
    return join(this.options.dataRoot, 'agents', project.id, 'session.sqlite');
  }
  private async open(project: Project): Promise<HostedAgent> {
    const existing = this.hosted.get(project.id);
    if (existing) return existing;
    const pending = (async (): Promise<HostedAgent> => {
      const path = this.storagePath(project);
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      const provider = fauxProvider();
      const models = createModels({credentials:this.options.providers?.credentials,authContext:{env:async()=>undefined,fileExists:async()=>false}});
      for(const p of this.options.providers?.models.getProviders()??[])models.setProvider(p);
      models.setProvider(provider.provider);
      const stream=models.streamSimple.bind(models);
      const conversationBySignal = new WeakMap<AbortSignal, ConversationId>();
      // Generation hooks are advisory: ordinary exceptions are reported then ignored.
      // Enforce policy at dispatch, including queued inputs and checkpoint recovery.
      models.streamSimple=(model,context,options)=>{
        const output=createAssistantMessageEventStream();
        void (async()=>{
          try{
            const signal=options?.signal;
            signal?.throwIfAborted();
            const conversationId = signal ? conversationBySignal.get(signal) : undefined;
            if (this.options.recovery) {
              if (conversationId === undefined) throw new HttpError(409, 'The model request session cannot be verified; no provider request was sent.');
              const refusal = recoveryGuard.refusalFor(conversationId);
              if (refusal !== null) throw new HttpError(409, refusal);
            }
            if(model.provider!==provider.provider.id){
              if(!this.options.providers)throw new HttpError(409,'Real providers are not configured');
              await this.options.providers.assertUsable({provider:model.provider,modelId:model.id});
              let turns=0;
              for(const message of [...context.messages].reverse()){if(message.role==='user')break;if(message.role==='assistant')turns++;}
              if(turns>=8)throw new HttpError(409,'Pilot stopped at eight model turns. Review before sending another message.');
            }
            const maxTokens=Math.min(options?.maxTokens??4096,4096);
            // The worker boundary. The role marker is in the worker system prompt; the guard is the
            // durable run/worker/policy/revocation check. A refusal returns a terminal assistant error
            // and never calls the provider. The ninth request is refused here, before the call.
            const workerRun = workerRunIdOf(context.messages);
            if (workerRun !== null) {
              let refusal: string | null;
              try { const verdict = this.options.workerRequestGuard?.({ projectId: project.id, runId: workerRun }); refusal = verdict === undefined ? 'The worker request could not be verified, so no model request was sent.' : verdict; }
              catch { refusal = 'The worker request could not be verified, so no model request was sent.'; }
              if (refusal === null) {
                const count = (this.workerRequests.get(workerRun) ?? 0) + 1;
                this.workerRequests.set(workerRun, count);
                if (count > 8) refusal = 'The worker stopped at its eight-model-request budget before the request was sent.';
              }
              if (refusal !== null) {
                const message = { ...fauxAssistantMessage(refusal, { stopReason: 'error', errorMessage: refusal }), provider: model.provider, model: model.id, api: model.api };
                (output.push as (event: unknown) => void)({ type: 'error', reason: 'error', error: message });
                output.end(message);
                return;
              }
            }
            // A test-only observation at the provider boundary. It is never selected by a model.
            try { this.options.onModelRequest?.({ provider: model.provider, modelId: model.id, maxTokens }); } catch { /* observation never breaks a run */ }
            const source=stream(model,context,{...options,maxTokens});
            const safeError='Model request failed. Check the provider connection, model access and quota.';
            // Provider/OAuth exceptions may embed raw response bodies. Never persist
            // those as UI errors; retain usage and partial model output only.
            // Guard against a hanging provider stream: check the abort signal between events
            // and race the iteration against the signal's own abort promise.
            let abortHandler:(()=>void)|undefined;
            const abortPromise=signal?new Promise<never>((_,reject)=>{
              abortHandler=()=>reject(new Error('aborted'));
              if(signal.aborted)abortHandler();
              else signal.addEventListener('abort',abortHandler,{once:true});
            }):undefined;
            const iter=source[Symbol.asyncIterator]();
            try {
              for(;;){
                const step=abortPromise?await Promise.race([iter.next(),abortPromise]):await iter.next();
                if(step.done)break;
                const event=step.value;
                // The pushed events are the same shape the for-await loop produced; the type is an
                // internal pi-ai type, so a cast to any is needed here at the call site.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (output.push as (event:any)=>void)(event.type==='error'?{...event as any,error:{...event.error,errorMessage:safeError}}:event as any);
              }
            } finally {
              if(signal&&abortHandler)signal.removeEventListener('abort',abortHandler);
              // Abort the provider iterator without waiting for its cleanup: a broken transport must not
              // keep this generation or process shutdown pending after the signal has fired.
              if(signal?.aborted&&iter.return)void Promise.resolve(iter.return()).catch(()=>{});
            }
            const result=await source.result();
            output.end(result.stopReason==='error'?{...result,errorMessage:safeError}:result);
          }catch(error){
            const detail=error instanceof HttpError?error.message:'Provider request failed. Check the provider connection and try again.';
            const reason=options?.signal?.aborted?'aborted' as const:'error' as const;
            const message={...fauxAssistantMessage(detail,{stopReason:reason,errorMessage:detail}),provider:model.provider,model:model.id,api:model.api};
            output.push({type:'error',reason,error:message});output.end(message);
          }
        })();
        return output;
      };
      scriptedResponses(provider, this.options.pauseMs ?? 2500, this.options.workerProbe, this.options.workerProbeDelayMs ?? 0);
      const storage = await openNodeSqliteStorage(path);
      const recoveryGuard = recoveryExtension(project, this.options, (conversationId) => this.sessionIdentity(project, conversationId as ConversationId));
      const recoveryBoundary = defineExtension({
        name: 'uncertain-recovery-provider-boundary',
        hooks: [hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            const signal = context.abortSignal;
            if (!signal) throw new HttpError(409, 'The model request session cannot be verified; no provider request was sent.');
            conversationBySignal.set(signal, api.conversationId);
            const refusal = recoveryGuard.refusalFor(api.conversationId);
            if (refusal !== null) throw new HttpError(409, refusal);
            return undefined;
          }
        })]
      });
      const guardTools = (extension: Extension): Extension => ({
        ...extension,
        tools: extension.tools?.map((tool) => {
          const execute = tool.execute;
          return {
            ...tool,
            execute: async (args, api, context) => {
              const refusal = recoveryGuard.refusalFor(Number(api.conversationId));
              if (refusal !== null) throw new HttpError(409, refusal);
              return execute(args, api, context);
            }
          };
        })
      });
      const question = questionExtension();
      const notes = notesExtension(project, { beforeWriteMs: this.options.recordNoteDelayMs, afterWriteMs: this.options.recordNoteAfterWriteMs, onExecute: this.options.recordNoteStarted }, { delayMs: this.options.readNotesDelayMs, onExecute: this.options.readNotesStarted });
      // The scopes in force are read once here, so the tools the model is offered are the permitted
      // ones, and again on every call by the privilege hook, which is the authority. Nothing about
      // the owner's own dispatch changes: with no privilege port the authority is null and every
      // installed tool is offered exactly as before.
      // The per-session authority. The root conversation's id *is* the legacy named session's id,
      // so the binding the owner set for that session governs this project's default conversation;
      // a fork's child conversation resolves its own session's binding by the same read.
      const rootSessionId = String(ROOT_CONVERSATION_ID);
      const authority = await this.dispatchAuthority(project, rootSessionId);
      const authorityOf = async (conversationId: string): Promise<DispatchAuthority> => {
        try { return await this.dispatchAuthority(project, this.sessionIdentity(project, Number(conversationId) as ConversationId)); }
        catch { return { agentId: null, scopes: [], projects: [], emptyReason: 'The conversation authority could not be verified.' }; }
      };
      const fileEditEnabled = this.options.fileEdit?.enabled === true;
      const privileges = privilegeExtension(project, authorityOf, fileEditEnabled);
      // Installed once, statically, and selected by every conversation. Its durable marker decides
      // whether it applies, so no unregistered dynamic extension carries the worker role.
      const workerRole = workerRoleExtension(project, this.options);
      const extensions: Extension[] = [question, notes, privileges, recoveryGuard.extension, recoveryBoundary, workerRole].map(guardTools);
      const registry = createRegistry();
      for (const extension of extensions) registry.install(extension);
      const fileEdit = this.options.fileEdit;
      if (fileEdit !== undefined && fileEdit.enabled) {
        const edits = guardTools(fileEditExtension(project, fileEdit, authorityOf));
        extensions.push(edits);
        registry.install(edits);
      }
      const harness = await Harness.open(storage, { models, registry,settings:{retry:{enabled:false},stream:{maxRetries:0,timeoutMs:120000},compaction:{enabled:false}} }, BACKGROUND_CONTEXT);
      const initial=await this.options.providers?.defaultModel();
      // Only the permitted tools are enabled for an agent, so the model is never offered one its
      // scopes forbid. The owner's own dispatch passes no filter at all and is unchanged.
      const permitted = permittedTools(extensions, authority.scopes);
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: {
        model: initial??{ provider: provider.provider.id, modelId: provider.getModel().id },
        extensions,
        ...(permitted === undefined ? {} : { tools: permitted })
      } });
      // Register the root conversation bound to the legacy root session id, so a session that
      // names the root conversation finds it on lookup. Every named session registered later gets
      // its own conversation through ensureSessionConversation.
      this.sessionConversations.set(project.id + ':' + rootSessionId, conversation.id);
      // Never replace an existing session's model with a newly changed global default.
      const watchers = new Map<ConversationId, Awaited<ReturnType<HostedAgent['conversation']['viewState']>>>();
      const watch = async (conversation: HostedAgent['conversation'], sessionId: string) => {
        // A worker conversation is never subscribed as a session, even by a direct internal call.
        if (this.isWorkerConversation(project.id, conversation.id)) throw this.workerConversationRefusal();
        try {
          const marker = workerMarkerOf(await harness.snapshot(WorkerMarkerDoc, conversation.id, BACKGROUND_CONTEXT));
          if (marker !== null && marker.projectId === project.id) throw this.workerConversationRefusal();
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw this.workerConversationRefusal();
        }
        // Watch this conversation so a question, a finished run or a failure is reported even
        // when nobody has the interface open. The first reading only primes the comparison.
        if (watchers.has(conversation.id)) return;
        const watched = await conversation.viewState(BACKGROUND_CONTEXT);
        watchers.set(conversation.id, watched);

        let previous = { working: false, open: 0, errors: 0, primed: false };
        let runFailed = false;
        watched.subscribe(() => {
          const view = agentViewFrom(watched.value);
          const openQuestions = view.questions.filter(entry => !entry.answer);
          const open = openQuestions.length;
          const errors = view.entries.filter(entry => entry.stopReason === 'error').length;
          if (previous.primed) {
            if (errors > previous.errors) runFailed = true;
            if (open > previous.open) {
              const asked = openQuestions.at(-1);
              // The question is made durable before its notification is sent, so a crash between the
              // two is recoverable. A question that cannot be admitted is reported and stays visible
              // in the transcript; it never breaks the run.
              if (asked && this.options.delivery) void this.options.delivery.questionSurfaced({ projectId: project.id, projectName: project.name, sessionId, questionId: asked.id, text: asked.text, askedAt: asked.askedAt }).catch(error => console.error('Question ' + asked.id + ' is open in the transcript but its delivery could not be admitted: ' + (error as Error).message));
              this.options.onEvent?.({ projectId: project.id, projectName: project.name, sessionId, kind: 'question', questionId: asked?.id, detail: asked?.text ?? '' });
            }
            if (previous.working && !view.working) {
              const failed = runFailed;
              runFailed = false;
              if (failed) this.options.onEvent?.({ projectId: project.id, projectName: project.name, sessionId, kind: 'error', detail: '' });
              else this.options.onEvent?.({ projectId: project.id, projectName: project.name, sessionId, kind: 'finished', detail: '' });
              // The owner's own cancel is the one writer at this revision. A cancel of a genuinely
              // running generation ends it in the same instant, and this settle is that end: writing
              // `idle` here would race the owner's `paused`/`idle` write and could overwrite it. The
              // flag is honoured (and cleared) exactly once, so a later genuine end still settles.
              if (this.ownerCancels.delete(project.id + ":" + sessionId)) {
                // The owner is still told the run ended; only the durable write is the owner's to make.
              } else {
                // A run that ended settles the durable lifecycle, so a finished generation is not
                // adopted as interrupted by the next start. Best-effort: it never breaks the run.
                void Promise.resolve()
                  .then(() => this.options.lifecycle?.settled({ projectId: project.id, sessionId, outcome: failed ? 'failed' as const : 'idle' as const }))
                  .catch(error => console.error('The session lifecycle could not record that a generation settled for project ' + project.id + ': ' + (error as Error).message));
              }
            }
          }
          previous = { working: view.working, open, errors, primed: true };
        });
      };
      await watch(conversation, rootSessionId);
      // Restore identity and watchers before checkpoint recovery can execute tools.
      for (const binding of this.options.conversationBinding?.list?.(project.id) ?? []) {
        this.sessionConversations.set(project.id + ':' + binding.sessionId, binding.conversationId as ConversationId);
        const bound = await harness.conversation(binding.conversationId as ConversationId, BACKGROUND_CONTEXT);
        if (!bound) throw new HttpError(409, 'A durable conversation binding is unavailable');
        await watch(bound, binding.sessionId);
      }
      harness.resume();
      const sessionExtensions = extensions;
      const sessionPermittedTools = permitted;
      return {
        harness,
        conversation,
        provider,
        extensions: sessionExtensions,
        storage,
        permittedTools: sessionPermittedTools,
        watch,
        close: async () => {
          for (const watched of watchers.values()) watched.dispose();
          await harness.close(BACKGROUND_CONTEXT);
          const closable = storage as unknown as { close?: () => Promise<void> };
          if (typeof closable.close === 'function') await closable.close();
        }
      };
    })();
    this.hosted.set(project.id, pending);
    try { return await pending; } catch (error) { this.hosted.delete(project.id); throw error; }
  }
  // Durable user blocks are immutable. Weak keys reuse validated refs across stream updates
  // without retaining historical image payloads after their source snapshots are released.
  private readonly projectedImages = new WeakMap<object, { id: string; mimeType: string } | null>();
  private resolveStoredImage(block: unknown): { id: string; mimeType: string } | null {
    if (!block || typeof block !== 'object') return null;
    if (this.projectedImages.has(block)) return this.projectedImages.get(block) ?? null;
    const image = block as { data?: unknown; mimeType?: unknown };
    const result = projectStoredImage(image.data,image.mimeType);
    this.projectedImages.set(block, result);
    return result;
  }
  private shape(hosted: HostedAgent, value: unknown, conversationId?: ConversationId): AgentSessionView {
    const view = agentViewFrom(value, undefined, block => this.resolveStoredImage(block));
    return {
      ...view,
      conversationId: String(conversationId ?? hosted.conversation.id),
      model: view.model ?? { provider: hosted.provider.provider.id, modelId: hosted.provider.getModel().id },
      usageDetail: usageDetailFrom(value),
      dismissals: this.dismissalsOf(view)
    };
  }
  /** The questions this conversation's transcript records as dismissed, keyed by question id. */
  private dismissalsOf(view: AgentView): Readonly<Record<string, AgentDismissal>> {
    const dismissals: Record<string, AgentDismissal> = {};
    for (const entry of view.entries) {
      if (entry.rawKind !== 'app.question.dismissed') continue;
      const data = entry.data ?? {};
      const id = typeof data.questionId === 'string' ? data.questionId : null;
      if (id === null) continue;
      dismissals[id] = Object.freeze({
        reason: typeof data.reason === 'string' ? data.reason : '',
        dismissedAt: typeof data.dismissedAt === 'number' ? data.dismissedAt : entry.at,
        dismissedBy: typeof data.dismissedBy === 'string' ? data.dismissedBy : 'owner'
      });
    }
    return Object.freeze(dismissals);
  }
  private async controlView(project: Project, sessionId?: string): Promise<AgentSessionView> {
    const hosted = await this.selected(project, sessionId);
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    try { return this.shape(hosted, state.value); } finally { state.dispose(); }
  }
  async view(project: Project): Promise<AgentSessionView> {
    this.assertEnabled();
    const hosted = await this.open(project);
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    const shaped = this.shape(hosted, state.value);
    state.dispose();
    return shaped;
  }
  /**
   * The conversation of one named session of this project, or null when this project has none.
   *
   * It is the read a fork is built on: the parent it branches from, and — for a fork's child — the
   * forked conversation itself. Reading it attaches the conversation exactly as `view` does, and it
   * writes no record of its own.
   */
  async sessionView(project: Project, sessionId: string): Promise<AgentSessionView | null> {
    this.assertEnabled();
    // A worker conversation is not a session view. The durable lookup is authoritative, including
    // after a restart when the in-process marker is gone.
    await this.assertSessionAliasAvailable(project, sessionId);
    const id = conversationIdOf(sessionId);
    if (id !== null) {
      const hosted = await this.open(project);
      const conversation = await hosted.harness.conversation(id, BACKGROUND_CONTEXT);
      if (conversation === undefined) return null;
      const state = await conversation.viewState(BACKGROUND_CONTEXT);
      const shaped = this.shape(hosted, state.value, id);
      state.dispose();
      return shaped;
    }
    // Named session (UUID): resolve the conversation through the durable binding.
    const resolver = this.options.conversationBinding;
    if (resolver) {
      const binding = resolver.read(project.id, sessionId);
      if (binding !== null) {
        const hosted = await this.open(project);
        if (await this.isWorkerConversationDurable(hosted, project, binding.conversationId)) throw this.workerConversationRefusal();
        const convId = binding.conversationId as ConversationId;
        const conversation = await hosted.harness.conversation(convId, BACKGROUND_CONTEXT);
        if (conversation === undefined) throw new HttpError(409, 'The durable session binding points to a conversation that is unavailable; it was not replaced');
        const state = await conversation.viewState(BACKGROUND_CONTEXT);
        const shaped = this.shape(hosted, state.value, convId);
        state.dispose();
        return shaped;
      }
    }
    return null;
  }

  /** Whether this project's harness holds a conversation for this session id. Read-only. */
  async hasSession(project: Project, sessionId: string): Promise<boolean> {
    this.assertEnabled();
    const id = conversationIdOf(sessionId);
    if (id !== null) {
      const hosted = await this.open(project);
      if (await this.isWorkerConversationDurable(hosted, project, id)) return false;
      return (await hosted.harness.conversation(id, BACKGROUND_CONTEXT)) !== undefined;
    }
    // Named session (UUID): check the durable binding. A binding that names a worker conversation
    // is not a session.
    const resolver = this.options.conversationBinding;
    if (resolver) {
      const binding = resolver.read(project.id, sessionId);
      if (binding !== null) {
        const hosted = await this.open(project);
        return !(await this.isWorkerConversationDurable(hosted, project, binding.conversationId));
      }
    }
    const cached = this.sessionConversations.get(project.id + ':' + sessionId);
    if (cached === undefined) return false;
    const hosted = await this.open(project);
    return !(await this.isWorkerConversationDurable(hosted, project, cached));
  }

  /**
   * Whether one conversation's transcript holds this entry id, searched oldest first inside the
   * documented bound. It is a read: it commits nothing, writes nothing and asks no model anything.
   * An entry outside the bound is reported as absent, so a cutoff is never guessed at.
   */
  async hasEntry(project: Project, sessionId: string, entryId: number, bound: number): Promise<boolean> {
    this.assertEnabled();
    let hosted: HostedAgent;
    try { hosted = await this.selected(project, sessionId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return false;
      throw error;
    }
    const conversation = hosted.conversation;
    let cursor: Parameters<typeof conversation.entries>[2];
    let read = 0;
    for (;;) {
      const page = await conversation.entries({ order: 'ascending' }, Math.max(1, Math.min(200, bound - read)), cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) if (Number(entry.id) === entryId) return true;
      read += page.items.length;
      if (page.next === undefined || page.items.length === 0 || read >= bound) return false;
      cursor = page.next;
    }
  }

  /**
   * Create the child conversation of a fork: the parent's context **up to and including the cutoff
   * entry** and nothing the parent recorded after it.
   *
   * This is Pi Durable's own `fork(at)`, so the cutoff is the transcript's own rule rather than a copy
   * this application performs; it commits the child and makes **no** model request. The child is
   * created with ownerless ownership, exactly like the project's root conversation, so it is durable
   * and readable like any other conversation of this project.
   */
  async forkTranscript(project: Project, parentSessionId: string, cutoffEntryId: number): Promise<{ childSessionId: string }> {
    this.assertEnabled();
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, parentSessionId);
      const parent = hosted.conversation;
      this.assertNotUncertain(project.id, this.sessionIdentity(project, parent.id));
      const child = await parent.fork(cutoffEntryId as EntryId, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
      return { childSessionId: String(child.id) };
    });
  }

  /**
   * Dispatch one input to a conversation of this project under a stable request identity.
   *
   * It is called **only** for a fork this application has already found active: the fork store owns
   * that rule and refuses a paused, discarded or failed fork before it reaches here. Pi collapses a
   * repeat of one request id onto the submission it already holds, so a retry is the same submission
   * rather than a second model request.
   */
  async dispatchToSession(project: Project, sessionId: string, input: { requestId: string; text: string }): Promise<{ submissionId: string }> {
    this.assertEnabled();
    const text = input.text.trim();
    if (text === '') throw new HttpError(422, 'Enter a message');
    if (text.length > 8000) throw new HttpError(413, 'Message is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const id = conversationIdOf(sessionId);
      if (id !== null && await this.isWorkerConversationDurable(hosted, project, id)) throw this.workerConversationRefusal();
      const conversation = id === null ? undefined : await hosted.harness.conversation(id, BACKGROUND_CONTEXT);
      if (conversation === undefined) throw new HttpError(404, 'This project holds no conversation for that session');
      const actualSessionId = this.sessionIdentity(project, conversation.id);
      this.assertNotUncertain(project.id, actualSessionId);
      const submission = await conversation.submit({ type: 'input', content: text, requestId: input.requestId }, BACKGROUND_CONTEXT);
      return { submissionId: String(submission.id) };
    });
  }

  /**
   * The conversation of one named session, creating a fresh empty conversation when this session
   * has never had one before. A durable binding is authoritative after creation; the legacy numeric
   * session path still directly names its conversation id.
   */
  async ensureSessionConversation(project: Project, sessionId: string): Promise<ConversationId> {
    this.assertEnabled();
    const hosted = await this.open(project);
    // A numeric session id is already a conversation id — no derivation needed, but a worker
    // conversation is never a session and is refused from the control binding and the harness marker.
    const direct = conversationIdOf(sessionId);
    if (direct !== null) {
      if (await this.isWorkerConversationDurable(hosted, project, direct)) throw this.workerConversationRefusal();
      return direct;
    }
    // Use the project-qualified in-process cache only when no durable binding port is configured.
    const cacheKey = project.id + ':' + sessionId;
    const resolver = this.options.conversationBinding;
    // Durable record is authoritative; do not allow a stale cache to mask corruption or mismatch.
    const binding = resolver?.read(project.id, sessionId) ?? null;
    if (binding !== null) {
      if (await this.isWorkerConversationDurable(hosted, project, binding.conversationId)) throw this.workerConversationRefusal();
      this.sessionConversations.set(cacheKey, binding.conversationId as ConversationId);
      return binding.conversationId as ConversationId;
    }
    const cached = this.sessionConversations.get(cacheKey);
    if (cached !== undefined && resolver === undefined) {
      if (await this.isWorkerConversationDurable(hosted, project, cached)) throw this.workerConversationRefusal();
      return cached;
    }
    // Serialize first creation for this session. The control-store admission is the durable
    // single-winner check; a failed durable write refuses the unbound conversation.
    return this.serial('conversation:' + cacheKey, async () => {
      const again = resolver?.read(project.id, sessionId) ?? null;
      if (again !== null) {
        if (await this.isWorkerConversationDurable(hosted, project, again.conversationId)) throw this.workerConversationRefusal();
        this.sessionConversations.set(cacheKey, again.conversationId as ConversationId);
        return again.conversationId as ConversationId;
      }
      const cachedAgain = this.sessionConversations.get(cacheKey);
      if (cachedAgain !== undefined && resolver === undefined) {
        if (await this.isWorkerConversationDurable(hosted, project, cachedAgain)) throw this.workerConversationRefusal();
        return cachedAgain;
      }
      // A named session starts as a genuinely new, empty conversation. Pi Durable's fork(at)
      // requires a real visible entry (entry 0 is not valid); createConversation avoids copying
      // root history and gives the new session its own durable transcript from its first input.
      const rootAgent = await hosted.conversation.agent(BACKGROUND_CONTEXT);
      const authority = await this.dispatchAuthority(project, sessionId);
      const tools = permittedTools(hosted.extensions, authority.scopes);
      const conversation = await hosted.harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model: rootAgent.model, extensions: hosted.extensions, ...(tools === undefined ? {} : { tools }) }
      }, BACKGROUND_CONTEXT);
      if (resolver) {
        // On a concurrent-writer conflict, refuse: never return a conversation that was not durably bound.
        resolver.record({ projectId: project.id, sessionId, conversationId: conversation.id });
      }
      this.sessionConversations.set(cacheKey, conversation.id);
      await hosted.watch(conversation, sessionId);
      return conversation.id;
    });
  }

  /** Subscribes to committed view changes of one session's conversation, or the root when none is named. */
  async subscribe(project: Project, listener: (view: AgentSessionView) => void, sessionId?: string): Promise<() => Promise<void>> {
    this.assertEnabled();
    const hosted = await this.open(project);
    const convId = sessionId ? await this.ensureSessionConversation(project, sessionId) : hosted.conversation.id;
    if (convId === hosted.conversation.id) {
      const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
      listener(this.shape(hosted, state.value));
      const unsubscribe = state.subscribe(() => { listener(this.shape(hosted, state.value)); });
      return async () => {
        if (typeof unsubscribe === 'function') unsubscribe();
        state.dispose();
      };
    }
    const conversation = await hosted.harness.conversation(convId, BACKGROUND_CONTEXT);
    if (!conversation) throw new HttpError(409, 'The durable session binding points to a conversation that is unavailable; it was not replaced');
    const state = await conversation.viewState(BACKGROUND_CONTEXT);
    listener(this.shape(hosted, state.value, convId));
    const unsubscribe = state.subscribe(() => { listener(this.shape(hosted, state.value, convId)); });
    return async () => {
      if (typeof unsubscribe === 'function') unsubscribe();
      state.dispose();
    };
  }
  async submit(project: Project, input: { text: string; mode: AgentInputMode; requestId?: string; images?: readonly AgentImage[]; sessionId?: string }): Promise<{ submissionId: string; queued: boolean }> {
    this.assertEnabled();
    const text = input.text.trim();
    const images = input.images ?? [];
    if (text === '' && images.length === 0) throw new HttpError(422, 'Enter a message');
    if (text.length > 8000) throw new HttpError(413, 'Message is too long');
    // An empty request identity means "none was supplied", so it becomes one generated identity.
    // A non-empty identity must satisfy the same rule the durable lifecycle records, and a bad one
    // is refused here, before any harness opens or any submission is admitted.
    const suppliedRequestId: unknown = input.requestId;
    if (suppliedRequestId !== undefined && suppliedRequestId !== '') {
      if (typeof suppliedRequestId !== 'string' || !requestIdPattern.test(suppliedRequestId))
        throw new HttpError(422, 'requestId must be 1-200 printable characters without spaces');
    }
    const requestId = suppliedRequestId === undefined || suppliedRequestId === '' ? randomUUID() : suppliedRequestId;
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const conversationId = input.sessionId ? await this.ensureSessionConversation(project, input.sessionId) : hosted.conversation.id;
      const conversation = conversationId === hosted.conversation.id ? hosted.conversation : await hosted.harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (!conversation) throw new HttpError(409, 'The session is bound to a conversation that is unavailable; no replacement was created');
      const sessionId = this.sessionIdentity(project, conversation.id);
      await hosted.watch(conversation, sessionId);
      this.assertNotUncertain(project.id, sessionId);
      const selected=(await conversation.agent(BACKGROUND_CONTEXT)).model;
      // The dispatch-time vision check. It reads the model this submission will actually run under, so
      // an image is refused outright — before anything is admitted — rather than dropped, or sent as
      // bytes a text-only model would ignore. Admission runs the same reading through vision().
      if (images.length > 0) this.assertVision(await this.visionFor({ ...hosted, conversation }));
      if(selected&&selected.provider!==hosted.provider.provider.id)await this.options.providers?.assertUsable(selected);
      const whenBusy = input.mode === 'steer' ? 'steer' as const : input.mode === 'reject' ? 'reject' as const : undefined;
      const content = inputContent(text, images);
      // Every admission carries a durable request identity, even when the caller sends none. The
      // lifecycle records this exact identity, so a pause followed by resume finds the existing
      // submission instead of appending the same user input a second time (which could make the
      // model repeat a non-idempotent tool call).
      try {
        this.assertNotUncertain(project.id, sessionId);
        const submission = await conversation.submit({ type: 'input', content, ...(whenBusy ? { whenBusy } : {}), requestId }, BACKGROUND_CONTEXT);
        // The generation is visible in the durable lifecycle under the identity it was submitted with,
        // so a start that finds it running adopts it as interrupted. A hook failure never fails a run.
        try {
          const status = await submission.status(BACKGROUND_CONTEXT);
          // A repeated request can return a completed submission. It starts no generation and
          // must not create another lifecycle attempt, including while another input is running.
          if (status.status !== 'done' && status.status !== 'unanswered') {
            this.assertNotUncertain(project.id, sessionId);
            await this.options.lifecycle?.began({ projectId: project.id, sessionId, requestId });
          }
          await this.reconcileIdleLifecycle(project, { ...hosted, conversation });
        }
        catch (error) { console.error('The session lifecycle could not record that a generation began for project ' + project.id + ': ' + (error as Error).message); }
        return { submissionId: String(submission.id), queued: whenBusy !== 'reject' };
      } catch (error) {
        if ((error as Error).name === 'ConversationBusy') throw new HttpError(409, 'The agent is already working; send a follow-up or a steer instead');
        throw error;
      }
    });
  }
  /** The open question with this id, or the refusal this route already returned. */
  private async openQuestion(hosted: HostedAgent, questionId: string): Promise<AgentQuestion> {
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    const view = this.shape(hosted, state.value);
    state.dispose();
    const question = view.questions.find(candidate => candidate.id === questionId);
    if (!question) throw new HttpError(404, 'Unknown question');
    if (question.answer) throw new HttpError(409, 'This question has already been answered');
    if (this.dismissalsOf(view)[questionId] !== undefined) throw new HttpError(409, 'This question was dismissed by the owner, so it cannot be answered; ask a fresh question instead');
    return question;
  }
  /**
   * Dismisses one open question with a reason, which is deliberately **not** an answer.
   *
   * The order mirrors `answer`: the dismissal is written to the transcript as its own durable entry
   * (who dismissed it, when and why), then the agent is told the question was dismissed rather than
   * silently ignored, so a resumed run sees the decision instead of re-asking. Both carry a request
   * id derived from the question, so a retry collapses onto the one dismissal. An answered question
   * and a question this conversation never asked are both refused.
   */
  async dismissQuestion(project: Project, input: { questionId: string; reason: string; dismissedBy?: string; sessionId?: string }): Promise<{ submissionId: string | null }> {
    this.assertEnabled();
    const reason = input.reason.trim();
    if (reason === '') throw new HttpError(422, 'Enter a reason for dismissing this question');
    if (reason.length > 400) throw new HttpError(413, 'The dismissal reason is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, input.sessionId);
      const sessionId = this.sessionIdentity(project, hosted.conversation.id);
      this.assertNotUncertain(project.id, sessionId);
      const question = await this.openQuestion(hosted, input.questionId);
      const dismissedAt = Date.now();
      const dismissedBy = (input.dismissedBy ?? 'owner').slice(0, 160);
      this.assertNotUncertain(project.id, sessionId);
      await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.question.dismissed', data: { questionId: question.id, reason, dismissedBy, dismissedAt } }, requestId: 'dismiss:' + question.id }, BACKGROUND_CONTEXT);
      // Telling the agent is a second, best-effort step: the transcript entry above is the durable
      // record, and a delivery that fails leaves the dismissal visible rather than hiding it.
      let submissionId: string | null = null;
      try {
        this.assertNotUncertain(project.id, sessionId);
        const submission = await hosted.conversation.submit({ type: 'input', content: 'The owner dismissed your question' + (question.text ? ' ("' + question.text + '")' : '') + ' for this reason: ' + reason + '. Do not proceed with it; wait for a new instruction.', requestId: 'dismiss-input:' + question.id }, BACKGROUND_CONTEXT);
        submissionId = String(submission.id);
      } catch (error) {
        console.error('The dismissal of question ' + question.id + ' was recorded but could not be delivered to the agent: ' + (error as Error).message);
      }
      return { submissionId };
    });
  }
  /**
   * Answers an open question exactly once.
   *
   * The order is the guarantee: the answer is recorded in the delivery ledger first, then written
   * to the transcript, then sent to the agent, and only then acknowledged. A delivery that refuses
   * the record refuses the whole answer — nothing reaches the agent unrecorded — while the ledger's
   * key derived from the question makes a retry reconcile rather than record a second answer. Both
   * submissions carry a request id derived from the question, so a retry or a double tap cannot
   * answer twice either, and an already answered question is refused rather than recorded again.
   * A crash between the record and the transcript write leaves the question open and the answer in
   * the ledger only: a retry of the same text completes it here, and a start that finds the row
   * outstanding completes it through `redeliverAnswer` from the ledger's own text.
   */
  async answer(project: Project, input: { questionId: string; text: string; sessionId?: string }): Promise<{ submissionId: string }> {
    this.assertEnabled();
    const text = input.text.trim();
    if (text === '') throw new HttpError(422, 'Enter an answer');
    if (text.length > 4000) throw new HttpError(413, 'Answer is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, input.sessionId);
      const sessionId = this.sessionIdentity(project, hosted.conversation.id);
      this.assertNotUncertain(project.id, sessionId);
      const question = await this.openQuestion(hosted, input.questionId);
      const answeredAt = Date.now();
      this.assertNotUncertain(project.id, sessionId);
      if (this.options.delivery) await this.options.delivery.answerRecorded({
        projectId: project.id, sessionId, questionId: question.id,
        question: { text: question.text, askedAt: question.askedAt }, text, answeredAt
      });
      this.assertNotUncertain(project.id, sessionId);
      await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.answer', data: { questionId: question.id, text, answeredAt } }, requestId: 'answer:' + question.id }, BACKGROUND_CONTEXT);
      this.assertNotUncertain(project.id, sessionId);
      const submission = await hosted.conversation.submit({ type: 'input', content: text, requestId: 'answer-input:' + question.id }, BACKGROUND_CONTEXT);
      const submissionId = String(submission.id);
      // The answer's outbox step is the answer reaching the agent. A failure to acknowledge leaves
      // the row outstanding for the next start to finish; it never fails an answer that got through.
      if (this.options.delivery) {
        try { await this.options.delivery.answerDelivered({ projectId: project.id, sessionId, questionId: question.id, receipt: { submissionId, requestId: 'answer-input:' + question.id } }); }
        catch (error) { console.error('The answer to question ' + question.id + ' reached the agent but its delivery was not acknowledged: ' + (error as Error).message); }
      }
      return { submissionId };
    });
  }
  /**
   * Re-delivers a recorded answer whose delivery never completed, for a start that found the row
   * outstanding.
   *
   * The transcript is canonical, so the answer is read back from it whenever it is there. When it is
   * not — a crash between the durable answer record and the transcript write — the ledger's own
   * recorded text (`recorded`, read from the ledger by the caller because this host does not hold
   * it) finishes the record: the transcript entry is written and then the submission is made from
   * that text. The question in this transcript must still be there, because an answer to a question
   * this conversation never asked would deliver an unanswerable input.
   *
   * Both writes carry a request id derived from the question, so a repeat finds the original entry
   * and the original submission instead of adding a second; the receipt is the same shape the live
   * answer path acknowledges with, so the two paths cannot disagree about what was delivered.
   */
  async redeliverAnswer(project: Project, questionId: string, recorded?: { text: string; answeredAt: string | number }, sessionId?: string): Promise<{ submissionId: string; requestId: string }> {
    this.assertEnabled();
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, sessionId);
      this.assertNotUncertain(project.id, this.sessionIdentity(project, hosted.conversation.id));
      const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
      const view = this.shape(hosted, state.value);
      state.dispose();
      const question = view.questions.find(candidate => candidate.id === questionId);
      if (!question) throw new HttpError(409, 'The transcript holds no question with this id, so the delivery needs an operator');
      const text = question.answer?.text ?? recorded?.text;
      if (text === undefined) throw new HttpError(409, 'The transcript holds no recorded answer for this question, so the delivery needs an operator');
      this.assertNotUncertain(project.id, this.sessionIdentity(project, hosted.conversation.id));
      if (!question.answer) {
        // The ledger already holds this answer, so completing its transcript write is recording the
        // answer it committed to, not a second one: the same question-derived request id collapses a
        // repeat onto the entry written here.
        const answeredAt = recorded ? (typeof recorded.answeredAt === 'number' ? recorded.answeredAt : Date.parse(recorded.answeredAt)) : Date.now();
        await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.answer', data: { questionId, text, answeredAt } }, requestId: 'answer:' + questionId }, BACKGROUND_CONTEXT);
      }
      this.assertNotUncertain(project.id, this.sessionIdentity(project, hosted.conversation.id));
      const submission = await hosted.conversation.submit({ type: 'input', content: text, requestId: 'answer-input:' + questionId }, BACKGROUND_CONTEXT);
      return { submissionId: String(submission.id), requestId: 'answer-input:' + questionId };
    });
  }
  /**
   * The owner-visible ledger projection for this project: which questions are delivered and which
   * answers are recorded, with the receipt the channel reported. It never returns a path, a secret
   * or any question or answer text, and a ledger it cannot read is reported as unavailable rather
   * than failing the view.
   */
  async deliveryView(project: Project, sessionId?: string): Promise<unknown> {
    this.assertEnabled();
    if (!this.options.delivery) return undefined;
    const hosted = await this.open(project);
    try { return await this.options.delivery.ledgerView({ projectId: project.id, sessionId: this.sessionIdentity(project, (await this.selected(project, sessionId)).conversation.id) }); }
    catch (error) { console.error('The delivery ledger could not be read for project ' + project.id + ': ' + (error as Error).message); return { unavailable: true }; }
  }
  /** Stops the current run: queued inputs are withdrawn and the agent goes idle. */
  async abort(project: Project, sessionId?: string): Promise<void> {
    this.assertEnabled();
    await this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, sessionId);
      await hosted.conversation.abort(BACKGROUND_CONTEXT);
    });
  }
  /**
   * The lifecycle cancel port: stop the current generation without ever starting one.
   *
   * A harness this process never opened has no generation to cancel, and opening one would resume
   * unfinished work - a model request - so it is deliberately left closed. A stop or a pause
   * therefore performs zero model work, which is what the tests assert.
   *
   * A cancel of a genuinely running generation also *owns* the end it causes: see `ownerCancels`.
   * The owner's lifecycle action is the single writer of that revision, so a pause keeps the session
   * resumable instead of racing the watcher's own settled `idle` write.
   */
  async cancelLifecycle(project: Project, sessionId?: string): Promise<void> {
    this.assertEnabled();
    if (!this.hosted.has(project.id)) return;
    // The owner's cancel owns the durable state its action writes next, so the watcher must not write
    // a competing terminal at that revision. The flag is raised before the abort (a settle that lands
    // while it is being raised is already honoured) and is only kept when a generation is genuinely
    // running: a cancel that ends nothing suppresses nothing, so no later generation's settle can be
    // swallowed by a stale flag.
    let selected: HostedAgent;
    try { selected = await this.selected(project, sessionId); }
    catch (error) {
      // A registry-only session has no generation to cancel. Do not create one or act on root.
      if (error instanceof HttpError && error.status === 404) return;
      throw error;
    }
    const key = project.id + ':' + this.sessionIdentity(project, selected.conversation.id);
    this.ownerCancels.add(key);
    try {
      if (!(await this.controlView(project, sessionId)).working) return;
      await this.abort(project, sessionId);
    } finally {
      this.ownerCancels.delete(key);
    }
  }
  /**
   * The last input this conversation carries, which is what a resume or a retry replays: its text and
   * the images it originally carried.
   *
   * An image is never quietly left behind. The content blocks the submission stored are read back
   * exactly as they were written, so a replay carries the same image bytes and types it was submitted
   * with; an input whose images cannot be read back refuses instead of being sent without them, and an
   * input that carries neither text nor an image is not an input a resume could replay.
   */
  private async lastInput(hosted: HostedAgent): Promise<{ text: string; images: AgentImage[] }> {
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    const value = state.value as unknown as { entries?: readonly unknown[] };
    state.dispose();
    const entries = Array.isArray(value?.entries) ? value.entries : [];
    for (const entry of [...entries].reverse()) {
      const record = entry as { kind?: unknown; model?: unknown };
      if (record.kind !== 'pi.user') continue;
      const messages = Array.isArray(record.model) ? record.model as { role?: unknown; content?: unknown }[] : [];
      const last = [...messages].reverse().find(message => message.role === 'user');
      if (!last) continue;
      const replayed = replayOfContent(last.content);
      if (replayed.unreadable > 0)
        throw new HttpError(409, 'The last input in this conversation carried ' + replayed.unreadable +
          ' image(s) that cannot be read back from the transcript, so a resume or a retry cannot carry them. Send the message again with its images rather than continuing without them.');
      if (replayed.text.trim() === '' && replayed.images.length === 0) continue;
      return { text: replayed.text, images: replayed.images };
    }
    throw new HttpError(409, 'This conversation holds no input to continue; an operator must decide');
  }
  /**
   * The lifecycle dispatch port for a resume and a retry.
   *
   * Both re-submit the conversation's last input under the request identity the lifecycle planned:
   * \`resume\` passes the record's own identity and \`retry\` passes the identity derived from the
   * revision the attempt is written at. Neither is minted at random, so Pi's own \`submissionByRequest\`
   * collapses a duplicate of either onto the first submission instead of starting a second model run -
   * and the lifecycle's durable write is what decides which caller reaches this method at all. Nothing
   * here is called for a reconnect, a stop or a pause.
   *
   * A replay is a dispatch, so it runs the same dispatch-time vision check a fresh submission runs:
   * when the input carried images, the model the replay will actually run under must accept them, and
   * a refusal beats a replay with the images silently removed.
   */
  async dispatchLifecycle(project: Project, requestId: string, sessionId?: string): Promise<SessionLifecycleDispatchOutcome> {
    this.assertEnabled();
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.selected(project, sessionId);
      this.assertNotUncertain(project.id, this.sessionIdentity(project, hosted.conversation.id));
      const input = await this.lastInput(hosted);
      if (input.images.length > 0) this.assertVision(await this.visionFor(hosted));
      this.assertNotUncertain(project.id, this.sessionIdentity(project, hosted.conversation.id));
      const submission = await hosted.conversation.submit({ type: 'input', content: inputContent(input.text, input.images), requestId }, BACKGROUND_CONTEXT);
      const status = await submission.status(BACKGROUND_CONTEXT);
      // A planned identity can already name a terminal submission (a resume after a cancelled or
      // finished request, or a retry whose identity was already settled). No generation starts in
      // that case, so report it as terminal rather than claiming a dispatch. `reconcileIdleLifecycle`
      // settles an idle or failed record; the service settles the record if this hook did not.
      if (status.status === 'done' || status.status === 'unanswered') {
        const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
        let stillWorking = false;
        try { stillWorking = agentViewFrom(state.value).working; } finally { state.dispose(); }
        if (!stillWorking) await this.reconcileIdleLifecycle(project, hosted);
        return {
          kind: 'terminal',
          stillWorking,
          reason: stillWorking
            ? 'No additional work was started by this resume: the original request is already terminal, and other work is running in this session.'
            : status.status === 'unanswered'
              ? 'No additional work was started: the original request is already terminal and unanswered. A terminal request cannot be resumed under its original identity; retry is available only for a failed session.'
              : 'No additional work was started: the original request is already complete. A terminal request cannot be resumed under its original identity; send a new message, and retry only a failed session.'
        };
      }
      return { kind: 'dispatched' };
    });
  }
  /** Reconcile an already-terminal input without inventing a new generation or request identity. */
  private async reconcileIdleLifecycle(project: Project, hosted: HostedAgent): Promise<void> {
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    try {
      const view = agentViewFrom(state.value);
      if (!view.working) {
        const terminal = [...view.entries].reverse().find(entry => entry.stopReason !== undefined && entry.stopReason !== null);
        await this.options.lifecycle?.settled({ projectId: project.id, sessionId: this.sessionIdentity(project, hosted.conversation.id), outcome: terminal?.stopReason === 'error' ? 'failed' : 'idle' });
      }
    } finally { state.dispose(); }
  }
  /**
   * The model a project's next submission would actually run under, with its image-input capability.
   * An unregistered or unknown model accepts nothing: the check fails closed.
   */
  private async visionFor(hosted: HostedAgent): Promise<AgentVision> {
    const selected = (await hosted.conversation.agent(BACKGROUND_CONTEXT)).model;
    const reference = selected ?? { provider: hosted.provider.provider.id, modelId: hosted.provider.getModel().id };
    const registered = this.options.providers?.models.getModel(reference.provider, reference.modelId);
    const model = registered ?? (reference.provider === hosted.provider.provider.id ? (hosted.provider.getModel(reference.modelId) ?? hosted.provider.getModel()) : undefined);
    return { provider: reference.provider, modelId: reference.modelId, acceptsImages: modelAcceptsImages(model) };
  }
  /**
   * The dispatch-time vision reading, exposed so admission refuses on the very same model capability.
   * It performs no model work: it opens the conversation and reads the model that is configured.
   */
  async vision(project: Project, sessionId?: string): Promise<AgentVision> {
    this.assertEnabled();
    return this.visionFor(await this.selected(project, sessionId));
  }
  /** Refuse a submission carrying images when the effective model cannot take them. A refusal beats a silent drop. */
  private assertVision(vision: AgentVision): void {
    if (vision.acceptsImages) return;
    throw new HttpError(409, 'The model ' + vision.provider + ' / ' + vision.modelId + ' does not accept image input, so the message was refused rather than sent with the image removed. Choose a model that accepts images, or remove the image and send again.');
  }
  async setModel(project:Project,choice:ModelChoice|null,sessionId?:string):Promise<AgentView>{
    this.assertEnabled();
    return this.serial('agent:'+project.id,async()=>{
      const hosted=await this.selected(project, sessionId);
      if((await this.controlView(project, sessionId)).working)throw new HttpError(409,'Stop the current run before changing models');
      if(choice){
        if(!this.options.providers)throw new HttpError(503,'Provider settings unavailable');
        const m=this.options.providers.models.getModel(choice.provider,choice.modelId);
        if(!m)throw new HttpError(422,'Unknown model');
      }
      await hosted.conversation.configure({model:choice??{provider:hosted.provider.provider.id,modelId:hosted.provider.getModel().id}},BACKGROUND_CONTEXT);
      return this.controlView(project, sessionId);
    });
  }
  /**
   * Run one bounded worker conversation in the application harness.
   *
   * This is the only worker execution path. It creates a fresh conversation with the pinned model
   * and only the permitted tools, submits one input under the run's request identity, and waits for
   * it to settle. It makes no report and writes no worker record: the caller owns those.
   *
   * A cancel resolves the wait and reports `cancelled`; text already committed stays. A provider
   * failure is a named failure with a fixed, path-free reason. The runner is not involved and no
   * provider path is added to it.
   */
  async runWorker(project: Project, input: WorkerRunRequest): Promise<WorkerRunOutcome> {
    this.assertEnabled();
    const hosted = await this.open(project);
    const key = project.id + ':' + input.runId;
    const controller = new AbortController();
    const handle: { conversation: Awaited<ReturnType<Harness['root']>> | null; cancelled: boolean; readonly controller: AbortController } = {
      conversation: null,
      cancelled: input.signal?.aborted === true,
      controller
    };
    const onAbort = () => {
      handle.cancelled = true;
      controller.abort();
      if (handle.conversation !== null) void handle.conversation.abort(BACKGROUND_CONTEXT).catch(() => {});
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // Registered **before** `createConversation` is awaited: a cancel that arrives during the open
    // window is recorded, and the submit below is skipped.
    this.workerRuns.set(key, handle);
    const cancelledOutcome = (turns = 0, text = ''): WorkerRunOutcome => Object.freeze({ text, turns, cancelled: true, failed: false, reason: null });
    const failedOutcome = (reason: string, turns = 0): WorkerRunOutcome => Object.freeze({ text: '', turns, cancelled: false, failed: true, reason });
    try {
      if (handle.cancelled) return cancelledOutcome();
      // Both extensions are the static, registry-installed instances. No dynamic extension is
      // passed to a worker conversation, so every hook and prompt is resolved by the registry.
      const notes = hosted.extensions.find((extension) => extension.name === 'notes');
      const workerRole = hosted.extensions.find((extension) => extension.name === 'worker-role');
      const recoveryGuard = hosted.extensions.find((extension) => extension.name === 'uncertain-recovery-guard');
      const recoveryBoundary = hosted.extensions.find((extension) => extension.name === 'uncertain-recovery-provider-boundary');
      if (notes === undefined || workerRole === undefined || recoveryGuard === undefined || recoveryBoundary === undefined)
        return failedOutcome('The worker role or recovery guards are not installed on this project, so no run was started.');
      const extensions: Extension[] = [notes, recoveryGuard, recoveryBoundary, workerRole];
      const tools = permittedTools(extensions, input.scopes);
      const conversation = await hosted.harness.createConversation({
        ownership: { kind: 'ownerless' },
        // The durable marker is written in the creating transaction. A crash before the
        // control-store binding still leaves a role that fails closed after restart.
        init: async (tx, conversationId) => {
          const marker = await tx.doc(WorkerMarkerDoc, conversationId);
          marker.marker = true;
          marker.projectId = project.id;
          marker.workerId = input.workerId;
          marker.runId = input.runId;
        },
        agent: {
          model: { provider: input.model.provider, modelId: input.model.modelId },
          extensions,
          ...(tools === undefined ? {} : { tools })
        }
      }, BACKGROUND_CONTEXT);
      handle.conversation = conversation;
      this.workerConversations.set(conversation.id, { projectId: project.id, runId: input.runId });
      // Persist the identity before the first submit. A failure here refuses the run without a
      // model request; the conversation is not used as a session.
      await input.onConversation(conversation.id);
      if (handle.cancelled) return cancelledOutcome();
      const before = await input.beforeSubmit();
      if (before !== null) return handle.cancelled ? cancelledOutcome() : failedOutcome(before);
      // Test-only bounded window. Production leaves it unset; a cancel lands inside it
      // deterministically and the submission below is never made.
      const delayMs = this.options.workerOpenDelayMs ?? 0;
      if (delayMs > 0) {
        try { await abortableDelay(delayMs, controller.signal); } catch { /* the cancel signal fired */ }
      }
      if (handle.cancelled) return cancelledOutcome();
      // The last check: a revocation or policy change during the window refuses with no submission.
      const again = await input.beforeSubmit();
      if (again !== null) return handle.cancelled ? cancelledOutcome() : failedOutcome(again);
      this.assertNotUncertain(project.id, String(conversation.id));
      const submission = await conversation.submit({ type: 'input', content: input.prompt, whenBusy: 'reject', requestId: input.requestId }, BACKGROUND_CONTEXT);
      let unanswered = false;
      try {
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        unanswered = settled.status === 'unanswered';
      } catch (error) {
        // An abort settles the submission by rejecting this wait; that is a cancel, not a failure.
        if (!handle.cancelled) throw error;
      }
      const cancelled = handle.cancelled;
      const state = await conversation.viewState(BACKGROUND_CONTEXT);
      const view = agentViewFrom(state.value);
      state.dispose();
      const assistants = view.entries.filter((entry) => entry.kind === 'assistant');
      const turns = assistants.length;
      const text = [...assistants].reverse().find((entry) => entry.text.trim() !== '' && entry.stopReason !== 'error')?.text ?? '';
      if (cancelled) return Object.freeze({ text, turns, cancelled: true, failed: false, reason: null });
      // A provider or credential failure is a named failure, never a report built from the error text.
      const failedEntry = assistants.find((entry) => entry.stopReason === 'error');
      if (failedEntry) return Object.freeze({ text: '', turns, cancelled: false, failed: true, reason: failedEntry.error ?? 'The worker model run failed. Check the provider connection, model access and quota.' });
      if (turns > 8) return Object.freeze({ text, turns, cancelled: false, failed: true, reason: 'The worker stopped at the eight-model-turn ceiling. No report was produced.' });
      if (unanswered || text.trim() === '') return Object.freeze({ text, turns, cancelled: false, failed: true, reason: 'The worker ended without a report.' });
      return Object.freeze({ text, turns, cancelled: false, failed: false, reason: null });
    } catch (error) {
      if (handle.cancelled) return cancelledOutcome();
      return failedOutcome(error instanceof HttpError ? error.message : 'The worker model run failed. Check the provider connection, model access and quota.');
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      this.workerRuns.delete(key);
    }
  }

  /**
   * Whether a numeric conversation belongs to a worker run. The in-process cache is checked first;
   * the durable binding is the authority. A lookup failure is treated as "worker" (fail closed), so
   * an unreadable store can never expose a worker transcript as a session.
   */
  private isWorkerConversation(projectId: string, conversationId: number): boolean {
    if (this.workerConversations.has(conversationId as ConversationId)) return true;
    try { return this.options.workerBinding?.isWorkerConversation(projectId, conversationId) === true; }
    catch { return true; }
  }

  /** The durable marker in the harness database, independent of the control binding and extensions. */
  private async workerMarkerPresent(hosted: HostedAgent, project: Project, conversationId: number): Promise<boolean> {
    try {
      const marker = workerMarkerOf(await hosted.harness.snapshot(WorkerMarkerDoc, conversationId as ConversationId, BACKGROUND_CONTEXT));
      return marker !== null && marker.projectId === project.id;
    } catch {
      // An unreadable marker is treated as a worker role: the caller refuses.
      return true;
    }
  }

  private async isWorkerConversationDurable(hosted: HostedAgent, project: Project, conversationId: number): Promise<boolean> {
    return this.isWorkerConversation(project.id, conversationId) || await this.workerMarkerPresent(hosted, project, conversationId);
  }

  /**
   * Refuse a session id or numeric alias that names a worker conversation.
   *
   * This is the check the stream route makes before it sends event-stream headers, so the refusal is
   * a `409` rather than a stream error. For a numeric alias it also reads the durable harness marker,
   * so a crash between conversation creation and the control binding still fails closed. It opens no
   * model request; a crash-resumed worker task is stopped by the static role's request guard.
   */
  async assertSessionAliasAvailable(project: Project, sessionId?: string): Promise<void> {
    if (sessionId === undefined) return;
    const direct = conversationIdOf(sessionId);
    const id = direct ?? this.options.conversationBinding?.read(project.id, sessionId)?.conversationId;
    if (id === undefined) return;
    if (this.isWorkerConversation(project.id, id)) throw this.workerConversationRefusal();
    if (direct !== null) {
      const hosted = await this.open(project);
      if (await this.workerMarkerPresent(hosted, project, id)) throw this.workerConversationRefusal();
    }
  }

  /** The one refusal message. It names no path and grants nothing. */
  private workerConversationRefusal(): HttpError {
    return new HttpError(409, 'This conversation belongs to a worker run. Its model, scopes and lifecycle are controlled only by the worker record. A session alias, a model setter and the conversation controls cannot use it.');
  }

  /**
   * The numeric conversations this process created for worker runs, for a read-only test and
   * diagnostic check. A conversation id is not a session id and grants nothing.
   */
  workerConversationIds(projectId: string): readonly number[] {
    return Object.freeze([...this.workerConversations.entries()].filter(([, entry]) => entry.projectId === projectId).map(([id]) => Number(id)));
  }

  /** Cooperatively cancel one worker run. A run this process does not hold is a no-op. */
  async cancelWorkerRun(projectId: string, runId: string): Promise<boolean> {
    const key = projectId + ':' + runId;
    const handle = this.workerRuns.get(key);
    if (!handle) return false;
    handle.cancelled = true;
    // Abort the open-window wait immediately. The conversation may not exist yet; the run then
    // skips its submit once it does.
    handle.controller.abort();
    if (handle.conversation !== null) await handle.conversation.abort(BACKGROUND_CONTEXT);
    return true;
  }

  async detach(project:Project):Promise<void>{
    await this.serial('agent:'+project.id,async()=>{
      const pending=this.hosted.get(project.id);if(!pending)return;
      const hosted=await pending;
      if((await this.view(project)).working)throw new HttpError(409,'Stop the agent before connecting a repository');
      await hosted.close();this.hosted.delete(project.id);
    });
  }
  async close(): Promise<void> {
    const opening = [...this.hosted.values()];
    this.hosted.clear();
    await Promise.allSettled(opening.map(async pending => { try { const hosted = await pending; await hosted.close(); } catch { /* an agent that never opened holds nothing to close */ } }));
    await Promise.allSettled([...this.tails.values()]);
  }
}
