import { appendFile,mkdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from 'typebox';
import { safePath } from '../paths';
import { modelAcceptsImages } from '../../shared/images';
import { agentViewFrom, type AgentQuestion, type AgentView } from '../../shared/agent';
import type { Project } from '../../shared/model';
import { HttpError } from '../board-store';
import type { ProviderStore } from '../providers';
import type { ModelChoice } from '../../shared/settings';

export type AgentInputMode = 'followUp' | 'steer' | 'reject';
/** One stored image attached to an input, as base64 and its sniffed type. */
export interface AgentImage { readonly mimeType: string; readonly data: string }
/** What the model a submission would run under accepts. */
export interface AgentVision { readonly provider: string; readonly modelId: string; readonly acceptsImages: boolean }
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

interface HostedAgent {
  harness: Harness;
  conversation: Awaited<ReturnType<Harness['root']>>;
  provider: FauxProviderHandle;
  close(): Promise<void>;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { finish(); reject(new Error('aborted')); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort);
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
 * Documentation tools, bounded to one project.
 *
 * `record_note` appends, which is not idempotent, so it is declared unsafe to replay: a run
 * that dies during it must be told the call was interrupted rather than repeating the write.
 * `read_notes` only reads and is safe to replay.
 */
function notesExtension(project: Project){
  return defineExtension({
    name: 'notes',
    sections: [section('notes-protocol', () => 'Use record_note to append a short note to this project documentation, and read_notes to read the notes back.', { tag: false })],
    tools: [
      defineTool({
        name: 'record_note',
        description: 'Append one line to this project notes file.',
        parameters: Type.Object({
          text: Type.String({ minLength: 1, maxLength: 400, description: 'One line to append' }),
          delayMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60000, description: 'Wait this long before writing, to model a slow call' }))
        }),
        replay: 'unsafe',
        execute: async (args) => {
          if (args.delayMs !== undefined && args.delayMs > 0) await new Promise(resolve => setTimeout(resolve, args.delayMs));
          await mkdir(join(project.path,'docs'),{ recursive: true, mode: 0o755 });
          const file = await safePath(project.path,notesPath);
          await appendFile(file,args.text.trim()+'\n');
          return { output: [{ type: 'text', text: 'Recorded: ' + args.text.trim() }] };
        }
      }),
      defineTool({
        name: 'read_notes',
        description: 'Read this project notes file.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async () => {
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
function scriptedResponses(provider: FauxProviderHandle, pauseMs: number) {
  const respond: FauxResponseFactory = async (context, options) => {
    // Re-arm before anything can be interrupted, so a run always has its next response.
    provider.appendResponses([respond]);
    const text = lastUserText(context).trim();
    const messages = (context as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
    // A tool result comes back as role 'toolResult', and the assistant message that asked
    // carries the call. Either signal means the question was already recorded: never ask twice
    // in one run, or the scripted provider would loop.
    if (messages.at(-1)?.role === 'toolResult') return fauxAssistantMessage('Scripted test reply — no model was called.\n\nI recorded that and stopped guessing.');
    const called = (name: string) => messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => (block as { type?: string; name?: string })?.type === 'toolCall' && (block as { name?: string }).name === name));
    const noteBody = (marker: RegExp) => text.replace(marker,'').replace(/\]\s*$/,'').trim().slice(0,300) || 'a note';
    if (/\[slow-note /i.test(text) && !called('record_note')) return fauxAssistantMessage([fauxToolCall('record_note',{ text: noteBody(/^[\s\S]*?\[slow-note/i), delayMs: 5000 })],{ stopReason: 'toolUse' });
    if (/\[note /i.test(text) && !called('record_note')) return fauxAssistantMessage([fauxToolCall('record_note',{ text: noteBody(/^[\s\S]*?\[note/i) })],{ stopReason: 'toolUse' });
    if (/\[read-notes\]/i.test(text) && !called('read_notes')) return fauxAssistantMessage([fauxToolCall('read_notes',{})],{ stopReason: 'toolUse' });
    const alreadyAsked = called('ask_question');
    if (/\[ask\]/i.test(text) && !alreadyAsked) {
      const subject = text.replace(/\[ask\]/gi, '').trim().slice(0, 120) || 'this change';
      return fauxAssistantMessage([fauxToolCall('ask_question', { question: 'Should I proceed with: ' + subject + '?' })], { stopReason: 'toolUse' });
    }
    if (/\[pause\]/i.test(text) && pauseMs > 0) await pause(pauseMs, (options as { signal?: AbortSignal } | undefined)?.signal);
    const summary = text.replace(/\[pause\]/gi, '').trim().slice(0, 160);
    return fauxAssistantMessage('Scripted test reply — no model was called.\n\nYou said: ' + (summary || '(nothing)'));
  };
  provider.setResponses([respond]);
}

export interface AgentEvent {
  projectId: string;
  projectName: string;
  kind: 'question' | 'finished' | 'error';
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
  private tails = new Map<string, Promise<unknown>>();
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
  constructor(private readonly options: HarnessHostOptions) {}
  get enabled(): boolean { return this.options.enabled; }
  private assertEnabled() { if (!this.options.enabled) throw new HttpError(503, 'Agents are disabled on this instance'); }
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
      // Generation hooks are advisory: ordinary exceptions are reported then ignored.
      // Enforce policy at dispatch, including queued inputs and checkpoint recovery.
      models.streamSimple=(model,context,options)=>{
        const output=createAssistantMessageEventStream();
        void (async()=>{
          try{
            if(model.provider!==provider.provider.id){
              if(!this.options.providers)throw new HttpError(409,'Real providers are not configured');
              await this.options.providers.assertUsable({provider:model.provider,modelId:model.id});
              let turns=0;
              for(const message of [...context.messages].reverse()){if(message.role==='user')break;if(message.role==='assistant')turns++;}
              if(turns>=8)throw new HttpError(409,'Pilot stopped at eight model turns. Review before sending another message.');
            }
            options?.signal?.throwIfAborted();
            const source=stream(model,context,{...options,maxTokens:Math.min(options?.maxTokens??4096,4096)});
            const safeError='Model request failed. Check the provider connection, model access and quota.';
            // Provider/OAuth exceptions may embed raw response bodies. Never persist
            // those as UI errors; retain usage and partial model output only.
            for await(const event of source)output.push(event.type==='error'?{...event,error:{...event.error,errorMessage:safeError}}:event);
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
      scriptedResponses(provider, this.options.pauseMs ?? 2500);
      const storage = await openNodeSqliteStorage(path);
      const question = questionExtension();
      const notes = notesExtension(project);
      const registry = createRegistry();
      registry.install(question);
      registry.install(notes);
      const harness = await Harness.open(storage, { models, registry,settings:{retry:{enabled:false},stream:{maxRetries:0,timeoutMs:120000},compaction:{enabled:false}} }, BACKGROUND_CONTEXT);
      const initial=await this.options.providers?.defaultModel();
      const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: initial??{ provider: provider.provider.id, modelId: provider.getModel().id }, extensions: [question,notes] } });
      // Never replace an existing session's model with a newly changed global default.
      // Continue any run the previous process left unfinished.
      harness.resume();
      // Watch this conversation so a question, a finished run or a failure is reported even
      // when nobody has the interface open. The first reading only primes the comparison.
      const watched = await conversation.viewState(BACKGROUND_CONTEXT);
      const sessionId = String(conversation.id);
      let previous = { working: false, open: 0, errors: 0, primed: false };
      watched.subscribe(() => {
        const view = agentViewFrom(watched.value);
        const openQuestions = view.questions.filter(entry => !entry.answer);
        const open = openQuestions.length;
        const errors = view.entries.filter(entry => entry.stopReason === 'error').length;
        if (previous.primed) {
          if (open > previous.open) {
            const asked = openQuestions.at(-1);
            // The question is made durable before its notification is sent, so a crash between the
            // two is recoverable. A question that cannot be admitted is reported and stays visible
            // in the transcript; it never breaks the run.
            if (asked && this.options.delivery) void this.options.delivery.questionSurfaced({ projectId: project.id, projectName: project.name, sessionId, questionId: asked.id, text: asked.text, askedAt: asked.askedAt }).catch(error => console.error('Question ' + asked.id + ' is open in the transcript but its delivery could not be admitted: ' + (error as Error).message));
            this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'question', detail: asked?.text ?? '' });
          }
          if (previous.working && !view.working) {
            const failed = errors > previous.errors;
            if (failed) this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'error', detail: '' });
            else this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'finished', detail: '' });
            // The owner's own cancel is the one writer at this revision. A cancel of a genuinely
            // running generation ends it in the same instant, and this settle is that end: writing
            // `idle` here would race the owner's `paused`/`idle` write and could overwrite it. The
            // flag is honoured (and cleared) exactly once, so a later genuine end still settles.
            if (this.ownerCancels.delete(project.id)) {
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
      return {
        harness,
        conversation,
        provider,
        close: async () => {
          const disposable = watched as unknown as { dispose?: () => Promise<void> };
          if (typeof disposable.dispose === 'function') await disposable.dispose();
          await harness.close(BACKGROUND_CONTEXT);
          const closable = storage as unknown as { close?: () => Promise<void> };
          if (typeof closable.close === 'function') await closable.close();
        }
      };
    })();
    this.hosted.set(project.id, pending);
    try { return await pending; } catch (error) { this.hosted.delete(project.id); throw error; }
  }
  private shape(hosted: HostedAgent, value: unknown): AgentView {
    const view = agentViewFrom(value);
    return { ...view, conversationId: String(hosted.conversation.id), model: view.model ?? { provider: hosted.provider.provider.id, modelId: hosted.provider.getModel().id } };
  }
  async view(project: Project): Promise<AgentView> {
    this.assertEnabled();
    const hosted = await this.open(project);
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    const shaped = this.shape(hosted, state.value);
    const disposable = state as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
    return shaped;
  }
  /** Subscribes to committed view changes; the callback runs once immediately. */
  async subscribe(project: Project, listener: (view: AgentView) => void): Promise<() => Promise<void>> {
    this.assertEnabled();
    const hosted = await this.open(project);
    const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
    listener(this.shape(hosted, state.value));
    const unsubscribe = state.subscribe(() => { listener(this.shape(hosted, state.value)); });
    return async () => {
      if (typeof unsubscribe === 'function') unsubscribe();
      const disposable = state as unknown as { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === 'function') await disposable.dispose();
    };
  }
  async submit(project: Project, input: { text: string; mode: AgentInputMode; requestId?: string; images?: readonly AgentImage[] }): Promise<{ submissionId: string; queued: boolean }> {
    this.assertEnabled();
    const text = input.text.trim();
    const images = input.images ?? [];
    if (text === '' && images.length === 0) throw new HttpError(422, 'Enter a message');
    if (text.length > 8000) throw new HttpError(413, 'Message is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const selected=(await hosted.conversation.agent(BACKGROUND_CONTEXT)).model;
      // The dispatch-time vision check. It reads the model this submission will actually run under, so
      // an image is refused outright — before anything is admitted — rather than dropped, or sent as
      // bytes a text-only model would ignore. Admission runs the same reading through vision().
      if (images.length > 0) this.assertVision(await this.visionFor(hosted));
      if(selected&&selected.provider!==hosted.provider.provider.id)await this.options.providers?.assertUsable(selected);
      const whenBusy = input.mode === 'steer' ? 'steer' as const : input.mode === 'reject' ? 'reject' as const : undefined;
      const content = inputContent(text, images);
      try {
        const submission = await hosted.conversation.submit({ type: 'input', content, ...(whenBusy ? { whenBusy } : {}), ...(input.requestId ? { requestId: input.requestId } : {}) }, BACKGROUND_CONTEXT);
        // The generation is visible in the durable lifecycle under the identity it was submitted with,
        // so a start that finds it running adopts it as interrupted. A hook failure never fails a run.
        try { await this.options.lifecycle?.began({ projectId: project.id, sessionId: String(hosted.conversation.id), requestId: input.requestId ?? String(submission.id) }); }
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
    const disposable = state as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
    const question = view.questions.find(candidate => candidate.id === questionId);
    if (!question) throw new HttpError(404, 'Unknown question');
    if (question.answer) throw new HttpError(409, 'This question has already been answered');
    return question;
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
  async answer(project: Project, input: { questionId: string; text: string }): Promise<{ submissionId: string }> {
    this.assertEnabled();
    const text = input.text.trim();
    if (text === '') throw new HttpError(422, 'Enter an answer');
    if (text.length > 4000) throw new HttpError(413, 'Answer is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const sessionId = String(hosted.conversation.id);
      const question = await this.openQuestion(hosted, input.questionId);
      const answeredAt = Date.now();
      if (this.options.delivery) await this.options.delivery.answerRecorded({
        projectId: project.id, sessionId, questionId: question.id,
        question: { text: question.text, askedAt: question.askedAt }, text, answeredAt
      });
      await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.answer', data: { questionId: question.id, text, answeredAt } }, requestId: 'answer:' + question.id }, BACKGROUND_CONTEXT);
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
  async redeliverAnswer(project: Project, questionId: string, recorded?: { text: string; answeredAt: string | number }): Promise<{ submissionId: string; requestId: string }> {
    this.assertEnabled();
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
      const view = this.shape(hosted, state.value);
      const disposable = state as unknown as { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === 'function') await disposable.dispose();
      const question = view.questions.find(candidate => candidate.id === questionId);
      if (!question) throw new HttpError(409, 'The transcript holds no question with this id, so the delivery needs an operator');
      const text = question.answer?.text ?? recorded?.text;
      if (text === undefined) throw new HttpError(409, 'The transcript holds no recorded answer for this question, so the delivery needs an operator');
      if (!question.answer) {
        // The ledger already holds this answer, so completing its transcript write is recording the
        // answer it committed to, not a second one: the same question-derived request id collapses a
        // repeat onto the entry written here.
        const answeredAt = recorded ? (typeof recorded.answeredAt === 'number' ? recorded.answeredAt : Date.parse(recorded.answeredAt)) : Date.now();
        await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.answer', data: { questionId, text, answeredAt } }, requestId: 'answer:' + questionId }, BACKGROUND_CONTEXT);
      }
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
  async deliveryView(project: Project): Promise<unknown> {
    this.assertEnabled();
    if (!this.options.delivery) return undefined;
    const hosted = await this.open(project);
    try { return await this.options.delivery.ledgerView({ projectId: project.id, sessionId: String(hosted.conversation.id) }); }
    catch (error) { console.error('The delivery ledger could not be read for project ' + project.id + ': ' + (error as Error).message); return { unavailable: true }; }
  }
  /** Stops the current run: queued inputs are withdrawn and the agent goes idle. */
  async abort(project: Project): Promise<void> {
    this.assertEnabled();
    await this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
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
  async cancelLifecycle(project: Project): Promise<void> {
    this.assertEnabled();
    if (!this.hosted.has(project.id)) return;
    // The owner's cancel owns the durable state its action writes next, so the watcher must not write
    // a competing terminal at that revision. The flag is raised before the abort (a settle that lands
    // while it is being raised is already honoured) and is only kept when a generation is genuinely
    // running: a cancel that ends nothing suppresses nothing, so no later generation's settle can be
    // swallowed by a stale flag.
    this.ownerCancels.add(project.id);
    try {
      if (!(await this.view(project)).working) this.ownerCancels.delete(project.id);
      await this.abort(project);
    } catch (error) {
      this.ownerCancels.delete(project.id);
      throw error;
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
    const disposable = state as unknown as { dispose?: () => Promise<void> };
    if (typeof disposable.dispose === 'function') await disposable.dispose();
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
  async dispatchLifecycle(project: Project, requestId: string): Promise<void> {
    this.assertEnabled();
    await this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const input = await this.lastInput(hosted);
      if (input.images.length > 0) this.assertVision(await this.visionFor(hosted));
      await hosted.conversation.submit({ type: 'input', content: inputContent(input.text, input.images), requestId }, BACKGROUND_CONTEXT);
    });
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
  async vision(project: Project): Promise<AgentVision> {
    this.assertEnabled();
    return this.visionFor(await this.open(project));
  }
  /** Refuse a submission carrying images when the effective model cannot take them. A refusal beats a silent drop. */
  private assertVision(vision: AgentVision): void {
    if (vision.acceptsImages) return;
    throw new HttpError(409, 'The model ' + vision.provider + ' / ' + vision.modelId + ' does not accept image input, so the message was refused rather than sent with the image removed. Choose a model that accepts images, or remove the image and send again.');
  }
  async setModel(project:Project,choice:ModelChoice|null):Promise<AgentView>{
    this.assertEnabled();
    return this.serial('agent:'+project.id,async()=>{
      const hosted=await this.open(project);
      if((await this.view(project)).working)throw new HttpError(409,'Stop the current run before changing models');
      if(choice){
        if(!this.options.providers)throw new HttpError(503,'Provider settings unavailable');
        const m=this.options.providers.models.getModel(choice.provider,choice.modelId);
        if(!m)throw new HttpError(422,'Unknown model');
      }
      await hosted.conversation.configure({model:choice??{provider:hosted.provider.provider.id,modelId:hosted.provider.getModel().id}},BACKGROUND_CONTEXT);
      return this.view(project);
    });
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
