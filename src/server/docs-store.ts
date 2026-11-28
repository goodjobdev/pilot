import { constants } from 'node:fs';
import { chmod,open,readdir,stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../shared/model';
import { assertAssetPath,assertEditableDocPath,assetIsSandboxed,assetType,docKind,headings,isBrowsableDocPath,isMarkdownPath,openQuestions,type DocEntry,type DocSnapshot } from '../shared/docs';
import { BoardStore,atomicWrite,hash,HttpError } from './board-store';
import type { WorkspaceStore } from './workspace';
import { PLAN_PATH } from '../shared/workspace';
import { safePath } from './paths';
import { LinuxProcfsCreateError, createLinuxProcfsFileBeneath } from './linux-procfs-create';
import { LinuxProcfsReadError, readLinuxProcfsRegularFileBeneath } from './linux-procfs-read';
import { LinuxProcfsListError, listLinuxProcfsRegularFilesBeneath, type LinuxProcfsListEntry } from './linux-procfs-list';

const limits = { listLimit: 5000, readLimit: 2 * 1024 * 1024, writeLimit: 2 * 1024 * 1024, assetLimit: 8 * 1024 * 1024, searchMatches: 200, searchBytes: 8 * 1024 * 1024, inboxQuestions: 200 };
const createdMode = 0o644;
const createdFolderMode = 0o755;

/**
 * Read at most limit + 1 bytes into one buffer sized from the initially validated file size.
 * The descriptor remains pinned throughout the read; a later size change fails closed.
 * O_NOFOLLOW protects only the final component: Node exposes no portable openat-style
 * descriptor-relative traversal, so a hostile concurrent parent-directory replacement remains
 * outside this check. Size/mtime/ctime changes during the read fail closed; same-size mutation
 * that restores timestamps cannot be detected by these filesystem APIs.
 */
export async function readBoundedRegularFile(
  path: string,
  limit: number,
  opener: typeof open = open,
  capabilities: () => { readOnly: number; noFollow?: number; nonBlock?: number } = () => ({
    readOnly: constants.O_RDONLY,
    noFollow: constants.O_NOFOLLOW,
    nonBlock: constants.O_NONBLOCK
  })
): Promise<Buffer> {
  const { readOnly, noFollow, nonBlock } = capabilities();
  if (!Number.isSafeInteger(limit) || limit < 0 || typeof noFollow !== 'number' || noFollow <= 0 || typeof nonBlock !== 'number' || nonBlock <= 0)
    throw new Error('Safe bounded file reads are unsupported on this platform');
  const handle = await opener(path, readOnly | noFollow | nonBlock);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new HttpError(404, 'File not found');
    if (before.size > limit) throw new HttpError(413, 'File exceeds the size limit');
    const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat();
    if (total > limit) throw new HttpError(413, 'File exceeds the size limit');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size)
      throw new HttpError(409, 'File changed while it was being read');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

/**
 * Reads and writes any Markdown in a registered project.
 *
 * Revision checks detect ordinary stale edits, but are not a filesystem CAS:
 * an external writer can change a path between the last check and replacement.
 * The repository file remains canonical. Listing, ordinary body reads, and
 * exclusive creation use Linux descriptor-relative backends. Writes, board
 * operations, and later history operations remain pathname-based. None of these
 * operations establishes root identity or isolation from same-UID mutation.
 *
 * Creating a document may create missing folders. A pinned directory can be
 * renamed, and failures after exclusive creation can leave an uncertain file.
 */
export class DocStore {
  private tails = new Map<string, Promise<unknown>>();
  private readonly bounds: typeof limits;
  constructor(
    overrides: Partial<typeof limits> = {},
    private integrations?: { boards: BoardStore; workspace: WorkspaceStore },
    private readOpen: typeof open = open,
    private readBeneath: typeof readLinuxProcfsRegularFileBeneath = readLinuxProcfsRegularFileBeneath,
    private createBeneath: typeof createLinuxProcfsFileBeneath = createLinuxProcfsFileBeneath
  ) { this.bounds = { ...limits, ...overrides }; }
  private save<T extends object>(project:Project,path:string,write:()=>Promise<T>){return this.integrations?this.integrations.workspace.save(project,[path],write):write();}
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.tails.set(key, current);
    try { return await current; } finally { if (this.tails.get(key) === current) this.tails.delete(key); }
  }
  async drain() { await Promise.allSettled([...this.tails.values()]); }
  private async root(project: Project): Promise<string> {
    let info; try { info = await stat(project.path); } catch { throw new HttpError(404, 'Project folder is unavailable'); }
    if (!info.isDirectory()) throw new HttpError(422, 'Project folder is not a directory');
    return project.path;
  }
  private mapReadFailure(error: unknown, subject: 'Document' | 'Asset'): never {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ELOOP' ||
        (error as NodeJS.ErrnoException)?.code === 'ENOTDIR' ||
        (error instanceof LinuxProcfsReadError && error.code === 'NOT_REGULAR')) throw new HttpError(404, `${subject} not found`);
    if (error instanceof LinuxProcfsReadError && error.code === 'BACKEND_UNAVAILABLE') throw new HttpError(503, 'Documentation reader is unavailable', 'DOC_READER_UNAVAILABLE');
    if (error instanceof LinuxProcfsReadError && error.code === 'OVERSIZE') throw new HttpError(413, `${subject} exceeds the size limit`);
    if (error instanceof LinuxProcfsReadError && error.code === 'CHANGED') throw new HttpError(409, `${subject} changed while it was being read`);
    throw error;
  }
  private async body(project: Project, path: string): Promise<string> {
    let bytes: Buffer;
    try { bytes = await this.readBeneath(project.path, path, this.bounds.readLimit); }
    catch (error) { this.mapReadFailure(error, 'Document'); }
    return bytes!.toString('utf8');
  }
  private snapshot(path: string, text: string): DocSnapshot {
    return { path, kind: docKind(path, text), revision: hash(text), text, headings: headings(text), questions: openQuestions(text) };
  }
  /** Keep the procfs backend as the only listing path; tests may subclass this boundary. */
  protected listBeneath(root: string, limit: number, include: (path: string) => boolean): Promise<LinuxProcfsListEntry[]> {
    return listLinuxProcfsRegularFilesBeneath(root, limit, include);
  }
  /** Every browsable document, relative to the project. Symlinks are never followed. */
  async list(project: Project): Promise<DocEntry[]> {
    const root = await this.root(project);
    let found: LinuxProcfsListEntry[];
    try {
      found = await this.listBeneath(root, this.bounds.listLimit, path =>
        path.endsWith('/placeholder.md')
          ? isBrowsableDocPath(path)
          : isMarkdownPath(path) && (isBrowsableDocPath(path) || Boolean(this.integrations && path === PLAN_PATH))
      );
    } catch (error) {
      if (error instanceof LinuxProcfsListError && error.code === 'BACKEND_UNAVAILABLE') {
        throw new HttpError(503, 'Documentation listing is unavailable', 'DOC_LIST_UNAVAILABLE');
      }
      if (error instanceof LinuxProcfsListError && error.code === 'WORK_LIMIT') {
        throw new HttpError(503, 'Documentation listing exceeded its safe traversal budget', 'DOC_LIST_LIMIT');
      }
      throw error;
    }
    return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, size, mtime }) => ({
      path, name: path.split('/').pop() ?? path, kind: docKind(path), bytes: size, modified: mtime.toISOString()
    }));
  }
  async read(project: Project, value: string): Promise<DocSnapshot> {
    if(value===PLAN_PATH&&this.integrations){const text=await this.integrations.boards.raw(project);if(Buffer.byteLength(text)>this.bounds.readLimit)throw new HttpError(413,'Plan exceeds the document preview limit');return this.snapshot(PLAN_PATH,text);}
    const path = assertEditableDocPath(value);
    return this.snapshot(path, await this.body(project, path));
  }
  async create(project: Project, value: string, text: string): Promise<DocSnapshot> {
    const path = assertEditableDocPath(value);
    if (typeof text !== 'string') throw new HttpError(422, 'Document body must be text');
    if (Buffer.byteLength(text) > this.bounds.writeLimit) throw new HttpError(413, 'Document exceeds the size limit');
    await this.root(project);
    return this.serial(project.id + ':' + path, () => this.save(project,path,async () => {
      let handle;
      try { handle = await this.createBeneath(project.path, path, createdMode, createdFolderMode); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new HttpError(409, 'Document already exists');
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || error instanceof LinuxProcfsCreateError && error.code === 'INVALID_PARENT')
          throw new HttpError(422, 'Parent folder cannot be created');
        if (error instanceof LinuxProcfsCreateError && error.code === 'BACKEND_UNAVAILABLE')
          throw new HttpError(503, 'Documentation creation is unavailable', 'DOC_CREATE_UNAVAILABLE');
        if (error instanceof LinuxProcfsCreateError && error.code === 'CREATE_UNCERTAIN') {
          const uncertain = new HttpError(503, 'The created file may be empty or partially written and may be elsewhere if the filesystem changed. Do not retry automatically. Inspect the project files and filesystem state, locate and reconcile the created file manually, and retry only after review.', 'DOC_CREATE_UNCERTAIN');
          Object.defineProperty(uncertain, 'cause', { value: error.cause });
          throw uncertain;
        }
        throw error;
      }
      let writeError: unknown;
      try { await handle.writeFile(text); await handle.sync(); }
      catch (error) { writeError = error; }
      try { await handle.close(); }
      catch (error) { writeError = writeError === undefined ? error : new AggregateError([writeError, error]); }
      if (writeError !== undefined) {
        const uncertain = new HttpError(503, 'The created file may be empty or partially written and may be elsewhere if the filesystem changed. Do not retry automatically. Inspect the project files and filesystem state, locate and reconcile the created file manually, and retry only after review.', 'DOC_CREATE_UNCERTAIN');
        Object.defineProperty(uncertain, 'cause', { value: writeError });
        throw uncertain;
      }
      return this.snapshot(path, text);
    }));
  }
  async write(project: Project, value: string, revision: string, text: string): Promise<DocSnapshot> {
    if(value===PLAN_PATH&&this.integrations){
      if(typeof text!=='string'||typeof revision!=='string'||!revision)throw new HttpError(422,'Text and the revision you edited are required');
      const saved=await this.integrations.boards.writeDocument(project,revision,text);return {...this.snapshot(PLAN_PATH,text),commit:saved.commit};
    }
    const path = assertEditableDocPath(value);
    if (typeof text !== 'string') throw new HttpError(422, 'Document body must be text');
    if (Buffer.byteLength(text) > this.bounds.writeLimit) throw new HttpError(413, 'Document exceeds the size limit');
    if (typeof revision !== 'string' || revision === '') throw new HttpError(422, 'The revision you edited from is required');
    return this.serial(project.id + ':' + path, () => this.save(project,path,async () => {
      const current = await this.body(project, path);
      if (hash(current) !== revision) throw new HttpError(409, 'Document changed on disk or in another tab. Reload and review; your draft is retained.');
      const file = await safePath(project.path, path);
      const mode = (await stat(file)).mode & 0o777;
      // The shared atomic write uses owner-only permissions for private data; repository
      // files keep the mode they already had.
      const verified = await readBoundedRegularFile(file, this.bounds.readLimit, this.readOpen);
      if (hash(verified.toString('utf8')) !== revision) throw new HttpError(409, 'External edit detected before commit');
      await atomicWrite(file, text);
      if (mode !== 0o600) await chmod(file, mode);
      return this.snapshot(path, text);
    }));
  }
  /** Content search across browsable documents, bounded by bytes scanned and matches returned. */
  async search(project: Project, query: string): Promise<{ path: string; line: number; text: string }[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) throw new HttpError(400, 'Enter at least two characters to search');
    await this.root(project);
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    for (const document of await this.list(project)) {
      if (matches.length >= this.bounds.searchMatches || scanned >= this.bounds.searchBytes) break;
      let text: string;
      try { text = await this.body(project, document.path); }
      catch (error) {
        if (error instanceof HttpError && error.code === 'DOC_READER_UNAVAILABLE') throw error;
        continue;
      }
      scanned += Buffer.byteLength(text);
      const lines = text.split('\n');
      for (let index = 0; index < lines.length && matches.length < this.bounds.searchMatches; index++) {
        if (lines[index].toLowerCase().includes(needle)) matches.push({ path: document.path, line: index + 1, text: lines[index].trim().slice(0, 300) });
      }
    }
    return matches;
  }
  /** Open questions across the project's documentation — the "needs me" list. */
  async inbox(project: Project): Promise<{ path: string; line: number; text: string; anchor: string | null; id: string }[]> {
    await this.root(project);
    const questions: { path: string; line: number; text: string; anchor: string | null; id: string }[] = [];
    let scanned = 0;
    for (const document of await this.list(project)) {
      if (questions.length >= this.bounds.inboxQuestions || scanned >= this.bounds.searchBytes) break;
      let text: string;
      try { text = await this.body(project, document.path); }
      catch (error) {
        if (error instanceof HttpError && error.code === 'DOC_READER_UNAVAILABLE') throw error;
        continue;
      }
      scanned += Buffer.byteLength(text);
      for (const question of openQuestions(text)) {
        if (!question.done) questions.push({ path: document.path, line: question.line, text: question.text, anchor: question.anchor, id: question.id });
      }
    }
    return questions;
  }
  /** A documentation asset: contained, read-only and limited to images and static mockups. */
  async asset(project: Project, value: string): Promise<{ bytes: Buffer; type: string; sandboxed: boolean }> {
    const path = assertAssetPath(value);
    await this.root(project);
    const type = assetType(path);
    if (type === null) throw new HttpError(415, 'Unsupported asset type');
    let bytes: Buffer;
    try { bytes = await this.readBeneath(project.path, path, this.bounds.assetLimit); }
    catch (error) { this.mapReadFailure(error, 'Asset'); }
    return { bytes, type, sandboxed: assetIsSandboxed(path) };
  }
}
