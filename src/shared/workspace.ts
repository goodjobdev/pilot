export const PLAN_PATH = 'docs/dashboard/board.md';
export interface SaveCommit { status: 'committed' | 'unchanged' | 'unavailable' | 'failed' | 'uncertain'; hash?: string; message: string }
export interface WorkspaceFile { path: string; bytes: number }
export interface WorkspaceChange { path: string; status: string }
export interface WorkspaceCommit { hash: string; subject: string }
export interface WorkspaceState { files: WorkspaceFile[]; changes: WorkspaceChange[]; commits: WorkspaceCommit[]; git: boolean; branch: string | null; message: string; truncated: boolean }
export interface WorkspaceDocument { path: string; text: string; revision: string }
const excluded = new Set(['node_modules','dist','build','out','target','coverage','vendor','venv','test-results','playwright-report','tmp','credentials','secrets']);
const extensions = new Set(['md','mdx','txt','ts','tsx','js','jsx','mjs','cjs','json','yaml','yml','toml','css','scss','html','htm','svg','xml','sql','sh','py','rs','go','swift','kt','kts','java','c','h','cpp','gradle','svelte','astro','vue','lock','png','jpg','jpeg','gif','webp','avif']);
/** A bounded text viewer, never an arbitrary file/asset server or credential browser. */
export function isWorkspacePath(path: string): boolean {
 if(typeof path!=='string'||path.length>500||/[\u0000-\u001f\u007f\\]/.test(path)||path.startsWith('/'))return false;
 if(path.startsWith('docs/dashboard/sources/'))return false;
 const parts=path.split('/');
 const dotFiles=['.gitignore','.gitattributes','.editorconfig'];
 if(parts.some((p,i)=>!p||p==='.'||p==='..'||(p.startsWith('.')&&!(p==='.github'&&i<parts.length-1)&&!(i===parts.length-1&&dotFiles.includes(p)))||excluded.has(p)))return false;
 const name=parts.at(-1)!;
 if(/^(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(name))return false;
 return extensions.has(name.split('.').at(-1)!.toLowerCase())||['Dockerfile','Makefile','LICENSE','README','NOTICE','CHANGELOG',...dotFiles].includes(name);
}
export function isWorkspaceImagePath(path:string):boolean{return isWorkspacePath(path)&&/\.(png|jpe?g|gif|webp|avif)$/i.test(path);}
export function commitMessage(commit?: SaveCommit): string {
 if(!commit)return 'Saved';
 return commit.status==='committed'?'Committed '+commit.hash!.slice(0,8):commit.status==='unchanged'?'Saved · no new changes':commit.status==='failed'?'Saved, not committed':commit.status==='uncertain'?'Saved · commit unconfirmed':'Saved · Git unavailable';
}
