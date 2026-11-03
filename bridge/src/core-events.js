import net from 'node:net';

const MAX_LINE_BYTES=16*1024*1024;
const WATCHDOG_MS=45000;
const DONE=new Set(['done','idle']);

/**
 * One persistent herdr-core `events.subscribe` connection.
 *
 * It records, per terminal, the latest turn that ended in done/idle, from
 * ordered `turn` events ({state, turn}: the state the agent left `working` for).
 * Turns learned from a (re)subscription snapshot are a baseline: the bridge did
 * not see them finish, so they never raise a completion alert. Every fact change
 * calls onChange so the session list can be republished at once.
 */
export function createCoreEvents(socketPath,{onChange=()=>{},connect=net.createConnection}={}) {
  const completions=new Map();
  let socket=null,buffer='',closed=false,retry=null,failures=0,watchdog=null,healthy=false;
  function baseline(terminals) {
    if(!Array.isArray(terminals))return;
    const live=new Set();
    for(const t of terminals) {
      if(typeof t?.address!=='string')continue;
      live.add(t.address);
      const known=completions.get(t.address);
      if(DONE.has(t.status?.state)&&Number.isSafeInteger(t.turn)&&t.turn>0&&(!known||known.turn<t.turn))
        completions.set(t.address,{turn:t.turn,state:t.status.state,baseline:true});
    }
    for(const address of completions.keys())if(!live.has(address))completions.delete(address);
  }
  function apply(params) {
    if(params?.type==='turn'&&typeof params.terminal==='string'&&DONE.has(params.data?.state)&&Number.isSafeInteger(params.data?.turn))
      completions.set(params.terminal,{turn:params.data.turn,state:params.data.state,baseline:false});
    else if(params?.type==='removed')completions.delete(params.terminal);
  }
  function arm() {
    clearTimeout(watchdog);
    watchdog=setTimeout(()=>socket?.destroy(),WATCHDOG_MS);watchdog.unref?.();
  }
  function schedule() {
    if(closed||retry)return;
    const delay=Math.min(10000,250*2**Math.min(failures++,6));
    retry=setTimeout(()=>{retry=null;open();},delay);retry.unref?.();
  }
  function lost() {
    if(healthy){healthy=false;onChange();}
    socket=null;buffer='';clearTimeout(watchdog);schedule();
  }
  function handle(line) {
    let message;try{message=JSON.parse(line);}catch{socket?.destroy();return;}
    arm();
    if(message.id===1) {
      if(message.error){socket?.destroy();return;}
      baseline(message.result?.terminals);healthy=true;failures=0;onChange();return;
    }
    if(message.method==='heartbeat')return;
    // A subscriber that fell behind gets a fresh snapshot: its gap is a baseline.
    if(Array.isArray(message.params?.terminals))baseline(message.params.terminals);
    else apply(message.params);
    onChange();
  }
  function open() {
    if(closed)return;
    const current=connect(socketPath);socket=current;
    current.setEncoding('utf8');
    current.on('connect',()=>{arm();current.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'events.subscribe',params:{}})+'\n');});
    current.on('data',chunk=>{
      if(socket!==current)return;
      buffer+=chunk;
      if(buffer.length>MAX_LINE_BYTES){current.destroy();return;}
      let index;
      while(socket===current&&(index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);handle(line);}
    });
    current.on('error',()=>{});
    current.on('close',()=>{if(socket===current)lost();});
  }
  open();
  return {
    completionFor:address=>completions.get(address)??null,
    get healthy(){return healthy;},
    close(){closed=true;clearTimeout(retry);clearTimeout(watchdog);socket?.destroy();socket=null;},
  };
}
