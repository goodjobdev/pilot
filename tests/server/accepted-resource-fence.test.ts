import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, operationDigest } from '../../src/server/state/control-store';
import { ActionTargetStore, actionTargetFingerprint } from '../../src/server/state/action-target-store';
import { pushResourceKey } from '../../src/server/state/push-resource-key';
import { AcceptedActionReviewStore } from '../../src/server/state/accepted-action-review';
import { AcceptedActionExecutor, targetBoundArtifact, type AcceptedActionIntent, type AcceptedActionPort } from '../../src/server/state/accepted-action';
import { defaultAcceptancePolicy, type AcceptancePolicy, type AcceptanceRecord } from '../../src/shared/acceptance';

const resourceKey = 'resource-' + 'a'.repeat(64);
const policy = { ...defaultAcceptancePolicy(), mode: 'agent-may-accept', actionClasses: { ...defaultAcceptancePolicy().actionClasses, deploy: 'full-auto' } } as AcceptancePolicy;
function fixtureIntent(projectId: string, targetId: string, version: string, key = resourceKey): AcceptedActionIntent {
  const target = { projectId, actionClass: 'deploy' as const, targetId, targetRevision: 1, targetDigest: 'b'.repeat(64), contentRevision: version, commit: null };
  return { ...target, sessionId: 'session', agentId: 'agent', evidenceId: 'evidence-' + version, acceptanceId: 'acceptance-' + version, artifact: targetBoundArtifact(target), resourceKey: key };
}
function port(intent: AcceptedActionIntent, execute: AcceptedActionPort['execute']): AcceptedActionPort {
  const acceptance = { id: intent.acceptanceId, evidenceId: intent.evidenceId, projectId: intent.projectId, sessionId: intent.sessionId, actionClass: 'deploy', artifact: intent.artifact, acceptedBy: { kind: 'agent', identity: 'agent' }, policy: { revision: policy.revision, mode: 'agent-may-accept', classDecision: 'full-auto' } } as AcceptanceRecord;
  return { authorize: async () => ({ acceptance, policy, allowed: true }), check: async () => {}, execute };
}
const success: AcceptedActionPort['execute'] = async input => ({ targetId: input.targetId, artifact: input.artifact, externalId: 'receipt' });

