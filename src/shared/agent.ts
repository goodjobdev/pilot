/** Shapes the agent view is rendered from. Pure: no Node and no Durable import. */

export type AgentEntryKind = 'user' | 'assistant' | 'tool' | 'system' | 'other';

export interface AgentToolUse { name: string; args: string }
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
  /** Custom entry payload, if the entry is not a provider message. */
  data: Record<string, unknown> | null;
}
export interface AgentQuestion {
  id: string;
  text: string;
  askedAt: number | null;
  answer: { text: string; answeredAt: number | null } | null;
}
export interface AgentInboxItem { id: string; mode: string; text: string }
export interface AgentView {
  conversationId: string;
  working: boolean;
  attempt: number | null;
  entries: AgentEntry[];
  partial: string;
  inbox: AgentInboxItem[];
  usage: { input: number; output: number; cost: number };
  model: { provider: string; modelId: string } | null;
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

/**
 * Maps one stored transcript entry to something renderable.
 *
 * Durable stores a provider-facing message list on each entry; only text,
 * thinking and tool-call blocks are surfaced, and nothing is interpreted as
 * markup by the server.
 */
export function agentEntryView(entry: unknown): AgentEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as { id?: unknown; kind?: unknown; model?: unknown; data?: unknown };
  if (typeof record.kind !== 'string') return null;
  const messages = Array.isArray(record.model) ? (record.model as Record<string, unknown>[]) : [];
  const last = messages.at(-1) ?? {};
  const content = last.content;
  const usage = last.usage as { input?: number; output?: number } | undefined;
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
    error: (usage && typeof (usage as { errorMessage?: string }).errorMessage === 'string' ? (usage as { errorMessage: string }).errorMessage : null),
    data
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
  return { conversationId, working: false, attempt: null, entries: [], partial: '', inbox: [], usage: { input: 0, output: 0, cost: 0 }, model, questions: [], updatedAt: new Date(0).toISOString() };
}

/** Maps a Durable conversation view (entries plus built-in documents) to the client shape. */
export function agentViewFrom(value: unknown, updatedAt = new Date().toISOString()): AgentView {
  const state = (value ?? {}) as { entries?: unknown[]; docs?: Record<string, unknown> };
  const entries = (state.entries ?? []).map(agentEntryView).filter((entry): entry is AgentEntry => entry !== null);
  const live = (state.docs?.['pi.live'] ?? {}) as { run?: unknown; generation?: { attempt?: number } };
  const inboxDoc = (state.docs?.['pi.inbox'] ?? {}) as { items?: { id?: unknown; mode?: unknown; content?: unknown }[] };
  const agentDoc = (state.docs?.['pi.agent'] ?? {}) as { model?: { provider?: string; modelId?: string } };
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
    questions: agentQuestionViews(entries),
    updatedAt
  };
}
