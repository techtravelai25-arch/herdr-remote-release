import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {companionVersion} from './version.js';

const unavailable = () => ({id:'codex',name:'Codex',status:'unavailable',windows:[],updatedAt:null,message:'Usage unavailable. Check Codex installation and sign-in on your laptop.'});

function windowLabel(minutes, fallback) {
  if(minutes===10080)return 'Weekly';
  if(Number.isFinite(minutes)&&minutes>0) {
    if(minutes%1440===0)return `${minutes/1440}-day`;
    if(minutes%60===0)return `${minutes/60}-hour`;
    return `${minutes}-minute`;
  }
  return fallback;
}

export function normalizeCodexUsage(result, now=Date.now()) {
  // Prefer the ordinary Codex bucket; do not accidentally display a model-specific quota.
  const limits=result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const windows=['primary','secondary'].flatMap(id=>{
    const value=limits?.[id];
    if(!value||!Number.isFinite(value.usedPercent)||value.usedPercent<0||value.usedPercent>100)return [];
    const reset=typeof value.resetsAt==='number'?new Date(value.resetsAt*1000):null;
    return [{id,label:windowLabel(value.windowDurationMins,id==='primary'?'Primary':'Secondary'),remainingPercent:100-value.usedPercent,resetsAt:reset&&Number.isFinite(reset.getTime())?reset.toISOString():null}];
  });
  if(!windows.length)throw new Error('Usage windows unavailable');
  return {id:'codex',name:'Codex',status:'available',windows,updatedAt:new Date(now).toISOString()};
}

// Only the initialized, read-only account endpoint is called. No session or turn is created.
export function readCodexRateLimits({spawnProcess=spawn,timeoutMs=10000}={}) {
  let cancel;
  const promise=new Promise((resolve,reject)=>{
    let child, timer, killTimer, exited=false, finished=false, buffer='';
    const finish=(error,result)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      child?.stdin?.end();
      if(child&&!exited) {
        child.kill();
        killTimer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},1000);
        killTimer.unref?.();
      }
      if(error)reject(new Error('Codex usage unavailable'));else resolve(result);
    };
    cancel=()=>finish(true);
    try {child=spawnProcess('codex',['app-server','--listen','stdio://'],{stdio:['pipe','pipe','ignore']});}
    catch {finish(true);return;}
    timer=setTimeout(()=>finish(true),timeoutMs);timer.unref?.();
    child.on('error',()=>finish(true));child.on('exit',()=>{exited=true;clearTimeout(killTimer);finish(true);});
    child.stdin.on('error',()=>finish(true));
    const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(finished)return;
      buffer+=chunk;
      if(buffer.length>1024*1024){finish(true);return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.id===1) {
          if(message.error){finish(true);return;}
          send({method:'initialized'});
          send({id:2,method:'account/rateLimits/read',params:{}});
        } else if(message.id===2) {finish(Boolean(message.error),message.result);return;}
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'herdr_remote_usage',title:'Herdr Remote',version:companionVersion()},capabilities:null}});
  });
  return {promise,cancel:()=>cancel?.()};
}

// ---- Claude usage (read-only local files; no network, no credential files) ----
// Sources: claude-swap's sequence.json + cache/usage.json (one entry per account) and,
// when that is absent, the active-account cache written by the Herdr statusline script.
const MAX_CLAUDE_FILE_BYTES=1024*1024;
const CLAUDE_FRESH_MS=10*60*1000;
const CLAUDE_REFRESH_MS=15000;
const SLOT=/^[A-Za-z0-9_-]{1,32}$/;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Returns {value,mtimeMs} or null. Only ever called with the three allow-listed usage files.
function readJsonFile(file) {
  let fd;
  try {
    fd=fs.openSync(file,'r');
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_CLAUDE_FILE_BYTES)return null;
    const buffer=Buffer.alloc(stat.size);
    let read=0;
    while(read<stat.size) {const n=fs.readSync(fd,buffer,read,stat.size-read,read);if(n<=0)break;read+=n;}
    return {value:JSON.parse(buffer.toString('utf8',0,read)),mtimeMs:stat.mtimeMs};
  } catch {return null;}
  finally {if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}

const remainingOf=used=>typeof used==='number'&&Number.isFinite(used)?Math.min(100,Math.max(0,100-used)):null;
const isoOf=value=>{
  if(typeof value!=='string'||!value)return null;
  const time=Date.parse(value);
  return Number.isFinite(time)?new Date(time).toISOString():null;
};
const claudeWindow=(id,label,used,resetsAt)=>{
  const remainingPercent=remainingOf(used);
  return remainingPercent===null?[]:[{id,label,remainingPercent,resetsAt:isoOf(resetsAt)}];
};

