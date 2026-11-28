import type { ImageDraft } from '../shared/images';

/**
 * Browser-local composer drafts, one per project and session.
 *
 * This module is pure: it takes a `StorageLike` rather than reaching for `localStorage`, so the
 * rules below are testable without a browser. The caller decides what storage to use and handles
 * the in-memory fallback; every refusal here is a named result, never a thrown error.
 *
 * What a draft holds: the text the person typed, references to images the server already stored
 * (the media id, never the bytes), the visible state of an image the server does not have yet,
 * and the request identity of a send that has not been confirmed admitted. The text is arbitrary
 * and may itself contain a secret the person pasted; the store adds no credential of its own.
 * Unknown fields read from storage are dropped, so a reference record can never smuggle image
 * bytes, an object URL, a file handle or an application credential back into the composer.
 *
 * Nothing here deletes a valid draft automatically. There is no age limit, no clock-skew rule and
 * no count limit: those would be product policy, and the owner has not accepted them. Only three
 * technical storage bounds remain, each with a visible refusal or a bounded, reported drop of
 * failure notes. A draft is removed only after an admitted send, by an explicit owner action, or
 * when a new save replaces its own key.
 */

/** Every draft key this module owns starts with this prefix. */
export const DRAFT_STORAGE_PREFIX = 'pilot.draft.v1:';
/** The per-project preference for the session the owner was last reading. */
export const SELECTED_SESSION_PREFIX = 'pilot.session.v1:';
/** A best-effort marker that the last local save of one draft failed. */
export const SAVE_FAILURE_PREFIX = 'pilot.draft.warn.v1:';

/** The part of Web Storage this module needs. A test supplies its own. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Technical storage bounds, not product policy.
 *
 * The text bound is 64 KiB of UTF-8 bytes, more than twice the largest possible UTF-8 encoding of
 * the server's 8000-character message limit (32,000 bytes), so a draft that can be sent is never
 * refused, even when every character takes four bytes. The profile bound keeps one browser profile
 * bounded. The metadata bound applies only to notes about images that cannot be sent; sendable
 * references are never dropped to meet it.
 */
export const DRAFT_STORAGE_LIMITS = Object.freeze({
  /** UTF-8 bytes of the draft text. */
  textBytes: 64 * 1024,
  /** All drafts for one browser profile, in UTF-8 bytes. */
  profileBytes: 2 * 1024 * 1024,
  /** Serialized bytes of notes about images that are not sendable, in one draft. */
  attachmentMetadataBytes: 16 * 1024,
});

/** The persisted state of one image reference. */
export type StoredAttachmentStatus = 'ready' | 'uploading' | 'failed';

/** One image reference as it is stored: its server id or its visible non-ready state. */
export interface StoredAttachment {
  key: string;
  name: string;
  status: StoredAttachmentStatus;
  /** A server media id. Required for `ready`; kept on a failed reference when one is known. */
  mediaId?: string;
  declaredBytes?: number;
  mimeType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  note?: string;
  /** Why the image is not ready, as the person was already shown it. */
  reason?: string;
}

/** One send attempt whose admission is not confirmed, so a retry can be the same admission. */
export interface StoredAttempt {
  requestId: string;
  /** The trimmed text that was submitted. */
  text: string;
  /** The stored media ids that were submitted, in order. */
  images: string[];
}

export interface StoredDraft {
  v: 1;
  projectId: string;
  session: string;
  text: string;
  updatedAt: number;
  attachments: StoredAttachment[];
  attempt: StoredAttempt | null;
}

export type DraftLoad =
  | { status: 'empty' }
  | { status: 'loaded'; draft: StoredDraft }
  | { status: 'corrupt' }
  | { status: 'unavailable' };

export type DraftSaveReason = 'unavailable' | 'quota' | 'too-large' | 'profile-limit';

export type DraftSave =
  | { ok: true; droppedFailureNotes: number }
  | { ok: false; reason: DraftSaveReason; detail: string };

export type SelectedSessionRead = { status: 'none' } | { status: 'selected'; sessionId: string } | { status: 'unavailable' };
export type SaveFailureRead = { status: 'none' } | { status: 'present'; at: number } | { status: 'unavailable' };

const MEDIA_ID = /^[a-f0-9]{64}$/;
const KEY_PART = /^[A-Za-z0-9_-]{1,200}$/;
const ROOT_SESSION = 'root';

