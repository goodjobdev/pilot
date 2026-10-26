import { APPROVAL_TARGET_FIELDS, approvalIsExpired, type ApprovalRecord } from '../../shared/approvals';
import type { SessionLifecycleRecord } from '../../shared/session-lifecycle';
import {
  ATTENTION_SEVERITY, attentionItemId,
  type AttentionAction, type AttentionItem
} from '../../shared/attention';
import { readTranscriptQuestions, type TranscriptQuestionsRead } from './transcript-questions';

/**
 * The authoritative, read-only attention projection for one project.
 *
 * Every item is derived from a durable record that already exists:
 *
 * - **question** — an open question in the project's canonical transcript, read with a read-only
 *   SQLite handle. No harness is opened, so nothing resumes and nothing is dispatched.
 * - **approval** — a pending, unexpired approval whose own scope names this project (or one of its
 *   named sessions). The record's single-use nonce is never copied into an item.
 * - **failure** / **interrupted** — the latest durable lifecycle record of a session in this
 *   project. `paused` and `running` are ordinary states, not attention.
 *
 * Nothing here writes. A source that cannot be read is reported as unavailable and contributes no
 * items: the surface never invents a state, never treats an unreadable store as "nothing to do",
 * and never marks anything resolved because it was viewed.
 */

export type AttentionSourceState = 'read' | 'empty' | 'unavailable';
export interface AttentionSources {
  readonly questions: AttentionSourceState;
  readonly approvals: AttentionSourceState;
  readonly lifecycle: AttentionSourceState;
}

export interface AttentionBuildInput {
  readonly projectId: string;
  readonly dataRoot: string;
  readonly now: Date;
  /** The durable conversation bindings of this project, for mapping a conversation to a session. */
  readonly bindings: readonly { readonly sessionId: string; readonly conversationId: number }[];
  /** The named sessions of this project, used only to attribute a session-scoped approval. */
  /**
   * The registry owners of a session id, read-only and global. One owner that equals this project is
   * the only proof that a session-scoped approval belongs here; zero or two owners are refused.
   */
  readonly sessionOwners?: ((sessionId: string) => readonly string[]) | undefined;
  readonly lifecycle?: { attention(projectId: string): readonly SessionLifecycleRecord[] } | undefined;
  readonly approvals?: { records(): readonly ApprovalRecord[] } | undefined;
}

export interface AttentionBuildResult {
  readonly items: readonly AttentionItem[];
  readonly sources: AttentionSources;
}

const CONTEXT_MAX = 240;
const TARGET_FIELD_MAX = 120;

/** A recorded instant, or null when the source records none. It is never replaced with the epoch. */
function instant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string') {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return null;
}

function line(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > CONTEXT_MAX ? flat.slice(0, CONTEXT_MAX - 1) + '…' : flat;
}

function actionsOf(...actions: AttentionAction[]): readonly AttentionAction[] {
  return Object.freeze(actions);
}

function approvalContext(record: ApprovalRecord): string {
  const fields = APPROVAL_TARGET_FIELDS[record.kind];
  const target = record.target as unknown as Record<string, unknown>;
  const parts = fields.map((field) => {
    const value = String(target[field] ?? '');
    const bounded = value.length > TARGET_FIELD_MAX ? value.slice(0, TARGET_FIELD_MAX - 1) + '…' : value;
    return field + '=' + bounded;
  });
  return line(record.kind + ' · pending · ' + parts.join(' · ') + ' · expires ' + record.expiresAt);
}

