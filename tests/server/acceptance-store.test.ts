import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../src/server/state/control-store';
import { ACCEPTANCE_RECORD_DIRECTORY, AcceptanceStore } from '../../src/server/state/acceptance-store';
import {
  ACCEPTANCE_ABSENCE_REASONS, ACCEPTANCE_MAX_INLINE_DIFF_BYTES, ACCEPTANCE_POLICY_ABSENCE, AcceptanceError, agentPolicyRule, defaultAcceptancePolicy
} from '../../src/shared/acceptance';

/**
 * The durable acceptance record: the policy, the frozen completion records and the single-use,
 * revision-bound acceptances — all over a disposable root, with no live project, no provider and no
 * model call anywhere in this file.
 *
 * The clock is fixed so an instant is a fact rather than a race, and the Markdown record is read
 * back from the disposable project folder, which is the only place it is written.
 */

const T0 = '2026-01-01T00:00:00.000Z';
const PROJECT = 'project-a';
const SESSION = 'session-a';
const REVISION = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const TEST_OUTPUT = ['TAP version 13', 'ok 1 - one', 'ok 2 - two', 'not ok 3 - three', '# tests 3', '# pass 2', '# fail 1', '# skipped 0'].join('\n');

const policy = (over: Record<string, unknown> = {}) => ({
  mode: 'agent-may-accept',
  actionClasses: { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' },
  ...over
});
const evidence = (over: Record<string, unknown> = {}) => ({
  sessionId: SESSION,
  subject: { kind: 'session', id: SESSION },
  artifact: { revision: REVISION, commit: COMMIT },
  commands: ['pnpm test'],
  diff: { files: 3, linesAdded: 42, linesRemoved: 7, text: '--- a/x\n+++ b/x\n-1\n+2\n', reference: null },
  // The outcome is the one this output supports: TEST_OUTPUT reports one failure, so the record says
  // 'failed' rather than a 'passed' its own evidence contradicts (see the reconciliation test below).
  tests: [{ command: 'pnpm test', outcome: 'failed', output: TEST_OUTPUT, counts: { passed: 2, failed: 1, skipped: 0 } }],
  review: { verdict: 'approved', reviewer: { kind: 'owner', identity: 'local' }, at: T0, note: 'looks right' },
  producedAt: T0,
  ...over
});
const acceptInput = (evidenceId: string, over: Record<string, unknown> = {}) => ({
  evidenceId,
  artifact: { revision: REVISION, commit: COMMIT },
  actionClass: 'commit',
  actor: { kind: 'agent', identity: 'worker-3' },
  ...over
});
function refuses(code: string, pattern: RegExp) {
  return (error: unknown) => error instanceof AcceptanceError && error.code === code && pattern.test(error.message);
}
async function fixture(run: (input: { root: string; project: string; store: ControlStore; acceptance: AcceptanceStore }) => Promise<void>, over: { ids?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-acceptance-'));
  const project = join(root, 'workspaces', 'project');
  await mkdir(join(project, 'docs', 'spec'), { recursive: true, mode: 0o755 });
  const store = new ControlStore(join(root, 'data'));
  let minted = 0;
  const acceptance = new AcceptanceStore(store, {
    clock: () => new Date(Date.parse(T0)),
    ...(over.ids === false ? {} : { id: () => 'ac-' + String(++minted).padStart(4, '0') }),
    projectRoot: (id) => (id === PROJECT ? project : undefined)
  });
  try { await run({ root, project, store, acceptance }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}
async function markdown(project: string, id: string): Promise<string> {
  return readFile(join(project, ACCEPTANCE_RECORD_DIRECTORY, id + '.md'), 'utf8');
}

test('an unwritten policy reads as the documented default, and the policy is validated against closed sets', async () => {
  await fixture(async ({ store, acceptance }) => {
    const initial = acceptance.readPolicy();
    assert.deepEqual(initial, {
      ...defaultAcceptancePolicy(),
      revision: 0,
      recorded: false,
      absenceReason: ACCEPTANCE_POLICY_ABSENCE.notRecorded,
      absenceDetail: 'The durable store holds no acceptance policy yet, so the documented default is in force: owner-only, with every action class asking the owner.',
      updatedAt: null,
      updatedBy: null
    });
    assert.equal(initial.mode, 'owner-only', 'the default is the safe direction, so an agent can accept nothing');
    assert.deepEqual(Object.values(initial.actionClasses), ['ask', 'ask', 'ask', 'ask', 'ask', 'ask']);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n, 0, 'reading the default writes nothing');

    const owner = { kind: 'owner' as const, identity: 'local' };
    // Every refusal leaves the store exactly as it was.
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy({ mode: 'trusting' }), actor: owner }), refuses('INVALID', /policy .*is invalid/));
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy({ actionClasses: { ...policy().actionClasses, deploy: 'yes' } }), actor: owner }), refuses('INVALID', /policy .*is invalid/));
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy({ actionClasses: { commit: 'ask' } }), actor: owner }), refuses('INVALID', /policy .*is invalid/));
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy({ confirm: true }), actor: owner }), refuses('INVALID', /policy .*is invalid/));
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy(), actor: { kind: 'robot', identity: 'x' } }), refuses('INVALID', /actor .*is invalid/));
    assert.throws(() => acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner, extra: 1 }), refuses('INVALID', /policy update .*is invalid/));
    assert.equal(acceptance.readPolicy().recorded, false, 'no refused update wrote a policy');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM operations').get() as { n: number }).n, 0);

    const written = acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner });
    assert.deepEqual(
      [written.mode, written.recorded, written.revision, written.updatedAt, written.updatedBy, written.actionClasses.commit],
      ['agent-may-accept', true, 1, T0, 'local', 'full-auto']
    );
    assert.ok(Object.isFrozen(written));
    // The policy is changeable only by the owner, and a stale revision is a conflict that writes nothing.
    assert.throws(() => acceptance.updatePolicy({ revision: 1, policy: policy({ mode: 'owner-only' }), actor: { kind: 'agent', identity: 'worker-3' } }), refuses('NOT_PERMITTED', /changeable only by the owner/));
    assert.throws(() => acceptance.updatePolicy({ revision: 7, policy: policy({ mode: 'owner-only' }), actor: owner }), refuses('CONFLICT', /at revision 1, not 7/));
    assert.equal(acceptance.readPolicy().revision, 1, 'both refusals changed nothing');

    const second = acceptance.updatePolicy({ revision: 1, policy: policy({ mode: 'owner-only' }), actor: owner });
    assert.deepEqual([second.revision, second.mode], [2, 'owner-only']);
    assert.equal(acceptance.readPolicy().revision, 2, 'each update is one revision of one durable record');
  });
});

