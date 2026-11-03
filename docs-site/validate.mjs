import { readdir,readFile } from 'node:fs/promises';
import { resolve,relative,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const site=dirname(fileURLToPath(import.meta.url));
const decode=text=>text.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');
export async function validate(output=resolve(site,'dist')){
 const pages=new Map();
 const walk=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isSymbolicLink())throw Error('Unexpected published symlink');if(entry.isDirectory())await walk(path);else if(entry.name.endsWith('.html'))pages.set('/'+relative(output,path).replaceAll('\\','/'),await readFile(path,'utf8'));}};
 await walk(output);if(!pages.size)throw Error('No built documentation pages');
 let count=0;
 for(const[path,html]of pages){for(const match of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)){
  const url=new URL(decode(match[1]),'https://docs.invalid'+path);if(url.origin!=='https://docs.invalid')continue;
  const target=decodeURIComponent(url.pathname),key=target.endsWith('/')?target+'index.html':target;
  const content=pages.get(key);if(content===undefined)throw Error('Broken built link: '+path+' → '+target);
  if(url.hash){const anchor=decodeURIComponent(url.hash.slice(1)),ids=[...content.matchAll(/\bid="([^"]*)"/g)].map(item=>decode(item[1]));if(!ids.includes(anchor))throw Error('Broken built anchor: '+path+' → '+target+url.hash);}
  count++;
 }}
 return {pages:pages.size,links:count};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await validate();console.log('Validated '+result.links+' local links and anchors across '+result.pages+' built pages');}
