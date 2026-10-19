import { chmod,mkdir,open,readFile,readdir,stat } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import type { Project } from '../shared/model';
import { assertAssetPath,assertEditableDocPath,assetIsSandboxed,assetType,docKind,headings,isBrowsableDocPath,isMarkdownPath,openQuestions,type DocEntry,type DocSnapshot } from '../shared/docs';
import { atomicWrite,hash,HttpError } from './board-store';
import { safePath } from './paths';

const limits = { listLimit: 5000, readLimit: 2 * 1024 * 1024, writeLimit: 2 * 1024 * 1024, assetLimit: 8 * 1024 * 1024, searchMatches: 200, searchBytes: 8 * 1024 * 1024, inboxQuestions: 200 };
const createdMode = 0o644;
const createdFolderMode = 0o755;

/**
 * Reads and writes any Markdown in a registered project.
 *
 * Reuses the board store's durability rules — containment, atomic writes and
 * revision checks — so a second writer loses nothing: it gets a conflict and
 * keeps its draft. Nothing here is canonical except the file in the repository.
 *
 * Creating a document may create its missing folders, because adding a page in a
 * new folder is ordinary documentation work. Existing parts are still validated
 * by containment checks, so a symlinked folder is refused rather than followed.
 */
export class DocStore {
  private tails = new Map<string, Promise<unknown>>();
  private readonly bounds: typeof limits;
  constructor(overrides: Partial<typeof limits> = {}) { this.bounds = { ...limits, ...overrides }; }
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
  private async body(project: Project, path: string): Promise<string> {
    const file = await safePath(project.path, path);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Document not found'); throw e; }
    if (Buffer.byteLength(text) > this.bounds.readLimit) throw new HttpError(413, 'Document exceeds the size limit');
    return text;
  }
  private snapshot(path: string, text: string): DocSnapshot {
    return { path, kind: docKind(path, text), revision: hash(text), text, headings: headings(text), questions: openQuestions(text) };
  }
  /** Every browsable document, relative to the project. Symlinks are never followed. */
  async list(project: Project): Promise<DocEntry[]> {
    const root = await this.root(project), found: string[] = [];
    const walk = async (relative: string) => {
      if (found.length >= this.bounds.listLimit) return;
      const entries = await readdir(relative === '' ? root : join(root, relative), { withFileTypes: true });
      for (const entry of entries) {
        if (found.length >= this.bounds.listLimit) return;
        if (entry.isSymbolicLink()) continue;
        const child = relative === '' ? entry.name : relative + '/' + entry.name;
        if (entry.isDirectory()) { if (!isBrowsableDocPath(child + '/placeholder.md')) continue; await walk(child); }
        else if (entry.isFile() && isMarkdownPath(child) && isBrowsableDocPath(child)) found.push(child);
      }
    };
    await walk('');
    const listed: DocEntry[] = [];
    for (const path of found.sort()) {
      const info = await stat(join(root, path));
      listed.push({ path, name: path.split('/').pop() ?? path, kind: docKind(path), bytes: info.size, modified: info.mtime.toISOString() });
    }
    return listed;
  }
  async read(project: Project, value: string): Promise<DocSnapshot> {
    const path = assertEditableDocPath(value);
    return this.snapshot(path, await this.body(project, path));
  }
  async create(project: Project, value: string, text: string): Promise<DocSnapshot> {
    const path = assertEditableDocPath(value);
    if (typeof text !== 'string') throw new HttpError(422, 'Document body must be text');
    if (Buffer.byteLength(text) > this.bounds.writeLimit) throw new HttpError(413, 'Document exceeds the size limit');
    await this.root(project);
    return this.serial(project.id + ':' + path, async () => {
      const file = await safePath(project.path, path);
      try { await mkdir(dirname(file), { recursive: true, mode: createdFolderMode }); }
      catch { throw new HttpError(422, 'Parent folder cannot be created'); }
      let handle;
      try { handle = await open(file, 'wx', createdMode); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new HttpError(409, 'Document already exists');
        if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(422, 'Parent folder cannot be created');
        throw e;
      }
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      return this.snapshot(path, text);
    });
  }
  async write(project: Project, value: string, revision: string, text: string): Promise<DocSnapshot> {
    const path = assertEditableDocPath(value);
    if (typeof text !== 'string') throw new HttpError(422, 'Document body must be text');
    if (Buffer.byteLength(text) > this.bounds.writeLimit) throw new HttpError(413, 'Document exceeds the size limit');
    if (typeof revision !== 'string' || revision === '') throw new HttpError(422, 'The revision you edited from is required');
    return this.serial(project.id + ':' + path, async () => {
      const current = await this.body(project, path);
      if (hash(current) !== revision) throw new HttpError(409, 'Document changed on disk or in another tab. Reload and review; your draft is retained.');
      const file = await safePath(project.path, path);
      const mode = (await stat(file)).mode & 0o777;
      // The shared atomic write uses owner-only permissions for private data; repository
      // files keep the mode they already had.
      if (hash(await readFile(file, 'utf8')) !== revision) throw new HttpError(409, 'External edit detected before commit');
      await atomicWrite(file, text);
      if (mode !== 0o600) await chmod(file, mode);
      return this.snapshot(path, text);
    });
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
      try { text = await this.body(project, document.path); } catch { continue; }
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
      try { text = await this.body(project, document.path); } catch { continue; }
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
    const file = await safePath(project.path, path);
    let info; try { info = await stat(file); } catch { throw new HttpError(404, 'Asset not found'); }
    if (!info.isFile()) throw new HttpError(404, 'Asset not found');
    if (info.size > this.bounds.assetLimit) throw new HttpError(413, 'Asset exceeds the size limit');
    const type = assetType(path);
    if (type === null) throw new HttpError(415, 'Unsupported asset type');
    return { bytes: await readFile(file), type, sandboxed: assetIsSandboxed(path) };
  }
}