test('resource fencing blocks different projects and aliases while an effect is pending or unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-resource-fence-')), first = new ControlStore(root), second = new ControlStore(root);
  let release!: () => void, started!: () => void;
  const insideEffect = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const a = fixtureIntent('project-one', 'worker-one', 'version-one'), b = fixtureIntent('project-two', 'worker-alias', 'version-two');
  try {
    const pending = new AcceptedActionExecutor(first).run(a, port(a, async () => { started(); await gate; throw Error('lost reply'); }));
    await insideEffect;
    await assert.rejects(new AcceptedActionExecutor(second).run(b, port(b, success)), /action holds this resource/);
    const other = fixtureIntent('project-two', 'different-worker', 'version-two', 'resource-' + 'c'.repeat(64));
    assert.equal((await new AcceptedActionExecutor(second).run(other, port(other, success))).status, 'succeeded');
    release(); assert.equal((await pending).status, 'uncertain');
    second.close(); const reopened = new ControlStore(root);
    try { await assert.rejects(new AcceptedActionExecutor(reopened).run(b, port(b, success)), /action holds this resource/); }
    finally { reopened.close(); }
  } finally { release(); first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

test('push admission verifies the resource key against the current configured target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-push-target-key-')), store = new ControlStore(root), other = new ControlStore(root);
  try {
    const targets = new ActionTargetStore(store), actor = { kind: 'owner', identity: 'fixture' };
    const definition = { kind: 'push' as const, remoteId: 'remote', repositoryDigest: 'd'.repeat(64), branch: 'refs/heads/pilot' };
    const configured = targets.write({ projectId: 'project', targetId: 'target', revision: 0, enabled: true, definition, actor });
    const target = { projectId: 'project', actionClass: 'push' as const, targetId: 'target', targetRevision: 1, targetDigest: actionTargetFingerprint(configured), contentRevision: 'commit-' + 'a'.repeat(40), commit: 'a'.repeat(40) };
    const { commit: _commit, ...fields } = target;
    const input = { ...fields, sessionId: 'session', agentId: 'agent', evidenceId: 'evidence', acceptanceId: 'acceptance', artifact: targetBoundArtifact(target), resourceKey: pushResourceKey(definition.repositoryDigest, definition.branch) };
    const admission = { scope: { projectId: 'project', sessionId: 'accepted-actions' }, idempotencyKey: 'push-test', kind: 'accepted.action', outbox: { kind: 'accepted.action', payload: { version: 1, acceptanceId: 'acceptance' } } };
    assert.throws(() => store.admit({ ...admission, input: { ...input, resourceKey: 'resource-' + 'f'.repeat(64) } }), /does not match its current configured target/);
    assert.throws(() => store.admit({ ...admission, input: { ...input, targetId: 'other' } }), /Invalid accepted action/);
    // A different connection revises the target after the caller built its snapshot; admission must
    // re-read it under the writer lock rather than accept the stale key or stale fingerprint.
    new ActionTargetStore(other).write({ projectId: 'project', targetId: 'target', revision: 1, enabled: true, definition, actor });
    assert.throws(() => store.admit({ ...admission, input }), /does not match its current configured target/);
    const count = store.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='accepted.action'").get() as { n: number };
    assert.equal(count.n, 0);
  } finally { other.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('historical push keys are checked against their original target even when the action digest is recomputed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-historical-push-key-')), store = new ControlStore(root);
  try {
    const targets = new ActionTargetStore(store), actor = { kind: 'owner', identity: 'fixture' };
    const definition = { kind: 'push' as const, remoteId: 'remote', repositoryDigest: 'd'.repeat(64), branch: 'refs/heads/pilot' };
    const configured = targets.write({ projectId: 'project', targetId: 'target', revision: 0, enabled: true, definition, actor });
    const target = { projectId: 'project', actionClass: 'push' as const, targetId: 'target', targetRevision: 1, targetDigest: actionTargetFingerprint(configured), contentRevision: 'commit-' + 'a'.repeat(40), commit: 'a'.repeat(40) };
    const { commit: _commit, ...fields } = target;
    const input = { ...fields, sessionId: 'session', agentId: 'agent', evidenceId: 'evidence', acceptanceId: 'acceptance', artifact: targetBoundArtifact(target), resourceKey: pushResourceKey(definition.repositoryDigest, definition.branch) };
    const outbox = { kind: 'accepted.action', payload: { version: 1, acceptanceId: 'acceptance' } };
    const admitted = store.admit({ scope: { projectId: 'project', sessionId: 'accepted-actions' }, idempotencyKey: 'push-history', kind: 'accepted.action', input, outbox });
    targets.write({ projectId: 'project', targetId: 'target', revision: 1, enabled: false, definition, actor });
    const unrelated = fixtureIntent('new-project', 'new-target', 'new-version', 'resource-' + 'c'.repeat(64));
    assert.equal((await new AcceptedActionExecutor(store).run(unrelated, port(unrelated, success))).status, 'succeeded', 'a later target revision does not invalidate legitimate history');
    const changed = { ...input, resourceKey: 'resource-' + 'e'.repeat(64) };
    store.db.prepare('UPDATE operations SET input_json=?,input_digest=? WHERE id=?').run(JSON.stringify(changed), operationDigest('accepted.action', { input: changed, outbox }), admitted.operation.id);
    const next = fixtureIntent('another-project', 'another-target', 'next-version', 'resource-' + 'f'.repeat(64));
    await assert.rejects(new AcceptedActionExecutor(store).run(next, port(next, success)), /invalid historical action/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('streamed resource history validates entries beyond the former page and rejects old and latest corruption', async () => {
  for (const corruptLatest of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'pilot-streamed-resource-history-')), store = new ControlStore(root);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 70; i++) {
        const key = 'resource-' + i.toString(16).padStart(64, '0');
        const admitted = store.admit({
          scope: { projectId: 'history-project', sessionId: 'accepted-actions' },
          idempotencyKey: `history-${i}`,
          kind: 'accepted.action',
          input: { actionClass: 'commit', resourceKey: key },
          outbox: { kind: 'accepted.action', payload: { index: i } },
        });
        ids.push(admitted.operation.id);
      }
      const victim = ids[corruptLatest ? ids.length - 1 : 0];
      store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run('{', victim);
      assert.throws(() => store.admit({
        scope: { projectId: 'new-project', sessionId: 'accepted-actions' },
        idempotencyKey: 'blocked-by-history-corruption',
        kind: 'accepted.action',
        input: { actionClass: 'commit', resourceKey: 'resource-' + 'f'.repeat(64) },
        outbox: { kind: 'accepted.action', payload: {} },
      }), /invalid historical action|Corrupt operation input JSON/);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('concurrent connections do not miss a newly admitted resource barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-resource-scan-race-')), first = new ControlStore(root), second = new ControlStore(root);
  const key = 'resource-' + '9'.repeat(64);
  const admission = (store: ControlStore, id: string) => store.admit({
    scope: { projectId: 'race-project', sessionId: 'accepted-actions' },
    idempotencyKey: id,
    kind: 'accepted.action',
    input: { actionClass: 'commit', resourceKey: key },
    outbox: { kind: 'accepted.action', payload: { id } },
  });
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => admission(first, 'race-first')),
      Promise.resolve().then(() => admission(second, 'race-second')),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(failure.reason), /action holds this resource/);
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }); }
});

