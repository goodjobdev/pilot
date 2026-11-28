import { MAX_IMAGES_PER_MESSAGE } from './images';
/** Shapes the agent view is rendered from. Pure: no Node and no Durable import. */

export type AgentEntryKind = 'user' | 'assistant' | 'tool' | 'system' | 'other';

export interface AgentToolUse { name: string; args: string }
/**
 * What a tool result message records about itself, kept apart from any call it may answer.
 *
 * The transcript carries no reliable call identity in the view this build maps, so these fields are
 * used as the result's own provenance: its tool name, the protocol's error flag and the harness's
 * own measured execution time. No instant is derived here and no duration is computed from two
 * timestamps.
 */
export interface AgentToolResultMeta {
  name: string | null;
  isError: boolean | null;
  durationMs: number | null;
}
export interface AgentEntry {
  id: string;
  kind: AgentEntryKind;
  /** The stored kind, before it is mapped to a display kind. */
  rawKind: string;
  at: number | null;
  text: string;
  thinking: string;
  tools: AgentToolUse[];
  stopReason: string | null;
  error: string | null;
  /** Authenticated media identifiers projected by the server; never image bytes or URLs. */
  images?: { id: string; mimeType: string }[];
  /** Custom entry payload, if the entry is not a provider message. */
  data: Record<string, unknown> | null;
  /** The result's own recorded metadata, or null when this entry is not a tool result. */
  toolResult: AgentToolResultMeta | null;
}
export interface AgentQuestion {
  id: string;
  text: string;
  askedAt: number | null;
  answer: { text: string; answeredAt: number | null } | null;
}
export interface AgentInboxItem { id: string; mode: string; text: string }
/** The thinking levels a session may choose, in Pi's own vocabulary, weakest first. */
export const THINKING_LEVELS = ['off','minimal','low','medium','high','xhigh','max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/**
 * The largest single message the server accepts. It is deliberately generous: a long paste is a
 * normal thing to send. The interface offers to save anything past its own smaller threshold as a
 * file in the worktree, which is a convenience rather than a limit.
 */
export const MESSAGE_MAX_CHARS = 200000;
/**
 * The inclusive ceiling for how many model requests one dispatch may make in a row. The bound
 * itself is an operator setting; this is the range any of them must fall inside.
 */
export const MAX_MODEL_TURNS_CEILING = 300;
/** The bound an instance runs with when nothing sets it. */
export const MAX_MODEL_TURNS_DEFAULT = 40;
/** Past this, the interface offers to keep the text as a document instead of inline. */
export const MESSAGE_DOCUMENT_THRESHOLD = 8000;

export interface AgentView {
  /** Client transcript-window metadata. It describes only retained rows, not transcript retention. */
  transcriptWindow?: { omitted: number; limit: number; questionsOmitted?: number };
  conversationId: string;
  working: boolean;
  attempt: number | null;
  entries: AgentEntry[];
  partial: string;
  inbox: AgentInboxItem[];
  usage: { input: number; output: number; cost: number };
  model: { provider: string; modelId: string } | null;
  /** The session's thinking level, or null when the host's default is in force. */
  thinkingLevel: ThinkingLevel | null;
  questions: AgentQuestion[];
  updatedAt: string;
}

const kindOf = (kind: string): AgentEntryKind =>
  kind === 'pi.user' ? 'user' : kind === 'pi.assistant' ? 'assistant' : kind === 'pi.tool-result' ? 'tool' : kind === 'pi.system' ? 'system' : 'other';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const typed = block as { type?: string; text?: string };
        if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(block => (block && typeof block === 'object' && (block as { type?: string }).type === 'thinking' ? String((block as { thinking?: string }).thinking ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}
function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function toolResultOf(message: Record<string, unknown>): AgentToolResultMeta {
  return {
    name: typeof message.toolName === 'string' && message.toolName !== '' ? message.toolName : null,
    isError: typeof message.isError === 'boolean' ? message.isError : null,
    durationMs: nonNegative(message.durationMs)
  };
}
function toolsOf(content: unknown): AgentToolUse[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const typed = block as { type?: string; name?: string; arguments?: unknown };
    if (typed.type !== 'toolCall' || typeof typed.name !== 'string') return [];
    let args = '';
    try { args = JSON.stringify(typed.arguments ?? {}); } catch { args = ''; }
    return [{ name: typed.name, args: args.slice(0, 400) }];
  });
}

function imageRefsOf(content: unknown, resolve?: (block: unknown) => { id: string; mimeType: string } | null): { id: string; mimeType: string }[] {
  if (!resolve || !Array.isArray(content)) return [];
  const images: { id: string; mimeType: string }[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') continue;
    const image = resolve(block);
    if (image) images.push(image);
    if (images.length === MAX_IMAGES_PER_MESSAGE) break;
  }
  return images;
}

/**
 * Maps one stored transcript entry to something renderable.
 *
 * Durable stores a provider-facing message list on each entry. Text, thinking and tool calls
 * are surfaced directly; user images require a server resolver that returns only media references.
 * Provider image bytes are never included in the view, and nothing is interpreted as markup.
 */
export function agentEntryView(entry: unknown, imageResolver?: (block: unknown) => { id: string; mimeType: string } | null): AgentEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as { id?: unknown; kind?: unknown; model?: unknown; data?: unknown };
  if (typeof record.kind !== 'string') return null;
  const messages = Array.isArray(record.model) ? (record.model as Record<string, unknown>[]) : [];
  const last = messages.at(-1) ?? {};
  const content = last.content;
  const data = record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>) : null;
  // A custom entry carries its text in data rather than in provider messages.
  const customText = data && typeof data.text === 'string' ? data.text : '';
  return {
    id: String(record.id ?? ''),
    kind: kindOf(record.kind),
    rawKind: record.kind,
    at: typeof last.timestamp === 'number' ? last.timestamp : null,
    text: textOf(content) || customText,
    thinking: thinkingOf(content),
    tools: toolsOf(content),
    stopReason: typeof last.stopReason === 'string' ? last.stopReason : null,
    error: typeof last.errorMessage==='string'?last.errorMessage:null,
    images: record.kind === 'pi.user' ? imageRefsOf(content, imageResolver) : [],
    data,
    toolResult: record.kind === 'pi.tool-result' ? toolResultOf(last) : null
  };
}

