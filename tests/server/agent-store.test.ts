import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../../src/server/state/control-store';
import { AgentStore } from '../../src/server/state/agent-store';
import {
  AGENT_BUDGET_BOUNDS, AGENT_SCOPES, AGENT_SCOPE_DESCRIPTIONS, AGENT_TOOL_SCOPES, AgentError, agentScopeVocabulary,
  authorizeToolUse, decideScopeChange, parseAgentBudgets, parseAgentScopes, parseAgentWorkspace, scopesInForceFor,
  type AgentActor, type AgentDraft, type AgentRecord, type AgentScope
} from '../../src/shared/agent-registry';

/**
 * The durable agent registry: strict validation, the closed scope vocabulary, default deny, and the
 * governance rule.
 *
 * Everything here runs over a disposable root with its own control store. Nothing reads or writes a
 * live project, a real planning document, a provider or an agent store, and no model call is made.
 */

const OWNER: AgentActor = Object.freeze({ kind: 'owner', identity: 'owner' });
const OFFERED = [{ provider: 'scripted', modelId: 'scripted-1' }, { provider: 'openai', modelId: 'gpt-5' }];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-agents-'));
  const store = new ControlStore(root);
  const projectId = randomUUID();
  const agents = new AgentStore(store, {
    models: () => OFFERED,
    projectKnown: (id) => id === projectId
  });
  return {
    root, store, agents, projectId,
    draft: (over: Partial<AgentDraft> = {}): AgentDraft => ({
      name: 'Nightly reviewer',
      description: 'Reviews what landed overnight.',
      enabled: true,
      model: { provider: 'scripted', modelId: 'scripted-1' },
      workspace: { projectId, subpath: '' },
      budgets: { maxRequests: 20, maxOutputTokens: 4096, maxJobsPerHour: 4 },
      scopes: ['read_notes', 'ask_question'],
      ...over
    }),
    cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); }
  };
}
/** One refusal, typed and by code. */
async function refused(work: () => unknown, code: AgentError['code']): Promise<string> {
  try { await work(); } catch (error) {
    assert.ok(error instanceof AgentError, 'the refusal is the registry own: ' + String(error));
    assert.equal(error.code, code, error.message);
    return error.message;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

test('the scope vocabulary is closed, described, and every scope governs at least one declared tool or is a stated capability', () => {
  // The vocabulary is exactly the documented set, and every scope carries one description.
  assert.deepEqual([...AGENT_SCOPES], ['read_notes', 'record_note', 'ask_question', 'read_docs', 'write_docs', 'file_read', 'file_edit', 'run_tests', 'fork', 'accept', 'commit', 'push', 'deploy', 'spend', 'provision', 'publish']);
  for (const scope of AGENT_SCOPES) {
    assert.equal(typeof AGENT_SCOPE_DESCRIPTIONS[scope], 'string');
    assert.ok(AGENT_SCOPE_DESCRIPTIONS[scope].length > 10, scope + ' has a real description');
  }
  const vocabulary = agentScopeVocabulary();
  assert.deepEqual(vocabulary.map((entry) => entry.scope), [...AGENT_SCOPES], 'the vocabulary is reported in the closed order');
  // Every tool this build exposes to a model is governed by a scope from the same closed set.
  for (const tool of Object.keys(AGENT_TOOL_SCOPES)) assert.ok((AGENT_SCOPES as readonly string[]).includes(AGENT_TOOL_SCOPES[tool]), tool);
  // The vocabulary has no dead word: every scope is either declared on a tool or is a capability the
  // action registry and the acceptance record name (fork, accept, commit, push, deploy, spend,
  // provision, publish) — none is a label with nothing behind it.
  const toolScopes = new Set(Object.values(AGENT_TOOL_SCOPES));
  for (const scope of ['read_notes', 'record_note', 'ask_question', 'read_docs', 'write_docs', 'file_read', 'file_edit', 'run_tests'] as AgentScope[]) {
    assert.ok(toolScopes.has(scope), scope + ' governs a declared tool');
  }
});

test('default deny: an agent has only what its allowlist names, and a tool with no declared scope is refused', () => {
  // The owner is not an agent: the authenticated session is unrestricted.
  assert.deepEqual(authorizeToolUse({ scopes: null, tool: 'record_note' }), { permitted: true, scope: 'record_note' });
  // An agent has exactly its allowlist.
  assert.deepEqual(authorizeToolUse({ scopes: ['read_notes'], tool: 'read_notes' }), { permitted: true, scope: 'read_notes' });
  const refusedCall = authorizeToolUse({ scopes: ['read_notes'], tool: 'record_note' });
  assert.equal(refusedCall.permitted, false);
  assert.match((refusedCall as { reason: string }).reason, /record_note scope is not in this agent.s allowlist/);
  assert.match((refusedCall as { reason: string }).reason, /Append one line/, 'the refusal says what granting it would allow');
  // An empty allowlist allows nothing at all.
  assert.equal(authorizeToolUse({ scopes: [], tool: 'read_notes' }).permitted, false);
  // A tool this build declares no scope for is refused for every agent, and for the owner too: the
  // decision is default-deny rather than default-open, so a tool added later is unreachable.
  const unknown = authorizeToolUse({ scopes: ['file_edit'], tool: 'shell_exec' });
  assert.equal(unknown.permitted, false);
  assert.match((unknown as { reason: string }).reason, /No privilege scope governs the tool shell_exec/);
  assert.equal(authorizeToolUse({ scopes: null, tool: 'shell_exec' }).permitted, false);
});

test('the registry validates strictly and freezes: unknown fields, unknown scopes and malformed shapes all fail closed', async () => {
  const f = await fixture();
  try {
    // An unknown field is refused by name.
    await refused(() => f.agents.create({ draft: { ...f.draft(), surprise: true }, actor: OWNER }), 'INVALID');
    // An unknown scope is refused rather than dropped.
    const unknownScope = await refused(() => f.agents.create({ draft: f.draft({ scopes: ['read_notes', 'sudo'] as unknown as AgentScope[] }), actor: OWNER }), 'SCOPE_UNKNOWN');
    assert.match(unknownScope, /scopes .* is invalid: 1: a scope must be one of the closed vocabulary/);
    // A repeated scope is refused.
    await refused(() => f.agents.create({ draft: f.draft({ scopes: ['read_notes', 'read_notes'] }), actor: OWNER }), 'SCOPE_UNKNOWN');
    // A missing field is refused.
    const missing = f.draft() as unknown as Record<string, unknown>;
    delete missing.model;
    await refused(() => f.agents.create({ draft: missing, actor: OWNER }), 'INVALID');
    // An unknown actor kind is refused.
    await refused(() => f.agents.create({ draft: f.draft(), actor: { kind: 'robot', identity: 'x' } }), 'INVALID');
    // The allowlist is canonicalised, so two runs over the same input produce the same record.
    const record = f.agents.create({ draft: f.draft({ scopes: ['ask_question', 'read_notes'] }), actor: OWNER });
    assert.deepEqual([...record.scopes], ['read_notes', 'ask_question'], 'the stored allowlist is in the vocabulary order');
    assert.equal(record.revision, 1);
    assert.deepEqual(record.updatedBy, OWNER);
  } finally { await f.cleanup(); }
});

test('a duplicate live name, a model this instance does not offer and an unregistered workspace are each refused', async () => {
  const f = await fixture();
  try {
    f.agents.create({ draft: f.draft(), actor: OWNER });
    const duplicate = await refused(() => f.agents.create({ draft: f.draft(), actor: OWNER }), 'DUPLICATE_NAME');
    assert.match(duplicate, /already named Nightly reviewer/);
    // A model outside the offered set is refused, so a declaration can never name a model that cannot run.
    const model = await refused(() => f.agents.create({ draft: f.draft({ name: 'Other', model: { provider: 'scripted', modelId: 'not-offered' } }), actor: OWNER }), 'MODEL_NOT_OFFERED');
    assert.match(model, /not one this instance offers/);
    // A workspace that names a project this instance does not know is refused.
    const workspace = await refused(() => f.agents.create({ draft: f.draft({ name: 'Other', workspace: { projectId: randomUUID(), subpath: '' } }), actor: OWNER }), 'WORKSPACE_NOT_IN_PROJECT');
    assert.match(workspace, /is not registered on this instance/);
    // Neither refusal wrote anything: the registry still holds exactly one agent.
    assert.equal(f.agents.list().length, 1);
  } finally { await f.cleanup(); }
});

test('a subpath that could escape the project root and a budget outside its bound are refused, never normalised or reduced', async () => {
  const f = await fixture();
  try {
    for (const subpath of ['../outside', '/etc', 'a/../../b', 'a\\b', 'a//b', '.', './a', 'a/./b']) {
      const message = await refused(() => parseAgentWorkspace({ projectId: f.projectId, subpath }), 'INVALID');
      assert.match(message, /workspace is invalid/, subpath);
    }
    // A legal relative subpath is accepted, and so is the empty one.
    assert.equal(parseAgentWorkspace({ projectId: f.projectId, subpath: 'packages/api' }).subpath, 'packages/api');
    assert.equal(parseAgentWorkspace({ projectId: f.projectId, subpath: '' }).subpath, '');
    // Every budget field is bounded, and a value outside its bound is refused rather than reduced.
    assert.throws(() => parseAgentBudgets({ maxRequests: 0, maxOutputTokens: null, maxJobsPerHour: null }), (error: Error) => error instanceof AgentError && error.code === 'BUDGET_OUT_OF_BOUNDS');
    assert.throws(() => parseAgentBudgets({ maxRequests: AGENT_BUDGET_BOUNDS.maxRequests.max + 1, maxOutputTokens: null, maxJobsPerHour: null }), (error: Error) => error instanceof AgentError && error.code === 'BUDGET_OUT_OF_BOUNDS');
    assert.throws(() => parseAgentBudgets({ maxRequests: -5, maxOutputTokens: null, maxJobsPerHour: null }), (error: Error) => error instanceof AgentError && error.code === 'BUDGET_OUT_OF_BOUNDS');
    assert.throws(() => parseAgentBudgets({ maxRequests: 1.5, maxOutputTokens: null, maxJobsPerHour: null }), (error: Error) => error instanceof AgentError);
    // The store refuses the same request rather than the parser alone doing it.
    const message = await refused(() => f.agents.create({ draft: f.draft({ budgets: { maxRequests: -1, maxOutputTokens: null, maxJobsPerHour: null } }), actor: OWNER }), 'BUDGET_OUT_OF_BOUNDS');
    assert.match(message, /budgets is invalid: maxRequests must be a whole number from 1 to 100000, or null for no budget/);
    assert.equal(f.agents.list().length, 0, 'a refused budget wrote nothing');
  } finally { await f.cleanup(); }
});

test('an agent may not widen its own scopes, create another agent, or give another agent more than it holds', async () => {
  const f = await fixture();
  try {
    const narrow = f.agents.create({ draft: f.draft({ name: 'Narrow', scopes: ['read_notes'] }), actor: OWNER });
    const wide = f.agents.create({ draft: f.draft({ name: 'Wide', scopes: ['read_notes', 'record_note', 'file_edit'] }), actor: OWNER });
    const asAgent = (id: string): AgentActor => Object.freeze({ kind: 'agent', identity: id });

    // An agent may not edit its own record, whatever the change is: that is how it would widen itself.
    const own = await refused(() => f.agents.update({ agentId: narrow.id, revision: narrow.revision, patch: { scopes: ['read_notes', 'file_edit'] }, actor: asAgent(narrow.id) }), 'NOT_PERMITTED');
    assert.match(own, /may not edit its own record/);
    assert.deepEqual([...f.agents.read(narrow.id).scopes], ['read_notes'], 'the refused widening wrote nothing');

    // An agent may not create an agent at all.
    const created = await refused(() => f.agents.create({ draft: f.draft({ name: 'Child' }), actor: asAgent(wide.id) }), 'NOT_PERMITTED');
    assert.match(created, /may not create another agent/);

    // An agent may pass on only what it holds: a scope it does not have is refused.
    const widened = await refused(() => f.agents.update({ agentId: narrow.id, revision: narrow.revision, patch: { scopes: ['read_notes', 'deploy'] }, actor: asAgent(wide.id) }), 'NOT_PERMITTED');
    assert.match(widened, /does not hold itself/);
    assert.deepEqual([...f.agents.read(narrow.id).scopes], ['read_notes'], 'the refused widening wrote nothing');

    // Narrowing is allowed: a change that stays inside the actor's own allowlist is permitted.
    const narrowed = f.agents.update({ agentId: wide.id, revision: wide.revision, patch: { scopes: ['read_notes'] }, actor: asAgent(narrow.id) });
    assert.deepEqual([...narrowed.scopes], ['read_notes']);
    assert.equal(narrowed.revision, 2);
    assert.deepEqual(narrowed.updatedBy, { kind: 'agent', identity: narrow.id }, 'the record names the agent that made the change');

    // The owner may do any of it, and the rule itself is a pure function this build can check.
    const byOwner = f.agents.update({ agentId: wide.id, revision: narrowed.revision, patch: { scopes: ['deploy', 'push'] }, actor: OWNER });
    assert.deepEqual([...byOwner.scopes], ['push', 'deploy'], 'the owner may widen to any scope');
    assert.deepEqual(decideScopeChange({ actor: OWNER, actorScopes: null, current: null, next: ['deploy'] }), { permitted: true });
    assert.equal(decideScopeChange({ actor: asAgent(narrow.id), actorScopes: ['read_notes'], current: null, next: [] }).permitted, false);
    // An agent that is not a live record of this registry may change nothing.
    assert.equal(decideScopeChange({ actor: asAgent(randomUUID()), actorScopes: null, current: narrow, next: [] }).permitted, false);
  } finally { await f.cleanup(); }
});

test('every change is one revision, a stale revision writes nothing, and the durable audit says who changed what and when', async () => {
  const f = await fixture();
  try {
    const created = f.agents.create({ draft: f.draft(), actor: OWNER });
    const renamed = f.agents.update({ agentId: created.id, revision: created.revision, patch: { name: 'Daylight reviewer', description: 'Runs by day.' }, actor: { kind: 'owner', identity: 'second-owner' } });
    assert.deepEqual([renamed.revision, renamed.name, renamed.description], [2, 'Daylight reviewer', 'Runs by day.']);
    assert.deepEqual(renamed.updatedBy, { kind: 'owner', identity: 'second-owner' });
    assert.equal(renamed.createdAt, created.createdAt, 'a change keeps the creation instant');

    // A stale revision is a conflict that writes nothing.
    const stale = await refused(() => f.agents.update({ agentId: created.id, revision: created.revision, patch: { name: 'Racing' }, actor: OWNER }), 'CONFLICT');
    assert.match(stale, /is at revision 2, not 1/);
    assert.equal(f.agents.read(created.id).name, 'Daylight reviewer', 'the refused write changed nothing');

    // The audit trail is durable and says what changed, by whom and when.
    const history = f.agents.history(created.id);
    assert.deepEqual(history.map((entry) => [entry.revision, entry.action, entry.changedBy.identity]), [[1, 'created', 'owner'], [2, 'updated', 'second-owner']]);
    for (const entry of history) assert.ok(Number.isFinite(Date.parse(entry.changedAt)), 'every audit entry carries a real instant');

    // An unknown agent is refused as not found, and so is reading its history.
    await refused(() => f.agents.read(randomUUID()), 'NOT_FOUND');
    await refused(() => f.agents.history(randomUUID()), 'NOT_FOUND');
    // A record read back from the durable store is the same record: this is one operation per revision.
    const reopened = new AgentStore(f.store, { models: () => OFFERED, projectKnown: () => true });
    assert.deepEqual(reopened.read(created.id), f.agents.read(created.id));
    assert.deepEqual(reopened.history(created.id).length, 2);
  } finally { await f.cleanup(); }
});

test('archiving closes an agent, frees its name, and the scopes in force follow enablement', async () => {
  const f = await fixture();
  try {
    const first = f.agents.create({ draft: f.draft({ scopes: ['read_notes', 'record_note'] }), actor: OWNER });
    // The scopes in force for the project are the enabled agent's own allowlist.
    assert.deepEqual(f.agents.authority(f.projectId), { agentId: first.id, scopes: ['read_notes', 'record_note'] });
    // Disabling it takes it out of force entirely: with no live agent bound, the owner's own dispatch
    // is in force and nothing is narrowed.
    const disabled = f.agents.update({ agentId: first.id, revision: first.revision, patch: { enabled: false }, actor: OWNER });
    assert.deepEqual(f.agents.authority(f.projectId), { agentId: null, scopes: null });
    f.agents.update({ agentId: first.id, revision: disabled.revision, patch: { enabled: true }, actor: OWNER });

    const archived = f.agents.archive({ agentId: first.id, revision: 3, actor: OWNER });
    assert.equal(archived.archived, true);
    assert.equal(archived.revision, 4);
    assert.deepEqual([...archived.scopes], ['read_notes', 'record_note'], 'archiving keeps every field it held');
    assert.deepEqual(f.agents.authority(f.projectId), { agentId: null, scopes: null }, 'an archived agent is never in force');
    // An archived agent is never changed again, and archiving twice is a conflict.
    await refused(() => f.agents.archive({ agentId: first.id, revision: 4, actor: OWNER }), 'CONFLICT');
    await refused(() => f.agents.update({ agentId: first.id, revision: 4, patch: { description: 'back' }, actor: OWNER }), 'CONFLICT');
    // Its name is free again, so a new agent may take it.
    const second = f.agents.create({ draft: f.draft(), actor: OWNER });
    assert.equal(second.name, 'Nightly reviewer');
    // Only the live agents are listed as live, and the archived one is still readable.
    assert.deepEqual(f.agents.live().map((record) => record.id), [second.id]);
    assert.equal(f.agents.list().length, 2);
    assert.equal(f.agents.read(first.id).archived, true);
    assert.deepEqual(f.agents.forProject(f.projectId).map((record) => record.id).sort(), [first.id, second.id].sort());
  } finally { await f.cleanup(); }
});

test('when more than one enabled agent names one project, only the scopes every one of them allows are in force', () => {
  const record = (id: string, scopes: AgentScope[], enabled = true, archived = false): AgentRecord => ({
    version: 1, id, name: id, description: '', enabled, archived,
    model: { provider: 'scripted', modelId: 'scripted-1' },
    workspace: { projectId: 'project', subpath: '' },
    budgets: { maxRequests: null, maxOutputTokens: null, maxJobsPerHour: null },
    scopes, revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    updatedBy: { kind: 'owner', identity: 'owner' }
  });
  // No agent bound: the owner's own dispatch, nothing narrowed.
  assert.equal(scopesInForceFor([]), null);
  assert.equal(scopesInForceFor([record('a', ['read_notes'], false)]), null, 'a disabled agent is not in force');
  assert.equal(scopesInForceFor([record('a', ['read_notes'], true, true)]), null, 'an archived agent is not in force');
  assert.deepEqual(scopesInForceFor([record('a', ['read_notes', 'record_note'])]), ['read_notes', 'record_note']);
  // Two agents: only the intersection is in force, which is the safe direction and never a widening.
  assert.deepEqual(scopesInForceFor([record('a', ['read_notes', 'record_note']), record('b', ['read_notes'])]), ['read_notes']);
  assert.deepEqual(scopesInForceFor([record('a', ['read_notes']), record('b', ['record_note'])]), [], 'nothing is shared, so nothing is in force');
});

test('the scope list is canonical, bounded and duplicate-free, and an oversize registry is refused', async () => {
  const f = await fixture();
  try {
    assert.deepEqual([...parseAgentScopes([])], []);
    assert.deepEqual([...parseAgentScopes(['publish', 'commit', 'read_notes'])], ['read_notes', 'commit', 'publish']);
    assert.equal(parseAgentScopes(AGENT_SCOPES.map((scope) => scope)).length, AGENT_SCOPES.length, 'the whole vocabulary is the documented maximum, and it is accepted');
    assert.throws(() => parseAgentScopes(Array.from({ length: 17 }, () => 'read_notes' as AgentScope)), (error: Error) => error instanceof AgentError);
    assert.throws(() => parseAgentScopes('read_notes'), (error: Error) => error instanceof AgentError);
    // Every agent is one control-store operation per revision: the record is bounded JSON.
    const record = f.agents.create({ draft: f.draft({ description: 'x'.repeat(400) }), actor: OWNER });
    assert.equal(record.description.length, 400);
    const rows = f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='agent.record'").get() as { n: number };
    assert.equal(rows.n, 1, 'one operation per record revision, and nothing else');
    const outboxes = f.store.db.prepare("SELECT count(*) AS n FROM outboxes WHERE kind='agent.registry'").get() as { n: number };
    assert.equal(outboxes.n, 1, 'one outbox row as the evidence of that write');
  } finally { await f.cleanup(); }
});