test('the same evidence records once, a changed revision is a different record, and both survive a reopen', async () => {
  await fixture(async ({ root, acceptance }) => {
    const first = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    assert.match(first.evidence.record.id, /^ev-[a-f0-9]{64}$/);
    assert.deepEqual(
      [first.evidence.record.projectId, first.evidence.record.sessionId, first.evidence.record.artifact.revision, first.evidence.record.frozen, first.evidence.record.producedAt],
      [PROJECT, SESSION, REVISION, true, T0]
    );
    assert.deepEqual(first.evidence.record.tests, [{
      command: 'pnpm test', outcome: 'failed', output: TEST_OUTPUT, counts: { passed: 2, failed: 1, skipped: 0 }, absenceReason: null
    }]);
    assert.equal(first.written, true);
    // The same evidence recorded twice is the same record: one durable row, not two.
    const again = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    assert.equal(again.evidence.record.id, first.evidence.record.id);
    assert.equal((await acceptance.readProject({ projectId: PROJECT })).evidence.length, 1);
    assert.equal((await acceptance.readProject({ projectId: PROJECT })).truncated, false);
    // A different revision is a different unit of work, so it is a different record.
    const changed = await acceptance.recordEvidence({
      projectId: PROJECT,
      evidence: evidence({ artifact: { revision: 'c'.repeat(64), commit: COMMIT } })
    });
    assert.notEqual(changed.evidence.record.id, first.evidence.record.id);
    const view = await acceptance.readProject({ projectId: PROJECT });
    assert.equal(view.evidence.length, 2);
    assert.deepEqual(view.evidence.map((entry) => entry.record.id), [first.evidence.record.id, changed.evidence.record.id]);
    assert.deepEqual(
      view.evidence.map((entry) => [entry.markdown.state, entry.acceptance]),
      [['current', null], ['current', null]],
      'both records are rendered, and neither is accepted'
    );
    assert.deepEqual(view.limits, { evidence: 200, commands: 50, results: 20, outputBytes: 8192, inlineDiffBytes: 16384 });
    assert.equal(view.readOnly, true);
    assert.equal(view.policy.recorded, false);
    // An unknown record, an unusable id, an unusable project and a project this instance cannot
    // resolve to a folder are all refused, and a refusal writes nothing.
    await assert.rejects(async () => acceptance.readEvidence({ projectId: PROJECT, evidenceId: 'ev-' + '0'.repeat(32) }), refuses('NOT_FOUND', /No completion record with id ev-000/));
    await assert.rejects(async () => acceptance.readEvidence({ projectId: PROJECT, evidenceId: 'not-evidence' }), refuses('NOT_FOUND', /No completion record with id/));
    await assert.rejects(async () => acceptance.readProject({ projectId: '../../etc' }), refuses('INVALID', /projectId must be/));
    await assert.rejects(async () => acceptance.recordEvidence({ projectId: 'project-b', evidence: evidence() }), refuses('NOT_FOUND', /could not be resolved to a folder/));
    assert.equal(await readFile(join(root, 'data', 'control.sqlite')).then(() => true), true, 'the disposable data root holds the durable store');
  });
});

