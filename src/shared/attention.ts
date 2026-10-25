import type { ApprovalKind, ApprovalScope, ApprovalTarget } from './approvals';

/**
 * The attention surface: the four kinds of work that need a person, and nothing else.
 *
 * This module is pure — no Node, no framework and no store. It defines the closed kind set, the
 * severity order, the item shapes, the keyset cursor and the conservative list limits. The server
 * projection that fills these items from durable records is `src/server/state/attention.ts`, and the
 * routes are in `src/server/main.ts`.
 *
 * The four kinds are **question**, **approval**, **failure** and **interrupted**. There is no fifth
 * kind and no catch-all: a routine message, a finished run and a paused session are not attention.
 *
 * Ordering is deterministic and total: severity first (an interrupted run outranks a failure, a
 * failure outranks an approval, an approval outranks a question), then age (older first, so the
 * longest-waiting item is seen first), then the stable item id. The id tie-break is what makes a
 * page boundary reproducible when two items share a severity and an instant.
 *
 * An item whose source records no instant (a question whose transcript entry carries no `askedAt`)
 * has `at: null`. It is not given an epoch age: the interface says the age is unknown, and the item
 * sorts after every known instant, then by id. That keeps the order deterministic without inventing
 * a time.
 *
 * Limits are a **proposed** operator policy, not an accepted one: 20 items per page, and at most
 * 100 open items listed in one pass. `ATTENTION_LIMITS.policy` says so in every response. The exact
 * open count is always reported separately from the capped list, so "more than 100" is visible
 * rather than hidden.
 */

export const ATTENTION_KINDS = ['question', 'approval', 'failure', 'interrupted'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Lower is more severe. The order is fixed and is the first sort key. */
export const ATTENTION_SEVERITY: Readonly<Record<AttentionKind, number>> = Object.freeze({
  interrupted: 0,
  failure: 1,
  approval: 2,
  question: 3
});

/** The proposed page size, the proposed listed cap, and the fact that neither is accepted policy. */
export const ATTENTION_PAGE_LIMIT = 20;
export const ATTENTION_MAX_PAGE_LIMIT = 100;
export const ATTENTION_LIST_CAP = 100;
export const ATTENTION_LIMITS = Object.freeze({
  perPage: ATTENTION_PAGE_LIMIT,
  listedCap: ATTENTION_LIST_CAP,
  policy: 'proposed' as const
});

/** What a person can do with one item. Every entry names an explicit owner action, never a read. */
export const ATTENTION_ACTIONS = ['open', 'consume', 'revoke', 'retry', 'resume'] as const;
export type AttentionAction = (typeof ATTENTION_ACTIONS)[number];

export interface AttentionItemBase {
  /** Stable identity for sorting, cursors and a deep link. It is kind-prefixed and never numeric. */
  readonly id: string;
  readonly kind: AttentionKind;
  readonly severity: number;
  readonly projectId: string;
  /** The exact session the item belongs to, or null when the source names only a project. */
  readonly sessionId: string | null;
  /**
   * The ordering instant: the question's asked time, the approval's issue time, the lifecycle
   * activity. `null` means the source records no instant; it is unknown, not the epoch.
   */
  readonly at: string | null;
  /** One bounded line of context. It never carries a filesystem path or a secret. */
  readonly context: string;
  readonly actions: readonly AttentionAction[];
}

export interface AttentionQuestionItem extends AttentionItemBase {
  readonly kind: 'question';
  readonly questionId: string;
}

export interface AttentionApprovalItem extends AttentionItemBase {
  readonly kind: 'approval';
  readonly approvalId: string;
  readonly approvalKind: ApprovalKind;
  readonly scope: ApprovalScope;
  /** The exact target a consumption must match, field for field. It is displayed before any action. */
  readonly target: ApprovalTarget;
  readonly expiresAt: string;
}

export interface AttentionFailureItem extends AttentionItemBase {
  readonly kind: 'failure';
  readonly lifecycleRevision: number;
  readonly reason: string;
}

export interface AttentionInterruptedItem extends AttentionItemBase {
  readonly kind: 'interrupted';
  readonly lifecycleRevision: number;
  readonly reason: string;
  /** True when the generation's effect cannot be proven idempotent. Such an item offers no replay. */
  readonly uncertain: boolean;
}

export type AttentionItem =
  | AttentionQuestionItem
  | AttentionApprovalItem
  | AttentionFailureItem
  | AttentionInterruptedItem;

/** A keyset cursor: everything strictly after this (severity, instant, id) is the next page. */
export interface AttentionCursor {
  readonly v: 1;
  readonly severity: number;
  readonly at: string | null;
  readonly id: string;
}

export type AttentionByKind = Readonly<Record<AttentionKind, number>>;
export interface AttentionCounts {
  readonly open: number;
  readonly byKind: AttentionByKind;
  readonly capped: boolean;
  /**
   * True only when every source was read (or was legitimately empty). A partial count is not an
   * exact zero: a caller must show it as incomplete rather than as a badge with no work.
   */
  readonly complete: boolean;
}

export interface AttentionPage {
  readonly limit: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly listedCap: number;
  readonly capped: boolean;
}

/** A cursor this module cannot read is a refused request, not an empty page. */
export class AttentionCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttentionCursorError';
  }
}

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The total order over the three keys, usable for both items and a cursor. */
export function compareAttentionKeys(
  left: { readonly severity: number; readonly at: string | null; readonly id: string },
  right: { readonly severity: number; readonly at: string | null; readonly id: string }
): number {
  if (left.severity !== right.severity) return left.severity - right.severity;
  // An unknown instant is last: it cannot claim to be older than a recorded one, and the id still
  // makes the order total and reproducible.
  if (left.at === null && right.at !== null) return 1;
  if (left.at !== null && right.at === null) return -1;
  if (left.at !== null && right.at !== null && left.at !== right.at) return left.at < right.at ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  return compareAttentionKeys(left, right);
}

