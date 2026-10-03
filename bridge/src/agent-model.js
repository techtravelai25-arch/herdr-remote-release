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
const optionRow=/^\s*([❯›])?\s*(\d{1,2})\.\s+(.+?)\s*$/;
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
  const options=[];let selectedIndex=null,afterRows=false;
  for(const line of lines.slice(start+1,footer)) {
    const match=optionRow.exec(line);
    if(match) {
      if(afterRows||+match[2]!==options.length+1)return null;
      if(match[1]){if(selectedIndex!==null)return null;selectedIndex=options.length;}
      options.push(match[3]);
    } else if(options.length&&line.trim()) {
      if(/(?:effort|Fast mode|\/fast|models? hidden|more models)/i.test(line)){afterRows=true;continue;}
      if(afterRows)continue;
      if(!/^\s{2,}\S/.test(line))return null;
      options[options.length-1]+=' '+line.trim();
    }
  }
  if(!options.length||options.length>32||selectedIndex===null)return null;
  return {id:hash({options}),title:'Select model',options,selectedIndex,stage:'model',provider:'claude',sessionOnly:true};
}
export function detectAgentModelMenu(text,agent) {
  if(agent==='codex')return detectCodexModelMenu(text);
  if(agent==='claude')return detectClaudeModelMenu(text);
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
  return bindAgentModelMenu(detectAgentModelMenu(await readText(herdr,id),pane.agent),pane);
}
async function verify(herdr,id,first) {
  const {pane}=await herdr.call('pane.get',{pane_id:id});
  if(pane.agent!==first.agent||pane.pane_id!==first.pane_id||pane.cwd!==first.cwd||
    ['terminal_id','agent_session'].some(key=>JSON.stringify(pane[key]??null)!==JSON.stringify(first[key]??null))||
    ['working','starting','stopped','error'].includes(pane.agent_status))fail('The conversation changed. Refresh before changing the model.');
  return pane;
}
export function hasEmptyClaudeModelComposer(text) {
  const lines=text.split('\n'),index=lines.findLastIndex(line=>/^\s*❯\s*$/.test(line));
  if(index<0)return false;
  return lines.slice(index+1).every(line=>border(line)||/^\s*\[[^\]\r\n]{1,100}\] \d+% ctx \(in [\d.,KM]+\/out [\d.,KM]+\) \$[\d.,]+\s*$/.test(line)||/^\s*⏸ manual mode on(?: · ← \d+ agents?)?\s*$/.test(line)||/^\s*(?:\? for shortcuts|(?:⏵⏵\s*)?(?:bypass permissions|accept edits|plan mode) on(?:\s*\(shift\+tab to cycle\))?)[\s·]*$/.test(line));
}
export async function openAgentModelMenu(herdr,id,current) {
  if(current.agent==='codex')return openCodexModelMenu(herdr,id,current);
  if(current.agent==='opencode')return openOpenCodeModelMenu(herdr,id,current);
  if(current.agent!=='claude'||!['idle','done'].includes(current.agent_status))fail('Wait until the agent finishes before changing the model.');
  if(!hasEmptyClaudeModelComposer(await readText(herdr,id)))fail('Clear the desktop draft or close its dialog before changing the model.');
  if(!['idle','done'].includes((await verify(herdr,id,current)).agent_status))fail('The agent is no longer idle.');
  await herdr.call('pane.send_input',{pane_id:id,text:'/model',keys:['enter']});return {opened:true};
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
  // default for new conversations. Never silently replace it with Enter.
  await herdr.call('pane.send_keys',{pane_id:id,keys:['s']});return {selected:true};
}
export async function keyAgentModelMenu(herdr,id,current,action) {
  if(current.agent!=='opencode')fail('This conversation does not use native model navigation.');
  return keyOpenCodeModelMenu(herdr,id,current,action);
}
