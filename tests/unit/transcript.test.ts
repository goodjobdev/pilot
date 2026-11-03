import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptEntryShown,transcriptRows } from '../../src/shared/transcript';
import type { AgentEntry } from '../../src/shared/agent';

/**
 * The transcript layout rule: what is worth showing, and how runs of tool results fold.
 *
 * The rule is pure, so it is checked directly rather than through a rendered page: a busy session
 * produces one entry per tool result, and those runs are what used to push the conversation off the
 * screen.
 */
function entry(overrides:Partial<AgentEntry>&{id:string}):AgentEntry{
  return {kind:'tool',rawKind:'pi.tool-result',at:1_700_000_000_000,text:'',thinking:'',tools:[],stopReason:null,error:null,data:null,toolResult:null,...overrides};
}
test('an entry with nothing to show is not rendered, and one with anything is',()=>{
  assert.equal(transcriptEntryShown(entry({id:'a'})),false);
  for(const shown of [entry({id:'b',text:'hi'}),entry({id:'c',thinking:'why'}),entry({id:'d',tools:[{name:'read',args:'{}'}]}),entry({id:'e',images:[{id:'i',mimeType:'image/png'}]}),entry({id:'f',error:'failed'})])
    assert.equal(transcriptEntryShown(shown),true,shown.id);
});
test('two or more consecutive tool results fold into one group, and a lone one does not',()=>{
  const rows=transcriptRows([
    entry({id:'1',kind:'user',text:'do it'}),
    entry({id:'2',kind:'tool',text:'first'}),
    entry({id:'3',kind:'tool',text:'second'}),
    entry({id:'4',kind:'tool',text:'third'}),
    entry({id:'5',kind:'assistant',text:'done'}),
    entry({id:'6',kind:'tool',text:'lone'})
  ]);
  assert.deepEqual(rows.map(row=>row.kind==='tools'?['tools',row.entries.length]:['one',row.entry.id]),
    [['one','1'],['tools',3],['one','5'],['one','6']]);
  const group=rows[1];
  assert.equal(group.kind,'tools');
  if(group.kind==='tools'){
    assert.equal(group.id,'tool-run-2','the group keeps the first entry identity, so it is stable across a re-render');
    assert.deepEqual(group.entries.map(item=>item.text),['first','second','third']);
  }
});
test('an empty transcript, and one whose entries are all empty, produce no rows',()=>{
  assert.deepEqual(transcriptRows([]),[]);
  assert.deepEqual(transcriptRows([entry({id:'x'}),entry({id:'y'})]),[]);
});
test('an assistant entry between two tool results keeps them apart',()=>{
  const rows=transcriptRows([
    entry({id:'1',kind:'tool',text:'a'}),
    entry({id:'2',kind:'assistant',text:'thinking out loud'}),
    entry({id:'3',kind:'tool',text:'b'})
  ]);
  assert.deepEqual(rows.map(row=>row.kind),[ 'one','one','one' ]);
});
