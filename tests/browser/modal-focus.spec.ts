import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

test('nested and overlapping native modal removal does not steal focus',async({page})=>{
 await page.goto('/');
 const script=transformSync(readFileSync('src/client/modal-focus.ts','utf8'),{loader:'ts',format:'iife',globalName:'PilotModalFocus'}).code;
 await page.route('**/modal-focus-test.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:script}));
 await page.addScriptTag({url:'/modal-focus-test.js'});
 const result=await page.evaluate(()=>{
  const helper=(window as unknown as {PilotModalFocus:{showModalWithFocusReturn:(element:HTMLDialogElement)=>()=>void}}).PilotModalFocus;
  const opener=document.createElement('button');opener.textContent='modal test opener';document.body.append(opener);opener.focus();
  const parent=document.createElement('dialog'),child=document.createElement('dialog'),inside=document.createElement('button'),childButton=document.createElement('button');
  inside.textContent='open child';childButton.textContent='child focus';parent.append(inside);child.append(childButton);document.body.append(parent,child);
  const closeParent=helper.showModalWithFocusReturn(parent);inside.focus();const closeChild=helper.showModalWithFocusReturn(child);childButton.focus();
  closeChild();child.remove();const nestedReturn=document.activeElement===inside;
  closeParent();parent.remove();const parentReturn=document.activeElement===opener;
  const first=document.createElement('dialog'),second=document.createElement('dialog'),firstButton=document.createElement('button'),secondButton=document.createElement('button');
  first.append(firstButton);second.append(secondButton);document.body.append(first,second);opener.focus();
  const closeFirst=helper.showModalWithFocusReturn(first);firstButton.focus();
  // The second modal inherits an opener in the first; the first may disappear before it closes.
  const closeSecond=helper.showModalWithFocusReturn(second);secondButton.focus();
  closeFirst();first.remove();const overlappingFocus=document.activeElement===secondButton;
  closeSecond();second.remove();const overlapReturn=document.activeElement===opener;opener.remove();
  return {nestedReturn,parentReturn,overlappingFocus,overlapReturn};
 });
 expect(result).toEqual({nestedReturn:true,parentReturn:true,overlappingFocus:true,overlapReturn:true});
});