/** The storage key for one project and session. `root` is the project's unnamed conversation. */
export function draftKey(projectId: string, session: string): string {
  return DRAFT_STORAGE_PREFIX + projectId + ':' + session;
}

/** The marker key for one project and session. */
export function saveFailureKey(projectId: string, session: string): string {
  return SAVE_FAILURE_PREFIX + projectId + ':' + session;
}

/** The session key for the composer's current selection. */
export function sessionKeyOf(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : ROOT_SESSION;
}

/** Whether an id may be part of a storage key. Anything else is never used as one. */
function keyPart(value: unknown): value is string {
  return typeof value === 'string' && KEY_PART.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, maxCharacters: number): value is string {
  return typeof value === 'string' && value.length <= maxCharacters;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return count(value) ? value : undefined;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * One stored attachment, with unknown fields dropped.
 *
 * This is the single place that decides what an image reference may carry. `data`, `base64`,
 * `file`, or anything else a future caller adds is not copied, so image bytes cannot be stored
 * even by mistake.
 */
function attachmentOf(value: unknown): StoredAttachment | null {
  if (!isRecord(value)) return null;
  if (!text(value.key, 200) || value.key === '') return null;
  if (!text(value.name, 200)) return null;
  const status = value.status;
  if (status !== 'ready' && status !== 'uploading' && status !== 'failed') return null;
  const mediaId = typeof value.mediaId === 'string' && MEDIA_ID.test(value.mediaId) ? value.mediaId : undefined;
  // A ready reference without a media id is not a stored image, so it is not a ready reference.
  if (status === 'ready' && mediaId === undefined) return null;
  const attachment: StoredAttachment = { key: value.key, name: value.name, status };
  if (mediaId !== undefined) attachment.mediaId = mediaId;
  const declaredBytes = optionalCount(value.declaredBytes);
  if (declaredBytes !== undefined) attachment.declaredBytes = declaredBytes;
  const mimeType = optionalText(value.mimeType, 100);
  if (mimeType !== undefined) attachment.mimeType = mimeType;
  const bytes = optionalCount(value.bytes);
  if (bytes !== undefined) attachment.bytes = bytes;
  const width = optionalCount(value.width);
  if (width !== undefined) attachment.width = width;
  const height = optionalCount(value.height);
  if (height !== undefined) attachment.height = height;
  const note = optionalText(value.note, 500);
  if (note !== undefined) attachment.note = note;
  const reason = optionalText(value.reason, 500);
  if (reason !== undefined) attachment.reason = reason;
  return attachment;
}

function attemptOf(value: unknown): StoredAttempt | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  if (!text(value.requestId, 200) || value.requestId === '') return undefined;
  if (!text(value.text, DRAFT_STORAGE_LIMITS.textBytes)) return undefined;
  // The same UTF-8 bound the writer applies, so a load cannot accept what a save would refuse.
  if (utf8Bytes(value.text) > DRAFT_STORAGE_LIMITS.textBytes) return undefined;
  if (!Array.isArray(value.images)) return undefined;
  const images: string[] = [];
  for (const id of value.images) {
    if (typeof id !== 'string' || !MEDIA_ID.test(id)) return undefined;
    images.push(id);
  }
  return { requestId: value.requestId, text: value.text, images };
}

/**
 * One draft read from storage, or `null` when it is not a draft this build understands.
 * `projectId` and `session` are the identity the key already named, so a record that disagrees
 * with its own key is refused rather than restored into the wrong context.
 */
function draftOf(value: unknown, projectId: string, session: string): StoredDraft | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (value.projectId !== projectId || value.session !== session) return null;
  if (!text(value.text, DRAFT_STORAGE_LIMITS.textBytes)) return null;
  if (utf8Bytes(value.text) > DRAFT_STORAGE_LIMITS.textBytes) return null;
  if (!count(value.updatedAt)) return null;
  if (!Array.isArray(value.attachments)) return null;
  const attachments: StoredAttachment[] = [];
  for (const raw of value.attachments) {
    const attachment = attachmentOf(raw);
    if (attachment === null) return null;
    attachments.push(attachment);
  }
  const attempt = attemptOf(value.attempt);
  if (attempt === undefined) return null;
  return { v: 1, projectId, session, text: value.text, updatedAt: value.updatedAt, attachments, attempt };
}

