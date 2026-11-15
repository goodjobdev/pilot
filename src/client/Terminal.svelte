<script lang="ts">
 import {onDestroy,onMount} from 'svelte';
 import {Terminal as XTerm} from '@xterm/xterm';
 import '@xterm/xterm/css/xterm.css';
 import {FitAddon} from '@xterm/addon-fit';
 import {api,type TerminalInfo} from './api';
 import Icon from './Icon.svelte';
 let {projectId,onerror}:{projectId:string;onerror:(message:string)=>void}=$props();
 let host=$state<HTMLDivElement>(),sessions=$state<TerminalInfo[]>([]),active=$state<TerminalInfo|null>(null),busy=$state(false),message=$state(''),problem=$state('');
 let xterm:XTerm|null=null,fit:FitAddon|null=null,socket:WebSocket|null=null,resizeObserver:ResizeObserver|null=null,inputDisposable:{dispose:()=>void}|null=null;

 onMount(()=>{xterm=new XTerm({cursorBlink:true,convertEol:false,scrollback:5000, fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:13,theme:{background:'#101318',foreground:'#e5e9f0',cursor:'#b9c9ff'}});fit=new FitAddon();xterm.loadAddon(fit);if(host)xterm.open(host);inputDisposable=xterm.onData(data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',data}));});resizeObserver=new ResizeObserver(()=>resize());if(host)resizeObserver.observe(host);void refresh();return()=>detach();});
 onDestroy(()=>detach());
 async function refresh(){try{sessions=(await api.terminals(projectId)).terminals;}catch(e){problem=(e as Error).message;}}
 function resize(){if(!xterm||!fit)return;try{fit.fit();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'resize',cols:xterm.cols,rows:xterm.rows}));}catch{/* terminal may be between mounts */}}
 async function open(){if(busy)return;busy=true;problem='';message='';try{const created=await api.openTerminal(projectId,{cols:xterm?.cols??80,rows:xterm?.rows??24});sessions=[created.terminal,...sessions];await attach(created.terminal);}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function attach(info:TerminalInfo){if(info.connected){problem='This terminal already has a browser attached.';return;}detachSocket();active=info;message='Connecting…';try{const {ticket}=await api.terminalTicket(projectId,info.id);const url=new URL('/api/terminals/'+encodeURIComponent(info.id)+'/stream',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(url,['pilot-terminal',ticket]);socket=ws;ws.onopen=()=>{message='Connected · '+info.cwd;resize();xterm?.focus();};ws.onmessage=event=>{try{const frame=JSON.parse(String(event.data)) as {type?:string;data?:string};if(frame.type==='output'&&typeof frame.data==='string')xterm?.write(frame.data);}catch{/* invalid frames are ignored */}};ws.onerror=()=>{message='Terminal connection failed.';};ws.onclose=()=>{message='Disconnected';void refresh();};}catch(e){active=null;problem=(e as Error).message;}}
 function detachSocket(){if(socket){socket.onclose=null;socket.close();socket=null;}}
 function detach(){resizeObserver?.disconnect();inputDisposable?.dispose();inputDisposable=null;detachSocket();xterm?.dispose();xterm=null;}
 async function closeActive(){if(!active)return;busy=true;try{await api.closeTerminal(projectId,active.id);active=null;await refresh();message='Terminal stopped.';}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function connectExisting(){const selected=sessions.find(item=>item.id===active?.id);if(selected)await attach(selected);}
 function runShortcut(command:string){if(socket?.readyState!==WebSocket.OPEN){problem='Connect the terminal before running a shortcut.';return;}problem='';socket.send(JSON.stringify({type:'input',data:command+'\r'}));xterm?.focus();}
</script>
<section class="terminal-view" aria-label="Project terminal">
 <header class="terminal-toolbar">
  <div><span class="eyebrow">SAME-USER TERMINAL</span><h2>{active?'Terminal · '+active.projectName:'Terminal'}</h2></div>
  <div class="terminal-actions">
   <select aria-label="Existing terminal" value={active?.id??''} onchange={e=>{const chosen=sessions.find(item=>item.id===e.currentTarget.value);if(chosen)void attach(chosen);}}>
    <option value="">Choose existing terminal</option>{#each sessions as item (item.id)}<option value={item.id}>{item.projectName} · {new Date(item.createdAt).toLocaleTimeString()} {item.connected?'(attached)':''}</option>{/each}
   </select>
   <button class="primary compact-button" disabled={busy} onclick={()=>void open()}><Icon name="plus" size={14}/><span>New terminal</span></button>
   {#if active}<button class="compact-button" disabled={busy} onclick={()=>void closeActive()}>Stop session</button>{/if}
  </div>
 </header>
 <p class="terminal-warning"><strong>Broad access:</strong> commands run as Pilot’s service user with its environment and filesystem permissions. The project is only the starting directory. Commands may access other files, credentials and services available to that user.</p>
 {#if problem}<p class="error" role="alert">{problem}</p>{/if}
 <div class="terminal-status" role="status">{message||'Open a terminal to start a shell in this project.'}</div>
 <div class="terminal-frame" bind:this={host} aria-label="Terminal output and input"></div>
 {#if active}
 <div class="terminal-shortcuts" aria-label="Terminal command shortcuts">
  <button class="compact-button" type="button" onclick={()=>runShortcut('pnpm check')}>Run pnpm check</button>
  <button class="compact-button" type="button" onclick={()=>runShortcut('pnpm test')}>Run pnpm test</button>
  <small>Shortcuts run in the selected project and share the same broad service-user access as typed commands.</small>
 </div>
 {/if}
</section>
<style>
 .terminal-view{height:100%;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px;overflow:auto}
 .terminal-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
 h2{margin:2px 0;font-size:18px}.terminal-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .terminal-actions select{min-width:180px;max-width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:4px;padding:7px}
 .terminal-warning{font-size:12px;color:var(--muted);padding:8px 10px;border:1px solid var(--line);border-left:3px solid var(--warning,#d39b43);margin:0}
 .terminal-status{font:12px var(--mono);color:var(--muted)}
 .terminal-frame{height:48dvh;min-height:240px;background:#101318;border:1px solid var(--line);border-radius:5px;padding:6px;overflow:hidden}
 .terminal-shortcuts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.terminal-shortcuts small{color:var(--muted)}
 @media(max-width:700px){.terminal-frame{height:50dvh;min-height:220px}.terminal-actions{width:100%}.terminal-actions select{flex:1}}
</style>