test('evidence whose claimed counts contradict its own recorded output is refused, and an unreadable count is a named absence', async () => {
  await fixture(async ({ acceptance }) => {
    // A contradiction between the claim and the output it is supposed to have been read from.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: TEST_OUTPUT, counts: { passed: 3, failed: 0, skipped: 0 } }] }) }),
      refuses('INVALID', /claims 3 passed, 0 failed and 0 skipped for .pnpm test., but its recorded output reports 2 passed, 1 failed and 0 skipped/)
    );
    // A claim with no readable output to check it against.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: null, counts: { passed: 2, failed: 1, skipped: 0 } }] }) }),
      refuses('INVALID', /with no recorded output to check them against/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: 'all good, nothing to report', counts: { passed: 2, failed: 1, skipped: 0 } }] }) }),
      refuses('INVALID', /carries no count line to check them against/)
    );
    // A result for a command the record does not say was run, and a result for a command it says was not run.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm check', outcome: 'passed', output: TEST_OUTPUT, counts: null }] }) }),
      refuses('INVALID', /not one of the commands this record says were run/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'not-run', output: TEST_OUTPUT, counts: { passed: 2, failed: 0, skipped: 0 } }] }) }),
      refuses('INVALID', /which it also says was not run/)
    );
    // An output that contradicts itself is refused too, rather than one number being picked.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: '# tests 1\n# pass 2\n# fail 0', counts: null }] }) }),
      refuses('INVALID', /summarises 1 tests but counts 2 passed/)
    );
    // Nothing above was written at all.
    assert.deepEqual((await acceptance.readProject({ projectId: PROJECT })).evidence, []);

    // The honest alternative to a claim: no counts, so the absence is named and never defaulted to zero.
    const silent = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'not-run', output: null, counts: null }] }) });
    assert.deepEqual(silent.evidence.record.tests, [{
      command: 'pnpm test', outcome: 'not-run', output: null, counts: null, absenceReason: ACCEPTANCE_ABSENCE_REASONS.outputNotRecorded
    }]);
    const unreadable = await acceptance.recordEvidence({
      projectId: PROJECT,
      evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'failed', output: 'the runner printed prose instead of a summary', counts: null }] })
    });
    assert.deepEqual(
      [unreadable.evidence.record.tests[0].counts, unreadable.evidence.record.tests[0].absenceReason],
      [null, ACCEPTANCE_ABSENCE_REASONS.outputCarriesNoCounts]
    );
    // The counts a record does carry are read from the output, never taken on trust: both line markers work.
    const glyph = await acceptance.recordEvidence({
      projectId: PROJECT,
      evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: '\u2139 tests 5\n\u2139 pass 4\n\u2139 fail 0\n\u2139 skipped 1', counts: null }] })
    });
    assert.deepEqual(glyph.evidence.record.tests[0].counts, { passed: 4, failed: 0, skipped: 1 });
  });
});