/**
 * Pairs the questions an agent asked with the answers a human gave, by question id.
 * A question is open until an answer records the same id, which is what makes
 * answering once resolve once.
 */
export function agentQuestionViews(entries: readonly AgentEntry[]): AgentQuestion[] {
  const questions = new Map<string, AgentQuestion>();
  for (const entry of entries) {
    const data = entry.data ?? {};
    const id = typeof data.questionId === 'string' ? data.questionId : null;
    if (id === null) continue;
    if (entry.rawKind === 'app.question') {
      questions.set(id, { id, text: entry.text, askedAt: typeof data.askedAt === 'number' ? data.askedAt : entry.at, answer: null });
    } else if (entry.rawKind === 'app.answer') {
      const existing = questions.get(id) ?? { id, text: '(the question is no longer in this transcript)', askedAt: null, answer: null };
      questions.set(id, { ...existing, answer: { text: entry.text, answeredAt: typeof data.answeredAt === 'number' ? data.answeredAt : entry.at } });
    }
  }
  return [...questions.values()];
}

export function agentUsageView(usage: unknown): { input: number; output: number; cost: number } {
  const models = usage && typeof usage === 'object' ? (usage as { models?: Record<string, { input?: number; output?: number; cost?: { total?: number } }> }).models : undefined;
  let input = 0, output = 0, cost = 0;
  for (const totals of Object.values(models ?? {})) {
    input += Number(totals?.input ?? 0);
    output += Number(totals?.output ?? 0);
    cost += Number(totals?.cost?.total ?? 0);
  }
  return { input, output, cost };
}

export function emptyAgentView(conversationId = '', model: AgentView['model'] = null): AgentView {
  return { conversationId, working: false, attempt: null, entries: [], partial: '', inbox: [], usage: { input: 0, output: 0, cost: 0 }, model, thinkingLevel: null, questions: [], updatedAt: new Date(0).toISOString() };
}

/** Maps a Durable conversation view (entries plus built-in documents) to the client shape. */
export function agentViewFrom(value: unknown, updatedAt = new Date().toISOString(), imageResolver?: (block: unknown) => { id: string; mimeType: string } | null): AgentView {
  const state = (value ?? {}) as { entries?: unknown[]; docs?: Record<string, unknown> };
  const entries = (state.entries ?? []).map(entry => agentEntryView(entry, imageResolver)).filter((entry): entry is AgentEntry => entry !== null);
  const live = (state.docs?.['pi.live'] ?? {}) as { run?: unknown; generation?: { attempt?: number } };
  const inboxDoc = (state.docs?.['pi.inbox'] ?? {}) as { items?: { id?: unknown; mode?: unknown; content?: unknown }[] };
  const agentDoc = (state.docs?.['pi.agent'] ?? {}) as { model?: { provider?: string; modelId?: string }; thinkingLevel?: unknown };
  const thinkingLevel = THINKING_LEVELS.includes(agentDoc.thinkingLevel as ThinkingLevel) ? agentDoc.thinkingLevel as ThinkingLevel : null;
  const inbox = (inboxDoc.items ?? []).map(item => ({ id: String(item.id ?? ''), mode: String(item.mode ?? 'queued'), text: typeof item.content === 'string' ? item.content : '' }));
  const lastAssistant = entries.filter(entry => entry.kind === 'assistant').at(-1);
  return {
    conversationId: '',
    working: live.run !== undefined || live.generation !== undefined,
    attempt: typeof live.generation?.attempt === 'number' ? live.generation.attempt : null,
    entries,
    // Partial content is committed into the transcript as it streams, so the newest
    // assistant entry is the live text while a run is working.
    partial: live.run !== undefined ? (lastAssistant?.text ?? '') : '',
    inbox,
    usage: agentUsageView(state.docs?.['pi.usage']),
    model: agentDoc.model?.provider && agentDoc.model?.modelId ? { provider: agentDoc.model.provider, modelId: agentDoc.model.modelId } : null,
    thinkingLevel,
    questions: agentQuestionViews(entries),
    updatedAt
  };
}
