import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_STORAGE_LIMITS,
  DRAFT_STORAGE_PREFIX,
  DraftStore,
  SAVE_FAILURE_PREFIX,
  attemptFor,
  clearSaveFailure,
  draftKey,
  draftSaveMessage,
  markSaveFailure,
  readSaveFailure,
  readSelectedSession,
  restoredImageItems,
  sameAttempt,
  saveFailureKey,
  sessionKeyOf,
  storedAttachments,
  writeSelectedSession,
  type StorageLike,
  type StoredDraft,
} from '../../src/client/drafts';
import type { ImageDraft } from '../../src/shared/images';

/**
 * The draft store's own rules, without a browser: isolation by project and session, what a stored
 * image reference may carry, the three technical storage bounds, a storage that refuses a write,
 * and the absence of any age, clock or count rule that could delete a valid draft.
 */

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  failOnSet: 'quota' | 'other' | null = null;
  failOnGet = false;
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null {
    if (this.failOnGet) throw new Error('storage disabled');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failOnSet === 'quota') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    if (this.failOnSet === 'other') throw new Error('storage refused');
    this.values.set(key, value);
  }
  removeItem(key: string): void { this.values.delete(key); }
}

const MEDIA = ['a', 'b', 'c', 'd', 'e', 'f'].map(character => character.repeat(64));

function draft(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return {
    v: 1,
    projectId: 'project-one',
    session: 'session-one',
    text: 'a draft',
    updatedAt: 1_700_000_000_000,
    attachments: [],
    attempt: null,
    ...overrides,
  };
}

function item(overrides: Partial<ImageDraft> = {}): ImageDraft {
  return { key: 'image-1', name: 'photo.png', declaredBytes: 120, status: 'ready', id: MEDIA[0], mimeType: 'image/png', bytes: 120, width: 8, height: 6, ...overrides };
}

function memory(store: DraftStore): MemoryStorage {
  return (store as unknown as { storage: MemoryStorage }).storage;
}

test('a draft round-trips its text, stored references and send attempt', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const saved = store.save(draft({ updatedAt: 2_000, attachments: [{ key: 'image-1', name: 'photo.png', status: 'ready', mediaId: MEDIA[0], declaredBytes: 120, width: 8, height: 6 }], attempt: { requestId: 'request-1', text: 'a draft', images: [MEDIA[0]] } }));
  assert.deepEqual(saved, { ok: true, droppedFailureNotes: 0 });
  const loaded = store.load('project-one', 'session-one');
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') return;
  assert.equal(loaded.draft.text, 'a draft');
  assert.equal(loaded.draft.attachments[0].mediaId, MEDIA[0]);
  assert.deepEqual(loaded.draft.attempt, { requestId: 'request-1', text: 'a draft', images: [MEDIA[0]] });
});

test('drafts are isolated by project and by session, and removing one never touches another', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  store.save(draft({ projectId: 'project-one', session: 'a', text: 'one-a', updatedAt: 2_000 }));
  store.save(draft({ projectId: 'project-one', session: 'b', text: 'one-b', updatedAt: 2_000 }));
  store.save(draft({ projectId: 'project-two', session: 'a', text: 'two-a', updatedAt: 2_000 }));
  store.remove('project-one', 'a');
  assert.equal(store.load('project-one', 'a').status, 'empty');
  const b = store.load('project-one', 'b');
  assert.equal(b.status, 'loaded');
  if (b.status === 'loaded') assert.equal(b.draft.text, 'one-b');
  const other = store.load('project-two', 'a');
  assert.equal(other.status, 'loaded');
  if (other.status === 'loaded') assert.equal(other.draft.text, 'two-a');
});

test('the unnamed conversation is its own key and never collides with a session id', () => {
  assert.equal(sessionKeyOf(''), 'root');
  assert.equal(sessionKeyOf(null), 'root');
  assert.equal(sessionKeyOf('session-one'), 'session-one');
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  store.save(draft({ session: 'root', text: 'root draft', updatedAt: 2_000 }));
  assert.equal(store.load('project-one', 'root').status, 'loaded');
  assert.equal(store.load('project-one', 'session-one').status, 'empty');
});

