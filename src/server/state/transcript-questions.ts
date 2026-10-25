import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { agentQuestionViews, type AgentEntry } from '../../shared/agent';

/**
 * A read-only projection of the open questions in one project's canonical transcript.
 *
 * The attention surface must not open an agent harness: opening one resumes unfinished work, which
 * would make merely looking at the list start a model request. This reader therefore opens the
 * project's durable SQLite file with `readOnly: true`, reads only the `app.question`, `app.answer`
 * and `app.question.dismissed` entries, and closes it. It creates no file, writes no row and starts
 * no task.
 *
 * The transcript remains canonical. This module is a derived index of that transcript, and a file
 * it cannot read is reported as unavailable rather than guessed at or treated as "no questions".
 *
 * The read matches Durable's **active** transcript, not the whole history. Durable's `head` column
 * on an entry is the first entry of the active context that entry selects (a reset marker). The
 * newest such marker in a conversation bounds the active range at its `head` value; entries older
 * than that bound are hidden history and are not reported here. When a conversation has no marker,
 * every entry is active. This reader does not apply context edits: the harness writes question,
 * answer and dismissal data as entries of their own, and no harness path edits them.
 *
 * Opening a WAL database read-only normally creates `-shm` and `-wal` sidecars even when the
 * caller never writes. When no `-wal` file exists there is no live writer in this process, so the
 * handle uses SQLite's `immutable=1` URI instead: it reads exactly, creates nothing, and cannot
 * checkpoint. When a `-wal` file does exist, a writer is holding the database and the ordinary
 * read-only handle is used so the read sees its committed frames rather than a frozen snapshot.
 */

export interface TranscriptQuestion {
  readonly questionId: string;
  readonly text: string;
  readonly askedAt: number | null;
  readonly conversationId: string;
  /** The named session the conversation is bound to, or the conversation id when there is none. */
  readonly sessionId: string;
  readonly answered: boolean;
  readonly dismissed: boolean;
}

export type TranscriptQuestionsRead =
  | { readonly available: true; readonly file: 'read' | 'empty'; readonly questions: readonly TranscriptQuestion[] }
  | { readonly available: false; readonly reason: string };

const QUESTION_KINDS = ['app.question', 'app.answer', 'app.question.dismissed'] as const;
const projectIdPattern = /^[a-f0-9-]{36}$/;

/** A deterministic session id for a conversation: its durable binding, else its numeric identity. */
function sessionFor(conversationId: string, bindings: ReadonlyMap<string, string>): string {
  return bindings.get(conversationId) ?? conversationId;
}

export function readTranscriptQuestions(input: {
  readonly dataRoot: string;
  readonly projectId: string;
  /** The durable conversation bindings of this project, as session id and conversation id pairs. */
  readonly bindings: readonly { readonly sessionId: string; readonly conversationId: number }[];
}): TranscriptQuestionsRead {
  if (!projectIdPattern.test(input.projectId)) return { available: false, reason: 'The project identifier is not valid' };
  const file = join(input.dataRoot, 'agents', input.projectId, 'session.sqlite');
  // A project whose harness never opened has no transcript at all. That is an empty read, not a
  // fault, and it must not create the file.
  if (!existsSync(file)) return Object.freeze({ available: true as const, file: 'empty' as const, questions: Object.freeze([]) });
  const byConversation = new Map<string, string>();
  for (const binding of [...input.bindings].sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
    const key = String(binding.conversationId);
    if (!byConversation.has(key)) byConversation.set(key, binding.sessionId);
  }
  let database: DatabaseSync | null = null;
  try {
    const liveWriter = existsSync(file + '-wal');
    const location = liveWriter ? file : pathToFileURL(file).href + '?immutable=1';
    database = new DatabaseSync(location, { readOnly: true });
    const rows = database
      .prepare("SELECT id, conversation_id, record FROM entries WHERE json_extract(record,'$.kind') IN (?,?,?) ORDER BY conversation_id, id")
      .all(...QUESTION_KINDS) as unknown as { id: number | bigint; conversation_id: number | bigint; record: string }[];
    const headStatement = database.prepare('SELECT head FROM entries WHERE conversation_id=? AND head IS NOT NULL ORDER BY id DESC LIMIT 1');
    const activeFloor = new Map<string, number | null>();
    /** The first active entry id selected by the newest head marker, or null when there is none. */
    const floorFor = (conversationId: string): number | null => {
      if (activeFloor.has(conversationId)) return activeFloor.get(conversationId) ?? null;
      const marker = headStatement.get(conversationId) as { head?: number | bigint | null } | undefined;
      const floor = marker?.head === undefined || marker.head === null ? null : Number(marker.head);
      activeFloor.set(conversationId, floor);
      return floor;
    };
    const entriesByConversation = new Map<string, AgentEntry[]>();
    const dismissedByConversation = new Map<string, Set<string>>();
    for (const row of rows) {
      const conversationId = String(row.conversation_id);
      // Hidden history before the newest head marker is not part of the active transcript.
      const floor = floorFor(conversationId);
      if (floor !== null && Number(row.id) < floor) continue;
      let record: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(row.record);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        record = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const kind = typeof record.kind === 'string' ? record.kind : '';
      const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : null;
      if (data === null || typeof data.questionId !== 'string') continue;
      if (kind === 'app.question.dismissed') {
        const dismissed = dismissedByConversation.get(conversationId) ?? new Set<string>();
        dismissed.add(data.questionId);
        dismissedByConversation.set(conversationId, dismissed);
        continue;
      }
      const entry: AgentEntry = {
        id: String(record.id ?? ''),
        kind: 'other',
        rawKind: kind,
        at: null,
        // The custom entry carries its own text in `data.text`; the harness writes it there for both
        // the question and the answer, so no provider message is read or interpreted here.
        text: typeof data.text === 'string' ? data.text : '',
        thinking: '',
        tools: [],
        stopReason: null,
        error: null,
        data,
        toolResult: null
      };
      const entries = entriesByConversation.get(conversationId) ?? [];
      entries.push(entry);
      entriesByConversation.set(conversationId, entries);
    }
    const questions: TranscriptQuestion[] = [];
    for (const [conversationId, entries] of entriesByConversation) {
      const dismissed = dismissedByConversation.get(conversationId) ?? new Set<string>();
      for (const question of agentQuestionViews(entries)) {
        questions.push(Object.freeze({
          questionId: question.id,
          text: question.text,
          askedAt: question.askedAt,
          conversationId,
          sessionId: sessionFor(conversationId, byConversation),
          answered: question.answer !== null,
          dismissed: dismissed.has(question.id)
        }));
      }
    }
    return Object.freeze({ available: true as const, file: 'read' as const, questions: Object.freeze(questions) });
  } catch {
    // The path is deliberately not returned or logged: a refusal never carries a filesystem path.
    return Object.freeze({ available: false as const, reason: 'The project transcript could not be read' });
  } finally {
    try { database?.close(); } catch { /* a read-only handle that cannot close holds nothing to recover */ }
  }
}