/** Whether a stored attempt is exactly the message about to be sent. */
export function sameAttempt(attempt: StoredAttempt | null, text: string, images: readonly string[]): boolean {
  if (attempt === null || attempt.text !== text) return false;
  return attempt.images.length === images.length && attempt.images.every((id, index) => id === images[index]);
}

/** The attempt to persist: only one whose exact message is still in the composer. */
export function attemptFor(attempt: StoredAttempt | null, text: string, images: readonly string[]): StoredAttempt | null {
  return sameAttempt(attempt, text, images) ? attempt : null;
}

/** A save refusal, in words the composer can show next to the draft. */
export function draftSaveMessage(result: Extract<DraftSave, { ok: false }>): string {
  if (result.reason === 'too-large') return 'This draft is larger than the local draft store holds (' + (DRAFT_STORAGE_LIMITS.textBytes / 1024) + ' KiB of text). The draft stays in this tab only, so copy or download it before leaving; neither prevents a duplicate admission.';
  if (result.reason === 'profile-limit') return 'The local draft store for this browser is full, so this draft was not saved. Nothing was deleted and the draft stays in this tab. Copy or download it, or clear local drafts you no longer need; copying does not prevent a duplicate admission.';
  if (result.reason === 'quota') return 'The browser refused to store this draft because its local storage is full. The draft stays in this tab; copy or download it before leaving; neither prevents a duplicate admission.';
  return 'This browser does not allow local draft storage, so the draft is kept in this tab only and a reload will lose it. Copy or download it before leaving; neither prevents a duplicate admission.';
}

/** One reason an image failure note could not be saved, for the caller to show. */
export function droppedFailureMessage(dropped: number): string {
  return dropped + (dropped === 1 ? ' image failure note was' : ' image failure notes were') + ' too large to store with the draft. Every image that can be sent and its reference were saved.';
}

function failure(reason: DraftSaveReason, detail: string): DraftSave {
  return { ok: false, reason, detail };
}

/** A storage-backed draft store. Every method catches storage faults and reports them by name. */
export class DraftStore {
  constructor(private readonly storage: StorageLike | null, private readonly now: () => number = () => Date.now()) {}

  /** Whether durable storage is available at all. */
  get available(): boolean {
    return this.storage !== null;
  }

