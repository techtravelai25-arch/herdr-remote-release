import {createHash,randomUUID} from 'node:crypto';
import {BridgeError} from './herdr.js';
import {readAgentModelMenu,openAgentModelMenu,actAgentModelMenu,keyAgentModelMenu,modelSelectionAgents} from './agent-model.js';
import {paneIdentity} from './pane-attachment.js';
import {readCodexQuestionScreen,revealCodexQuestion,actCodexQuestion,questionFingerprint,questionSemantic,questionId} from './codex-question.js';
import {readClaudeQuestionScreen,actClaudeQuestion,claudeQuestionSemantic} from './claude-question.js';

const reject=(code,message,status=400)=>{ throw new BridgeError(code,message,status); };
const requestKey=(deviceId,paneId)=>JSON.stringify([deviceId,paneId]);
const retiredKey=id=>createHash('sha256').update(id).digest('hex');
const identityHash=pane=>createHash('sha256').update(paneIdentity(pane)).digest('hex');
const QUESTION_TTL=120000;

/** Per-device native question and agent model-picker state for each pane. */
export function createPaneMenus({herdr,store}) {
  // Model-menu recognition is scoped to an explicit picker request. Native
  // question recognition separately reads the current visible screen only;
  // neither passive read sends input.
  const modelMenuRequests=new Map();
  // Each device may act only on the current question it actually saw. A
  // dispatched key retires that exact generation even if the old frame lingers.
  const questionRequests=new Map();
  const questionReveals=new Map();
  let questionRetired=new Map(Object.entries(store.read('question-retired.json',{})));
  function saveQuestionRetired(next) {
    // Commit tombstones before dispatch. They contain hashes only: neither
    // the user's question nor the terminal/pane identity is stored verbatim.
    store.write('question-retired.json',Object.fromEntries(next));
    questionRetired=next;
  }
  function retireQuestion(id,pane,semantic) {
    const next=new Map(questionRetired);
    next.set(retiredKey(id),{identity:identityHash(pane),semantic});
    saveQuestionRetired(next);
  }
  function clearRetiredQuestion(id) {
    const key=retiredKey(id);
    if(!questionRetired.has(key))return;
    const next=new Map(questionRetired);next.delete(key);saveQuestionRetired(next);
  }
  /** Drop requests and tombstones for panes that no longer exist. */
  function prune(live) {
    const now=Date.now();
    for(const [key,request] of modelMenuRequests) if(!live.has(request.paneId)||request.expiresAt<now) modelMenuRequests.delete(key);
    for(const [key,request] of questionRequests) if(!live.has(request.paneId)||(!request.attempted&&request.expiresAt<now)) questionRequests.delete(key);
    for(const [key,request] of questionReveals) if(!live.has(request.paneId)) questionReveals.delete(key);
    const liveRetirementKeys=new Set([...live].map(retiredKey));
    if([...questionRetired.keys()].some(key=>!liveRetirementKeys.has(key)))
      saveQuestionRetired(new Map([...questionRetired].filter(([key])=>liveRetirementKeys.has(key))));
  }
  async function readQuestion(deviceId,id,current,busy) {
    let question=null,questionReviewAvailable=false,questionAwaitingTransition=false;
    const qKey=requestKey(deviceId,id);
    const supported=current.agent==='codex'||current.agent==='claude';
    const semantic=value=>current.agent==='claude'
      ?claudeQuestionSemantic(value,current):questionSemantic(value,current);
    if(supported && busy) questionAwaitingTransition=true;
    else if(supported) {
      try {
        const screen=current.agent==='claude'
          ?await readClaudeQuestionScreen(herdr,id,current)
          :await readCodexQuestionScreen(herdr,id,current);
        const retired=questionRetired.get(retiredKey(id));
        if(retired && (retired.identity!==identityHash(current) || screen.transitioned ||
            (screen.question && retired.semantic!==semantic(screen.question))))
          clearRetiredQuestion(id);
        const previousReveal=questionReveals.get(id);
        const sameReveal=previousReveal?.attempted && previousReveal.identity===paneIdentity(current);
        // An unknown or truncated frame does not prove a prior reveal
        // failed. Only a complete editor, normal composer, or changed
        // occupant retires the attempt.
        if(previousReveal && (!sameReveal || screen.question || screen.transitioned)) questionReveals.delete(id);
        questionAwaitingTransition=questionRetired.has(retiredKey(id)) ||
          Boolean(sameReveal && !screen.question && !screen.transitioned);
        questionReviewAvailable=current.agent==='codex'&&screen.collapsed&&!questionAwaitingTransition;
        if(screen.question && !questionAwaitingTransition) {
          const fingerprint=questionFingerprint(screen.question,current);
          let request=questionRequests.get(qKey);
          if(!request || request.fingerprint!==fingerprint || request.identity!==paneIdentity(current)) {
            request={paneId:id,identity:paneIdentity(current),fingerprint,question:screen.question,
              id:questionId(fingerprint,randomUUID()),attempted:false,expiresAt:Date.now()+QUESTION_TTL};
            questionRequests.set(qKey,request);
          }
          if(!request.attempted) {
            request.expiresAt=Date.now()+QUESTION_TTL;
            const native=screen.question;
            question=native.stage==='text'
              ?(native.otherDraft===null?{id:request.id,prompt:native.prompt,options:[],selectedIndex:null,freeText:true,stage:'text',
                ...(current.agent==='claude'?{cancelAvailable:true,multiSelect:native.multiSelect}:{} )}:null)
              :{id:request.id,prompt:native.prompt,
                options:current.agent==='claude'&&native.multiSelect&&native.otherDraft!==null
                  ?native.options.map((label,index)=>index===native.typeIndex?`Custom: ${native.otherDraft}`:label)
                  :native.options,
                selectedIndex:native.selectedIndex,
                freeText:false,stage:native.stage,
                ...(current.agent==='claude'?{cancelAvailable:native.kind!=='claude_trust',
                  ...(native.kind?{kind:native.kind}:{}),multiSelect:native.multiSelect,
                  selectedOptions:native.selectedOptions}:{} )};
          }
        } else if(!questionAwaitingTransition) questionRequests.delete(qKey);
      } catch {
        questionRequests.delete(qKey);
        const previousReveal=questionReveals.get(id);
        questionAwaitingTransition=questionRetired.has(retiredKey(id)) ||
          Boolean(previousReveal?.attempted && previousReveal.identity===paneIdentity(current));
      }
    }
    return {question,questionReviewAvailable,questionAwaitingTransition};
  }
  async function readModelMenu(key,modelRequest,id,current) {
    if(!modelRequest)return null;
    try {
      if(modelRequest.expiresAt>Date.now()&&modelRequest.identity===paneIdentity(current)&&
        modelSelectionAgents.includes(current.agent)&&!['working','starting','stopped','error'].includes(current.agent_status)) {
        const menu=await readAgentModelMenu(herdr,id,current);
        if(menu) modelRequest.expiresAt=Date.now()+300000;
        return menu;
      }
      modelMenuRequests.delete(key);
    } catch {modelMenuRequests.delete(key);}
    return null;
  }
  /**
   * Passive output fields for one device. Menu metadata is published only
   * after this device requested the picker in this exact pane occupant.
   * Detection reads never send input. `busy` marks a pane action in flight.
   */
  async function observe(deviceId,id,current,busy) {
    const key=requestKey(deviceId,id);
    const modelRequest=modelMenuRequests.get(key);
    const {question,questionReviewAvailable,questionAwaitingTransition}=await readQuestion(deviceId,id,current,busy);
    const agentModelMenu=await readModelMenu(key,modelRequest,id,current);
    return {questionReviewAvailable,questionAwaitingTransition,...(question?{question}:{}),
      ...(agentModelMenu?{agentModelMenu,...(current.agent==='codex'?{codexModelMenu:agentModelMenu}:{})}:{})};
  }
  /** Reveal or answer the question this device saw. Runs under the pane lock. */
  function questionAction(action,deviceId,id,current,b) {
    if(current.agent!=='codex'&&current.agent!=='claude')
      reject('question_unavailable','This pane does not have a supported native question.',409);
    if(action==='question-review') {
      if(current.agent!=='codex')
        reject('question_unavailable','This question is already visible in the Claude pane.',409);
      const prior=questionReveals.get(id);
      if(prior?.attempted && prior.identity===paneIdentity(current))
        reject('question_stale','The question reveal was already attempted. Inspect the pane.',409);
      return revealCodexQuestion(herdr,id,current,()=>questionReveals.set(id,{paneId:id,identity:paneIdentity(current),attempted:true}));
    }
    const request=questionRequests.get(requestKey(deviceId,id));
    if(!request || request.attempted || request.id!==b.questionId || request.identity!==paneIdentity(current) || request.expiresAt<Date.now())
      reject('question_stale','The question changed. Refresh before answering.',409);
    const act=current.agent==='claude'?actClaudeQuestion:actCodexQuestion;
    return act(herdr,id,current,request.question,{option:b.option,text:b.text,cancel:b.cancel},()=>{
      // Another phone may have observed the same frame. Once any key is
      // dispatched, all those authorizations are obsolete.
      retireQuestion(id,current,current.agent==='claude'
        ?claudeQuestionSemantic(request.question,current):questionSemantic(request.question,current));
      for(const entry of questionRequests.values())
        if(entry.paneId===id && entry.identity===request.identity) entry.attempted=true;
    });
  }
  /** Open, navigate, select or cancel the agent model picker. Runs under the pane lock. */
  async function modelAction(action,deviceId,id,current,b) {
    if(!modelSelectionAgents.includes(current.agent)) reject('model_unavailable','This agent does not have a verified app model picker. Use its terminal controls.',409);
    const result=await (action==='model'?openAgentModelMenu(herdr,id,current)
      :action==='model-key'?keyAgentModelMenu(herdr,id,current,{menuId:b.menuId,key:b.key})
      :actAgentModelMenu(herdr,id,current,{menuId:b.menuId,option:b.option,cancel:action==='model-cancel'}));
    const key=requestKey(deviceId,id);
    if(action==='model-cancel') modelMenuRequests.delete(key);
    else modelMenuRequests.set(key,{paneId:id,identity:paneIdentity(current),expiresAt:Date.now()+120000});
    return result;
  }
  return {prune,observe,questionAction,modelAction};
}