export function buildAttention(input: AttentionBuildInput): AttentionBuildResult {
  const items: AttentionItem[] = [];
  const sources: { questions: AttentionSourceState; approvals: AttentionSourceState; lifecycle: AttentionSourceState } = {
    questions: 'unavailable',
    approvals: 'unavailable',
    lifecycle: 'unavailable'
  };

  // Questions: the transcript is canonical, and the read-only handle prevents a display from
  // resuming a run. A dismissed question is not open, and its reason stays in the transcript.
  let questions: TranscriptQuestionsRead;
  try {
    questions = readTranscriptQuestions({ dataRoot: input.dataRoot, projectId: input.projectId, bindings: input.bindings });
  } catch {
    questions = { available: false, reason: 'The project transcript could not be read' };
  }
  sources.questions = questions.available ? questions.file : 'unavailable';
  if (questions.available) {
    for (const question of questions.questions) {
      if (question.answered || question.dismissed) continue;
      items.push(Object.freeze({
        id: attentionItemId('question', question.questionId),
        kind: 'question' as const,
        severity: ATTENTION_SEVERITY.question,
        projectId: input.projectId,
        sessionId: question.sessionId,
        at: instant(question.askedAt),
        context: line(question.text),
        actions: actionsOf('open'),
        questionId: question.questionId
      }));
    }
  }

  // Approvals: pending and unexpired only. A record scoped to another project is not reachable here,
  // even when it has an id; this is a projection, not a second listing with weaker scope rules.
  if (input.approvals !== undefined) {
    sources.approvals = 'read';
    let ownerLookupFailed = false;
    try {
      for (const record of input.approvals.records()) {
        if (record.state !== 'pending') continue;
        if (approvalIsExpired(record, input.now)) continue;
        // A project scope is authoritative when it is present: a record for another project is not
        // reachable here, even when it also names a session this project happens to have.
        if (record.scope.projectId !== undefined) {
          if (record.scope.projectId !== input.projectId) continue;
        } else if (record.scope.sessionId !== undefined) {
          // A session id alone is not proof of a project. Legacy root sessions share the id `1` in
          // every project, so attribution requires a globally unique registry owner equal to this
          // project. An unreadable or ambiguous owner is refused, never guessed.
          if (input.sessionOwners === undefined) continue;
          let owners: readonly string[];
          try { owners = input.sessionOwners(record.scope.sessionId); }
          catch { ownerLookupFailed = true; continue; }
          if (owners.length !== 1 || owners[0] !== input.projectId) continue;
        } else {
          continue;
        }
        items.push(Object.freeze({
          id: attentionItemId('approval', record.id),
          kind: 'approval' as const,
          severity: ATTENTION_SEVERITY.approval,
          projectId: input.projectId,
          sessionId: record.scope.sessionId ?? null,
          at: instant(record.issuedAt),
          context: approvalContext(record),
          actions: actionsOf('consume', 'revoke'),
          approvalId: record.id,
          approvalKind: record.kind,
          scope: Object.freeze({ ...record.scope }),
          target: Object.freeze({ ...record.target }),
          expiresAt: record.expiresAt
        }));
      }
    } catch {
      sources.approvals = 'unavailable';
    }
    // A registry lookup that failed is not a proof of ownership. The source is reported as
    // unavailable (so the count is incomplete), and the attribution fails closed.
    if (ownerLookupFailed) sources.approvals = 'unavailable';
  }

  // Failures and interruptions: the latest durable lifecycle record. `uncertain` interrupted runs
  // offer no action at all, because replay is exactly what must not happen.
  if (input.lifecycle !== undefined) {
    sources.lifecycle = 'read';
    try {
      for (const record of input.lifecycle.attention(input.projectId)) {
        if (record.state === 'failed') {
          items.push(Object.freeze({
            id: attentionItemId('failure', record.sessionId),
            kind: 'failure' as const,
            severity: ATTENTION_SEVERITY.failure,
            projectId: input.projectId,
            sessionId: record.sessionId,
            at: instant(record.activityAt),
            context: line(record.reason ?? 'The run failed.'),
            actions: actionsOf('retry'),
            lifecycleRevision: record.revision,
            reason: line(record.reason ?? 'The run failed.')
          }));
        } else if (record.state === 'interrupted') {
          const reason = line(record.reason ?? 'The run was interrupted.');
          items.push(Object.freeze({
            id: attentionItemId('interrupted', record.sessionId),
            kind: 'interrupted' as const,
            severity: ATTENTION_SEVERITY.interrupted,
            projectId: input.projectId,
            sessionId: record.sessionId,
            at: instant(record.activityAt),
            context: reason,
            actions: record.uncertain ? actionsOf('acknowledge-uncertainty') : actionsOf('resume'),
            lifecycleRevision: record.revision,
            reason,
            uncertain: record.uncertain
          }));
        }
      }
    } catch {
      sources.lifecycle = 'unavailable';
    }
  }

  return Object.freeze({ items: Object.freeze(items), sources: Object.freeze(sources) });
}