test('valid legacy keyless push history blocks unrelated resource admissions after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-legacy-push-')), store = new ControlStore(root);
  try {
    const definition = { kind: 'push' as const, remoteId: 'old-remote', repositoryDigest: 'd'.repeat(64), branch: 'refs/heads/legacy' };
    const configured = new ActionTargetStore(store).write({ projectId: 'old-project', targetId: 'old-target', revision: 0, enabled: true, definition, actor: { kind: 'owner', identity: 'fixture' } });
    const target = { projectId: 'old-project', actionClass: 'push' as const, targetId: 'old-target', targetRevision: 1, targetDigest: actionTargetFingerprint(configured), contentRevision: 'commit-' + 'a'.repeat(40), commit: 'a'.repeat(40) };
    const { commit: _commit, ...fields } = target;
    const legacy = { ...fields, sessionId: 'session', agentId: 'agent', evidenceId: 'old-evidence', acceptanceId: 'old-acceptance', artifact: targetBoundArtifact(target) };
    const outbox = { kind: 'accepted.action', payload: { version: 1, acceptanceId: legacy.acceptanceId } };
    const inserted = store.admit({ scope: { projectId: target.projectId, sessionId: 'accepted-actions' }, idempotencyKey: 'legacy', kind: 'accepted.action', input: { ...legacy, resourceKey: pushResourceKey(definition.repositoryDigest, definition.branch) }, outbox });
    // Construct a self-consistent pre-barrier record, rather than merely corrupting its digest.
    store.db.prepare('UPDATE operations SET input_json=?,input_digest=? WHERE id=?').run(JSON.stringify(legacy), operationDigest('accepted.action', { input: legacy, outbox }), inserted.operation.id);
    store.close(); const reopened = new ControlStore(root);
    try {
      const other = fixtureIntent('new-project', 'different-target', 'version-new', 'resource-' + 'd'.repeat(64));
      await assert.rejects(new AcceptedActionExecutor(reopened).run(other, port(other, success)), /invalid historical action/);
      assert.equal(reopened.getOperation(inserted.operation.id, { projectId: target.projectId, sessionId: 'accepted-actions' }).state, 'pending');
    } finally { reopened.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a commit-bound deployment admits its exact artifact and preserves the resource barrier',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-resource-commit-')),store=new ControlStore(root);
 try{
  const base=fixtureIntent('one','target-a','version-a'),commit='a'.repeat(40);
  const artifact=targetBoundArtifact({projectId:base.projectId,actionClass:base.actionClass,targetId:base.targetId,targetRevision:base.targetRevision,targetDigest:base.targetDigest,contentRevision:base.contentRevision,commit});
  const bound={...base,artifact};let effects=0;
  const changed={...bound,artifact:{...artifact,commit:'b'.repeat(40)}};
  assert.throws(()=>store.admit({scope:{projectId:'one',sessionId:'accepted-actions'},idempotencyKey:'forged',kind:'accepted.action',input:changed,outbox:{kind:'accepted.action',payload:{}}}),/Invalid accepted action/);
  await assert.rejects(new AcceptedActionExecutor(store).run(changed,port(changed,async input=>{effects++;return success(input,undefined,async()=>{});})),/does not bind/);
  assert.equal(effects,0);
  const done=await new AcceptedActionExecutor(store).run(bound,port(bound,async input=>{effects++;return success(input,undefined,async()=>{});}));
  assert.equal(done.status,'succeeded');assert.equal(effects,1);
  await assert.rejects(new AcceptedActionExecutor(store).run(fixtureIntent('two','target-b','version-b'),port(fixtureIntent('two','target-b','version-b'),success)),/action holds this resource/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('an owner observation does not release an uncertain deployment barrier',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pilot-resource-observation-')),store=new ControlStore(root);
 try{
  const a=fixtureIntent('one','target-a','version-a'),b=fixtureIntent('two','target-b','version-b');
  const attempted=await new AcceptedActionExecutor(store).run(a,port(a,async()=>{throw Error('lost result');}));assert.equal(attempted.status,'uncertain');
  const review=new AcceptedActionReviewStore(store);
  review.record({projectId:'one',actionId:attempted.operationId,actionRevision:2,revision:0,observation:'checked-no-effect-visible',actor:{kind:'owner',identity:'local'}});
  await assert.rejects(new AcceptedActionExecutor(store).run(b,port(b,success)),/action holds this resource/);
  assert.equal(store.getOperation(attempted.operationId,{projectId:'one',sessionId:'accepted-actions'}).state,'unknown');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('generic operation transitions do not release a deployment barrier', async () => {
  for (const state of ['succeeded', 'failed', 'interrupted', 'unknown'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'pilot-resource-transition-')), store = new ControlStore(root);
    try {
      const a = fixtureIntent('one', 'target-a', 'version-a'), b = fixtureIntent('two', 'target-b', 'version-b');
      const admitted = store.admit({ scope: { projectId: a.projectId, sessionId: 'accepted-actions' }, idempotencyKey: 'held', kind: 'accepted.action', input: a, outbox: { kind: 'accepted.action', payload: {} } });
      store.updateOperation(admitted.operation.id, { projectId: a.projectId, sessionId: 'accepted-actions' }, 1, state);
      await assert.rejects(new AcceptedActionExecutor(store).run(b, port(b, success)), /action holds this resource/);
      if (state === 'unknown') {
        store.updateOperation(admitted.operation.id, { projectId: a.projectId, sessionId: 'accepted-actions' }, 2, 'succeeded');
        await assert.rejects(new AcceptedActionExecutor(store).run(b, port(b, success)), /action holds this resource/);
      }
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('no generic transition releases a resource and malformed legacy deploys block conservatively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-resource-fence-')), store = new ControlStore(root);
  try {
    const a = fixtureIntent('one', 'target-a', 'version-a'), b = fixtureIntent('two', 'target-b', 'version-b');
    const original = await new AcceptedActionExecutor(store).run(a, port(a, success)); assert.equal(original.status, 'succeeded');
    store.db.prepare('UPDATE operations SET rowid=-1 WHERE id=?').run(original.operationId);
    await assert.rejects(new AcceptedActionExecutor(store).run(b, port(b, success)), /action holds this resource/);
    for (const input of [{ actionClass: 'deploy' }, { actionClass: 'deploy', resourceKey }]) {
      assert.throws(() => store.admit({ scope: { projectId: 'legacy', sessionId: 'accepted-actions' }, idempotencyKey: 'old', kind: 'accepted.action', input, outbox: { kind: 'accepted.action', payload: {} } }), /Invalid accepted action/);
    }
    const c = fixtureIntent('three', 'target-c', 'version-c', 'resource-' + 'c'.repeat(64));
    const completed = await new AcceptedActionExecutor(store).run(c, port(c, success)); assert.equal(completed.status, 'succeeded');
    const other = fixtureIntent('four', 'target-d', 'version-d', 'resource-' + 'd'.repeat(64));
    const stored = store.db.prepare('SELECT input_json FROM operations WHERE id=?').get(completed.operationId) as { input_json: string };
    const changedKey = { ...JSON.parse(stored.input_json), resourceKey: 'resource-' + 'e'.repeat(64) };
    store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run(JSON.stringify(changedKey), completed.operationId);
    await assert.rejects(new AcceptedActionExecutor(store).run(other, port(other, success)), /invalid historical action/);
    // Simulate old/malformed historical records without teaching current admission to create them.
    for (const input of [{ actionClass: 'deploy' }, { actionClass: 'push' }, { actionClass: 'deploy', resourceKey: '' }, { actionClass: 'deploy', resourceKey: 1 }, { actionClass: 'commit', resourceKey: '' }, { actionClass: 'commit', resourceKey: 'resource-' + 'e'.repeat(64) + '\u0000junk' }, { actionClass: 'deploy', resourceKey: 'resource-' + 'e'.repeat(64) }, { ...c, targetDigest: '' }, { ...c, projectId: '' }, { ...c, artifact: { ...c.artifact, revision: 'action-' + '0'.repeat(64) } }, { actionClass: 'unknown', resourceKey: 'x' }, {}]) {
      store.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run(JSON.stringify(input), completed.operationId);
      await assert.rejects(new AcceptedActionExecutor(store).run(other, port(other, success)), /invalid historical action/);
    }
    await assert.rejects(new AcceptedActionExecutor(store).run({ ...other, resourceKey: undefined }, port(other, success)), /resource key is unavailable/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