// claude-swap lastGood: {five_hour:{pct,resets_at}, seven_day:{pct,resets_at}, scoped:[{name,pct,resets_at}]}
function windowsFromLastGood(lastGood) {
  if(!isObject(lastGood))return [];
  const windows=[];
  for(const [key,id,label] of [['five_hour','five_hour','5-hour'],['seven_day','seven_day','Weekly']]) {
    const value=lastGood[key];
    if(isObject(value))windows.push(...claudeWindow(id,label,value.pct,value.resets_at));
  }
  if(Array.isArray(lastGood.scoped)) {
    lastGood.scoped.slice(0,16).forEach((value,index)=>{
      if(isObject(value)&&typeof value.name==='string'&&value.name.trim()&&value.name.length<=40)windows.push(...claudeWindow(`scoped_${index}`,`${value.name.trim()} weekly`,value.pct,value.resets_at));
    });
  }
  return windows;
}

// Statusline cache: five_hour/seven_day {utilization,resets_at} plus limits[] {group,percent,resets_at,scope.model.display_name}.
function windowsFromOauthUsage(data) {
  if(!isObject(data))return [];
  const byId=new Map();
  const add=window=>{if(!byId.has(window.id))byId.set(window.id,window);};
  for(const [key,id,label] of [['five_hour','five_hour','5-hour'],['seven_day','seven_day','Weekly']]) {
    if(isObject(data[key]))claudeWindow(id,label,data[key].utilization,data[key].resets_at).forEach(add);
  }
  if(Array.isArray(data.limits)) {
    data.limits.slice(0,32).forEach((limit,index)=>{
      if(!isObject(limit))return;
      const name=limit.scope?.model?.display_name;
      if(typeof name==='string'&&name.trim()&&name.length<=40)claudeWindow(`scoped_${index}`,`${name.trim()} weekly`,limit.percent,limit.resets_at).forEach(add);
      else if(limit.group==='session')claudeWindow('five_hour','5-hour',limit.percent,limit.resets_at).forEach(add);
      else if(limit.group==='weekly')claudeWindow('seven_day','Weekly',limit.percent,limit.resets_at).forEach(add);
    });
  }
  return [...byId.values()];
}

const epochMs=seconds=>typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0?Math.round(seconds*1000):null;

export function readClaudeUsage({homeDirectory=os.homedir()}={}) {
  const swapDir=path.join(homeDirectory,'.local','share','claude-swap');
  const sequence=readJsonFile(path.join(swapDir,'sequence.json'))?.value;
  const cache=readJsonFile(path.join(swapDir,'cache','usage.json'))?.value;
  const oauthFile=readJsonFile(path.join(homeDirectory,'.cache','claude-herdr','oauth-usage.json'));
  const oauth=oauthFile?{windows:windowsFromOauthUsage(oauthFile.value),fetchedAt:Math.round(oauthFile.mtimeMs)}:null;
  const sequenceAccounts=isObject(sequence?.accounts)?sequence.accounts:{};
  const cacheAccounts=isObject(cache?.accounts)?cache.accounts:{};
  const slots=[];
  const addSlot=slot=>{slot=String(slot);if(SLOT.test(slot)&&!slots.includes(slot))slots.push(slot);};
  if(Array.isArray(sequence?.sequence))sequence.sequence.forEach(slot=>{if(String(slot) in sequenceAccounts)addSlot(slot);});
  const numeric=(a,b)=>(Number(a)-Number(b))||a.localeCompare(b);
  Object.keys(sequenceAccounts).sort(numeric).forEach(addSlot);
  const hasSequenceAccounts=slots.length>0;
  if(!slots.length)Object.keys(cacheAccounts).sort(numeric).forEach(addSlot);
  const activeSlot=sequence?.activeAccountNumber===undefined||sequence?.activeAccountNumber===null?null:String(sequence.activeAccountNumber);
  if(!slots.length) {
    if(!oauth?.windows.length)return [];
    return [{id:'claude',name:'Claude',group:'claude',account:null,active:true,windows:oauth.windows,fetchedAt:oauth.fetchedAt,failed:false}];
  }
  const entries=slots.map(slot=>{
    const account=sequenceAccounts[slot];
    const cached=isObject(cacheAccounts[slot])?cacheAccounts[slot]:{};
    // Slot numbers can be reused or moved. Match claude-swap's identity guard before
    // attributing measurements to the current account; cache-only entries name themselves.
    const matches=!hasSequenceAccounts||(typeof account?.email==='string'&&account.email.length>0&&
      cached.email===account.email&&(cached.organizationUuid===undefined?'':cached.organizationUuid)===(account.organizationUuid||''));
    const row=matches?cached:{};
    const email=[account?.email,row.email].find(value=>typeof value==='string'&&value.length>0&&value.length<=200)??null;
    const active=slot===activeSlot;
    const windows=windowsFromLastGood(row.lastGood),fetchedAt=epochMs(row.fetchedAt);
    const failed=Boolean(row.lastError)||(typeof row.consecutiveFailures==='number'&&row.consecutiveFailures>0);
    // The statusline cache has no account identity, so it cannot fill a named slot.
    return {id:`claude:${slot}`,slot,email,group:'claude',active,windows,fetchedAt,failed};
  });
  const locals=new Map();
  entries.forEach(entry=>{const local=entry.email?.split('@')[0].toLowerCase();if(local)locals.set(local,(locals.get(local)??0)+1);});
  const ordered=[...entries.filter(entry=>entry.active),...entries.filter(entry=>!entry.active)];
  return ordered.map(({slot,email,...entry})=>{
    const local=email?.split('@')[0];
    const label=!email?`account ${slot}`:locals.get(local.toLowerCase())>1?email:local;
    return {...entry,name:`Claude · ${label}`,account:email};
  });
}

