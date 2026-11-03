import { lstat,mkdir,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Project } from '../shared/model';
import { HttpError } from './board-store';
import { safePath } from './paths';

/**
 * Files the owner attaches to a message, and pasted text too long for a message.
 *
 * Pi's message content carries text and images only, so an arbitrary file cannot reach a model the
 * way an image does. What this does instead is the honest version of "attach a document": the file
 * is written **into the project's connected worktree**, and the message names the path, so an agent
 * that holds `file_read` opens it and reads it — with the same containment as any other read.
 *
 * The consequences, stated where the owner makes the decision rather than discovered later:
 *
 * - The file lands in the worktree as an **uncommitted change**. Nothing commits or pushes it: it
 *   appears in Workspace → Changes like any other edit, and the owner decides what happens to it.
 * - A project without a connected repository has no worktree, so it has no attachment storage, and
 *   the refusal says so instead of writing somewhere unexpected.
 * - Names are replaced with a generated one and the original name kept inside it, so a name cannot
 *   choose a path. The size is capped before a byte is written.
 * - Attachment bytes are the owner's own; the server does not inspect, transform or execute them.
 */
export const ATTACHMENT_DIRECTORY = 'docs/uploads';
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** One stored attachment, as the interface reports it: a path inside the worktree and its size. */
export interface StoredAttachment {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

/** The path a message names. Kept here so the server and the tests state it identically. */
export function attachmentLine(paths: readonly string[]): string {
  return 'Attached files, saved into this project\u2019s repository worktree (read them from there): ' + paths.join(', ');
}

/** A file name that cannot choose a directory, cannot be empty and cannot be absurdly long. */
export function safeAttachmentName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-120);
  return cleaned === '' ? 'attachment' : cleaned;
}

/** Whether a stored name is one this store could have written: the check a later read repeats. */
export function isAttachmentPath(path: string): boolean {
  return /^docs\/uploads\/[a-f0-9-]{36}-[A-Za-z0-9._-]{1,120}$/.test(path);
}

export class AttachmentStore {
  constructor(private worktree: (projectId: string) => string | undefined) {}

  /**
   * Write one attachment into the worktree, exclusively, and report its path. A project with no
   * connected worktree, an empty body or an oversize body is refused before anything is written.
   */
  async store(project: Project, name: unknown, bytes: Uint8Array): Promise<StoredAttachment> {
    const root = this.worktree(project.id);
    if (root === undefined) throw new HttpError(409, 'Attachments need a connected repository worktree. Connect the repository first, then attach the file.');
    if (bytes.byteLength === 0) throw new HttpError(422, 'The file is empty, so nothing was stored.');
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new HttpError(413, 'The file is ' + bytes.byteLength + ' bytes. The limit for one attachment is ' + ATTACHMENT_MAX_BYTES + ' bytes.');
    const directory = join(ATTACHMENT_DIRECTORY, 'x');
    const folder = await safePath(root, directory, true);
    await mkdir(join(folder, '..'), { recursive: true, mode: 0o700 });
    const name_ = safeAttachmentName(name);
    const relative = ATTACHMENT_DIRECTORY + '/' + randomUUID() + '-' + name_;
    const file = await safePath(root, relative, true);
    // Exclusive creation: an existing path (including a symlink) is refused rather than followed.
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(500, 'The attachment was not stored as a regular file.');
    return Object.freeze({ path: relative, name: name_, bytes: info.size });
  }
}
