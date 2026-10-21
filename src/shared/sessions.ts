import { z } from 'zod';
import { boundedJson } from './control-state';
import { isBrowsableDocPath, normalizeDocPath } from './docs';

/**
 * The named-session registry model: a durable, project-scoped session with a stable id, an
 * owner-visible name, created/updated timestamps, an optional **declared** model choice and links
 * to work items.
 *
 * This module is pure — no Node built-ins and no framework. It defines the record, the closed set
 * of link kinds, the exact fields each kind binds, and the strict, fail-closed validation all of it
 * goes through. The durable half (storage, resources, the revision rule, the legacy migration) is
 * `src/server/state/session-registry.ts`, and the operator-facing description is
 * `docs/SESSIONS.md`.
 *
 * Two deliberate limits:
 *
 * - The `model` field is a **declaration recorded with the session**, not an instruction applied to
 *   a live agent. Nothing here (and nothing in the registry) changes a running conversation's
 *   provider, model or thinking selection; applying a declared choice is a separate, explicit
 *   action outside this round.
 * - The registry is working state, not documentation. Markdown in the project stays canonical, so
 *   losing the registry costs convenience, never a planning fact.
 */

export const SESSION_RECORD_VERSION = 1 as const;
/** One control-store payload cap applies to the record: it is stored as bounded JSON. */
export const SESSION_MAX_RECORD_BYTES = 64 * 1024;
/** The documented name rule: 1-80 characters, first character alphanumeric. */
export const SESSION_NAME_MIN_LENGTH = 1;
export const SESSION_NAME_MAX_LENGTH = 80;
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,79}$/;
/** The documented id rule, shared with the control store's own record identifier rule. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const SESSION_PATH_MAX_LENGTH = 1000;
export const SESSION_DOCUMENT_PATH_MAX_LENGTH = 400;
export const SESSION_LINK_KINDS = ['task', 'document', 'workspace'] as const;
export const SESSION_MAX_LINKS = 32;

export type SessionLinkKind = (typeof SESSION_LINK_KINDS)[number];
/** A work item on the project's board. The id is the board's own task id. */
export type SessionTaskLink = { readonly kind: 'task'; readonly taskId: string };
/** A documentation path, optionally anchored: a path reference or a spec reference to one heading. */
export type SessionDocumentLink = { readonly kind: 'document'; readonly path: string; readonly anchor: string | null };
/** A workspace directory, stored as its canonical absolute path inside the approved roots. */
export type SessionWorkspaceLink = { readonly kind: 'workspace'; readonly path: string };
export type SessionLink = SessionTaskLink | SessionDocumentLink | SessionWorkspaceLink;

export type SessionModelChoice = { readonly provider: string; readonly modelId: string };

/** The stored record. `revision` is the optimistic-concurrency token a rename/link/unlink sends back. */
export type SessionRecord = {
  readonly version: 1;
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly revision: number;
  readonly model: SessionModelChoice | null;
  readonly links: readonly SessionLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Failed-closed reasons. Each refusal carries one of these codes and a precise message. */
export type SessionErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'OUTSIDE_ROOTS'
  | 'DUPLICATE_NAME'
  | 'CONFLICT'
  | 'CORRUPT'
  | 'STORAGE';
export class SessionError extends Error {
  constructor(message: string, public readonly code: SessionErrorCode) {
    super(message);
    this.name = 'SessionError';
  }
}

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const anchorPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const opaquePattern = /^[^\s\u0000-\u001f\u007f]+$/;
const textPattern = /^[^\u0000-\u001f\u007f]+$/;
const absolutePathPattern = /^\/[^\u0000-\u001f\u007f]*$/;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid value';
  const path = issue.path.length ? issue.path.map(String).join('.') + ': ' : '';
  return path + issue.message;
}
/** Strict parsing: a ZodError becomes a precise, typed refusal rather than a stack trace. */
function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string, code: SessionErrorCode = 'INVALID'): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new SessionError(label + ' is invalid: ' + firstIssue(error), code);
    throw error;
  }
}

/**
 * The link shapes. A request's document path is deliberately accepted loosely here — an absolute
 * path, a `..` segment or a non-Markdown path must be refused by the resource that owns it, as
 * `outside the approved roots`, rather than as a malformed request.
 */
const linkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task'), taskId: z.string().regex(uuidPattern, 'a task id must be a UUID') }),
  z.strictObject({
    kind: z.literal('document'),
    path: z.string().min(1).max(SESSION_DOCUMENT_PATH_MAX_LENGTH).regex(textPattern, 'a document path must be printable text'),
    anchor: z.string().regex(anchorPattern, 'an anchor must be 1-120 characters from a-z0-9-').nullable()
  }),
  z.strictObject({
    kind: z.literal('workspace'),
    path: z.string().min(1).max(SESSION_PATH_MAX_LENGTH).regex(absolutePathPattern, 'a workspace path must be an absolute path')
  })
]);
const modelSchema = z.strictObject({
  provider: z.string().min(1).max(100).regex(opaquePattern, 'a provider id must be printable text'),
  modelId: z.string().min(1).max(200).regex(opaquePattern, 'a model id must be printable text')
});
const recordSchema = z.strictObject({
  version: z.literal(SESSION_RECORD_VERSION),
  id: z.string().regex(SESSION_ID_PATTERN, 'a session id must be 1-160 characters from A-Za-z0-9._:-'),
  projectId: z.string().regex(SESSION_ID_PATTERN, 'a project id must be 1-160 characters from A-Za-z0-9._:-'),
  name: z.string().regex(SESSION_NAME_PATTERN, 'a name must be 1-80 characters, start alphanumeric, and use only letters, digits, space, . _ : -'),
  revision: z.number().int().positive(),
  model: modelSchema.nullable(),
  links: z.array(linkSchema).max(SESSION_MAX_LINKS),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export function parseSessionIdentifier(value: unknown, label: string): string {
  return parseStrict(z.string().regex(SESSION_ID_PATTERN, label + ' must be 1-160 characters from A-Za-z0-9._:-'), value, label);
}
/** The documented name rule. A name outside the length or charset fails closed with this reason. */
export function parseSessionName(value: unknown, label = 'name'): string {
  return parseStrict(
    z.string().regex(SESSION_NAME_PATTERN, label + ' must be ' + SESSION_NAME_MIN_LENGTH + '-' + SESSION_NAME_MAX_LENGTH + ' characters, start with a letter or digit, and use only letters, digits, space, . _ : -'),
    value,
    label
  );
}
/** The declared model choice: a provider/model pair, or null for "no choice declared". */
export function parseSessionModel(value: unknown, label = 'model'): SessionModelChoice | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStrict(modelSchema, value, label + ' (requires provider and modelId)');
  return Object.freeze({ provider: parsed.provider, modelId: parsed.modelId }) as SessionModelChoice;
}

/** The canonical form of one link: what a link *is*, for identity, ordering and duplicate detection. */
export function sessionLinkKey(link: SessionLink): string {
  return JSON.stringify({ anchor: (link as SessionDocumentLink).anchor ?? null, kind: link.kind, path: (link as SessionDocumentLink).path ?? null, taskId: (link as SessionTaskLink).taskId ?? null });
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Parses one link strictly. Unknown fields, an unknown kind, a missing field for the kind and a
 * wrong type all fail closed, and the reason names the field.
 */
export function parseSessionLink(value: unknown, label = 'link'): SessionLink {
  const parsed = parseStrict(linkSchema as unknown as z.ZodType<SessionLink>, value, label);
  return Object.freeze(parsed) as SessionLink;
}

/**
 * Parses a list of links into its canonical form: each link strict, none repeated, and ordered by
 * link key. A request may supply them in any order; the stored record is always canonical, which is
 * what makes two runs over the same input produce the same registry state.
 */
export function parseSessionLinks(value: unknown, label = 'links'): readonly SessionLink[] {
  if (value === undefined) return Object.freeze([]) as readonly SessionLink[];
  const list = parseStrict(z.array(z.unknown()).max(SESSION_MAX_LINKS), value, label + ' (an array of at most ' + SESSION_MAX_LINKS + ' links)');
  const parsed: SessionLink[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const link = parseSessionLink(list[index], label + '[' + index + ']');
    const key = sessionLinkKey(link);
    if (seen.has(key)) throw new SessionError(label + ' repeats the same ' + link.kind + ' link', 'INVALID');
    seen.add(key);
    parsed.push(link);
  }
  return canonicalLinks(parsed);
}

/** Sorts links into the one canonical order. */
export function canonicalLinks(links: readonly SessionLink[]): readonly SessionLink[] {
  return Object.freeze([...links].sort((left, right) => sessionLinkKey(left).localeCompare(sessionLinkKey(right))));
}

/**
 * Validates a whole stored record: strict fields, a positive revision, an updated time no earlier
 * than the created time, links already in canonical order with no duplicates, and — for a document
 * link — a path the documentation store actually serves. A record read back from storage that does
 * not validate is corruption, never a record to interpret.
 */
export function validateSessionRecord(value: unknown, code: SessionErrorCode = 'INVALID'): SessionRecord {
  const parsed = parseStrict(recordSchema, value, 'session record (requires version, id, projectId, name, revision, model, links, createdAt, updatedAt)', code);
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)) throw new SessionError('A session record is updated before it was created', code);
  const keys = parsed.links.map((link) => sessionLinkKey(link as SessionLink));
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index - 1] >= keys[index]) throw new SessionError('Session record links are not in canonical order or repeat', code);
  }
  for (const link of parsed.links as SessionLink[]) {
    if (link.kind !== 'document') continue;
    let browsable = false;
    try { browsable = isBrowsableDocPath(normalizeDocPath(link.path)); } catch { browsable = false; }
    if (!browsable) throw new SessionError('A stored document link is not a browsable documentation path', code);
  }
  const record: SessionRecord = Object.freeze({
    version: SESSION_RECORD_VERSION,
    id: parsed.id,
    projectId: parsed.projectId,
    name: parsed.name,
    revision: parsed.revision,
    model: parsed.model === null ? null : parseSessionModel(parsed.model),
    links: canonicalLinks(parsed.links as SessionLink[]),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt
  });
  let encoded: string;
  try {
    encoded = boundedJson(record);
  } catch (error) {
    throw new SessionError('The session record is not bounded JSON data: ' + (error as Error).message, code);
  }
  if (byteLength(encoded) > SESSION_MAX_RECORD_BYTES) throw new SessionError('The session record exceeds ' + SESSION_MAX_RECORD_BYTES + ' bytes', code);
  return record;
}

/**
 * The deterministic name the legacy-conversation migration gives an adopted session: the project's
 * own name, reduced to the documented charset, plus a fixed suffix. Two runs over the same project
 * therefore compute the same name, and the result always satisfies the name rule.
 */
export function legacySessionName(projectName: unknown): string {
  const raw = typeof projectName === 'string' ? projectName : '';
  const cleaned = raw
    .replace(/[^A-Za-z0-9 ._:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 52)
    .trim()
    .replace(/[^A-Za-z0-9]+$/, '');
  return (cleaned === '' ? 'Project' : cleaned) + ' legacy conversation';
}
