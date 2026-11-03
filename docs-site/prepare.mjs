import { readFile,writeFile,mkdir,rm,lstat } from 'node:fs/promises';
import { resolve,relative,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { frontmatterSchema } from './schema.mjs';
const site=dirname(fileURLToPath(import.meta.url)),root=resolve(site,'..');
const publicSource=/^docs\/(?:manual\/[a-z0-9-]+\.md|templates\/[a-z0-9-]+\.md|specs\/[a-z0-9-]+\.md|DOCUMENTATION\.md)$/;
const slugPattern=/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
export async function prepare(base=root,manifest=resolve(site,'pages.json'),output=resolve(site,'.generated/docs')){
 const pages=JSON.parse(await readFile(manifest,'utf8'));
 if(!Array.isArray(pages)||pages.length<1||pages.length>200)throw Error('Invalid publication manifest');
 const sources=new Map(),slugs=new Set(),ids=new Set(),contents=new Map();
 for(const page of pages){
  if(!page||Object.keys(page).sort().join(',')!=='slug,source'||!publicSource.test(page.source)||!slugPattern.test(page.slug))throw Error('Publication requires an explicit public Markdown source and safe slug');
  if(sources.has(page.source)||slugs.has(page.slug))throw Error('Duplicate publication source or slug');
  sources.set(page.source,page.slug);slugs.add(page.slug);
  let path=base;for(const part of page.source.split('/')){path=resolve(path,part);if((await lstat(path)).isSymbolicLink())throw Error('Publication refuses symlinks');}
  const bytes=await readFile(path);if(bytes.length>256*1024)throw Error('Published page exceeds 256 KiB');
  const text=bytes.toString('utf8');if(!bytes.equals(Buffer.from(text))||text.includes('\0'))throw Error('Published pages must be UTF-8 text');
  if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(text))throw Error('Possible credential in publication source');
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!match)throw Error('Published page lacks frontmatter: '+page.source);
  const document=parseDocument(match[1],{uniqueKeys:true});if(document.errors.length)throw Error('Invalid page frontmatter: '+page.source);
  const data=frontmatterSchema.parse(document.toJS({maxAliasCount:0}));
  if(ids.has(data.pilot.id))throw Error('Duplicate documentation id: '+data.pilot.id);ids.add(data.pilot.id);
  contents.set(page.source,text);
 }
 // Rewrite only real Markdown links outside fenced examples. Private/non-published
 // source links fail rather than becoming broken public links or copying content.
 const rendered=new Map();
 for(const [source,text]of contents){
  let fence=null;const lines=[];
  for(const line of text.split('\n')){
   const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
   if(marker){if(fence&&marker[0]===fence[0]&&marker.length>=fence.length)fence=null;else if(!fence)fence=marker;lines.push(line);continue;}
   if(fence){lines.push(line);continue;}
   lines.push(line.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g,(whole,start,href,end)=>{
    if(/^(?:https?:|mailto:|#)/.test(href))return whole;
    if(start.startsWith('!'))throw Error('Image publication needs an explicit reviewed asset path: '+source);
    const [path,anchor]=href.split('#');if(!path.endsWith('.md'))throw Error('Unsupported source link: '+source);
    const target=relative(base,resolve(base,dirname(source),decodeURIComponent(path))).replaceAll('\\','/');
    const slug=sources.get(target);if(!slug)throw Error('Link to unpublished source: '+source+' → '+target);
    return start+(slug==='index'?'/':'/'+slug+'/')+(anchor?'#'+anchor:'')+end;
   }));
  }
  rendered.set(sources.get(source),lines.join('\n'));
 }
 // This function writes only caller-owned generated output; validation finishes first.
 await rm(output,{recursive:true,force:true});
 for(const[slug,text]of rendered){const path=resolve(output,slug+'.md');await mkdir(dirname(path),{recursive:true});await writeFile(path,text);}
 return {pages:pages.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await prepare();console.log('Prepared '+result.pages+' explicitly published Markdown pages');
}
