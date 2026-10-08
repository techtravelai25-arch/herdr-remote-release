import {createHash} from 'node:crypto';
import {BridgeError} from './herdr.js';
import {detectCodexModelMenu,bindCodexModelMenu,openCodexModelMenu,actCodexModelMenu} from './codex-model.js';
import {detectOpenCodeModelMenu,readOpenCodeModelMenu,openOpenCodeModelMenu,keyOpenCodeModelMenu,actOpenCodeModelMenu} from './opencode-model.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>{throw new BridgeError('model_stale',message,409);};
// Capability flags must name only agents whose native pickers this bridge can
// actually drive: each entry has a verified parser and menu driver below.
// Unknown menu formats still fail closed per pane at detection time.
export const modelSelectionAgents=['codex','claude','opencode'];
const tidy=line=>line.replace(/^\s*[│┃]\s?/,'').replace(/\s*[│┃]\s*$/,'').trimEnd();
const border=line=>/^[\s─━╭╮╰╯┌┐└┘│┃═▀▄]+$/.test(line)||!line.trim();
const optionRow=/^\s*(?:([❯›])|([↑↓]))?\s*(\d{1,2})\.\s+(.+?)\s*$/;
const hiddenRow=/^\s*(?:…|\.\.\.)\s*\+(\d{1,3})\s+models?\s*$/i;
// Claude Code 2.1.263 embeds the Select model renderer and its session-only
// shortcut in the installed binary. Only the complete, unfiltered picker is
// actionable; confirmation/consent dialogs are deliberately not model menus.
export function detectClaudeModelMenu(text) {
  if(typeof text!=='string')return null;
  const lines=text.split('\n').map(tidy),start=lines.findLastIndex(line=>line.trim()==='Select model');
  if(start<0)return null;
  let footer=-1;
  for(let i=start+1;i<lines.length;i++)if(/(?:enter to (?:set as default|confirm)).*(?:s to use this session only).*(?:esc to cancel)/i.test(lines[i]))footer=i;
  if(footer<0||lines.slice(footer+1).some(line=>!border(line)))return null;
  if(lines.slice(start,footer).some(line=>/Type to filter|Search models|No models match/.test(line)))return null;
  const rows=[];let selectedIndex=null,afterRows=false,hiddenBelow=0,moreBelow=false,first=0;
  for(const line of lines.slice(start+1,footer)) {
    const match=optionRow.exec(line);
    if(match) {
      const number=+match[3];
      // Long lists scroll in a window that keeps absolute row numbers and marks
      // clipped edges with arrows; a window may therefore start above row 1.
      if(afterRows||!rows.length&&(number<1||number>1&&match[2]!=='↑')||rows.length&&number!==first+rows.length)return null;
      if(!rows.length)first=number;
      if(match[2]==='↓')moreBelow=true;
      if(match[1]){if(selectedIndex!==null)return null;selectedIndex=number-1;}
      rows.push(match[4]);
    } else if(rows.length&&line.trim()) {
      const hidden=hiddenRow.exec(line);
      if(hidden){hiddenBelow=+hidden[1];afterRows=true;continue;}
      if(/(?:effort|Fast mode|\/fast|models? hidden|more models)/i.test(line)){afterRows=true;continue;}
      if(afterRows)continue;
      if(!/^\s{2,}\S/.test(line))return null;
      rows[rows.length-1]+=' '+line.trim();
    }
  }
  if(!rows.length||rows.length>32||selectedIndex===null||moreBelow&&!hiddenBelow)return null;
  const total=first-1+rows.length+hiddenBelow;
  if(total>64)return null;
  const options=Array.from({length:total},(_,i)=>i>=first-1&&i<first-1+rows.length?rows[i-first+1]:`Model ${i+1}`);
  const base={title:'Select model',options,selectedIndex,stage:'model',provider:'claude',sessionOnly:true};
  if(total===rows.length)return {id:hash({options}),...base};
  return {id:hash({total}),...base,window:{start:first-1,rows}};
}
// A partial window only shows ten rows. The bridge scans the whole list when it
// opens the picker and remembers each name per pane, so the phone sees every
// model while the cursor scrolls underneath.
const claudeKnown=new Map();
const knownKey=pane=>JSON.stringify([pane.pane_id,pane.terminal_id??null,pane.agent_session??null]);
export function mergeClaudeModelWindow(menu,pane) {
  if(!menu?.window)return menu;
  const {window,...rest}=menu,key=knownKey(pane),total=menu.options.length,prior=claudeKnown.get(key);
  const known=prior?.length===total&&window.rows.every((text,i)=>prior[window.start+i]==null||prior[window.start+i]===text)?prior.slice():Array(total).fill(null);
  window.rows.forEach((text,i)=>{known[window.start+i]=text;});
  claudeKnown.delete(key);claudeKnown.set(key,known);
  if(claudeKnown.size>40)claudeKnown.delete(claudeKnown.keys().next().value);
  const options=known.map((text,i)=>text??`Model ${i+1}`);
  return {...rest,options,id:known.every(text=>text!=null)?hash({options}):menu.id};
}
// Switching models inside a conversation makes Claude ask before it drops the
// prompt cache. Herdr still reports the agent idle while this dialog waits, so
// the bridge surfaces it as a second stage; only the exact two-choice shape counts.
export function detectClaudeModelConfirm(text) {
  if(typeof text!=='string')return null;
  const lines=text.split('\n').map(tidy),start=lines.findLastIndex(line=>line.trim()==='Switch model?');
  if(start<0)return null;
  const options=[],paragraphs=[[]];let selectedIndex=null;
  for(const line of lines.slice(start+1)) {
    const match=optionRow.exec(line);
    if(match) {
      if(+match[3]!==options.length+1)return null;
      if(match[1]){if(selectedIndex!==null)return null;selectedIndex=options.length;}
      options.push(match[4]);
    } else if(options.length) {
      if(line.trim()&&!/^\s*(?:enter|esc)\b/i.test(line))return null;
    } else if(line.trim())paragraphs.at(-1).push(line.trim());
    else if(paragraphs.at(-1).length)paragraphs.push([]);
  }
  if(options.length!==2||selectedIndex===null||!/^Yes\b/i.test(options[0])||!/^No\b/i.test(options[1]))return null;
  const note=paragraphs.filter(p=>p.length).map(p=>p.join(' ')).join('\n');
  return {id:hash({confirm:options,note}),title:'Switch model?',note,options,selectedIndex,stage:'confirm',provider:'claude',sessionOnly:true};
}
export function detectAgentModelMenu(text,agent) {
  if(agent==='codex')return detectCodexModelMenu(text);
  if(agent==='claude')return detectClaudeModelMenu(text)??detectClaudeModelConfirm(text);
  if(agent==='opencode')return detectOpenCodeModelMenu(text);
  return null;
}
export function bindAgentModelMenu(menu,pane) {
  if(!menu)return null;
  if(pane.agent==='codex')return {...bindCodexModelMenu(menu,pane),provider:'codex'};
  return {...menu,id:hash({menu:menu.id,pane:pane.pane_id,terminal:pane.terminal_id??null,session:pane.agent_session??null,cwd:pane.cwd,agent:pane.agent})};
}
async function readText(herdr,id) {
  const {read}=await herdr.call('pane.read',{pane_id:id,source:'detection',format:'text',strip_ansi:true,lines:120});return read.text;
}
export async function readAgentModelMenu(herdr,id,pane) {
  if(pane.agent==='opencode')return readOpenCodeModelMenu(herdr,id,pane);
  const menu=detectAgentModelMenu(await readText(herdr,id),pane.agent);
  return bindAgentModelMenu(pane.agent==='claude'?mergeClaudeModelWindow(menu,pane):menu,pane);
}
async function verify(herdr,id,first) {
  const {pane}=await herdr.call('pane.get',{pane_id:id});
  if(pane.agent!==first.agent||pane.pane_id!==first.pane_id||pane.cwd!==first.cwd||
    ['terminal_id','agent_session'].some(key=>JSON.stringify(pane[key]??null)!==JSON.stringify(first[key]??null))||
    ['working','starting','stopped','error'].includes(pane.agent_status))fail('The conversation changed. Refresh before changing the model.');
  return pane;
}
// The composer is empty when its prompt row holds nothing (or Claude's own
// `Try "..."` placeholder) and the box closes right after it. Whatever sits
// below the box (mode hints, user-configured status lines) is not draft text.
// Claude draws prompt suggestions after the caret in dim text. With ANSI kept,
// that ghost text is dropped; real draft text is never dim.
const withoutGhostText=line=>line.replace(/\x1b\[[0-9;:]*2m[^\x1b]*(?:\x1b\[[0-9;:]*m)?/g,'').replace(/\x1b\[[0-9;:]*m/g,'');
export function hasEmptyClaudeModelComposer(text) {
  const lines=text.split('\n').map(withoutGhostText),index=lines.findLastIndex(line=>/^\s*❯\s*(?:Try ".*")?\s*$/.test(line));
  if(index<0)return false;
  const next=lines.slice(index+1).find(line=>line.trim());
  return next===undefined||/^\s*[─━▔]{3,}\s*$/.test(next)||/^\s*\? for shortcuts\s*$/.test(next);
}
export async function openAgentModelMenu(herdr,id,current) {
  if(current.agent==='codex')return openCodexModelMenu(herdr,id,current);
  if(current.agent==='opencode')return openOpenCodeModelMenu(herdr,id,current);
  if(current.agent!=='claude'||!['idle','done'].includes(current.agent_status))fail('Wait until the agent finishes before changing the model.');
  const {read}=await herdr.call('pane.read',{pane_id:id,source:'visible',format:'ansi',strip_ansi:false,lines:120});
  if(!hasEmptyClaudeModelComposer(read.text))fail('Clear the desktop draft or close its dialog before changing the model.');
  if(!['idle','done'].includes((await verify(herdr,id,current)).agent_status))fail('The agent is no longer idle.');
  await herdr.call('pane.send_input',{pane_id:id,text:'/model',keys:['enter']});
  await learnClaudeModelList(herdr,id,current);
  return {opened:true};
}
const settle=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForClaudeMenu(herdr,id,current,moved) {
  for(let attempt=0;attempt<25;attempt++) {
    await settle(80);
    const menu=await readAgentModelMenu(herdr,id,current);
    if(menu&&(moved===null||menu.selectedIndex===moved))return menu;
  }
  return null;
}
// Scrolls the native picker to its first and last rows and back so every model
// name is known. Failure leaves the picker open; the phone then shows what it can see.
async function learnClaudeModelList(herdr,id,current) {
  try {
    const menu=await waitForClaudeMenu(herdr,id,current,null);
    if(!menu||!menu.options.some(label=>/^Model \d+$/.test(label)))return;
    const home=menu.selectedIndex,last=menu.options.length-1;
    let at=home;
    const moveTo=async target=>{
      while(at!==target) {
        const step=Math.min(6,Math.abs(target-at))*Math.sign(target-at);
        await herdr.call('pane.send_keys',{pane_id:id,keys:Array(Math.abs(step)).fill(step>0?'down':'up')});at+=step;
        if(!await waitForClaudeMenu(herdr,id,current,at))throw new Error('menu moved');
      }
    };
    await moveTo(0);await moveTo(last);await moveTo(home);
  } catch {}
}
export async function actAgentModelMenu(herdr,id,current,action) {
  if(current.agent==='codex')return actCodexModelMenu(herdr,id,current,action);
  if(current.agent==='opencode')return actOpenCodeModelMenu(herdr,id,current,action);
  if(current.agent!=='claude')fail('This conversation does not support model selection.');
  let menu=await readAgentModelMenu(herdr,id,current);
  if(!menu||menu.id!==action.menuId)fail('The model menu changed. Refresh and choose again.');
  const option=action.option;
  if(!action.cancel&&(!Number.isInteger(option)||option<0||option>=menu.options.length))fail('Choose a visible model option.');
  await verify(herdr,id,current);
  if(action.cancel){await herdr.call('pane.send_keys',{pane_id:id,keys:['esc']});return {cancelled:true};}
  const delta=option-menu.selectedIndex;
  if(delta) {
    await herdr.call('pane.send_keys',{pane_id:id,keys:Array(Math.abs(delta)).fill(delta>0?'down':'up')});
    for(let attempt=0;attempt<10;attempt++) {
      menu=await readAgentModelMenu(herdr,id,await verify(herdr,id,current));
      if(!menu||menu.id!==action.menuId)fail('The model menu changed while selecting.');
      if(menu.selectedIndex===option)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  menu=await readAgentModelMenu(herdr,id,await verify(herdr,id,current));
  if(!menu||menu.id!==action.menuId||menu.selectedIndex!==option)fail('The model cursor changed. Refresh before selecting.');
  // 's' is Claude's native session-only action. Enter would change the user's
  // default for new conversations, so the model picker never gets Enter. The
  // yes/no confirmation that may follow has no default to change: Enter answers it.
  await herdr.call('pane.send_keys',{pane_id:id,keys:[menu.stage==='confirm'?'enter':'s']});return {selected:true};
}
export async function keyAgentModelMenu(herdr,id,current,action) {
  if(current.agent!=='opencode')fail('This conversation does not use native model navigation.');
  return keyOpenCodeModelMenu(herdr,id,current,action);
}