  private keys(prefix: string): string[] {
    if (this.storage === null) return [];
    const keys: string[] = [];
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (key !== null && key.startsWith(prefix)) keys.push(key);
      }
    } catch {
      return [];
    }
    return keys;
  }

  /**
   * Read one draft. A record this build cannot read is reported as corrupt and **left in place**:
   * its bytes may still be recoverable by an operator, and the next save of the same identity
   * replaces it. Nothing is deleted by a read.
   */
  load(projectId: string, session: string): DraftLoad {
    if (!keyPart(projectId) || !keyPart(session)) return { status: 'corrupt' };
    if (this.storage === null) return { status: 'unavailable' };
    let raw: string | null;
    try {
      raw = this.storage.getItem(draftKey(projectId, session));
    } catch {
      return { status: 'unavailable' };
    }
    if (raw === null) return { status: 'empty' };
    // A record larger than the profile bound could not have been written by this build.
    if (utf8Bytes(raw) > DRAFT_STORAGE_LIMITS.profileBytes) return { status: 'corrupt' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'corrupt' };
    }
    const draft = draftOf(parsed, projectId, session);
    if (draft === null) return { status: 'corrupt' };
    return { status: 'loaded', draft };
  }

  /**
   * Save one draft. The caller keeps its in-memory copy on every refusal; nothing is evicted and
   * no other draft is changed. Failure notes that do not fit the metadata bound are dropped and
   * counted, while every sendable reference is kept.
   */
  save(draft: StoredDraft): DraftSave {
    if (!keyPart(draft.projectId) || !keyPart(draft.session) || draft.v !== 1) return failure('unavailable', 'The draft identity is not storable');
    if (this.storage === null) return failure('unavailable', 'No local storage is available');
    const textBytes = utf8Bytes(draft.text);
    if (textBytes > DRAFT_STORAGE_LIMITS.textBytes) return failure('too-large', textBytes + ' bytes of text');
    const attempt = attemptOf(draft.attempt);
    const attachments: StoredAttachment[] = [];
    let failureBytes = 0, droppedFailureNotes = 0;
    for (const raw of draft.attachments) {
      const attachment = attachmentOf(raw);
      if (attachment === null) return failure('unavailable', 'An attachment reference is not storable');
      if (attachment.status === 'ready') {
        // A sendable reference is never dropped for the metadata bound.
        attachments.push(attachment);
        continue;
      }
      const bytes = utf8Bytes(JSON.stringify(attachment));
      if (failureBytes + bytes > DRAFT_STORAGE_LIMITS.attachmentMetadataBytes) {
        droppedFailureNotes += 1;
        continue;
      }
      failureBytes += bytes;
      attachments.push(attachment);
    }
    if (attempt === undefined) return failure('unavailable', 'The send attempt is not storable');
    const record: StoredDraft = {
      v: 1, projectId: draft.projectId, session: draft.session, text: draft.text,
      updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : this.now(),
      attachments, attempt,
    };
    const key = draftKey(draft.projectId, draft.session);
    const serialized = JSON.stringify(record);
    const ownBytes = utf8Bytes(serialized) + utf8Bytes(key);
    if (ownBytes > DRAFT_STORAGE_LIMITS.profileBytes) return failure('too-large', 'The draft alone is larger than the profile bound');
    // The common case reads the other entries' sizes without parsing them. Only when the profile
    // bound is close is every entry listed again; a caller flushes this at most a few times a second.
    let others = this.otherBytes(key);
    if (others === null) return failure('unavailable', 'The local draft store could not be read');
    if (others + ownBytes > DRAFT_STORAGE_LIMITS.profileBytes) {
      return failure('profile-limit', others + ownBytes + ' bytes in this profile');
    }
    try {
      this.storage.setItem(key, serialized);
      return { ok: true, droppedFailureNotes };
    } catch (error) {
      const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
      if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return failure('quota', 'The browser storage quota was reached');
      return failure('unavailable', 'The local draft store refused the write');
    }
  }

  /** Remove one draft. It never touches another identity's key. */
  remove(projectId: string, session: string): void {
    if (this.storage === null || !keyPart(projectId) || !keyPart(session)) return;
    try {
      this.storage.removeItem(draftKey(projectId, session));
      this.storage.removeItem(saveFailureKey(projectId, session));
    } catch {
      // A storage that refuses removal keeps the record; the next load reports it.
    }
  }

  /** Remove every draft and failure marker this module owns. Returns how many keys were removed. */
  clearAll(): number {
    if (this.storage === null) return 0;
    let removed = 0;
    for (const key of [...this.keys(DRAFT_STORAGE_PREFIX), ...this.keys(SAVE_FAILURE_PREFIX)]) {
      try {
        this.storage.removeItem(key);
        removed += 1;
      } catch {
        // Leave a key that cannot be removed; the caller reports that it could not clear everything.
      }
    }
    return removed;
  }

  /** Bytes held by every draft key except one, or `null` when storage cannot be read. */
  private otherBytes(except: string): number | null {
    if (this.storage === null) return 0;
    let total = 0;
    for (const other of this.keys(DRAFT_STORAGE_PREFIX)) {
      if (other === except) continue;
      try {
        const raw = this.storage.getItem(other);
        if (raw !== null) total += utf8Bytes(raw) + utf8Bytes(other);
      } catch {
        return null;
      }
    }
    return total;
  }
}

/** The image references a draft saves: a server id when it has one, otherwise the visible state. */
export function storedAttachments(items: readonly ImageDraft[]): StoredAttachment[] {
  const attachments: StoredAttachment[] = [];
  for (const item of items) {
    const base: StoredAttachment = { key: item.key, name: item.name.slice(0, 200), status: 'failed', declaredBytes: item.declaredBytes };
    if ((item.status === 'ready' || item.status === 'checking' || item.status === 'missing') && item.id) {
      // A reference the server last had keeps its id even while the lookup fails or has answered
      // 404, so a reload can retry and the id is never lost to a transport problem.
      base.status = 'ready';
      base.mediaId = item.id;
      if (item.mimeType !== undefined) base.mimeType = item.mimeType;
      if (item.bytes !== undefined) base.bytes = item.bytes;
      if (item.width !== undefined) base.width = item.width;
      if (item.height !== undefined) base.height = item.height;
      if (item.note !== undefined) base.note = item.note.slice(0, 500);
    } else if (item.status === 'uploading') {
      // An upload that has not been admitted has no id; on reload its bytes are gone.
      base.status = 'uploading';
    } else {
      base.status = 'failed';
      const reason = item.reason ?? item.previewError;
      if (reason !== undefined) base.reason = reason.slice(0, 500);
    }
    attachments.push(base);
  }
  return attachments;
}

