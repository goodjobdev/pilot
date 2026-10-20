import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEntryView, agentQuestionViews, agentUsageView, agentViewFrom, emptyAgentView, type AgentEntry } from '../../src/shared/agent';

test('transcript entries map to renderable text, thinking and tool calls', () => {
  const user = agentEntryView({ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hello there', timestamp: 1700 }] });
  assert.deepEqual(user, { id: '1', kind: 'user', rawKind: 'pi.user', at: 1700, text: 'hello there', thinking: '', tools: [], stopReason: null, error: null, data: null });
  const assistant = agentEntryView({
    id: 2,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing options' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }, { type: 'toolCall', name: 'note', arguments: { text: 'x' } }], stopReason: 'toolUse' }]
  });
  assert.equal(assistant?.kind, 'assistant');
  assert.equal(assistant?.text, 'first\nsecond');
  assert.equal(assistant?.thinking, 'weighing options');
  assert.deepEqual(assistant?.tools, [{ name: 'note', args: '{"text":"x"}' }]);
  assert.equal(assistant?.stopReason, 'toolUse');
  assert.equal(agentEntryView({ id: 3, kind: 'pi.tool-result', model: [{ role: 'tool', content: [{ type: 'text', text: 'result' }] }] })?.kind, 'tool');
  assert.equal(agentEntryView({ id: 4, kind: 'pi.system' })?.kind, 'system');
  assert.equal(agentEntryView({ id: 5, kind: 'app.note' })?.kind, 'other');
  assert.equal(agentEntryView({ id: 6 }), null);
  assert.equal(agentEntryView(null), null);
  assert.equal(agentEntryView({id:7,kind:'pi.assistant',model:[{role:'assistant',content:[],stopReason:'error',errorMessage:'Model connection required'}]})?.error,'Model connection required');
});

test('the view reports working state, the inbox and usage', () => {
  const idle = agentViewFrom({ entries: [], docs: {} });
  assert.equal(idle.working, false);
  assert.equal(idle.partial, '');
  assert.deepEqual(idle.usage, { input: 0, output: 0, cost: 0 });

  const busy = agentViewFrom({
    entries: [{ id: 7, kind: 'pi.assistant', model: [{ role: 'assistant', content: 'half a sentence', timestamp: 10 }] }],
    docs: {
      'pi.live': { run: { taskId: 1, inputs: [2] }, generation: { attempt: 2 } },
      'pi.inbox': { items: [{ id: 9, mode: 'steer', content: 'use pnpm' }, { id: 10, mode: 'followUp', content: 'then test' }] },
      'pi.usage': { models: { 'faux/faux-1': { input: 4, output: 5, cost: { total: 0.25 } } }, tools: {} },
      'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } }
    }
  });
  assert.equal(busy.working, true);
  assert.equal(busy.attempt, 2);
  assert.equal(busy.partial, 'half a sentence');
  assert.deepEqual(busy.inbox.map(item => [item.mode, item.text]), [['steer', 'use pnpm'], ['followUp', 'then test']]);
  assert.deepEqual(busy.usage, { input: 4, output: 5, cost: 0.25 });
  assert.deepEqual(busy.model, { provider: 'faux', modelId: 'faux-1' });
});

test('questions pair with answers by id, so one answer resolves one question',()=>{
  const raw=[
    { id: 1, kind: 'app.question', data: { questionId: 'q1', text: 'Which provider?', askedAt: 1700 } },
    { id: 2, kind: 'app.question', data: { questionId: 'q2', text: 'Ship it now?', askedAt: 1800 } },
    { id: 3, kind: 'app.answer', data: { questionId: 'q1', text: 'Stripe', answeredAt: 1900 } },
    { id: 4, kind: 'pi.user', model: [{ role: 'user', content: 'unrelated' }] }
  ];
  const entries=raw.map(agentEntryView).filter((entry): entry is AgentEntry => entry !== null);
  assert.deepEqual(agentQuestionViews(entries),[
    { id: 'q1', text: 'Which provider?', askedAt: 1700, answer: { text: 'Stripe', answeredAt: 1900 } },
    { id: 'q2', text: 'Ship it now?', askedAt: 1800, answer: null }
  ]);
  // An answer whose question is not in the transcript is reported rather than dropped silently.
  const orphan=agentEntryView({ id: 5, kind: 'app.answer', data: { questionId: 'q9', text: 'Orphan', answeredAt: 2000 } })!;
  assert.deepEqual(agentQuestionViews([orphan]),[{ id: 'q9', text: '(the question is no longer in this transcript)', askedAt: null, answer: { text: 'Orphan', answeredAt: 2000 } }]);
  assert.deepEqual(agentQuestionViews([]),[]);
  assert.deepEqual(agentViewFrom({ entries: raw, docs: {} }).questions.map(question=>question.id),['q1','q2']);
});

test('usage totals add up across models and tolerate missing data', () => {
  assert.deepEqual(agentUsageView(undefined), { input: 0, output: 0, cost: 0 });
  assert.deepEqual(agentUsageView({ models: { a: { input: 1, output: 2, cost: { total: 0.5 } }, b: { input: 3, output: 4 } } }), { input: 4, output: 6, cost: 0.5 });
  assert.equal(emptyAgentView().entries.length, 0);
});