test('image references keep the server id and facts but never bytes or unknown fields', () => {
  const [ready] = storedAttachments([item()]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.mediaId, MEDIA[0]);
  assert.equal(ready.bytes, 120);
  const raw = { ...ready, data: 'BASE64BYTES', base64: 'BASE64BYTES', file: {} } as unknown as StoredDraft['attachments'][number];
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  store.save(draft({ attachments: [raw], updatedAt: 2_000 }));
  const serialized = [...memory(store).values.values()][0];
  assert.equal(serialized.includes('BASE64BYTES'), false);
  assert.equal(serialized.includes('base64'), false);
});

test('a ready reference without a server media id is corrupt, and the record is not deleted', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const storage = memory(store);
  storage.setItem(draftKey('project-one', 'session-one'), JSON.stringify(draft({ attachments: [{ key: 'x', name: 'x', status: 'ready' }] })));
  assert.equal(store.load('project-one', 'session-one').status, 'corrupt');
  assert.equal(storage.length, 1);
});

test('restoring distinguishes a stored reference, an unfinished upload and a failed one', () => {
  const restored = restoredImageItems([
    { key: 'a', name: 'a.png', status: 'ready', mediaId: MEDIA[0] },
    { key: 'b', name: 'b.png', status: 'uploading' },
    { key: 'c', name: 'c.png', status: 'failed', reason: 'The image could not be uploaded.' },
  ]);
  assert.equal(restored[0].status, 'checking');
  assert.equal(restored[0].id, MEDIA[0]);
  assert.equal(restored[1].status, 'missing');
  assert.match(restored[1].reason ?? '', /did not finish/);
  assert.equal(restored[2].status, 'failed');
  assert.equal(restored[2].reason, 'The image could not be uploaded.');
  assert.deepEqual(restored.filter(entry => entry.status === 'ready'), []);
});

test('a reference whose lookup failed keeps its media id, so a reload can retry', () => {
  const [kept] = storedAttachments([item({ status: 'checking', probeError: 'The server could not be reached.' })]);
  assert.equal(kept.status, 'ready');
  assert.equal(kept.mediaId, MEDIA[0]);
  const [missing] = storedAttachments([item({ status: 'missing', reason: 'The server no longer has this image.' })]);
  assert.equal(missing.status, 'ready');
  assert.equal(missing.mediaId, MEDIA[0]);
});

test('a corrupt record is reported and left in place; a save of the same identity replaces it', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const storage = memory(store);
  storage.setItem(draftKey('project-one', 'session-one'), '{ not json');
  assert.equal(store.load('project-one', 'session-one').status, 'corrupt');
  assert.equal(storage.getItem(draftKey('project-one', 'session-one')), '{ not json');

  storage.setItem(draftKey('project-one', 'session-two'), JSON.stringify({ ...draft(), v: 2 }));
  assert.equal(store.load('project-one', 'session-two').status, 'corrupt');

  // A record that names another identity than its own key is never restored into this one.
  storage.setItem(draftKey('project-one', 'session-one'), JSON.stringify(draft({ projectId: 'project-two' })));
  assert.equal(store.load('project-one', 'session-one').status, 'corrupt');
  assert.equal(storage.length, 2);

  assert.equal(store.save(draft({ updatedAt: 2_000 })).ok, true);
  assert.equal(store.load('project-one', 'session-one').status, 'loaded');
});

test('no age or clock rule deletes a valid draft', () => {
  const store = new DraftStore(new MemoryStorage(), () => 10_000_000_000_000);
  const storage = memory(store);
  storage.setItem(draftKey('project-one', 'old'), JSON.stringify(draft({ session: 'old', updatedAt: 0 })));
  storage.setItem(draftKey('project-one', 'future'), JSON.stringify(draft({ session: 'future', updatedAt: 9_999_999_999_999 })));
  const old = store.load('project-one', 'old');
  const future = store.load('project-one', 'future');
  assert.equal(old.status, 'loaded');
  assert.equal(future.status, 'loaded');
  assert.equal(storage.length, 2);
});

