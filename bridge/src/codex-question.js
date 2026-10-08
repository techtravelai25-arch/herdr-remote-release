import {createHash} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {BridgeError} from './herdr.js';
import {paneIdentity} from './pane-attachment.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const header = /^\s*[•●]\s+Queued follow-up inputs\s*$/;
const queueCount = /^\s*\?\s+[1-9]\d*\s+questions?(?:\s*·\s*\d+s)?\s*$/i;
const queueHint = /^\s*shift\s*\+\s*←\s+to\s+answer\s*$/i;
const row = /^\s{2,4}([›❯])?\s*(\d{1,2})\.\s+(.+?)\s*$/;
const footer = /^\s*enter\s+submit\s+(?:ctrl\s*\+\s*\]|\^\])\s+skip\s+shift\s*\+\s*→\s+(?:main prompt|prev question)(?:\s+shift\s*\+\s*←\s+(?:next question|queued messages))?\s*$/i;
const clean = text => stripVTControlCharacters(text).replace(/[\u2800-\u28ff]/g, ' ').split('\n');

// Codex 0.159.2's ChatComposer::render_inline_input renders the empty
// placeholder with .dim(); populated textarea content has no dim modifier.
// A literal user draft of "Type your answer" must never pass for an empty field.
function dimmedPlaceholder(rawLines,indices) {
  let sawText=false,dim=false;
  for(const index of indices) {
    const raw=rawLines[index];
    const cells=[];
    for(let cursor=0;cursor<raw.length;) {
      if(raw[cursor]==='\u001b') {
        const sgr=/^\u001b\[([\d;]*)m/.exec(raw.slice(cursor));
        if(!sgr) return false;
        const codes=sgr[1]?sgr[1].split(';').map(Number):[0];
        for(let part=0;part<codes.length;part++) {
          const code=codes[part];
          if(code===0 || code===22) dim=false;
          else if(code===2) dim=true;
          else if([38,48,58].includes(code)) {
            // Extended color payloads can themselves contain the number 2.
            if(codes[part+1]===2) part+=4;
            else if(codes[part+1]===5) part+=2;
            else return false;
          }
        }
        cursor+=sgr[0].length;
      } else {
        cells.push({char:raw[cursor],dim});cursor++;
      }
    }
    const first=cells.findIndex(cell=>cell.char.trim());
    if(first<0) return false;
    const last=cells.findLastIndex(cell=>cell.char.trim());
    for(let pos=first;pos<=last;pos++) {
      if(cells[pos].char.trim()) {
        sawText=true;
        if(!cells[pos].dim) return false;
      }
    }
  }
  return sawText;
}

function freeTextQuestion(lines,rawLines,start,end) {
  // The zero-option editor has two blank-separated blocks: the question and
  // Codex's answer field. Keep a drafted field distinct from an empty one.
  if(rawLines.length!==lines.length) return null;
  const blocks=[]; let block=[];
  for (let index=start+1;index<end;index++) {
    const line=lines[index];
    if (!line.trim()) {
      if (block.length) {blocks.push(block);block=[];}
    } else {
      if (!/^\s{2,}\S/.test(line) || row.test(line)) return null;
      block.push(index);
    }
  }
  if (block.length) blocks.push(block);
  if (blocks.length!==2 || blocks[1].length>12) return null;
  const prompt=blocks[0].map(index=>lines[index].trim()).join(' ').replace(/\s+/g,' ').trim();
  // Keep spaces inside a typed line exactly; the post-send read must match
  // the bytes entered, including deliberate double spaces.
  const field=blocks[1].map(index=>lines[index].trim()).join(' ').trim();
  if (!prompt || prompt.length>2048 || prompt.includes('…') || !field ||
      field.length>500 || field.includes('…')) return null;
  return {prompt,options:[],selectedIndex:null,stage:'text',
    otherDraft:field==='Type your answer' && dimmedPlaceholder(rawLines,blocks[1])?null:field};
}

/** Only a current-screen queue hint may offer an explicit reveal action. */
export function hasCollapsedCodexQuestion(text) {
  if (typeof text !== 'string' || text.length > 24000) return false;
  const lines = clean(text), start = lines.findLastIndex(line => header.test(line));
  if (start < 0 || start < lines.length - 24) return false;
  let cursor=start+1;
  while (cursor<lines.length && !lines[cursor].trim()) cursor++;
  if (!queueCount.test(lines[cursor]??'') || !queueHint.test(lines[cursor+1]??'')) return false;
  const tail=lines.slice(cursor+2);
  // A real collapsed cue sits immediately above the native composer. Quoted
  // terminal history or another active modal must not authorize a key press.
  const meaningful=tail.filter(line=>line.trim());
  if (meaningful.length<2 || meaningful.length>9 ||
      !meaningful.some(line=>/^\s*[›❯]\s+\S/.test(line) && !row.test(line)) ||
      !meaningful.some(line=>/\bContext\s+\d+%\s+left\b|tab\s+to\s+queue\s+message/i.test(line))) return false;
  // An expanded menu is never also an offer to send the reveal shortcut.
  return !tail.some(line => row.test(line) || footer.test(line));
}

/** Parse the complete currently rendered Codex 0.159 async-question editor. */
export function detectCodexQuestion(text) {
  if (typeof text !== 'string' || text.length > 24000) return null;
  const lines = clean(text), rawLines=text.split('\n');
  const start = lines.findLastIndex(line => header.test(line));
  if (start < 0 || start < lines.length - 80) return null;
  let cursor = start + 1;
  while (cursor < lines.length && !lines[cursor].trim()) cursor++;
  const promptLines = [];
  while (cursor < lines.length && !row.test(lines[cursor]) && !footer.test(lines[cursor])) {
    const value = lines[cursor].trim();
    if (value) promptLines.push(value);
    cursor++;
  }
  const prompt = promptLines.join(' ').replace(/\s+/g, ' ').trim();
  if (cursor < lines.length && footer.test(lines[cursor])) {
    if (lines.slice(cursor+1).some(line=>line.trim())) return null;
    return freeTextQuestion(lines,rawLines,start,cursor);
  }
  if (!prompt || prompt.length > 2048 || prompt.includes('…') || cursor >= lines.length || !row.test(lines[cursor])) return null;
  const options = []; let selectedIndex = null;
  while (cursor < lines.length) {
    const match = row.exec(lines[cursor]);
    if (!match) break;
    if (+match[2] !== options.length + 1 || options.length >= 33) return null;
    if (match[1]) {
      if (selectedIndex !== null) return null;
      selectedIndex = options.length;
    }
    let label = match[3]; cursor++;
    while (cursor < lines.length && lines[cursor].trim() && !row.test(lines[cursor]) && !footer.test(lines[cursor])) {
      if (!/^\s{6,}\S/.test(lines[cursor])) return null;
      label += ' ' + lines[cursor].trim(); cursor++;
    }
    if (label.length > 512 || label.includes('…')) return null;
    options.push(label);
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
  }
  if (options.length < 2 || selectedIndex === null) return null;
  if (cursor >= lines.length || !footer.test(lines[cursor])) return null;
  if (lines.slice(cursor + 1).some(line => line.trim())) return null;
  const last = options.at(-1);
  const emptyOther = last === 'Other' || last === 'Other (write an answer)';
  // The final row is Codex's own inline Other editor. Its changed label is a
  // native draft, not a new model-authored choice and never safe to append to.
  if (!emptyOther && selectedIndex !== options.length - 1) return null;
  const stage = selectedIndex === options.length - 1 ? 'text' : 'choices';
  return {prompt, options, selectedIndex, stage,
    otherDraft:stage === 'text' && !emptyOther ? last : null};
}

export const questionFingerprint = (question, pane) => hash({pane:paneIdentity(pane), question});
export const questionSemantic = (question, pane) => hash({pane:paneIdentity(pane),
  prompt:question.prompt,modelOptions:question.options.slice(0,-1),stage:question.stage});
export const questionId = (fingerprint, nonce) => hash({fingerprint, nonce});

const stale = message => new BridgeError('question_stale',message,409);
const sameChoices = (first, next) => next?.prompt === first.prompt &&
  (first.options.length===0
    ? next.options.length===0 && next.stage==='text' && next.selectedIndex===null
    : next.options.length===first.options.length &&
      JSON.stringify(next.options.slice(0,-1)) === JSON.stringify(first.options.slice(0,-1)) &&
      (next.options.at(-1) === 'Other' || next.options.at(-1) === 'Other (write an answer)' || next.stage === 'text'));
const pause = () => new Promise(resolve => setTimeout(resolve,50));

/** A visible-screen read bracketed by Herdr's stable pane identity. */
export async function readCodexQuestionScreen(herdr, id, first) {
  const before = (await herdr.call('pane.get',{pane_id:id})).pane;
  if (paneIdentity(before) !== paneIdentity(first) || before.agent !== 'codex')
    throw stale('The Codex pane changed. Refresh it.');
  const {read} = await herdr.call('pane.read',{pane_id:id,source:'visible',format:'ansi',strip_ansi:false,lines:120});
  const after = (await herdr.call('pane.get',{pane_id:id})).pane;
  if (paneIdentity(after) !== paneIdentity(first))
    throw stale('The Codex pane changed while it was read. Refresh it.');
  const question=read.truncated ? null : detectCodexQuestion(read.text);
  const collapsed=!read.truncated && hasCollapsedCodexQuestion(read.text);
  const visible=typeof read.text==='string'?clean(read.text).join('\n'):'';
  const normalComposer=/^\s*[›❯]\s+(?!\d{1,2}\.)\S[^\n]*$/m.test(visible) &&
    /\bContext\s+\d+%\s+left\b|tab\s+to\s+queue\s+message/i.test(visible);
  return {question,collapsed,
    transitioned:!read.truncated && !question && !collapsed && normalComposer,
    truncated:read.truncated === true};
}

export async function revealCodexQuestion(herdr,id,first,onWrite) {
  const screen = await readCodexQuestionScreen(herdr,id,first);
  if (!screen.collapsed || screen.question)
    throw stale('The queued question is no longer collapsed. Refresh the pane.');
  // The current cue explicitly names this key; no timer or passive read sends it.
  onWrite();
  try {await herdr.call('pane.send_keys',{pane_id:id,keys:['shift+left']});}
  catch(error) {error.paneId=id;throw error;}
  return {opened:true};
}

export async function actCodexQuestion(herdr,id,first,expected,{option,text},onWrite) {
  let wrote = false;
  const markWrite = () => {wrote = true;onWrite();};
  const dispatch = async(method,params) => {
    markWrite();
    try {return await herdr.call(method,params);}
    catch(error) {error.paneId=id;throw error;}
  };
  const uncertain = message => {
    const error = stale(message);
    if (wrote) error.paneId = id;
    throw error;
  };
  const readExpected = async() => {
    let live;
    try {live = await readCodexQuestionScreen(herdr,id,first);}
    catch (error) {if (wrote) error.paneId = id;throw error;}
    if (!live.question || !sameChoices(expected,live.question)) uncertain('The native question changed. Inspect the pane before retrying.');
    return live.question;
  };
  let current = await readExpected();
  if (questionFingerprint(current,first) !== questionFingerprint(expected,first))
    throw stale('The question or its selection changed. Refresh before answering.');
  if (option !== undefined) {
    if (current.stage !== 'choices' || !Number.isInteger(option) || option < 0 || option >= current.options.length)
      throw new BridgeError('invalid_question_option','Choose a visible question option.',400);
    const target = option;
    const steps = Math.abs(target-current.selectedIndex);
    for (let index=0; index<steps; index++) {
      await dispatch('pane.send_keys',{pane_id:id,keys:[target>current.selectedIndex?'down':'up']});
      let moved=false;
      for (let attempt=0; attempt<10; attempt++) {
        const next=await readExpected();
        if (next.selectedIndex === current.selectedIndex + (target>current.selectedIndex?1:-1)) {
          current=next;moved=true;break;
        }
        await pause();
      }
      if (!moved) uncertain('The question cursor did not move as expected. Inspect the pane.');
    }
    current = await readExpected();
    if (current.selectedIndex !== target) uncertain('The question selection changed. Inspect the pane.');
    if (target === current.options.length - 1) return {stage:'text',opened:true};
    await dispatch('pane.send_keys',{pane_id:id,keys:['enter']});
    return {dispatched:true};
  }
  if (current.stage !== 'text' || current.otherDraft !== null ||
      typeof text !== 'string' || text.length < 1 || text.length > 500 ||
      text.trim() !== text || /[\u0000-\u001f\u007f-\u009f]/.test(text))
    throw new BridgeError('invalid_question_text','Enter a single-line answer in the empty question field.',400);
  await dispatch('pane.send_text',{pane_id:id,text});
  let inserted=false;
  for (let attempt=0; attempt<10; attempt++) {
    const next=await readExpected();
    if (next.stage === 'text' && next.selectedIndex === current.selectedIndex && next.otherDraft === text) {
      inserted=true;break;
    }
    await pause();
  }
  if (!inserted) uncertain('The native Other field could not be verified. Inspect the pane.');
  await dispatch('pane.send_keys',{pane_id:id,keys:['enter']});
  return {dispatched:true};
}