/**
 * Restore stored references as visible items.
 *
 * A stored id is looked up by the composer before it becomes sendable, so a reference the server
 * no longer has is named rather than dropped. An upload that never finished cannot be resumed —
 * its bytes were never stored and are gone from the page — so it is shown as missing, never
 * re-uploaded automatically.
 */
export function restoredImageItems(attachments: readonly StoredAttachment[]): ImageDraft[] {
  return attachments.map(attachment => {
    const item: ImageDraft = { key: attachment.key, name: attachment.name, declaredBytes: attachment.declaredBytes ?? 0, status: 'missing' };
    if (attachment.status === 'ready' && attachment.mediaId) {
      item.status = 'checking';
      item.id = attachment.mediaId;
      if (attachment.mimeType !== undefined) item.mimeType = attachment.mimeType;
      if (attachment.bytes !== undefined) item.bytes = attachment.bytes;
      if (attachment.width !== undefined) item.width = attachment.width;
      if (attachment.height !== undefined) item.height = attachment.height;
      if (attachment.note !== undefined) item.note = attachment.note;
      return item;
    }
    if (attachment.status === 'uploading') {
      item.status = 'missing';
      item.reason = 'The upload did not finish before this page was closed, so the image was not stored. Add it again or remove it.';
      return item;
    }
    item.status = 'failed';
    item.reason = attachment.reason ?? 'This image is not stored, so it cannot be sent. Add it again or remove it.';
    return item;
  });
}

/**
 * Record that the latest save of one draft failed. This is best effort: when storage is full the
 * marker may not be written, and the current tab still holds the latest text.
 */
export function markSaveFailure(storage: StorageLike | null, projectId: string, session: string, at: number): boolean {
  if (storage === null || !keyPart(projectId) || !keyPart(session)) return false;
  try {
    storage.setItem(saveFailureKey(projectId, session), JSON.stringify({ v: 1, at }));
    return true;
  } catch {
    return false;
  }
}

/** Read the marker that the last local save of this draft failed. */
export function readSaveFailure(storage: StorageLike | null, projectId: string, session: string): SaveFailureRead {
  if (storage === null || !keyPart(projectId) || !keyPart(session)) return { status: 'unavailable' };
  try {
    const raw = storage.getItem(saveFailureKey(projectId, session));
    if (raw === null || raw === '') return { status: 'none' };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !count(parsed.at)) return { status: 'present', at: 0 };
    return { status: 'present', at: parsed.at };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Clear the save-failure marker after a successful save or an explicit clear. */
export function clearSaveFailure(storage: StorageLike | null, projectId: string, session: string): void {
  if (storage === null || !keyPart(projectId) || !keyPart(session)) return;
  try {
    storage.removeItem(saveFailureKey(projectId, session));
  } catch {
    // A marker that cannot be removed is read again on the next load and stays honest.
  }
}

/** The session the owner was last reading in one project, so a reload returns to its draft. */
export function readSelectedSession(storage: StorageLike | null, projectId: string): SelectedSessionRead {
  if (storage === null || !keyPart(projectId)) return { status: 'unavailable' };
  try {
    const value = storage.getItem(SELECTED_SESSION_PREFIX + projectId);
    if (value === null || value === '') return { status: 'none' };
    if (!keyPart(value) || value === ROOT_SESSION) return { status: 'none' };
    return { status: 'selected', sessionId: value };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Remember, or forget with `null`, the session to return to for one project. */
export function writeSelectedSession(storage: StorageLike | null, projectId: string, sessionId: string | null): boolean {
  if (storage === null || !keyPart(projectId)) return false;
  try {
    if (sessionId === null || sessionId === '') {
      storage.removeItem(SELECTED_SESSION_PREFIX + projectId);
      return true;
    }
    if (!keyPart(sessionId) || sessionId === ROOT_SESSION) return false;
    storage.setItem(SELECTED_SESSION_PREFIX + projectId, sessionId);
    return true;
  } catch {
    return false;
  }
}