test('a diff that is neither inlined nor referenced, or larger than the inline bound, is refused', async () => {
  await fixture(async ({ acceptance }) => {
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: null, reference: null } }) }),
      refuses('INVALID', /neither inlined nor referenced/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: 'x'.repeat(ACCEPTANCE_MAX_INLINE_DIFF_BYTES + 1), reference: null } }) }),
      refuses('INVALID', /larger than the documented 16384 byte bound/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ diff: { files: 1, linesAdded: 1, linesRemoved: 0, text: null, reference: '../outside.diff' } }) }),
      refuses('INVALID', /contained relative reference/)
    );
    assert.deepEqual((await acceptance.readProject({ projectId: PROJECT })).evidence, []);
    // The full diff by reference is the honest answer for a large one, and the summary is what the record carries.
    const referenced = await acceptance.recordEvidence({
      projectId: PROJECT,
      evidence: evidence({ diff: { files: 900, linesAdded: 40_000, linesRemoved: 12, text: null, reference: 'snapshots/900-file.diff' } })
    });
    assert.deepEqual(referenced.evidence.record.diff, { files: 900, linesAdded: 40_000, linesRemoved: 12, text: null, reference: 'snapshots/900-file.diff' });
  });
});

test('the Markdown record is written next to the work with the expected fields, and a hand edit is reported rather than trusted', async () => {
  await fixture(async ({ project, acceptance }) => {
    await acceptance.updatePolicy({ revision: 0, policy: policy(), actor: { kind: 'owner', identity: 'local' } });
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;
    assert.equal(recorded.evidence.markdown.path, ACCEPTANCE_RECORD_DIRECTORY + '/' + id + '.md');
    assert.equal(recorded.evidence.markdown.state, 'current');

    const text = await markdown(project, id);
    for (const expected of [
      '# Completion record ' + id,
      '| Project | `' + PROJECT + '` |',
      '| Session | `' + SESSION + '` |',
      '| Work | session `' + SESSION + '` |',
      '| Artifact revision | `' + REVISION + '` |',
      '| Commit | `' + COMMIT + '` |',
      '| Produced at | ' + T0 + ' |',
      '1. `pnpm test`',
      '- Files: 3',
      '- Lines: +42 / -7',
      '- Full diff: inlined below',
      '### `pnpm test`',
      '- Outcome: failed',
      '- Counts (read from the recorded output): 2 passed, 1 failed, 0 skipped',
      '- Verdict: approved by owner `local` at ' + T0,
      '- Note: looks right',
      'No acceptance is recorded for this evidence.'
    ]) assert.ok(text.includes(expected), 'the Markdown record carries: ' + expected);
    assert.ok(text.includes(TEST_OUTPUT), 'the recorded output is part of the record');
    // It is inside the project, next to the work, and nowhere else.
    assert.equal((await readFile(join(project, ACCEPTANCE_RECORD_DIRECTORY, id + '.md'), 'utf8')), text);

    // A hand-edited file is reported as stale, never read as the record: the store stays authoritative.
    await writeFile(join(project, ACCEPTANCE_RECORD_DIRECTORY, id + '.md'), '# everything passed\n', 'utf8');
    const after = await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id });
    assert.equal(after.markdown.state, 'stale');
    assert.equal(after.record.id, id, 'the durable record is unchanged by an edit to its rendering');
    // Recording the same evidence again rewrites the rendering, which is how a crash is repaired.
    const repaired = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    assert.equal(repaired.evidence.markdown.state, 'current');
    assert.equal(await markdown(project, id), text);

    // A record whose file is missing is reported as missing, not assumed present.
    await rm(join(project, ACCEPTANCE_RECORD_DIRECTORY, id + '.md'));
    const gone = await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id });
    assert.equal(gone.markdown.state, 'missing');
    assert.equal((await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() })).evidence.markdown.state, 'current');
  });
});

