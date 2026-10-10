import {createHash} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {BridgeError} from './herdr.js';
import {paneIdentity} from './pane-attachment.js';

const row=/^\s*([❯›])?\s*(\d{1,2})\.\s+(?:\[([^\]]?)\]\s*)?(.+?)\s*$/;
const border=/^[\s─━═│┃╭╮╰╯┌┐└┘]+$/;
const footer=/^Enter to select\s*[·•]\s*(?:Tab\/Arrow keys|↑\/↓) to navigate(?:\s*[·•]\s*ctrl\+g to edit in Vim)?(?:\s*[·•]\s*Esc to cancel)?$/i;
const pause=()=>new Promise(resolve=>setTimeout(resolve,50));
const stale=message=>new BridgeError('question_stale',message,409);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const headerQuestions=value=>value.replace(/[☐☑☒✔✓]/g,'□');

// Claude renders the unfocused empty inline field in gray (SGR 246), and
// places the inverse-video caret on its first character when focused. That
// focused visual can also be a literal desktop draft with its caret at Home,
// so action dispatch additionally probes and restores one character.
function emptyInlineField(rawLines,index,focused,label) {
  let foreground=null,dim=false,inverse=false;
  let cells=[];
  for(let lineIndex=0;lineIndex<=index;lineIndex++) {
    cells=[];
    const raw=rawLines[lineIndex];
    for(let cursor=0;cursor<raw.length;) {
      if(raw[cursor]==='\u001b') {
        const sgr=/^\u001b\[([\d;]*)m/.exec(raw.slice(cursor));
        if(!sgr)return false;
        const codes=sgr[1]?sgr[1].split(';').map(Number):[0];
        for(let part=0;part<codes.length;part++) {
          const code=codes[part];
          if(code===0){foreground=null;dim=false;inverse=false;}
          else if(code===39)foreground=null;
          else if((code>=30&&code<=37)||(code>=90&&code<=97))foreground='basic';
          else if(code===2)dim=true;
          else if(code===22)dim=false;
          else if(code===7)inverse=true;
          else if(code===27)inverse=false;
          else if(code===38&&codes[part+1]===5){foreground=codes[part+2];part+=2;}
          else if(code===38&&codes[part+1]===2){
            foreground=codes.slice(part+2,part+5).join(',');part+=4;
          } else if((code===48||code===58)&&codes[part+1]===5)part+=2;
          else if((code===48||code===58)&&codes[part+1]===2)part+=4;
        }
        cursor+=sgr[0].length;
      } else {cells.push({char:raw[cursor],foreground,dim,inverse});cursor++;}
    }
  }
  const visible=cells.map(cell=>cell.char).join('');
  const start=visible.lastIndexOf(label);
  if(start<0)return false;
  const field=cells.slice(start,start+label.length);
  if(focused)return field[0]?.inverse===true&&field.slice(1).every(cell=>!cell.inverse);
  return field.every(cell=>cell.dim||cell.foreground===246||cell.foreground==='148,148,148');
}

/** A complete, current Claude Code AskUserQuestion choice menu. */
export function detectClaudeQuestion(text) {
  if(typeof text!=='string'||text.length>24000)return null;
  const ansiLines=text.split('\n');
  const rawLines=stripVTControlCharacters(text).split('\n').map(line=>line.replace(/\u2800/g,' '));
  const lines=rawLines.map(line=>line
    .replace(/^\s*[│┃]\s?/,'').replace(/\s*[│┃]\s*$/,''));
  const meaningful=lines.map((line,index)=>line.trim()&&!border.test(line)?index:-1).filter(index=>index>=0);
  const end=meaningful.at(-1);
  if(end===undefined)return null;
  // Claude may wrap the key hint at the terminal edge. It must be the final
  // visible content, so an old menu in scrollback cannot authorize an answer.
  let footerStart=-1;
  for(let count=1;count<=3&&count<=meaningful.length;count++) {
    const start=meaningful.at(-count);
    const candidate=lines.slice(start,end+1).map(line=>line.trim()).filter(Boolean).join(' ');
    if(footer.test(candidate)){footerStart=start;break;}
  }
  if(footerStart<0||footerStart<2)return detectClaudeReview(lines);
  const headerIndex=lines.findLastIndex((line,index)=>index<footerStart&&(
    /^\s*←.*\bSubmit\b.*→\s*$/.test(line)||
    /^\s*[☐☑☒✔✓]\s+\S/.test(line)&&index>0&&border.test(lines[index-1])));
  if(headerIndex<0||headerIndex<footerStart-100)return null;
  const tabbed=/^\s*←.*\bSubmit\b.*→\s*$/.test(lines[headerIndex]);
  const gutterIndices=[];
  let rowStart;
  let promptLines;
  if(tabbed) {
    for(let index=headerIndex+1;index<footerStart;index++)
      if(/^\s*[│┃]\s+\S/.test(rawLines[index]))gutterIndices.push(index);
  }
  if(tabbed&&gutterIndices.length) {
    if(gutterIndices.length>12)return null;
    if(lines.slice(headerIndex+1,gutterIndices[0]).some(line=>line.trim()&&!border.test(line)))return null;
    promptLines=gutterIndices.map(index=>lines[index].trim());
    rowStart=gutterIndices.at(-1)+1;
  } else {
    const firstRow=lines.findIndex((line,index)=>index>headerIndex&&index<footerStart&&
      row.exec(line)?.[2]==='1');
    if(firstRow<0)return null;
    promptLines=lines.slice(headerIndex+1,firstRow).filter(line=>line.trim()&&!border.test(line)).map(line=>line.trim());
    if(promptLines.length<1||promptLines.length>12)return null;
    rowStart=firstRow;
  }
  const prompt=promptLines.join(' ').replace(/\s+/g,' ').trim();
  if(!prompt||prompt.length>2048||prompt.includes('…'))return null;
  const rows=[];let selected=null;
  for(let index=rowStart;index<footerStart;index++) {
    const match=row.exec(lines[index]);
    if(!match)continue;
    const number=Number(match[2]);
    if(!rows.length&&number!==1)continue;
    if(rows.length&&number!==rows.length+1)return null;
    if(rows.length>=34)return null;
    if(match[1]) {
      if(selected!==null)return null;
      selected=rows.length;
    }
    rows.push({index,label:match[4],checked:match[3]===undefined?null:match[3].trim().length>0,
      focused:Boolean(match[1])});
  }
  if(rows.length&&lines.slice(rowStart,rows[0].index).some(line=>line.trim()&&!border.test(line)))return null;
  if(rows.length<3)return null;
  const multi=rows[0].checked!==null;
  const chat=/^Chat about this$/i.test(rows.at(-1).label);
  const typeIndex=chat?rows.length-2:rows.length-1;
  if(typeIndex<2)return null;
  if(rows.slice(0,typeIndex+1).some(item=>(item.checked!==null)!==multi)||
     chat&&rows.at(-1).checked!==null)return null;
  const type=rows[typeIndex];
  const emptyType=/^Type something\.?$/i.test(type.label)&&
    emptyInlineField(ansiLines,type.index,selected===typeIndex,type.label);
  // The last numbered row is Claude's inline custom-answer editor. Once a
  // user drafts there, its label becomes the draft itself.
  const otherDraft=emptyType?null:type.label;
  if(!chat&&!multi)return null;
  let submitIndex=null,submitLabel=null;
  if(multi) {
    const tail=lines.slice(type.index+1,chat?rows.at(-1).index:footerStart)
      .filter(line=>line.trim()&&!border.test(line));
    const submits=tail.map(line=>/^\s*([❯›])?\s*(Submit|Next)\s*$/.exec(line));
    if(submits.length!==1||!submits[0])return null;
    submitIndex=chat?rows.length-1:rows.length;submitLabel=submits[0][2];
    if(submits[0][1]) {
      if(selected!==null)return null;
      selected=submitIndex;
    }
  }
  if(multi&&chat&&rows.at(-1).focused)selected++;
  if(selected===null)return null;
  const contextHeader=lines[headerIndex].trim();
  const options=[];
  for(let item=0;item<typeIndex;item++) {
    const after=rows[item+1].index;
    const description=[];
    for(let index=rows[item].index+1;index<after;index++) {
      const line=lines[index].trim();
      if(line&&!border.test(line))description.push(line);
    }
    const label=[rows[item].label,...description].join(' ').replace(/\s+/g,' ').trim();
    if(!label||label.length>1024||label.includes('…'))return null;
    options.push(label);
  }
  if(chat&&lines.slice(rows.at(-1).index+1,footerStart).some(line=>line.trim()&&!border.test(line)))return null;
  const selectedOptions=multi?rows.slice(0,typeIndex+1).flatMap((item,index)=>item.checked?[index]:[]):[];
  // Once Claude has accepted a custom multi-select value it can leave focus on
  // that row. Keep the native Submit/Next action available in that state.
  const stage=selected===typeIndex&&(!multi||otherDraft===null)
    ?'text':multi?'multi':'choices';
  // In the current multi renderer, Down from Type reaches Submit before the
  // separately numbered Chat row.
  return {prompt,options:[...options,multi?'Type something':'Type something.',
    ...(multi?[submitLabel]:[]),...(chat?['Chat about this']:[])],selectedIndex:selected,stage,
    otherDraft,selectedOptions,multiSelect:multi,typeIndex,chatIndex:chat?(multi?rows.length:rows.length-1):null,
    submitIndex,contextHeader};
}

function detectClaudeReview(lines) {
  const content=lines.filter(line=>line.trim()&&!border.test(line));
  const start=content.findLastIndex(line=>line.trim()==='Review your answers');
  if(start<0||start<content.length-24)return null;
  const reviewIndex=lines.findLastIndex(line=>line.trim()==='Review your answers');
  const headerIndex=lines.findLastIndex((line,index)=>index<reviewIndex&&
    /^\s*←.*\bSubmit\b.*→\s*$/.test(line));
  if(headerIndex<0)return null;
  const tail=content.slice(start);
  if(!tail.some(line=>line.trim()==='Ready to submit your answers?'))return null;
  if(!/^\s*[❯›]\s*(?:1\.\s+)?Submit answers\s*$/.test(tail.at(-2)??'')||
     !/^\s*(?:2\.\s+)?Cancel\s*$/.test(tail.at(-1)??''))return null;
  const ready=tail.findIndex(line=>line.trim()==='Ready to submit your answers?');
  const summary=tail.slice(1,ready).map(line=>line.trim()).filter(Boolean).join(' ').replace(/\s+/g,' ');
  if(!summary||summary.length>1800||summary.includes('…'))return null;
  const contextHeader=lines[headerIndex].trim();
  return {prompt:`Review your answers — ${summary}`,options:['Submit answers'],selectedIndex:0,
    stage:'review',otherDraft:null,selectedOptions:[],multiSelect:false,
    typeIndex:null,chatIndex:null,submitIndex:0,contextHeader};
}

export const claudeQuestionSemantic=(question,pane)=>hash({pane:paneIdentity(pane),
  prompt:question.prompt,options:question.options,stage:question.stage,
  selectedOptions:question.selectedOptions,otherDraft:question.otherDraft,
  contextHeader:question.contextHeader});

export async function readClaudeQuestionScreen(herdr,id,first) {
  const before=(await herdr.call('pane.get',{pane_id:id})).pane;
  if(paneIdentity(before)!==paneIdentity(first)||before.agent!=='claude')
    throw stale('The Claude pane changed. Refresh it.');
  const {read}=await herdr.call('pane.read',{pane_id:id,source:'visible',format:'ansi',strip_ansi:false,lines:120});
  const after=(await herdr.call('pane.get',{pane_id:id})).pane;
  if(paneIdentity(after)!==paneIdentity(first))
    throw stale('The Claude pane changed while it was read. Refresh it.');
  const question=read.truncated?null:detectClaudeQuestion(read.text);
  const visible=typeof read.text==='string'?stripVTControlCharacters(read.text):'';
  const visibleLines=visible.split('\n');
  const composerIndex=visibleLines.findLastIndex(line=>/^\s*❯\s*(?:Try \".*\")?\s*$/.test(line));
  const trailingContent=visibleLines.slice(composerIndex+1).filter(line=>line.trim()&&!border.test(line));
  // Only a bottom composer proves the prior question has gone. An older
  // composer above a partially painted current menu is just scrollback.
  const normalComposer=composerIndex>=0&&trailingContent.length<=3&&
    trailingContent.every(line=>/\? for shortcuts|← for agents|manual mode on|auto mode on|\bContext\s+\d+%\s+left\b|tab to queue message/i.test(line));
  return {question,collapsed:false,transitioned:!read.truncated&&!question&&normalComposer,
    truncated:read.truncated===true};
}

export async function actClaudeQuestion(herdr,id,first,expected,{option,text,cancel},onWrite) {
  let wrote=false;
  const uncertain=message=>{const error=stale(message);if(wrote)error.paneId=id;throw error;};
  const readExpected=async({allowSelectionChange=false,allowDraftChange=false,
    allowHeaderStatusChange=false}={})=>{
    let screen;
    try{screen=await readClaudeQuestionScreen(herdr,id,first);}
    catch(error){if(wrote)error.paneId=id;throw error;}
    const current=screen.question;
    if(!current||current.prompt!==expected.prompt||current.multiSelect!==expected.multiSelect||
       (allowHeaderStatusChange
         ?headerQuestions(current.contextHeader)!==headerQuestions(expected.contextHeader)
         :current.contextHeader!==expected.contextHeader)||
       JSON.stringify(current.options)!==JSON.stringify(expected.options)||
       !allowSelectionChange&&JSON.stringify(current.selectedOptions)!==JSON.stringify(expected.selectedOptions)||
       !allowDraftChange&&current.otherDraft!==expected.otherDraft)
      uncertain('The native question changed. Inspect the pane before retrying.');
    return current;
  };
  let current=await readExpected();
  if(current.selectedIndex!==expected.selectedIndex||
     JSON.stringify(current.selectedOptions)!==JSON.stringify(expected.selectedOptions)||
     current.otherDraft!==expected.otherDraft)
    throw stale('The question selection changed. Refresh before answering.');
  const send=async(method,params)=>{
    wrote=true;onWrite();
    try{await herdr.call(method,{pane_id:id,...params});}
    catch(error){error.paneId=id;throw error;}
  };
  const key=key=>send('pane.send_keys',{keys:[key]});
  if(cancel===true){await key('esc');return {dispatched:true};}
  if(current.stage==='text') {
    if(current.otherDraft!==null||typeof text!=='string'||text.length<1||text.length>500||
       text.trim()!==text||/[\u0000-\u001f\u007f-\u009f]/.test(text))
      throw new BridgeError('invalid_question_text','Enter a single-line answer in the empty question field.',400);
    // The selected native placeholder and a desktop draft literally reading
    // "Type something." can look identical when the caret is at Home. Probe
    // one character and undo it before the phone's answer. The probe only
    // continues if the field contained no draft.
    const readTextChange=async()=>{
      const next=await readExpected({allowDraftChange:true,allowSelectionChange:true,
        allowHeaderStatusChange:true});
      if(next.selectedIndex!==current.selectedIndex)
        uncertain('The native input focus changed. Inspect the pane.');
      const authored=items=>items.filter(index=>index!==current.typeIndex);
      if(JSON.stringify(authored(next.selectedOptions))!==
         JSON.stringify(authored(current.selectedOptions)))
        uncertain('The native checkbox selection changed. Inspect the pane.');
      return next;
    };
    await send('pane.send_text',{text:'x'});
    let probe;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await readTextChange();
      if(next.otherDraft!==null){probe=next.otherDraft;break;}
      await pause();
    }
    if(probe===undefined)uncertain('The native custom field could not be verified. Inspect the pane.');
    if(probe!=='x'&&probe!==`x${current.options[current.typeIndex]}`)
      uncertain('The native custom draft changed during verification. Inspect the pane.');
    await key('backspace');
    let restored=false;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await readTextChange();
      if(next.otherDraft===null&&JSON.stringify(next.selectedOptions)===
         JSON.stringify(current.selectedOptions)){restored=true;break;}
      await pause();
    }
    if(!restored||probe!=='x')uncertain('The native custom field had a draft. Inspect the pane before retrying.');
    await send('pane.send_text',{text});
    let inserted=false;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await readTextChange();
      if(next.selectedIndex===current.selectedIndex&&next.otherDraft===text&&
         (!current.multiSelect||next.selectedOptions.includes(current.typeIndex))){inserted=true;break;}
      await pause();
    }
    if(!inserted)uncertain('The native custom answer could not be verified. Inspect the pane.');
    if(current.multiSelect)return {selected:true};
    await key('enter');
    return {dispatched:true};
  }
  if(!Number.isInteger(option)||option<0||option>=current.options.length)
    throw new BridgeError('invalid_question_option','Choose a visible question option.',400);
  if(current.stage==='review') {
    if(option!==0)throw new BridgeError('invalid_question_option','Choose the visible review action.',400);
    await key('enter');return {dispatched:true};
  }
  while(current.selectedIndex!==option) {
    const direction=option>current.selectedIndex?1:-1;
    await key(direction>0?'down':'up');
    let moved=false;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await readExpected();
      if(next.selectedIndex===current.selectedIndex+direction){current=next;moved=true;break;}
      await pause();
    }
    if(!moved)uncertain('The question cursor did not move as expected. Inspect the pane.');
  }
  current=await readExpected();
  if(current.selectedIndex!==option)uncertain('The question selection changed. Inspect the pane.');
  if(option===current.typeIndex&&(!current.multiSelect||current.otherDraft===null))
    return {stage:'text',opened:true};
  if(current.multiSelect&&option<=current.typeIndex) {
    const before=current.selectedOptions.includes(option);
    await key('enter');
    let toggled=false;
    for(let attempt=0;attempt<10;attempt++) {
      const next=await readExpected({allowSelectionChange:true,allowHeaderStatusChange:true});
      const changes=[...new Set([...current.selectedOptions,...next.selectedOptions])]
        .filter(index=>current.selectedOptions.includes(index)!==next.selectedOptions.includes(index));
      if(changes.length===1&&changes[0]===option&&next.selectedOptions.includes(option)!==before){toggled=true;break;}
      await pause();
    }
    if(!toggled)uncertain('The native checkbox did not change. Inspect the pane.');
    return {selected:!before};
  }
  await key('enter');
  return {dispatched:true};
}
