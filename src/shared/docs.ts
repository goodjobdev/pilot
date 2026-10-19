export const markdownExtensions = ['.md', '.mdx'] as const;

/** Sections and directories whose contents are derived, vendored or app-managed. */
const generatedSegments = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor', 'venv',
  '.git', '.astro', '.svelte-kit', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  'test-results', 'playwright-report', '.runway', '.kilo', '.pi-web', 'tmp'
]);

/** Paths the dashboard owns. They are edited through validated board operations, not as documents. */
const lockedPrefixes = ['docs/dashboard/board.md', 'docs/dashboard/sources/'];

export type DocKind = 'spec' | 'decision' | 'question' | 'visual' | 'guide' | 'note';

/** Read-only asset types documentation may reference. Nothing executable is served. */
export const assetTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8'
};
export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
export function assetType(path: string): string | null {
  return assetTypes[extensionOf(path)] ?? null;
}
/** Static HTML and SVG mockups are always framed without scripts or same-origin access. */
export function assetIsSandboxed(path: string): boolean {
  const ext = extensionOf(path);
  return ext === '.html' || ext === '.htm' || ext === '.svg';
}
export function assertAssetPath(value: string): string {
  const path = normalizeDocPath(value);
  if (assetType(path) === null) throw new Error('Only documentation images or static HTML mockups can be served');
  if (inGeneratedFolder(path)) throw new Error('Generated or dependency folders are not served');
  if (isLockedDocPath(path)) throw new Error('This path is managed by the dashboard');
  return path;
}

export interface DocRef { path: string; anchor: string | null }
export interface DocHeading { level: number; title: string; slug: string; line: number }
export interface DocEntry { path: string; name: string; kind: DocKind; bytes: number; modified: string }
export interface OpenQuestion { id: string; text: string; done: boolean; line: number; anchor: string | null; heading: string }
export interface DocSnapshot { path: string; kind: DocKind; revision: string; text: string; headings: DocHeading[]; questions: OpenQuestion[] }

/** Repository-relative Markdown path, or an error explaining why it is not one. */
export function normalizeDocPath(value: string): string {
  if (typeof value !== 'string') throw new Error('Document path must be text');
  const raw = value.trim().replace(/^\.\//, '');
  if (raw === '' || raw.includes('\0') || raw.includes('\\')) throw new Error('Use a repository-relative Markdown path');
  if (raw.startsWith('/')) throw new Error('Use a repository-relative Markdown path');
  const parts = raw.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw new Error('Unsafe document path');
  return parts.join('/');
}
export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return markdownExtensions.some(ext => lower.endsWith(ext));
}
function inGeneratedFolder(path: string): boolean {
  const dirs = path.split('/').slice(0, -1);
  return dirs.some(segment => generatedSegments.has(segment) || (segment.startsWith('.') && segment !== '.github'));
}
export function isLockedDocPath(path: string): boolean {
  return lockedPrefixes.some(prefix => path === prefix || path.startsWith(prefix));
}
/** Whether a document is listed and served: Markdown, not generated, not app-managed. */
export function isBrowsableDocPath(path: string): boolean {
  return isMarkdownPath(path) && !inGeneratedFolder(path) && !isLockedDocPath(path);
}
export function assertEditableDocPath(value: string): string {
  const path = normalizeDocPath(value);
  if (!isMarkdownPath(path)) throw new Error('Only Markdown documents can be read or edited');
  if (inGeneratedFolder(path)) throw new Error('Generated or dependency folders are not editable');
  if (isLockedDocPath(path)) throw new Error('This document is managed by the dashboard; edit it through the board view');
  return path;
}
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~\[\]()#!>]/g, '')
    .replace(/[^a-z0-9\u00c0-\uffff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
function fencedLines(text: string): boolean[] {
  const lines = text.split('\n'), flags: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (marker) { fence = marker[1][0]; flags.push(true); continue; }
      flags.push(false);
    } else {
      flags.push(true);
      if (marker && marker[1][0] === fence) fence = null;
    }
  }
  return flags;
}
export function headings(text: string): DocHeading[] {
  const lines = text.split('\n'), inside = fencedLines(text), out: DocHeading[] = [];
  lines.forEach((line, index) => {
    if (inside[index]) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;
    const title = match[2].replace(/`/g, '').trim();
    out.push({ level: match[1].length, title, slug: slug(title), line: index + 1 });
  });
  return out;
}
/** Section boundaries for a heading, ending at the next heading of the same or higher level. */
function sectionEnd(all: DocHeading[], start: DocHeading): number {
  const next = all.find(h => h.line > start.line && h.level <= start.level);
  return next ? next.line - 1 : Number.POSITIVE_INFINITY;
}
function uniqueId(base: string, taken: Set<string>): string {
  const seed = base === '' ? 'item' : base;
  let id = seed, n = 1;
  while (taken.has(id)) { n += 1; id = seed + '-' + n; }
  taken.add(id);
  return id;
}
export function openQuestions(text: string): OpenQuestion[] {
  const all = headings(text), lines = text.split('\n'), inside = fencedLines(text), out: OpenQuestion[] = [], taken = new Set<string>();
  for (const start of all) {
    if (!/open questions?|needs me|blockers?|unknowns?/i.test(start.title)) continue;
    const end = sectionEnd(all, start);
    for (let i = start.line; i < end && i < lines.length; i++) {
      if (inside[i]) continue;
      const match = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+?)\s*$/.exec(lines[i]);
      if (!match) continue;
      const body = match[2].trim();
      out.push({ id: uniqueId(slug(body).slice(0, 60), taken), text: body, done: match[1].toLowerCase() === 'x', line: i + 1, anchor: start.slug, heading: start.title });
    }
  }
  return out;
}
export function docKind(path: string, text = ''): DocKind {
  const name = (path.split('/').pop() ?? '').replace(/\.mdx?$/i, '');
  const all = text === '' ? [] : headings(text);
  const hasHeading = (pattern: RegExp) => all.some(h => pattern.test(h.title));
  if (/^(readme|agents?|claude|contributing|guide|changelog)$/i.test(name)) return 'guide';
  if (/^adr[-_ ]?\d*/i.test(name) || /(^|\/)(adr|decisions?)([-_./]|$)/i.test(path) || hasHeading(/^decisions?$|^decision log$|^decisions made$/i)) return 'decision';
  if (hasHeading(/open questions?|needs me|blockers?/i)) return 'question';
  if (/spec|requirement|behaviou?r|acceptance|product|roadmap|vision/i.test(name)) return 'spec';
  if (text !== '' && (/```mermaid|~~~mermaid/.test(text) || /!\[[^\]]*\]\([^)]+\)/.test(text))) return 'visual';
  return 'note';
}
export function refFromText(value: string): DocRef {
  const [path, anchor] = value.split('#');
  return { path: normalizeDocPath(path), anchor: anchor ? slug(anchor) : null };
}
/** Inline `spec: <path>#<anchor>` references linking prose to the work item it specifies. */
export function specRefs(text: string): DocRef[] {
  const lines = text.split('\n'), inside = fencedLines(text), out: DocRef[] = [];
  lines.forEach((line, index) => {
    if (inside[index]) return;
    const match = /(?<!\S)spec:\s*([^\s`]+)/i.exec(line);
    if (match) out.push(refFromText(match[1]));
  });
  return out;
}