test('an agent acceptance is refused under owner-only and permitted under agent-may-accept with the permitting rule recorded', async () => {
  await fixture(async ({ project, acceptance }) => {
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;
    const owner = { kind: 'owner' as const, identity: 'local' };

    // The default policy is owner-only, and an agent acceptance is refused outright.
    assert.equal(acceptance.readPolicy().mode, 'owner-only');
    await assert.rejects(async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id) }), refuses('NOT_PERMITTED', /policy is owner-only, so an acceptance by agent worker-3 is refused outright/));
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).acceptance, null, 'the refusal recorded no acceptance');

    // agent-may-accept with commit set to full-auto: the agent may accept, and the rule is recorded.
    await acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner });
    const accepted = await acceptance.accept({ projectId: PROJECT, request: acceptInput(id) });
    assert.deepEqual(
      [
        accepted.acceptance.evidenceId,
        accepted.acceptance.artifact.revision,
        accepted.acceptance.acceptedBy.kind,
        accepted.acceptance.acceptedBy.identity,
        accepted.acceptance.acceptedBy.policyRule,
        accepted.acceptance.actionClass,
        accepted.acceptance.acceptedAt,
        accepted.acceptance.singleUse
      ],
      [id, REVISION, 'agent', 'worker-3', agentPolicyRule('commit'), 'commit', T0, true]
    );
    assert.deepEqual(accepted.acceptance.policy, { revision: 1, recorded: true, mode: 'agent-may-accept', classDecision: 'full-auto' });
    assert.deepEqual(accepted.acceptance.subject, { kind: 'session', id: SESSION });
    assert.equal(accepted.acceptance.projectId, PROJECT);
    // The Markdown record now carries the verdict, and it is the durable file on disk.
    assert.equal(accepted.evidence.markdown.state, 'current');
    const text = await markdown(project, id);
    assert.ok(text.includes('- Accepted by: agent `worker-3` at ' + T0), text);
    assert.ok(text.includes('- Rule that permitted it: `' + agentPolicyRule('commit') + '`'), text);
    assert.ok(text.includes('- Policy: revision 1, mode agent-may-accept, commit=full-auto'), text);
    assert.ok(text.includes('- Accepted artifact: revision `' + REVISION + '`, commit `' + COMMIT + '`'), text);
    assert.ok(!text.includes('No acceptance is recorded for this evidence.'), 'the acceptance replaces the empty section');

    // The owner may also accept, and an owner acceptance claims no rule.
    const other = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ artifact: { revision: 'd'.repeat(64), commit: null } }) });
    const owned = await acceptance.accept({ projectId: PROJECT, request: acceptInput(other.evidence.record.id, { artifact: { revision: 'd'.repeat(64), commit: null }, actor: owner }) });
    assert.deepEqual([owned.acceptance.acceptedBy.kind, owned.acceptance.acceptedBy.policyRule], ['owner', null]);
    assert.ok((await markdown(project, other.evidence.record.id)).includes('the owner decides, so no rule was needed'));
  });
});

