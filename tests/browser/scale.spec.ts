import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const areas=['storage','sync','backend','frontend','desktop','mobile','devices','release'];
const milestones=[{id:'M1',name:'Documentation',order:1},{id:'M2',name:'Safety and packaging',order:2},{id:'M3',name:'Desktop channels',order:3}];

function bigBoard(){
  const tasks=Array.from({length:500},(_,index)=>({
    id:'00000000-0000-4000-8000-'+String(index).padStart(12,'0'),
    title:'Task '+String(index+1).padStart(3,'0')+' — '+(index%7===0?'investigate the failing case':'implement the change'),
    description:'',
    domain:areas[index%areas.length],
    tags:[],
    milestone:milestones[index%milestones.length].id,
    status:(['todo','doing','done','blocked'] as const)[index%4],
    scope:'active',
    acceptance:'',
    gates:[],
    sources:[],
    specs:[],
    archived:false
  }));
  return {version:1,adoption:'mirror',domains:areas.map((id,index)=>({id,name:id,color:'#'+((index*2654435761)%0xffffff).toString(16).padStart(6,'0')})),milestones,tasks,relationships:[],sources:[],layout:{},summary:''};
}

test('a five-hundred task board stays legible and usable',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'＋ Add project',exact:true}).first().click();
  await page.getByLabel('Project name').fill('Scale fixture');
  await page.getByRole('button',{name:'Confirm & add project'}).click();

  // Load a full-size board through the API, the same way an import or a real project would.
  const loaded=await page.evaluate(async(board)=>{
    const token=document.querySelector<HTMLMetaElement>('meta[name="dashboard-token"]')!.content;
    const headers={'X-Dashboard-Token':token,'Content-Type':'application/json'};
    const projects=await (await fetch('/api/projects',{headers})).json() as {id:string;name:string}[];
    const project=projects.find(candidate=>candidate.name==='Scale fixture')!;
    const current=await (await fetch('/api/projects/'+project.id+'/board',{headers})).json();
    const saved=await (await fetch('/api/projects/'+project.id+'/board',{method:'POST',headers,body:JSON.stringify({revision:current.revision,operation:{op:'restore',board}})}));
    return {status:saved.status,revision:current.revision.length};
  },bigBoard());
  expect(loaded.status).toBe(200);

  await page.reload();
  const started=Date.now();
  await page.getByRole('button',{name:'List',exact:true}).click();
  await expect(page.locator('.task-table tbody tr')).toHaveCount(500,{timeout:15000});
  const listMs=Date.now()-started;
  await expect(page.getByText('500 matching tasks')).toBeVisible();

  // Filtering and searching still narrow the full board.
  await page.getByLabel('Search tasks').fill('Task 250');
  await expect(page.locator('.task-table tbody tr')).toHaveCount(1);
  await expect(page.getByText('1 matching tasks')).toBeVisible();
  await page.getByLabel('Search tasks').fill('');
  await expect(page.locator('.task-table tbody tr')).toHaveCount(500);

  // The canvas groups by area rather than drawing five hundred loose cards at once.
  await page.getByRole('button',{name:'Dependencies',exact:true}).click();
  await expect(page.locator('.task-card.group')).toHaveCount(areas.length,{timeout:15000});
  await page.getByRole('button',{name:'Timeline',exact:true}).click();
  await expect(page.getByText('Sequence, not dates or duration')).toBeVisible();

  await mkdir('/tmp/project-dashboard-ui-preview',{recursive:true});
  await page.getByRole('button',{name:'List',exact:true}).click();
  await expect(page.locator('.task-table tbody tr')).toHaveCount(500);
  await page.screenshot({path:'/tmp/project-dashboard-ui-preview/scale-list.png',animations:'disabled'});
  await page.getByRole('button',{name:'Dependencies',exact:true}).click();
  await expect(page.locator('.task-card.group')).toHaveCount(areas.length);
  await page.screenshot({path:'/tmp/project-dashboard-ui-preview/scale-canvas.png',animations:'disabled'});

  // A generous ceiling that still catches a pathological regression.
  expect(listMs).toBeLessThan(15000);
});