import {spawn} from 'node:child_process';

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
    send({id:1,method:'initialize',params:{clientInfo:{name:'herdr_remote_usage',title:'Herdr Remote',version:'0.1.0'},capabilities:null}});
  });
  return {promise,cancel:()=>cancel?.()};
}

export function createUsageSource({read=readCodexRateLimits,now=Date.now,refreshMs=60000}={}) {
  let current=unavailable(),nextRead=0,flight=null,closed=false;
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
      // Do not suggest a reset has restored quota until a fresh account read confirms it.
      const expired=current.status==='available'&&(now()-Date.parse(current.updatedAt)>refreshMs*2||current.windows.some(window=>window.resetsAt&&Date.parse(window.resetsAt)<=now()));
      return [expired?{...current,status:'stale',message:'Showing the last usage reading.'}:current];
    },
    close() {closed=true;flight?.cancel?.();}
  };
}