function claudeProvider(entry,now) {
  const base={id:entry.id,name:entry.name,group:'claude',...(entry.account?{account:entry.account}:{}),active:entry.active};
  if(!entry.windows.length)return {...base,status:'unavailable',windows:[],updatedAt:null,message:'No Claude usage reading yet. Open Claude on your laptop to refresh.'};
  const updatedAt=entry.fetchedAt===null?null:new Date(entry.fetchedAt).toISOString();
  const result={...base,status:'available',windows:entry.windows,updatedAt};
  if(entry.failed)return {...result,status:'stale',message:'Could not refresh usage. Showing the last reading.'};
  if(entry.fetchedAt===null||now-entry.fetchedAt>CLAUDE_FRESH_MS||entry.fetchedAt-now>60000)return {...result,status:'stale',message:'Showing the last usage reading.'};
  // Do not suggest a reset has restored quota until a fresh reading confirms it.
  if(entry.windows.some(window=>window.resetsAt&&Date.parse(window.resetsAt)<=now))return {...result,status:'stale',message:'Showing the last usage reading.'};
  return result;
}

const CLAUDE_COLLECT_MS=3*60*1000;
/**
 * Ask claude-swap to refresh its usage cache (`cswap list --json`, its supported read path; it paces network
 * use per account itself). Output is discarded: the cache files it writes are what readClaudeUsage reads, and
 * this process never touches credentials. Absent or failing tools are ignored.
 */
export function refreshClaudeUsage({homeDirectory=os.homedir(),spawnProcess=spawn,timeoutMs=45000}={}) {
  if(!fs.existsSync(path.join(homeDirectory,'.local','share','claude-swap','sequence.json')))return null;
  let child,timer,cancel;
  const promise=new Promise(resolve=>{
    try {child=spawnProcess('cswap',['list','--json'],{stdio:['ignore','ignore','ignore']});}catch {resolve();return;}
    timer=setTimeout(()=>{child.kill();resolve();},timeoutMs);timer.unref?.();
    child.on('error',()=>{clearTimeout(timer);resolve();});
    child.on('exit',()=>{clearTimeout(timer);resolve();});
    cancel=()=>{clearTimeout(timer);child.kill();resolve();};
  });
  return {promise,cancel:()=>cancel?.()};
}

export function createUsageSource({read=readCodexRateLimits,now=Date.now,refreshMs=60000,homeDirectory=os.homedir(),claudeRefreshMs=CLAUDE_REFRESH_MS,readClaude=readClaudeUsage,refreshClaude=refreshClaudeUsage,claudeCollectMs=CLAUDE_COLLECT_MS}={}) {
  let current=unavailable(),nextRead=0,flight=null,closed=false,claudeEntries=[],nextClaudeRead=0,nextCollect=0,collecting=null;
  return {
    get() {
      if(!closed&&!flight&&now()>=nextRead) {
        nextRead=now()+refreshMs;
        try {flight=read();}catch {flight={promise:Promise.reject(new Error('Unavailable'))};}
        Promise.resolve(flight.promise).then(result=>{
          if(!closed)current=normalizeCodexUsage(result,now());
        }).catch(()=>{
          if(!closed)current=current.updatedAt?{...current,status:'stale',message:'Could not refresh usage. Showing the last reading.'}:unavailable();
        }).finally(()=>{flight=null;});
      }
      // claude-swap only refreshes its cache when something asks it to; ask at its own pace.
      if(!closed&&!collecting&&now()>=nextCollect) {
        nextCollect=now()+claudeCollectMs;
        try {collecting=refreshClaude({homeDirectory});}catch {collecting=null;}
        if(collecting)Promise.resolve(collecting.promise).catch(()=>{}).finally(()=>{collecting=null;nextClaudeRead=0;});
      }
      if(!closed&&now()>=nextClaudeRead) {
        nextClaudeRead=now()+claudeRefreshMs;
        try {claudeEntries=readClaude({homeDirectory});}catch {claudeEntries=[];}
      }
      // Do not suggest a reset has restored quota until a fresh account read confirms it.
      const expired=current.status==='available'&&(now()-Date.parse(current.updatedAt)>refreshMs*2||current.windows.some(window=>window.resetsAt&&Date.parse(window.resetsAt)<=now()));
      return [expired?{...current,status:'stale',message:'Showing the last usage reading.'}:current,...claudeEntries.map(entry=>claudeProvider(entry,now()))];
    },
    close() {closed=true;flight?.cancel?.();collecting?.cancel?.();}
  };
}
