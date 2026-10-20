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
import { agentViewFrom, type AgentView } from '../../shared/agent';
import type { Project } from '../../shared/model';
import { HttpError } from '../board-store';
import type { ProviderStore } from '../providers';
import type { ModelChoice } from '../../shared/settings';

export type AgentInputMode = 'followUp' | 'steer' | 'reject';
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

export interface HarnessHostOptions {
  dataRoot: string;
  enabled: boolean;
  /** How long a [pause] message holds the run open, in milliseconds. */
  pauseMs?: number;
  providers?: ProviderStore;
  /** Called when a run needs a person, finishes or fails, with no browser attached. */
  onEvent?: (event: AgentEvent) => void;
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
      let previous = { working: false, open: 0, errors: 0, primed: false };
      watched.subscribe(() => {
        const view = agentViewFrom(watched.value);
        const open = view.questions.filter(entry => !entry.answer).length;
        const errors = view.entries.filter(entry => entry.stopReason === 'error').length;
        if (previous.primed) {
          if (open > previous.open) this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'question', detail: view.questions.filter(entry => !entry.answer).at(-1)?.text ?? '' });
          if (previous.working && !view.working) {
            if (errors > previous.errors) this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'error', detail: '' });
            else this.options.onEvent?.({ projectId: project.id, projectName: project.name, kind: 'finished', detail: '' });
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
  async submit(project: Project, input: { text: string; mode: AgentInputMode; requestId?: string }): Promise<{ submissionId: string; queued: boolean }> {
    this.assertEnabled();
    const text = input.text.trim();
    if (text === '') throw new HttpError(422, 'Enter a message');
    if (text.length > 8000) throw new HttpError(413, 'Message is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const selected=(await hosted.conversation.agent(BACKGROUND_CONTEXT)).model;
      if(selected&&selected.provider!==hosted.provider.provider.id)await this.options.providers?.assertUsable(selected);
      const whenBusy = input.mode === 'steer' ? 'steer' as const : input.mode === 'reject' ? 'reject' as const : undefined;
      try {
        const submission = await hosted.conversation.submit({ type: 'input', content: text, ...(whenBusy ? { whenBusy } : {}), ...(input.requestId ? { requestId: input.requestId } : {}) }, BACKGROUND_CONTEXT);
        return { submissionId: String(submission.id), queued: whenBusy !== 'reject' };
      } catch (error) {
        if ((error as Error).name === 'ConversationBusy') throw new HttpError(409, 'The agent is already working; send a follow-up or a steer instead');
        throw error;
      }
    });
  }
  /**
   * Answers an open question exactly once.
   *
   * Both record the answer and send it to the agent, and both carry a request id derived
   * from the question, so a retry or a double tap cannot answer twice. An already answered
   * question is refused rather than recorded again.
   */
  async answer(project: Project, input: { questionId: string; text: string }): Promise<{ submissionId: string }> {
    this.assertEnabled();
    const text = input.text.trim();
    if (text === '') throw new HttpError(422, 'Enter an answer');
    if (text.length > 4000) throw new HttpError(413, 'Answer is too long');
    return this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      const state = await hosted.conversation.viewState(BACKGROUND_CONTEXT);
      const view = this.shape(hosted, state.value);
      const disposable = state as unknown as { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === 'function') await disposable.dispose();
      const question = view.questions.find(candidate => candidate.id === input.questionId);
      if (!question) throw new HttpError(404, 'Unknown question');
      if (question.answer) throw new HttpError(409, 'This question has already been answered');
      await hosted.conversation.submit({ type: 'write', entry: { kind: 'app.answer', data: { questionId: input.questionId, text, answeredAt: Date.now() } }, requestId: 'answer:' + input.questionId }, BACKGROUND_CONTEXT);
      const submission = await hosted.conversation.submit({ type: 'input', content: text, requestId: 'answer-input:' + input.questionId }, BACKGROUND_CONTEXT);
      return { submissionId: String(submission.id) };
    });
  }
  /** Stops the current run: queued inputs are withdrawn and the agent goes idle. */
  async abort(project: Project): Promise<void> {
    this.assertEnabled();
    await this.serial('agent:' + project.id, async () => {
      const hosted = await this.open(project);
      await hosted.conversation.abort(BACKGROUND_CONTEXT);
    });
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
