import {createHash} from 'node:crypto';
import {BridgeError} from './herdr.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message,code='model_stale')=>{throw new BridgeError(code,message,409);};
const sgr=/\x1b\[[0-9;:]*m/g;
const plain=value=>value.replace(sgr,'');
const same=(a,b)=>b?.pane_id===a.pane_id&&b.agent==='opencode'&&b.cwd===a.cwd&&
  ['terminal_id','agent_session'].every(key=>JSON.stringify(a[key]??null)===JSON.stringify(b[key]??null));
const available=pane=>pane.agent==='opencode'&&!['working','starting','stopped','error'].includes(pane.agent_status);
const idle=pane=>pane.agent==='opencode'&&['idle','done'].includes(pane.agent_status);

function styledRows(ansi) {
  let style='',bg=null;
  return ansi.split('\n').map(line=>{
    const cells=[];
    for(const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
      if(part.startsWith('\x1b[')) {
        const codes=part.slice(2,-1).split(';').map(Number);
        if(codes[0]===0){style='';bg=null;}
        style+=part;
        for(let i=0;i<codes.length;i++) {
          if(codes[i]===48&&codes[i+1]===2){bg=codes.slice(i,i+5).join(';');i+=4;}
          else if(codes[i]===48&&codes[i+1]===5){bg=codes.slice(i,i+3).join(';');i+=2;}
          else if((codes[i]>=40&&codes[i]<=47)||(codes[i]>=100&&codes[i]<=107))bg=String(codes[i]);
          else if(codes[i]===49)bg=null;
        }
      } else for(const text of part) {
        const point=text.codePointAt(0);
        if(/\p{Mark}/u.test(text)){if(cells.length)cells.at(-1).text+=text;continue;}
        cells.push({text,style,bg});
        if(point>=0x1100&&(point<=0x115f||point>=0x2e80&&point<=0xa4cf||point>=0xac00&&point<=0xd7a3||point>=0xf900&&point<=0xfaff||point>=0xff01&&point<=0xff60||point>=0x1f300))cells.push({text:'',style,bg});
      }
    }
    return cells;
  });
}
function encode(cells) {
  let output='',style=null;
  for(const cell of cells){if(cell.style!==style){output+='\x1b[0m'+cell.style;style=cell.style;}output+=cell.text;}
  return output+'\x1b[0m';
}
function optionsFromOverlay(crop,background) {
  const text=crop.map(row=>row.map(cell=>cell.text).join(''));
  const footer=text.findIndex((line,index)=>index>2&&/^\s*Connect provider ctrl\+a\s+Favorite ctrl\+f\s*$/.test(line));
  if(footer<4||text.slice(footer+1).some(line=>line.trim()))return null;
  const options=[];let selectedIndex=-1,section='';
  for(const row of crop.slice(3,footer)) {
    const value=row.map(cell=>cell.text).join('').trim();
    if(!value)continue;
    const visible=row.filter(cell=>cell.text.trim());
    const highlighted=row.slice(1,-1).filter(cell=>cell.bg&&cell.bg!==background).length>=row.length*0.6;
    // Group headings are bold on the modal background; the highlighted model
    // is bold too, but its distinct background covers the row.
    if(!highlighted&&visible[0]?.style.includes('\x1b[1m')) {section=value;continue;}
    if(value.includes('●')&&!/^●\s+/.test(value))return null;
    const label=value.replace(/^●\s+/,'').replace(/\s{2,}/g,' · ');
    const option=section?`${section} · ${label}`:label;
    if(!option||option.length>120||options.includes(option))return null;
    if(highlighted){if(selectedIndex>=0)return null;selectedIndex=options.length;}
    options.push(option);
  }
  if(!options.length||options.length>50||selectedIndex<0)return null;
  return {options,selectedIndex};
}
function overlayMenu(safe) {
  const rows=styledRows(safe);
  for(let top=rows.length-1;top>=1;top--) {
    const line=rows[top].map(cell=>cell.text).join(''),match=/Select (?:model|variant)(?:\s+\d+(?:\/\d+)?)?\s+esc/.exec(line);
    if(!match)continue;
    const anchor=match.index,bg=rows[top][anchor]?.bg;
    if(!bg)continue;
    let left=anchor,right=anchor;
    while(left>0&&rows[top][left-1]?.bg===bg)left--;
    while(right<rows[top].length&&rows[top][right]?.bg===bg)right++;
    if(right-left<20||left===0||right===rows[top].length)continue;
    const edge=row=>row?.[left]?.bg===bg&&row?.[right-1]?.bg===bg;
    if(!edge(rows[top-1])||rows[top-1].slice(left,right).some(cell=>cell.text.trim()))continue;
    let bottom=top+1;
    while(bottom<rows.length&&edge(rows[bottom]))bottom++;
    if(bottom>=rows.length||bottom-top<6)continue;
    const crop=rows.slice(top,bottom).map(row=>row.slice(left,right));
    const text=crop.map(row=>row.map(cell=>cell.text).join(''));
    if(text.at(-1).trim()||text[1]?.trim()||text[2]?.trim()!=='Search')continue;
    // The highlighted native row has a distinct background. The filled circle
    // marks the configured model and can stay put when the cursor moves.
    const choices=optionsFromOverlay(crop,bg);
    if(!choices)continue;
    const ansi=crop.map(encode).join('\n');
    return {id:hash({ansi}),title:match[0].replace(/(?:\s+\d+(?:\/\d+)?)?\s+esc$/,''),stage:'model',provider:'opencode',mode:'options',options:choices.options,selectedIndex:choices.selectedIndex};
  }
  return null;
}

// OpenCode's picker uses a row background for cursor selection rather than
// numbered rows. Only the complete recognized overlay yields tappable choices;
// the older text-only shape is kept for fixtures but not exposed by read().
export function detectOpenCodeModelMenu(ansi) {
  if(typeof ansi!=='string'||ansi.length>65536)return null;
  const safe=ansi.replace(/\r\n/g,'\n').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'');
  if(/[\x00-\x08\x0b-\x1f\x7f]/.test(plain(safe)))return null;
  const overlay=overlayMenu(safe);
  if(overlay)return overlay;
  const lines=safe.split('\n'),texts=lines.map(plain);
  const start=texts.findLastIndex(line=>/^\s*Select (?:model|variant)(?:\s+\d+(?:\/\d+)?)?\s+esc\s*$/.test(line));
  if(start<0)return null;
  const end=texts.findIndex((line,index)=>index>start&&/^\s*▀{3,}\s*$/.test(line));
  if(end<0||texts.slice(end+1).some(line=>line.trim()))return null;
  const search=texts.findIndex((line,index)=>index>start&&index<end&&/^\s+Search\s*$/.test(line));
  if(search<0||texts.slice(start+1,search).some(line=>line.trim()))return null;
  const rows=texts.slice(search+1,end).filter(line=>line.trim());
  if(!rows.length||rows.some(line=>!/^\s{2,}\S/.test(line)))return null;
  const body=lines.slice(search+1,end).join('\n');
  // Background styling is needed for visible selection feedback on the phone.
  if(!/\x1b\[[0-9;:]*(?:48[;:]|4[0-7](?:;|m)|10[0-7](?:;|m))/.test(body))return null;
  const title=texts[start].trim().replace(/(?:\s+\d+(?:\/\d+)?)?\s+esc$/,'');
  const text=texts.slice(start,end+1).join('\n');
  return {id:hash({ansi:lines.slice(start,end+1).join('\n')}),title,stage:'model',provider:'opencode',mode:'terminal',ansi:lines.slice(start,end+1).join('\n'),text,options:[],selectedIndex:-1};
}

async function read(herdr,id) {
  const {read}=await herdr.call('pane.read',{pane_id:id,source:'visible',format:'ansi',strip_ansi:false,lines:120});
  return read.text;
}
function bind(menu,pane) {
  return menu?{...menu,id:hash({menu:menu.id,pane:pane.pane_id,terminal:pane.terminal_id??null,session:pane.agent_session??null,cwd:pane.cwd})}:null;
}
async function verify(herdr,id,current) {
  const {pane}=await herdr.call('pane.get',{pane_id:id});
  if(!same(current,pane)||!available(pane))fail('The conversation changed. Refresh before changing the model.');
  return pane;
}
export async function readOpenCodeModelMenu(herdr,id,pane) {
  if(!available(pane))return null;
  const menu=detectOpenCodeModelMenu(await read(herdr,id));
  return bind(menu?.mode==='options'?menu:null,pane);
}

export function hasEmptyOpenCodeComposer(ansi) {
  if(typeof ansi!=='string')return false;
  const lines=plain(ansi.replace(/\r\n/g,'\n')).split('\n');
  if(lines.some(line=>/^\s*(?:Select (?:model|variant)|Connect a provider|Commands|Permissions?|Questions?|Sessions)\b.*\besc\s*$/.test(line)))return false;
  const model=lines.findLastIndex(line=>/^\s*┃\s+(?:Build|Plan)(?:\s+auto)?\s+·\s+\S.*$/.test(line));
  if(model<0)return false;
  let start=model;
  while(start>0&&/^\s*┃/.test(lines[start-1])&&!/^\s*┃.+┃\s*$/.test(lines[start-1]))start--;
  const input=lines.slice(start,model);
  if(input.length<3)return false;
  let placeholder=false;
  for(const line of input) {
    if(/^\s*┃\s*$/.test(line))continue;
    if(!placeholder&&/^\s*┃\s+Ask anything(?:…|\.\.\.) "[^"\n]+"\s*$/.test(line)){placeholder=true;continue;}
    return false;
  }
  const tail=lines.slice(model+1).filter(line=>line.trim()).map(line=>line.trimEnd());
  if(!/^\s*╹▀{3,}\s*$/.test(tail[0]??''))return false;
  // The captured in-conversation footer includes project path, token count,
  // command shortcut and OpenCode version. Requiring its anchored identity
  // avoids treating an arbitrary empty-looking box as the composer.
  if(placeholder&&/^\s*tab agents\s+ctrl\+p commands\s*$/.test(tail[1]??'')&&tail.length===3&&/^\s+.+\s+\d+\.\d+\.\d+\s*$/.test(tail[2]))return true;
  return tail.length===2&&/^\s+.+\s+ctrl\+p commands\s+• OpenCode \d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/.test(tail[1]);
}
export async function openOpenCodeModelMenu(herdr,id,current) {
  if(!idle(current))fail('Wait until OpenCode finishes before changing the model.','model_unavailable');
  if(!hasEmptyOpenCodeComposer(await read(herdr,id)))fail('Clear the desktop draft or close its dialog before changing the model.','model_unavailable');
  if(!idle(await verify(herdr,id,current)))fail('OpenCode is no longer idle.');
  await herdr.call('pane.send_input',{pane_id:id,text:'/models'});
  let commandReady=false;
  for(let attempt=0;attempt<10;attempt++) {
    await verify(herdr,id,current);
    const text=plain(await read(herdr,id)).replace(/\r\n/g,'\n');
    if(/^\s*┃\s+\/models\s*$/m.test(text)) {
      // Substitute only the exact command row with the native placeholder so
      // all other composer/draft/modal/footer checks remain in effect.
      const empty=text.replace(/^(\s*┃)\s+\/models\s*$/m,'$1  Ask anything… "model selection"');
      if(hasEmptyOpenCodeComposer(empty)){commandReady=true;break;}
    }
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  if(!commandReady)fail('The model command has not appeared. Refresh before continuing.');
  await verify(herdr,id,current);
  const finalText=plain(await read(herdr,id)).replace(/\r\n/g,'\n');
  if(!/^\s*┃\s+\/models\s*$/m.test(finalText)||!hasEmptyOpenCodeComposer(finalText.replace(/^(\s*┃)\s+\/models\s*$/m,'$1  Ask anything… "model selection"')))fail('The model command changed. Refresh before continuing.');
  await herdr.call('pane.send_keys',{pane_id:id,keys:['enter']});
  return {opened:true};
}
export async function keyOpenCodeModelMenu(herdr,id,current,{menuId,key}) {
  if(!['up','down','esc'].includes(key))throw new BridgeError('invalid_model_selection','Choose a model-menu navigation action.');
  if(!available(current))fail('This conversation is not ready to change models.');
  let menu=await readOpenCodeModelMenu(herdr,id,current);
  if(!menu||menu.id!==menuId)fail('The model menu changed. Refresh and choose again.');
  const next=await verify(herdr,id,current);
  menu=await readOpenCodeModelMenu(herdr,id,next);
  if(!menu||menu.id!==menuId)fail('The model menu changed. Refresh and choose again.');
  await herdr.call('pane.send_keys',{pane_id:id,keys:[key]});
  return key==='esc'?{cancelled:true}:{sent:true};
}
export async function actOpenCodeModelMenu(herdr,id,current,{menuId,option,cancel}) {
  if(cancel)return keyOpenCodeModelMenu(herdr,id,current,{menuId,key:'esc'});
  let menu=await readOpenCodeModelMenu(herdr,id,current);
  if(!menu||menu.id!==menuId)fail('The model menu changed. Refresh and choose again.');
  if(!Number.isInteger(option)||option<0||option>=menu.options.length)fail('Choose a visible model option.');
  const initialOptions=menu.options;
  const title=menu.title,target=initialOptions[option],first=menu.selectedIndex;
  const direction=option>first?'down':'up';
  for(let index=first;index!==option;) {
    const before=await readOpenCodeModelMenu(herdr,id,await verify(herdr,id,current));
    if(!before||before.title!==title||before.options[before.selectedIndex]!==menu.options[menu.selectedIndex])
      fail('The highlighted model changed. Refresh and choose again.');
    index+=option>first?1:-1;
    const expected=initialOptions[index];
    await herdr.call('pane.send_keys',{pane_id:id,keys:[direction]});
    let observed=null;
    for(let attempt=0;attempt<10;attempt++) {
      observed=await readOpenCodeModelMenu(herdr,id,await verify(herdr,id,current));
      if(observed?.title===title&&observed.options[observed.selectedIndex]===expected)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!observed||observed.title!==title||observed.options[observed.selectedIndex]!==expected)
      fail('The model cursor did not reach the chosen option. Inspect the terminal before trying again.');
    menu=observed;
  }
  const ready=await readOpenCodeModelMenu(herdr,id,await verify(herdr,id,current));
  if(!ready||ready.title!==title||ready.options[ready.selectedIndex]!==target)
    fail('The highlighted model changed. Refresh before selecting.');
  await herdr.call('pane.send_keys',{pane_id:id,keys:['enter']});
  return {selected:true};
}