test('many attachments are stored: sendable references are never refused by a count rule', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const attachments = [
    ...MEDIA.map((id, index) => ({ key: 'ready-' + index, name: 'ready.png', status: 'ready' as const, mediaId: id })),
    ...Array.from({ length: 5 }, (_, index) => ({ key: 'failed-' + index, name: 'failed.png', status: 'failed' as const, reason: 'Not stored.' })),
  ];
  const saved = store.save(draft({ attachments, updatedAt: 2_000 }));
  assert.equal(saved.ok, true);
  if (saved.ok) assert.equal(saved.droppedFailureNotes, 0);
  const loaded = store.load('project-one', 'session-one');
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') return;
  assert.equal(loaded.draft.attachments.filter(entry => entry.status === 'ready').length, MEDIA.length);
  assert.equal(loaded.draft.attachments.length, attachments.length);
});

test('only failure metadata is bounded, and the bound drops notes without refusing the draft', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const ready = MEDIA.map((id, index) => ({ key: 'ready-' + index, name: 'ready.png', status: 'ready' as const, mediaId: id }));
  const failed = Array.from({ length: 40 }, (_, index) => ({ key: 'failed-' + index, name: 'failed.png', status: 'failed' as const, reason: 'r'.repeat(500) }));
  const saved = store.save(draft({ attachments: [...ready, ...failed], updatedAt: 2_000 }));
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.ok(saved.droppedFailureNotes > 0);
  const loaded = store.load('project-one', 'session-one');
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') return;
  assert.equal(loaded.draft.attachments.filter(entry => entry.status === 'ready').length, MEDIA.length);
  assert.ok(loaded.draft.attachments.length < ready.length + failed.length);
});

test('the technical text bound is refused by name and writes nothing', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const tooLarge = store.save(draft({ text: 'x'.repeat(DRAFT_STORAGE_LIMITS.textBytes + 1) }));
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.reason, 'too-large');
  assert.equal(store.load('project-one', 'session-one').status, 'empty');
  assert.match(draftSaveMessage(tooLarge), /copy or download/i);
  // The text bound is UTF-8 on both sides: 20000 four-byte characters fit in UTF-16 units but not
  // in the byte bound, and a record written that way is not accepted on load either.
  const multiByte = '\u{1F600}'.repeat(20_000);
  const refused = store.save(draft({ text: multiByte }));
  assert.equal(refused.ok, false);
  const storage = memory(store);
  storage.setItem(draftKey('project-one', 'session-one'), JSON.stringify(draft({ text: multiByte })));
  assert.equal(store.load('project-one', 'session-one').status, 'corrupt');
});

test('the technical profile bound refuses a new draft without evicting an existing one', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const text = 'x'.repeat(60_000);
  let refused: string | null = null;
  for (let index = 0; index < 60 && refused === null; index++) {
    const result = store.save(draft({ projectId: 'project-' + index, session: 's', text, updatedAt: 2_000 }));
    if (!result.ok) refused = result.reason;
  }
  assert.equal(refused, 'profile-limit');
  const first = store.load('project-0', 's');
  assert.equal(first.status, 'loaded');
  if (first.status === 'loaded') assert.equal(first.draft.text.length, 60_000);
});

test('a storage that refuses a write keeps the refusal named, and a disabled storage is unavailable', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const storage = memory(store);
  storage.failOnSet = 'quota';
  const quota = store.save(draft({ updatedAt: 2_000 }));
  assert.equal(quota.ok, false);
  if (!quota.ok) assert.equal(quota.reason, 'quota');
  assert.match(draftSaveMessage(quota), /copy or download/i);
  storage.failOnSet = 'other';
  const refused = store.save(draft({ updatedAt: 2_000 }));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'unavailable');

  const unavailable = new DraftStore(null);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.load('project-one', 'session-one').status, 'unavailable');
  assert.equal(unavailable.save(draft()).ok, false);

  const readFails = new MemoryStorage();
  readFails.failOnGet = true;
  assert.equal(new DraftStore(readFails).load('project-one', 'session-one').status, 'unavailable');
});

