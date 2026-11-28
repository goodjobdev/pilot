import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlStore } from '../../src/server/state/control-store';
import { ActionTargetStore, actionTargetFingerprint } from '../../src/server/state/action-target-store';
import { targetBoundArtifact } from '../../src/server/state/accepted-action';

const owner = { kind: 'owner', identity: 'fixture' };
const initial = { projectId: 'project', targetId: 'target', revision: 0, enabled: true, definition: { kind: 'commit', repositoryId: 'repo', branch: 'refs/heads/pilot' }, actor: owner };

test('owner target revisions are durable, strict, immutable and fail closed on change or disablement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-action-target-')), control = new ControlStore(root);
  try {
    const targets = new ActionTargetStore(control);
    assert.throws(() => targets.write({ ...initial, actor: { kind: 'agent', identity: 'fixture' } }), /Only the owner/);
    assert.throws(() => targets.write({ ...initial, definition: { kind: 'push', remoteId: 'https://example.invalid', repositoryDigest: 'a'.repeat(64), branch: 'refs/heads/pilot' } }), /Invalid action target/);
    assert.throws(() => targets.write({ ...initial, definition: { ...initial.definition, token: 'secret' } }), /Invalid action target/);
    const one = targets.write({ ...initial, actor:{kind:'owner',identity:'owner@example.invalid'} }); assert.equal(one.updatedBy,'owner@example.invalid'); assert.equal(one.revision, 1); assert.deepEqual(targets.resolve('project', 'target', 1, 'commit'), one);
    assert.throws(() => targets.resolve('project', 'target', 1, 'push'), /unavailable or changed/);
    const content = { projectId: 'project', actionClass: 'commit' as const, targetId: 'target', contentRevision: 'tree-abc', commit: 'a'.repeat(40) };
    const accepted = targetBoundArtifact({ ...content, targetRevision: one.revision, targetDigest: actionTargetFingerprint(one) });
    const two = targets.write({ ...initial, revision: 1, definition: { ...initial.definition, branch: 'refs/heads/next' } });
    assert.equal(two.revision, 2); assert.deepEqual(targets.readRevision('project', 'target', 1), one);
    assert.notDeepEqual(targetBoundArtifact({ ...content, targetRevision: two.revision, targetDigest: actionTargetFingerprint(two) }), accepted);
    const reusedRevision = { ...two, revision: one.revision };
    assert.notEqual(actionTargetFingerprint(reusedRevision), actionTargetFingerprint(one), 'a reused version with different semantics is not equivalent');
    assert.notDeepEqual(targetBoundArtifact({ ...content, targetRevision: one.revision, targetDigest: actionTargetFingerprint(reusedRevision) }), accepted);
    assert.throws(() => targets.resolve('project', 'target', 1, 'commit'), /unavailable or changed/);
    assert.throws(() => targets.write({ ...initial, revision: 1 }), /changed/);
    const three = targets.write({ ...initial, revision: 2, enabled: false });
    assert.equal(three.revision, 3); assert.throws(() => targets.resolve('project', 'target', 3, 'commit'), /unavailable or changed/);
    control.close(); const reopened = new ControlStore(root);
    try { assert.deepEqual(new ActionTargetStore(reopened).read('project', 'target'), three); }
    finally { reopened.close(); }
  } finally { control.close(); await rm(root, { recursive: true, force: true }); }
});

test('all action classes record only declared semantic identifiers; no adapter is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-action-target-kinds-')), control = new ControlStore(root);
  try {
    const targets = new ActionTargetStore(control);
    const definitions = [
      { kind: 'push' as const, remoteId: 'remote', repositoryDigest: 'a'.repeat(64), branch: 'refs/heads/main' },
      { kind: 'deploy' as const, integrationId: 'host', serviceId: 'service', environmentId: 'staging', resourceDigest: 'b'.repeat(64) },
      { kind: 'spend' as const, integrationId: 'billing', accountId: 'account' },
      { kind: 'provision' as const, integrationId: 'infra', accountId: 'account', regionId: 'region', templateId: 'template' },
      { kind: 'publish' as const, integrationId: 'publisher', channelId: 'channel' }
    ];
    for (const definition of definitions) {
      const target = targets.write({ projectId: 'project', targetId: definition.kind, revision: 0, enabled: true, definition, actor: owner });
      assert.deepEqual(targets.resolve('project', definition.kind, 1, definition.kind).definition, definition);
      assert.match(actionTargetFingerprint(target), /^[a-f0-9]{64}$/);
    }
  } finally { control.close(); await rm(root, { recursive: true, force: true }); }
});

test('target reads reject changed operation or audit evidence on an already-open store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-target-integrity-')), control = new ControlStore(root);
  try {
    const targets = new ActionTargetStore(control); targets.write(initial);
    const row = control.db.prepare("SELECT id,input_json FROM operations WHERE kind='accepted.target'").get() as { id: string; input_json: string };
    const changed = { ...JSON.parse(row.input_json), updatedBy: 'tampered' };
    control.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run(JSON.stringify(changed), row.id);
    assert.throws(() => targets.read('project', 'target'), /audit is corrupt/);
    assert.throws(() => targets.readRevision('project', 'target', 1), /audit is corrupt/);
    control.db.prepare('UPDATE operations SET input_json=? WHERE id=?').run(row.input_json, row.id);
    const out = control.db.prepare('SELECT id,payload_json FROM outboxes WHERE operation_id=?').get(row.id) as { id: string; payload_json: string };
    control.db.prepare('UPDATE outboxes SET payload_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(out.payload_json), extra: true }), out.id);
    assert.throws(() => targets.read('project', 'target'), /audit is corrupt/);
  } finally { control.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent target updates cannot reuse a revision for different definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-action-target-race-')), one = new ControlStore(root), two = new ControlStore(root);
  try {
    const first = new ActionTargetStore(one), second = new ActionTargetStore(two); first.write(initial);
    const admit = one.admit.bind(one); let raced = false;
    one.admit = input => {
      if (!raced && input.kind === 'accepted.target') {
        raced = true; second.write({ ...initial, revision: 1, definition: { ...initial.definition, branch: 'refs/heads/winner' } });
      }
      return admit(input);
    };
    assert.throws(() => first.write({ ...initial, revision: 1, definition: { ...initial.definition, branch: 'refs/heads/loser' } }), /changed|refused/);
    assert.equal(first.read('project', 'target')?.definition.kind, 'commit');
    assert.deepEqual(first.read('project', 'target')?.definition, { ...initial.definition, branch: 'refs/heads/winner' });
  } finally { one.close(); two.close(); await rm(root, { recursive: true, force: true }); }
});
