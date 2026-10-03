import {createHash} from 'node:crypto';
import {BridgeError} from './herdr.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code='model_stale') => { throw new BridgeError(code,message,409); };
const heading = /^(Select Model(?: and Effort)?|Select Reasoning Level for .+|Advanced Reasoning)$/;
const row = /^\s*([›❯])?\s*(\d{1,2})\.\s*(\S.*?)\s*$/;
const legacyFooter = /^\s*Press enter to confirm or esc to (?:go back|exit|cancel)\s*$/i;
const modelFooter = /^\s*enter select · esc back\s*$/i;
const reasoningFooter = /^\s*enter default · s session · esc back\s*$/i;
const clean = text => text.replace(/[\u2800-\u28ff]/g,' ').split('\n');

// Read only the active native picker, never a menu quoted in conversation history.
// Labels come from the running Codex catalog, including auto modes and reasoning.
export function detectCodexModelMenu(text) {
  if(typeof text!=='string')return null;
  const lines=clean(text), start=lines.findLastIndex(line=>heading.test(line.trim()));
  if(start<0)return null;
  const title=lines[start].trim(),options=[];let selectedIndex=null,footerKey=null;
  const stage=title.startsWith('Select Reasoning')||title==='Advanced Reasoning'?'reasoning':'model';
  for(let i=start+1;i<lines.length;i++) {
    const line=lines[i];
    if(legacyFooter.test(line)||(stage==='model'&&modelFooter.test(line))||(stage==='reasoning'&&reasoningFooter.test(line))) {
      if(lines.slice(i+1).some(value=>value.trim()))return null;
      footerKey=reasoningFooter.test(line)?'s':'enter';break;
    }
    const match=row.exec(line);
    if(match) {
      if(+match[2]!==options.length+1)return null;
      if(match[1]) {if(selectedIndex!==null)return null;selectedIndex=options.length;}
      options.push(match[3]);
    } else if(line.trim()) {
      if(!/^\s{2,}\S/.test(line))return null;
      if(options.length)options[options.length-1]+=' '+line.trim();
      // The native menu can have a short introductory sentence before its rows.
    }
  }
  if(!footerKey||!options.length||options.length>32||selectedIndex===null)return null;
  return {id:hash({title,options,stage,footerKey}),title,options,selectedIndex,stage,footerKey};
}
export function bindCodexModelMenu(menu,pane) {
  if(!menu)return null;
  return {...menu,id:hash({menu:menu.id,pane:pane.pane_id,terminal:pane.terminal_id??null,session:pane.agent_session??null,cwd:pane.cwd})};
}
const same=(first,next)=>next?.pane_id===first.pane_id&&next.agent==='codex'&&next.cwd===first.cwd&&
  ['terminal_id','agent_session'].every(key=>JSON.stringify(first[key]??null)===JSON.stringify(next[key]??null));
const idle=pane=>pane.agent==='codex'&&['idle','done'].includes(pane.agent_status);
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
async function read(herdr,id) {
  const {read}=await herdr.call('pane.read',{pane_id:id,source:'detection',format:'text',strip_ansi:true,lines:120});
  // Truncation can mean omitted earlier scrollback. The parser independently
  // requires the whole bottom picker; the composer check anchors its footer.
  return read.text;
}
async function verify(herdr,id,first) {
  const {pane}=await herdr.call('pane.get',{pane_id:id});
  if(!same(first,pane)||['working','starting','stopped','error'].includes(pane.agent_status))fail('The conversation changed. Refresh before changing the model.');
  return pane;
}
export function hasEmptyCodexModelComposer(text) {
  if(typeof text!=='string')return false;
  const lines=clean(text);
  const index=lines.findLastIndex(line=>/^\s*[›❯]\s*Ask Codex to do anything[ .·]*$/.test(line));
  if(index<0)return false;
  // A strict known footer permits the action; unknown modal/composer content fails closed.
  return lines.slice(index+1).every(line=>!line.trim()||
    /^\s*[\w./:-]+(?:\s+(?:none|minimal|low|medium|high|xhigh|max|ultra))?\s*·\s*Context \d+% left(?:\s*·\s*weekly \d+% left)?(?:\s*·\s*[\d.]+K? used)?(?:\s*·\s*Main)?(?:\s*\[default\])?\s*(?:·\s*)?$/i.test(line)||
    /^\s*weekly \d+% left(?:\s*·\s*[\d.]+K? used)?(?:\s*·\s*Main)?\s*$/.test(line)||/^\s*\[default\]\s*$/.test(line)||
    /^\s*← for agents · \? for shortcuts\s*$/.test(line));
}
export async function openCodexModelMenu(herdr,id,current) {
  if(!idle(current))fail('Wait until Codex finishes or answer its question before changing the model.','model_unavailable');
  const text=await read(herdr,id);
  if(!hasEmptyCodexModelComposer(text)) {
    if(/Folder access[\s\S]*Trust this folder\?/i.test(text)&&
      !/› Ask Codex to do anything/.test(text.slice(text.lastIndexOf('Trust this folder?'))))
      fail('Answer Codex\'s "Trust this folder?" prompt with the terminal keys before changing the model.','model_unavailable');
    fail('Clear the desktop draft or close its dialog before changing the model.','model_unavailable');
  }
  const next=await verify(herdr,id,current);
  if(!idle(next))fail('Codex is no longer idle.');
  // This is a TUI slash command, not an agent turn. Do not call agent.prompt,
  // which waits for an agent lifecycle transition this command does not trigger.
  await herdr.call('pane.send_input',{pane_id:id,text:'/model',keys:['enter']});
  return {opened:true};
}
export async function actCodexModelMenu(herdr,id,current,{menuId,option,cancel=false}) {
  if(current.agent!=='codex')fail('This conversation is no longer running Codex.');
  let menu=bindCodexModelMenu(detectCodexModelMenu(await read(herdr,id)),current);
  if(!menu||menu.id!==menuId)fail('The model menu changed. Refresh and choose again.');
  if(!cancel&&(!Number.isInteger(option)||option<0||option>=menu.options.length))fail('Choose a visible model option.','invalid_model');
  await verify(herdr,id,current);
  if(cancel) {await herdr.call('pane.send_keys',{pane_id:id,keys:['esc']});return {cancelled:true};}
  const delta=option-menu.selectedIndex;
  if(delta) {
    await herdr.call('pane.send_keys',{pane_id:id,keys:Array(Math.abs(delta)).fill(delta>0?'down':'up')});
    let settled=false;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await verify(herdr,id,current);
      menu=bindCodexModelMenu(detectCodexModelMenu(await read(herdr,id)),next);
      if(!menu||menu.id!==menuId)fail('The model menu changed while selecting. Refresh and choose again.');
      if(menu.selectedIndex===option){settled=true;break;}
      await pause();
    }
    if(!settled)fail('The model cursor has not updated. Refresh before selecting.');
  }
  // Recheck both the menu cursor and pane identity immediately before confirming.
  menu=bindCodexModelMenu(detectCodexModelMenu(await read(herdr,id)),await verify(herdr,id,current));
  if(!menu||menu.id!==menuId||menu.selectedIndex!==option)fail('The model selection changed. Refresh and choose again.');
  const key=menu.stage==='reasoning'&&/^More reasoning…(?:\s|$)/.test(menu.options[option])?'enter':menu.footerKey;
  await herdr.call('pane.send_keys',{pane_id:id,keys:[key]});
  return {selected:true};
}
