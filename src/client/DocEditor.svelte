<script lang="ts">
 import type { DocSnapshot } from '../shared/docs';
 import { download } from './api';
 import Icon from './Icon.svelte';
 let { doc, draft, conflict, saving, message, ondraft, onsave, oncancel, onreload }:{
   doc: DocSnapshot; draft: string; conflict: boolean; saving: boolean; message: string;
   ondraft:(text:string)=>void; onsave:(text:string)=>void; oncancel:()=>void; onreload:()=>void;
 }=$props();
</script>
<div class="doc-editor">
 <header class="doc-head">
  <div class="doc-title"><span class="eyebrow">EDITING</span><h2>{doc.path}</h2></div>
  <div class="doc-editor-actions">
   <button class="compact-button" aria-label="Cancel editing" onclick={oncancel}>Cancel</button>
   <button class="primary compact-button" aria-label="Save document" disabled={saving} onclick={()=>onsave(draft)}><Icon name="save" size={14}/><span>{saving?'Saving…':'Save document'}</span></button>
  </div>
 </header>
 {#if conflict}
 <div class="error doc-conflict" role="alert">
  <strong>This document changed on disk.</strong> Your draft is still here — nothing was overwritten.
  <div class="row"><button onclick={onreload}>Reload from disk</button><button onclick={()=>download('draft-'+doc.path.split('/').pop(),draft,'text/markdown')}>Download my draft</button></div>
 </div>
 {:else if message}<div class="callout">{message}</div>{/if}
 <label class="doc-textarea">Document body
  <textarea aria-label="Document body" spellcheck="false" value={draft} oninput={(e)=>ondraft((e.currentTarget as HTMLTextAreaElement).value)}></textarea>
 </label>
 <p class="doc-hint">Markdown is committed to the repository file itself. Diagrams (```mermaid), images and static HTML mockups render on save.</p>
</div>