/** The one ordering every page, count and test uses. It does not mutate its input. */
export function sortAttentionItems(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort(compareAttentionItems);
}

/** The exact open count. It is computed from every item, never from a capped page. */
export function countAttentionItems(items: readonly AttentionItem[], complete = true): AttentionCounts {
  const byKind = { question: 0, approval: 0, failure: 0, interrupted: 0 };
  for (const item of items) byKind[item.kind] += 1;
  return Object.freeze({
    open: items.length,
    byKind: Object.freeze({ ...byKind }),
    capped: items.length > ATTENTION_LIST_CAP,
    complete
  });
}

/**
 * A short human age for one item. A missing instant is reported as unknown; it is never shown as
 * "1970" or as a very large age.
 */
export function attentionAgeLabel(at: string | null, now: number): string {
  if (at === null) return 'age unknown';
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return 'age unknown';
  const ms = Math.max(0, now - parsed);
  if (ms < 60_000) return 'under 1 min';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' min';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' h';
  return Math.floor(ms / 86_400_000) + ' d';
}

function base64Url(text: string): string {
  const encoded = btoa(text);
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new AttentionCursorError('The attention cursor is not readable');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return atob(padded);
  } catch {
    throw new AttentionCursorError('The attention cursor is not readable');
  }
}

export function encodeAttentionCursor(item: AttentionItem): string {
  const cursor: AttentionCursor = { v: 1, severity: item.severity, at: item.at, id: item.id };
  return base64Url(JSON.stringify(cursor));
}

export function decodeAttentionCursor(value: unknown): AttentionCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400)
    throw new AttentionCursorError('The attention cursor must be a non-empty string');
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64Url(value));
  } catch (error) {
    if (error instanceof AttentionCursorError) throw error;
    throw new AttentionCursorError('The attention cursor is not readable');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded))
    throw new AttentionCursorError('The attention cursor is not readable');
  const cursor = decoded as Record<string, unknown>;
  const keys = Object.keys(cursor);
  if (keys.length !== 4 || keys.some((key) => !['v', 'severity', 'at', 'id'].includes(key)))
    throw new AttentionCursorError('The attention cursor is not readable');
  if (cursor.v !== 1) throw new AttentionCursorError('The attention cursor version is not supported');
  if (typeof cursor.severity !== 'number' || !Number.isInteger(cursor.severity) || cursor.severity < 0 || cursor.severity > ATTENTION_KINDS.length)
    throw new AttentionCursorError('The attention cursor severity is not valid');
  if (cursor.at !== null && (typeof cursor.at !== 'string' || !instantPattern.test(cursor.at)))
    throw new AttentionCursorError('The attention cursor instant is not valid');
  if (typeof cursor.id !== 'string' || cursor.id.length === 0 || cursor.id.length > 200)
    throw new AttentionCursorError('The attention cursor id is not valid');
  return Object.freeze({ v: 1 as const, severity: cursor.severity, at: cursor.at, id: cursor.id });
}

/** A page size outside 1..100 is a refused request, not a clamp the caller cannot see. */
export function parseAttentionLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return ATTENTION_PAGE_LIMIT;
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new AttentionCursorError('The attention limit must be a whole number from 1 to ' + ATTENTION_MAX_PAGE_LIMIT);
  const limit = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > ATTENTION_MAX_PAGE_LIMIT)
    throw new AttentionCursorError('The attention limit must be a whole number from 1 to ' + ATTENTION_MAX_PAGE_LIMIT);
  return limit;
}

/**
 * One page of the capped, sorted list.
 *
 * The cap is on everything listed in one pass, not on one response: once 100 items have been
 * listed, `hasMore` is false even when the exact count is larger. A cursor keeps its own position
 * even when the item that produced it has since been resolved, because the comparison is a keyset
 * (severity, instant, id) and not an index into a snapshot.
 */
export function pageAttentionItems(
  items: readonly AttentionItem[],
  options: { readonly cursor?: AttentionCursor | null; readonly limit?: number; readonly openCount?: number } = {}
): { readonly items: readonly AttentionItem[]; readonly page: AttentionPage } {
  const limit = options.limit ?? ATTENTION_PAGE_LIMIT;
  const sorted = sortAttentionItems(items);
  const listed = sorted.slice(0, ATTENTION_LIST_CAP);
  const cursor = options.cursor ?? null;
  const start = cursor === null
    ? 0
    : listed.findIndex((item) => compareAttentionKeys(item, cursor) > 0);
  const from = start === -1 ? listed.length : start;
  const pageItems = listed.slice(from, from + limit);
  const hasMore = from + pageItems.length < listed.length;
  const openCount = options.openCount ?? items.length;
  return Object.freeze({
    items: Object.freeze(pageItems),
    page: Object.freeze({
      limit,
      returned: pageItems.length,
      hasMore,
      nextCursor: hasMore && pageItems.length > 0 ? encodeAttentionCursor(pageItems[pageItems.length - 1] as AttentionItem) : null,
      listedCap: ATTENTION_LIST_CAP,
      capped: openCount > ATTENTION_LIST_CAP
    })
  });
}

/** The stable id of one item. A kind prefix keeps ids unique across sources. */
export function attentionItemId(kind: AttentionKind, identity: string): string {
  return kind + ':' + identity;
}