test('an action class the policy asks the owner to decide refuses an agent acceptance, and a class set to ask is per class', async () => {
  await fixture(async ({ acceptance }) => {
    const owner = { kind: 'owner' as const, identity: 'local' };
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;
    await acceptance.updatePolicy({ revision: 0, policy: policy({ actionClasses: { commit: 'full-auto', push: 'ask', deploy: 'ask', spend: 'ask', provision: 'ask', publish: 'ask' } }), actor: owner });

    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { actionClass: 'deploy' }) }),
      refuses('NOT_PERMITTED', /asks the owner to decide a deploy, so an acceptance by agent worker-3 is refused/)
    );
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).acceptance, null);
    // The same class decided by the owner is allowed: asking is a requirement to ask, not a refusal forever.
    const owned = await acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { actionClass: 'deploy', actor: owner }) });
    assert.deepEqual([owned.acceptance.actionClass, owned.acceptance.acceptedBy.kind, owned.acceptance.policy.classDecision], ['deploy', 'owner', 'ask']);
  });
});

test('accepting an artifact that has changed since the evidence was produced is refused, and a new revision needs new evidence', async () => {
  await fixture(async ({ acceptance }) => {
    const owner = { kind: 'owner' as const, identity: 'local' };
    await acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner });
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;

    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { artifact: { revision: 'e'.repeat(64), commit: COMMIT } }) }),
      refuses('ARTIFACT_CHANGED', /The artifact has changed since this evidence was produced: the evidence records revision a{64}/)
    );
    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { artifact: { revision: REVISION, commit: null } }) }),
      refuses('ARTIFACT_CHANGED', /and this request accepts revision a{64} \(not committed\)/)
    );
    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { artifact: { revision: REVISION, commit: null } }) }),
      refuses('ARTIFACT_CHANGED', /record new evidence first/)
    );
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).acceptance, null, 'no refused acceptance wrote anything');

    // New evidence for the new revision, then that one is accepted: the binding is per revision.
    const moved = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ artifact: { revision: 'e'.repeat(64), commit: COMMIT } }) });
    const accepted = await acceptance.accept({ projectId: PROJECT, request: acceptInput(moved.evidence.record.id, { artifact: { revision: 'e'.repeat(64), commit: COMMIT } }) });
    assert.equal(accepted.acceptance.artifact.revision, 'e'.repeat(64));
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).acceptance, null, 'the original evidence is still not accepted');
  });
});