test('a request identity is reused only for exactly the same message', () => {
  const attempt = { requestId: 'request-1', text: 'hello', images: [MEDIA[0], MEDIA[1]] };
  assert.equal(sameAttempt(attempt, 'hello', [MEDIA[0], MEDIA[1]]), true);
  assert.equal(sameAttempt(attempt, 'hello there', [MEDIA[0], MEDIA[1]]), false);
  assert.equal(sameAttempt(attempt, 'hello', [MEDIA[1], MEDIA[0]]), false);
  assert.equal(sameAttempt(attempt, 'hello', [MEDIA[0]]), false);
  assert.equal(attemptFor(attempt, 'hello', [MEDIA[0], MEDIA[1]]), attempt);
  assert.equal(attemptFor(attempt, 'changed', [MEDIA[0], MEDIA[1]]), null);
  assert.equal(attemptFor(null, 'hello', []), null);
});

test('the save-failure marker is per identity, reported, and cleared explicitly', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readSaveFailure(storage, 'project-one', 'session-one'), { status: 'none' });
  assert.equal(markSaveFailure(storage, 'project-one', 'session-one', 1_234), true);
  assert.deepEqual(readSaveFailure(storage, 'project-one', 'session-one'), { status: 'present', at: 1_234 });
  assert.deepEqual(readSaveFailure(storage, 'project-one', 'session-two'), { status: 'none' });
  clearSaveFailure(storage, 'project-one', 'session-one');
  assert.deepEqual(readSaveFailure(storage, 'project-one', 'session-one'), { status: 'none' });
  storage.setItem(saveFailureKey('project-one', 'session-one'), '{ not json');
  assert.equal(readSaveFailure(storage, 'project-one', 'session-one').status, 'unavailable');
  assert.equal(markSaveFailure(null, 'project-one', 'session-one', 1), false);
});

test('clearAll removes every draft and marker and leaves preferences and unrelated keys', () => {
  const store = new DraftStore(new MemoryStorage(), () => 2_000);
  const storage = memory(store);
  store.save(draft({ projectId: 'project-one', session: 'a', updatedAt: 2_000 }));
  store.save(draft({ projectId: 'project-one', session: 'b', updatedAt: 2_000 }));
  markSaveFailure(storage, 'project-one', 'a', 5);
  writeSelectedSession(storage, 'project-one', 'a');
  storage.setItem('dashboard.theme', 'dark');
  assert.equal(store.clearAll(), 3);
  assert.equal([...storage.values.keys()].every(key => !key.startsWith(DRAFT_STORAGE_PREFIX) && !key.startsWith(SAVE_FAILURE_PREFIX)), true);
  assert.equal(storage.getItem('dashboard.theme'), 'dark');
  assert.equal(storage.getItem('pilot.session.v1:project-one'), 'a');
});

test('the last selected session is remembered per project and validated before use', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readSelectedSession(storage, 'project-one'), { status: 'none' });
  assert.equal(writeSelectedSession(storage, 'project-one', 'session-one'), true);
  assert.deepEqual(readSelectedSession(storage, 'project-one'), { status: 'selected', sessionId: 'session-one' });
  assert.deepEqual(readSelectedSession(storage, 'project-two'), { status: 'none' });
  assert.equal(writeSelectedSession(storage, 'project-one', null), true);
  assert.deepEqual(readSelectedSession(storage, 'project-one'), { status: 'none' });
  assert.equal(writeSelectedSession(storage, 'project-one', 'bad:id'), false);
  storage.setItem('pilot.session.v1:project-one', 'bad:id');
  assert.deepEqual(readSelectedSession(storage, 'project-one'), { status: 'none' });
  storage.setItem('pilot.session.v1:project-one', 'root');
  assert.deepEqual(readSelectedSession(storage, 'project-one'), { status: 'none' });
  assert.equal(readSelectedSession(null, 'project-one').status, 'unavailable');
});
