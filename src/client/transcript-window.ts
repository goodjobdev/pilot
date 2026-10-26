import type { AgentEntry, AgentView } from '../shared/agent';

/** Technical client memory bound only. The server transcript remains canonical and unchanged. */
export const CLIENT_TRANSCRIPT_ROW_LIMIT = 500;
/** Questions remain separately actionable, but this client also caps their retained projection. */
export const CLIENT_TRANSCRIPT_QUESTION_LIMIT = 500;

/** Keep the newest rows while preserving stable entry identities and all non-row view semantics. */
export function capTranscriptRows<T extends { entries: readonly AgentEntry[] }>(
  view: T,
  limit = CLIENT_TRANSCRIPT_ROW_LIMIT,
  focusedQuestionId?: string
): T & { entries: AgentEntry[]; transcriptWindow: { omitted: number; limit: number; questionsOmitted?: number } } {
  const safeLimit = Math.max(0, Math.floor(limit));
  const omitted = Math.max(0, view.entries.length - safeLimit);
  const questions = 'questions' in view && Array.isArray(view.questions) ? view.questions : null;
  let retainedQuestions=questions?.slice(-CLIENT_TRANSCRIPT_QUESTION_LIMIT);
  if(questions&&focusedQuestionId&&!retainedQuestions?.some(question=>question.id===focusedQuestionId)){
    const focused=questions.find(question=>question.id===focusedQuestionId);
    if(focused&&CLIENT_TRANSCRIPT_QUESTION_LIMIT>0){
      const keep=new Set([...questions.slice(-(CLIENT_TRANSCRIPT_QUESTION_LIMIT-1)).map(question=>question.id),focusedQuestionId]);
      retainedQuestions=questions.filter(question=>keep.has(question.id));
    }
  }
  const questionOmitted = questions ? Math.max(0, questions.length - (retainedQuestions?.length??0)) : 0;
  return {
    ...view,
    entries: view.entries.slice(omitted) as AgentEntry[],
    ...(questions ? { questions: retainedQuestions??[] } : {}),
    transcriptWindow: { omitted, limit: safeLimit, ...(questionOmitted ? { questionsOmitted: questionOmitted } : {}) }
  } as T & { entries: AgentEntry[]; transcriptWindow: { omitted: number; limit: number; questionsOmitted?: number } };
}

/**
 * Count genuinely new entry identities across a rolling window. A contiguous suffix/prefix overlap
 * proves an exact append count. No overlap or a non-append reorder is unknown, not a guessed count.
 */
export function appendedTranscriptRows(previousIds: readonly string[], currentIds: readonly string[]): { count: number; exact: boolean } {
  if (previousIds.length === 0) return { count: currentIds.length, exact: true };
  const previous = new Set(previousIds);
  const freshPositions = currentIds.map((id, index) => previous.has(id) ? -1 : index).filter(index => index >= 0);
  if (freshPositions.length === 0) {
    const sameOrder=previousIds.length===currentIds.length&&previousIds.every((id,index)=>id===currentIds[index]);
    return { count: 0, exact: sameOrder };
  }
  // New identities must form a suffix. Any new id inserted into old history indicates a reorder.
  const firstFresh = freshPositions[0]!;
  if (freshPositions.some((position, index) => position !== firstFresh + index)) return { count: freshPositions.length, exact: false };
  let overlap = Math.min(previousIds.length, firstFresh);
  while (overlap > 0 && !previousIds.slice(-overlap).every((id,index)=>id===currentIds[index])) overlap -= 1;
  if (overlap === 0) return { count: freshPositions.length, exact: false };
  return { count: freshPositions.length, exact: true };
}

export function retainedAgentView(view: AgentView, focusedQuestionId?: string): AgentView {
  return capTranscriptRows(view,CLIENT_TRANSCRIPT_ROW_LIMIT,focusedQuestionId);
}