test('an unknown evidence id is refused, and an acceptance is single use including after a crash and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-acceptance-reopen-'));
  const project = join(root, 'workspaces', 'project');
  await mkdir(join(project, 'docs'), { recursive: true, mode: 0o755 });
  const data = join(root, 'data');
  try {
    let store = new ControlStore(data);
    let acceptance = new AcceptanceStore(store, { clock: () => new Date(Date.parse(T0)), id: () => 'ac-0001', projectRoot: (id) => (id === PROJECT ? project : undefined) });
    const owner = { kind: 'owner' as const, identity: 'local' };
    await acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner });
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;
    await assert.rejects(async () => acceptance.accept({ projectId: PROJECT, request: acceptInput('ev-' + 'f'.repeat(32)) }), refuses('NOT_FOUND', /No completion record with id ev-fff/));
    await assert.rejects(async () => acceptance.accept({ projectId: PROJECT, request: { evidenceId: id } }), refuses('INVALID', /acceptance request .*is invalid/));
    const first = await acceptance.accept({ projectId: PROJECT, request: acceptInput(id) });
    assert.equal(first.acceptance.acceptedBy.policyRule, agentPolicyRule('commit'));
    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { actor: owner }) }),
      refuses('ALREADY_ACCEPTED', /already accepted at 2026-01-01T00:00:00.000Z by agent .worker-3.; an acceptance is single use/)
    );
    store.close();

    // A crash and reopen: the single-use record is still single use, and the durable record is byte-identical.
    const bytes = await readFile(join(data, 'control.sqlite'));
    store = new ControlStore(data);
    acceptance = new AcceptanceStore(store, { clock: () => new Date(Date.parse(T0)), id: () => 'ac-0002', projectRoot: (id) => (id === PROJECT ? project : undefined) });
    const persisted = await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id });
    assert.deepEqual(persisted.acceptance, first.acceptance, 'the acceptance survives a reopen unchanged');
    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { actor: owner }) }),
      refuses('ALREADY_ACCEPTED', /already accepted/)
    );
    assert.deepEqual((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).acceptance, first.acceptance, 'the replay changed nothing');
    assert.ok(bytes.length > 0);

    // A second handle over the same database, as another process would be, is refused too.
    const other = new ControlStore(data);
    const second = new AcceptanceStore(other, { clock: () => new Date(Date.parse(T0)), projectRoot: (id) => (id === PROJECT ? project : undefined) });
    await assert.rejects(async () => second.accept({ projectId: PROJECT, request: acceptInput(id, { actor: owner }) }), refuses('ALREADY_ACCEPTED', /already accepted/));
    other.close();
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the policy survives a reopen, and a corrupt stored record is refused rather than interpreted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilot-acceptance-corrupt-'));
  const project = join(root, 'workspaces', 'project');
  await mkdir(join(project, 'docs'), { recursive: true, mode: 0o755 });
  try {
    let store = new ControlStore(join(root, 'data'));
    let acceptance = new AcceptanceStore(store, { clock: () => new Date(Date.parse(T0)), projectRoot: (id) => (id === PROJECT ? project : undefined) });
    const owner = { kind: 'owner' as const, identity: 'local' };
    const written = acceptance.updatePolicy({ revision: 0, policy: policy({ mode: 'owner-only' }), actor: owner });
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    store.close();
    store = new ControlStore(join(root, 'data'));
    acceptance = new AcceptanceStore(store, { clock: () => new Date(Date.parse(T0)), projectRoot: (id) => (id === PROJECT ? project : undefined) });
    assert.deepEqual(acceptance.readPolicy(), written, 'the policy survives a reopen unchanged');

    // Corruption written behind the store's back, as a damaged file would appear.
    store.db.prepare('UPDATE operations SET input_json=? WHERE kind=?').run(JSON.stringify({ version: 1, mode: 'owner-only' }), 'acceptance.policy');
    await assert.rejects(async () => acceptance.readPolicy(), refuses('CORRUPT', /stored acceptance policy is corrupt/));
    // An acceptance reads the policy in force, so it refuses too rather than deciding under a policy it cannot read.
    await assert.rejects(async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(recorded.evidence.record.id) }), refuses('CORRUPT', /stored acceptance policy is corrupt/));
    await assert.rejects(async () => acceptance.readProject({ projectId: PROJECT }), refuses('CORRUPT', /stored acceptance policy is corrupt/));
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: recorded.evidence.record.id })).record.artifact.revision, REVISION, 'the completion record itself is still readable');
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('an outcome that contradicts the counts its own recorded output carries is refused, and a not-run command stores a named absence', async () => {
  await fixture(async ({ project, acceptance }) => {
    const passing = '# tests 2\n# pass 2\n# fail 0\n# skipped 0';
    // Both directions, with no claim to hide behind: the outcome is checked against the very counts
    // the record is about to store, not against what the caller says about them.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: TEST_OUTPUT, counts: null }] }) }),
      refuses('INVALID', /records .pnpm test. as passed, but its own recorded output reports 1 failed/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'failed', output: passing, counts: null }] }) }),
      refuses('INVALID', /records .pnpm test. as failed, but its own recorded output reports no failure \(2 passed, 0 failed\)/)
    );
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'passed', output: TEST_OUTPUT, counts: { passed: 2, failed: 1, skipped: 0 } }] }) }),
      refuses('INVALID', /records .pnpm test. as passed/),
      'a caller that claims the failing counts honestly still cannot record the run as passed'
    );
    assert.deepEqual((await acceptance.readProject({ projectId: PROJECT })).evidence, [], 'every refusal wrote nothing');

    // A command the record says was not run asserts no result: the counts its recorded output carries
    // are not this record's result, so they are reported as the named absence instead.
    const notRun = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'not-run', output: TEST_OUTPUT, counts: null }] }) });
    assert.deepEqual(notRun.evidence.record.tests, [{
      command: 'pnpm test', outcome: 'not-run', output: TEST_OUTPUT, counts: null, absenceReason: ACCEPTANCE_ABSENCE_REASONS.commandNotRun
    }]);
    const notRunMarkdown = await markdown(project, notRun.evidence.record.id);
    assert.ok(notRunMarkdown.includes('- Counts: not asserted — ' + ACCEPTANCE_ABSENCE_REASONS.commandNotRun + ' — '), notRunMarkdown);
    assert.ok(!notRunMarkdown.includes('Counts (read from the recorded output)'), 'the Markdown record reports no counts for a command it says was not run');

    // The outcomes its own evidence does support are stored as stated, with the counts read from it.
    const failed = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence({ tests: [{ command: 'pnpm test', outcome: 'failed', output: TEST_OUTPUT, counts: null }] }) });
    assert.deepEqual([failed.evidence.record.tests[0].outcome, failed.evidence.record.tests[0].counts], ['failed', { passed: 2, failed: 1, skipped: 0 }]);
    const passed = await acceptance.recordEvidence({
      projectId: PROJECT,
      evidence: evidence({ artifact: { revision: '9'.repeat(64), commit: null }, tests: [{ command: 'pnpm test', outcome: 'passed', output: passing, counts: null }] })
    });
    assert.deepEqual([passed.evidence.record.tests[0].outcome, passed.evidence.record.tests[0].counts], ['passed', { passed: 2, failed: 0, skipped: 0 }]);
  });
});

