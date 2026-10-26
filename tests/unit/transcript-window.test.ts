import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAgentView, type AgentEntry } from '../../src/shared/agent';
import { appendedTranscriptRows, capTranscriptRows, CLIENT_TRANSCRIPT_QUESTION_LIMIT, CLIENT_TRANSCRIPT_ROW_LIMIT, retainedAgentView } from '../../src/client/transcript-window';

function row(id: string): AgentEntry {
  return { id, kind: 'user', rawKind: 'pi.user', at: null, text: id, thinking: '', tools: [], stopReason: null, error: null, data: null, toolResult: null };
}

test('the client keeps newest rows, stable keys, exact omissions, and untruncated totals', () => {
  const view = { ...emptyAgentView(), entries: Array.from({ length: 507 }, (_, i) => row(`row-${i}`)), usage: { input: 99, output: 42, cost: 3 }, questions: [{ id: 'pending', text: 'action?', askedAt: null, answer: null }] };
  const result = retainedAgentView(view);
  assert.equal(CLIENT_TRANSCRIPT_ROW_LIMIT, 500);
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries[0]?.id, 'row-7');
  assert.equal(result.entries.at(-1)?.id, 'row-506');
  assert.deepEqual(result.transcriptWindow, { omitted: 7, limit: 500 });
  assert.deepEqual(result.usage, view.usage);
  assert.deepEqual(result.questions, view.questions);
});

test('rolling-window overlap counts multiple new identities exactly', () => {
  const before = Array.from({ length: 500 }, (_, i) => `row-${i}`);
  const after = [...before.slice(20), ...Array.from({ length: 20 }, (_, i) => `new-${i}`)];
  assert.deepEqual(appendedTranscriptRows(before, after), { count: 20, exact: true });
  assert.deepEqual(appendedTranscriptRows(['a','b','c','d'], ['b','c','d','x','y']), { count: 2, exact: true });
});

test('stale, reordered, and non-overlapping views do not claim an exact arrival count', () => {
  const before = ['a', 'b', 'c', 'd'];
  assert.deepEqual(appendedTranscriptRows(before, ['a', 'b', 'c', 'd']), { count: 0, exact: true });
  assert.deepEqual(appendedTranscriptRows(before, ['d', 'b', 'c', 'a']), { count: 0, exact: false });
  assert.deepEqual(appendedTranscriptRows(before, ['x', 'y']), { count: 2, exact: false });
});

test('same entry identity with streamed text updates is not a new transcript row', () => {
  assert.deepEqual(appendedTranscriptRows(['a', 'partial'], ['a', 'partial']), { count: 0, exact: true });
});

test('question rows have a separate cap and explicit omission metadata', () => {
  const questions = Array.from({ length: CLIENT_TRANSCRIPT_QUESTION_LIMIT + 3 }, (_, i) => ({ id: `q-${i}`, text: 'pending', askedAt: null, answer: null }));
  const result = retainedAgentView({ ...emptyAgentView(), questions });
  assert.equal(result.questions.length, CLIENT_TRANSCRIPT_QUESTION_LIMIT);
  assert.equal(result.questions[0]?.id, 'q-3');
  assert.equal(result.transcriptWindow?.questionsOmitted, 3);
});

test('an authoritative question deep link retains its exact omitted identity within the 500-question cap',()=>{
  const questions=Array.from({length:CLIENT_TRANSCRIPT_QUESTION_LIMIT+5},(_,i)=>({id:`q-${i}`,text:`question ${i}`,askedAt:null,answer:null}));
  const result=retainedAgentView({...emptyAgentView(),questions},'q-0');
  assert.equal(result.questions.length,CLIENT_TRANSCRIPT_QUESTION_LIMIT);
  assert.equal(result.questions[0]?.id,'q-0');
  assert.equal(result.questions[1]?.id,'q-6');
  assert.equal(result.transcriptWindow?.questionsOmitted,5);
});

test('the cap does not mutate source rows and preserves question identities outside the row window', () => {
  const entries = [row('old'), row('new')];
  const result = capTranscriptRows({ entries, questions: [{ id: 'outside-row-window', text: 'pending', askedAt: null, answer: null }] }, 1);
  assert.deepEqual(entries.map(entry => entry.id), ['old', 'new']);
  assert.deepEqual(result.entries.map(entry => entry.id), ['new']);
  assert.equal(result.questions[0]?.id, 'outside-row-window');
  assert.equal(result.transcriptWindow.omitted, 1);
});