test('the Markdown write reports the state it read back, so an unrenderable file is reported and never asserted as written', async () => {
  await fixture(async ({ project, acceptance }) => {
    const owner = { kind: 'owner' as const, identity: 'local' };
    await acceptance.updatePolicy({ revision: 0, policy: policy(), actor: owner });
    const recorded = await acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() });
    const id = recorded.evidence.record.id;
    assert.deepEqual([recorded.written, recorded.evidence.markdown.state], [true, 'current'], 'a write that really landed is reported as current');

    // Make the record's own file unrenderable: a directory where the Markdown file belongs, so the
    // atomic write can no longer produce the file. The state is then the one the file really has.
    const path = join(project, ACCEPTANCE_RECORD_DIRECTORY, id + '.md');
    await rm(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).markdown.state, 'unreadable');
    // Re-recording the same evidence cannot render it and says so, rather than answering with a write
    // it did not make: the durable record itself is the one it always was.
    await assert.rejects(
      async () => acceptance.recordEvidence({ projectId: PROJECT, evidence: evidence() }),
      refuses('STORAGE', /Markdown record could not be written in the project/)
    );
    assert.equal((await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id })).record.id, id, 'a failed render never changed the durable record');

    // The acceptance is admitted before the render too, so a render that fails after it must not be
    // answered as a refusal: the single-use decision is already durable, and telling the operator it
    // failed and then that it already exists would contradict itself. The answer reports the file.
    const accepted = await acceptance.accept({ projectId: PROJECT, request: acceptInput(id) });
    assert.deepEqual(
      [accepted.acceptance.acceptedBy.kind, accepted.acceptance.acceptedBy.identity, accepted.acceptance.acceptedBy.policyRule, accepted.acceptance.singleUse],
      ['agent', 'worker-3', agentPolicyRule('commit'), true],
      'the agent acceptance is durable and records the rule that permitted it'
    );
    assert.equal(accepted.evidence.markdown.state, 'unreadable', 'the answer reports what is really on disk instead of a state it never verified');
    assert.equal(accepted.evidence.record.id, id);
    // Every later read agrees with that answer: one acceptance, one reported state, and no second one.
    const read = await acceptance.readEvidence({ projectId: PROJECT, evidenceId: id });
    assert.deepEqual([read.acceptance, read.markdown.state], [accepted.acceptance, 'unreadable']);
    await assert.rejects(
      async () => acceptance.accept({ projectId: PROJECT, request: acceptInput(id, { actor: owner }) }),
      refuses('ALREADY_ACCEPTED', /an acceptance is single use/)
    );
  });
});

