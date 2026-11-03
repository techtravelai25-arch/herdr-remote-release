import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import xterm from '@xterm/headless';
import {BridgeError} from './herdr.js';

// IDs of Herdr desktop-app (herdr-core, `hc`) panes carry this prefix so they
// never collide with TUI IDs such as `w1Y:p1`.
export const CORE_PREFIX='hc:';
export const isCoreId=value=>typeof value==='string'&&value.startsWith(CORE_PREFIX);
export const defaultCoreSocket=()=>path.join(process.env.XDG_RUNTIME_DIR||`/run/user/${process.getuid?.()??0}`,'herdr-core','default.sock');

const AGENT_COMMANDS={claude:'claude',codex:'codex',opencode:'opencode'};
const AGENT_ENV={TERM:'xterm-256color',TERM_PROGRAM:'ghostty',COLORTERM:'truecolor'};
const STATUS={idle:'idle',working:'working',done:'done',blocked:'blocked'};
const ERROR_CODES={not_found:'pane_not_found',finished:'pane_not_found',blocked:'agent_blocked',busy:'agent_busy',timeout:'herdr_timeout'};
const MAX_FRAME=4*1024*1024;
// hc 0.1.x repaint contract: one frame that starts with CAN + DECSTR and ends,
// after every cell and the cursor, with DECRST 9001 plus only OSC title/status.
const PAINT_HEADER='\x18\x1b[!p';
const PAINT_TRAILER='\x1b[?9001l';
const OSC_ONLY=/^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*$/;

const address=id=>{
  if(!isCoreId(id))throw new BridgeError('pane_not_found','The requested pane is unavailable. Refresh the session list.',409);
  return id.slice(CORE_PREFIX.length);
};
function processStart(pid) {
  try {const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]||'?';}
  catch {return '?';}
}
export function agentKind(terminal) {
  const fg=terminal.foreground;
  const named=fg?.name==='claude'?'claude':AGENT_COMMANDS[fg?.name]??null;
  if(named)return named;
  // A status record can outlive its agent; trust it only while a child of the shell is in front.
  if(!fg||fg.pid===terminal.pid)return null;
  const app=terminal.status?.app;
  return app==='claude-code'||app==='claude'?'claude':AGENT_COMMANDS[app]??null;
}
function spaceName(where) {
  if(typeof where!=='string'||!where)return 'Herdr app';
  const split=where.lastIndexOf(' / ');
  return split>0?where.slice(0,split):where;
}
const visible=t=>t?.state==='live'&&typeof t.labels?.['herdr.space']==='string'&&!String(t.address).includes('/');

export function corePane(t,coreId) {
  const agent=agentKind(t);
  const fg=t.foreground;
  const space=t.labels['herdr.space'],tab=t.labels['herdr.tab']||space;
  // A new agent process or a recovered shell gives a new identity (PID + start time).
  const agentPid=agent&&fg?fg.pid:0;
  const terminal_id=`${coreId}/${t.address}/${t.pid}:${processStart(t.pid)}/${agentPid}:${agentPid?processStart(agentPid):0}`;
  return {pane_id:CORE_PREFIX+t.address,terminal_id,workspace_id:CORE_PREFIX+space,tab_id:CORE_PREFIX+tab,focused:false,
    cwd:t.cwd,foreground_cwd:fg?.cwd||t.cwd,terminal_title:t.title||'',terminal_title_stripped:t.title||'',
    ...(agent?{agent}:{}),agent_status:agent?STATUS[t.status?.state]??'unknown':'unknown',
    revision:Number.isSafeInteger(t.turn)?t.turn:0,
    ...(t.labels['herdr-remote.title']?{label:t.labels['herdr-remote.title']}:{})};
}

// Collapse a rendered cell's attributes to one SGR parameter list.
function cellStyle(cell) {
  const codes=[];
  if(cell.isBold())codes.push(1);if(cell.isDim())codes.push(2);if(cell.isItalic())codes.push(3);
  if(cell.isUnderline())codes.push(4);if(cell.isBlink())codes.push(5);if(cell.isInverse())codes.push(7);
  if(cell.isInvisible())codes.push(8);if(cell.isStrikethrough())codes.push(9);
  const color=(palette,rgb,value,base,bright,extended)=>{
    if(palette)return value<8?[base+value]:value<16?[bright+value-8]:[extended,5,value];
    if(rgb)return [extended,2,(value>>16)&255,(value>>8)&255,value&255];
    return [];
  };
  codes.push(...color(cell.isFgPalette(),cell.isFgRGB(),cell.getFgColor(),30,90,38));
  codes.push(...color(cell.isBgPalette(),cell.isBgRGB(),cell.getBgColor(),40,100,48));
  return codes.join(';');
}
export function serializeLine(line,cols,ansi) {
  if(!line)return '';
  const cells=[];
  for(let x=0;x<cols;x++) {
    const cell=line.getCell(x);
    if(!cell||cell.getWidth()===0)continue;
    cells.push({text:cell.getChars()||' ',style:ansi?cellStyle(cell):'',bg:!cell.isBgDefault()});
  }
  while(cells.length&&cells.at(-1).text===' '&&!cells.at(-1).bg)cells.pop();
  let out='',style='';
  for(const cell of cells) {
    if(cell.style!==style){out+=cell.style?`\x1b[0;${cell.style}m`:'\x1b[0m';style=cell.style;}
    out+=cell.text;
  }
  return style?out+'\x1b[0m':out;
}

/** One connection to the core: JSON-RPC lines, optionally switched to framed mode. */
function connect(socketPath,timeout) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketPath);
    let buffer=Buffer.alloc(0),framed=false,id=0,closed=false,failure=null;
    const pending=new Map(),channels=new Map();
    const fail=error=>{
      if(closed)return;closed=true;failure=error;clearTimeout(timer);socket.destroy();
      for(const {reject:rejectCall} of pending.values())rejectCall(error);pending.clear();
      reject(error);
    };
    const timer=setTimeout(()=>fail(new BridgeError('herdr_timeout','The Herdr app core did not respond. Refresh before retrying an action; it may have completed.',504)),timeout);
    const frame=(channel,type,payload)=>{
      const head=Buffer.alloc(9);head.writeUInt32LE(channel,0);head.writeUInt8(type,4);head.writeUInt32LE(payload.length,5);
      socket.write(Buffer.concat([head,payload]));
    };
    const settle=message=>{
      const call=pending.get(message.id);if(!call)return;pending.delete(message.id);
      if(message.error) {
        const kind=message.error.data?.kind;
        call.reject(new BridgeError(ERROR_CODES[kind]??`hc_${kind||'error'}`,String(message.error.message||'Herdr app core rejected the request.').slice(0,300),409));
      } else call.resolve(message.result);
    };
    const client={
      rpc(method,params={}) {
        if(failure)return Promise.reject(failure);
        return new Promise((resolveCall,rejectCall)=>{
          const callId=++id;pending.set(callId,{resolve:resolveCall,reject:rejectCall});
          const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:callId,method,params}));
          if(framed)frame(0,0,body);else socket.write(Buffer.concat([body,Buffer.from('\n')]));
        });
      },
      async frame(params) {const result=await client.rpc('hello',{framed:true,...params});framed=true;return result;},
      send:frame,
      channel(number) {if(!channels.has(number))channels.set(number,[]);return channels.get(number);},
      close() {if(!closed){closed=true;clearTimeout(timer);socket.destroy();}},
    };
    socket.on('connect',()=>resolve(client));
    socket.on('error',error=>fail(['ENOENT','ECONNREFUSED'].includes(error.code)
      ?new BridgeError('herdr_offline','The Herdr app core is not running on the laptop.',503)
      :new BridgeError('herdr_socket_error','Cannot access the Herdr app core socket.',503)));
    socket.on('close',()=>fail(new BridgeError('herdr_disconnected','The Herdr app core disconnected; refresh before retrying.',503)));
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length>MAX_FRAME+9)return fail(new BridgeError('response_too_large','Herdr app core response exceeded limit.',502));
      for(;;) {
        if(!framed) {
          const end=buffer.indexOf(10);if(end<0)return;
          const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
          try{settle(JSON.parse(line));}catch{return fail(new BridgeError('invalid_response','Invalid Herdr app core response.',502));}
          continue;
        }
        if(buffer.length<9)return;
        const channel=buffer.readUInt32LE(0),type=buffer.readUInt8(4),length=buffer.readUInt32LE(5);
        if(length>MAX_FRAME)return fail(new BridgeError('response_too_large','Herdr app core response exceeded limit.',502));
        if(buffer.length<9+length)return;
        const payload=buffer.subarray(9,9+length);buffer=buffer.subarray(9+length);
        if(channel===0&&type===0) {try{settle(JSON.parse(payload));}catch{return fail(new BridgeError('invalid_response','Invalid Herdr app core response.',502));}}
        else client.channel(channel).push({type,payload:Buffer.from(payload)});
      }
    });
  });
}

function runApp(args,timeout=10000) {
  const binary=process.env.HERDR_APP_BIN||path.join(os.homedir(),'.local/bin/herdr-app');
  return new Promise((resolve,reject)=>execFile(binary,args,{timeout,maxBuffer:256*1024},(error,stdout)=>{
    let result=null;try{result=JSON.parse(stdout);}catch{}
    if(!error&&result&&!result.error)return resolve(result);
    reject(new BridgeError('herdr_app_unavailable',`The Herdr app window must be open on the laptop for this action.${result?.error?` ${String(result.error).slice(0,200)}`:''}`,409));
  }));
}

/**
 * Herdr desktop-app backend. Speaks hc JSON-RPC and answers the subset of the
 * Herdr protocol-22 methods the bridge uses, in protocol-22 shapes.
 */
export class HerdrCore {
  constructor(socketPath=defaultCoreSocket(),{app=runApp}={}) {this.socketPath=socketPath;this.app=app;}
  async session(timeout,work) {
    const client=await connect(this.socketPath,timeout);
    try{return await work(client);}finally{client.close();}
  }
  async terminal(client,id) {
    const t=await client.rpc('terminal.get',{terminal:address(id)});
    if(!visible(t))throw new BridgeError('pane_not_found','The requested pane is unavailable. Refresh the session list.',409);
    return t;
  }
  async coreId(client) {return this.id??=(await client.rpc('hello',{})).core.id;}

  /** Screen (plus main-screen history) as rendered rows, failing closed on any doubt. */
  async render(id,{history=0,ansi=true,verify=true},timeout) {
    return this.session(timeout,async client=>{
      const coreId=await this.coreId(client);
      await client.frame();
      const before=await this.terminal(client,id);
      const {channel}=await client.rpc('terminal.attach',{terminal:before.address,cols:before.cols,rows:before.rows,observe:true,history});
      const credit=Buffer.alloc(4);credit.writeUInt32LE(248);client.send(channel,1,credit);
      // The core writes the initial paint before it answers a later request on this connection.
      await client.rpc('server.status',{});
      const frames=client.channel(channel).splice(0);
      const after=await this.terminal(client,id);
      const plain=verify?(await client.rpc('terminal.read',{terminal:before.address,lines:0})).text:null;
      const paint=frames.length===1&&frames[0].type===0?frames[0].payload:null;
      const text=paint?.toString('utf8')??'';
      const trailer=text.lastIndexOf(PAINT_TRAILER);
      let complete=Boolean(paint)&&text.startsWith(PAINT_HEADER)&&trailer>=0&&OSC_ONLY.test(text.slice(trailer+PAINT_TRAILER.length))&&
        before.cols===after.cols&&before.rows===after.rows;
      const term=new xterm.Terminal({cols:before.cols,rows:before.rows,scrollback:history,allowProposedApi:true});
      try {
        if(paint)await new Promise(resolve=>term.write(paint,resolve));
        const buffer=term.buffer.active;
        const lines=[];
        for(let y=0;y<buffer.length;y++) {
          const line=buffer.getLine(y);
          const rendered=serializeLine(line,before.cols,ansi);
          if(line?.isWrapped&&lines.length)lines[lines.length-1]+=rendered;else lines.push(rendered);
        }
        if(verify) {
          const screen=[];for(let y=buffer.baseY;y<buffer.baseY+before.rows;y++)screen.push(buffer.getLine(y)?.translateToString(true)??'');
          const trim=rows=>{const copy=rows.map(row=>row.trimEnd());while(copy.length&&!copy.at(-1))copy.pop();return copy.join('\n');};
          complete&&=trim(screen)===trim(String(plain).split('\n'));
        }
        while(lines.length&&!lines.at(-1).replace(/\x1b\[[\d;]*m/g,''))lines.pop();
        return {lines,complete,pane:corePane(after,coreId)};
      } finally {term.dispose();}
    });
  }
  /** Raw bytes typed as if by a person, through a short attach at the terminal's own size. */
  async write(id,text,timeout) {
    return this.session(timeout,async client=>{
      await client.frame();
      const t=await this.terminal(client,id);
      const {channel}=await client.rpc('terminal.attach',{terminal:t.address,cols:t.cols,rows:t.rows,observe:false,history:0});
      const credit=Buffer.alloc(4);credit.writeUInt32LE(248);client.send(channel,1,credit);
      client.send(channel,0,Buffer.from(text,'utf8'));
      await client.rpc('server.status',{});
      return {ok:true};
    });
  }
  async snapshot(timeout) {
    return this.session(timeout,async client=>{
      const coreId=await this.coreId(client);
      const {terminals=[]}=await client.rpc('terminal.list',{});
      const live=terminals.filter(visible);
      const panes=live.map(t=>corePane(t,coreId));
      const workspaces=new Map(),tabs=new Map();
      for(const t of live) {
        const space=CORE_PREFIX+t.labels['herdr.space'];
        if(!workspaces.has(space))workspaces.set(space,{workspace_id:space,label:spaceName(t.labels.where)});
        const tab=CORE_PREFIX+(t.labels['herdr.tab']||t.labels['herdr.space']);
        if(!tabs.has(tab))tabs.set(tab,{tab_id:tab,workspace_id:space});
      }
      const agents=live.filter(t=>t.labels['herdr-remote.name']).map(t=>({pane_id:CORE_PREFIX+t.address,name:t.labels['herdr-remote.name']}));
      return {protocol:22,focused_pane_id:null,workspaces:[...workspaces.values()],tabs:[...tabs.values()],panes,agents};
    });
  }
  async create(params,timeout) {
    const kind=AGENT_COMMANDS[params.agent_kind]?params.agent_kind:null;
    const labels={...(kind&&params.agent_name?{'herdr-remote.name':params.agent_name}:{}),...(!kind&&params.label?{'herdr-remote.title':params.label}:{})};
    let created;
    if(params.workspace_id) {
      // Works with the window closed: the app gives a labelled terminal its own tab.
      created=await this.session(timeout,client=>client.rpc('terminal.run',{cwd:params.cwd,keep:true,no_parent:true,no_notify:true,env:AGENT_ENV,
        argv:kind?[AGENT_COMMANDS[kind]]:[],labels:{'herdr.space':address(params.workspace_id),...labels}}));
    } else {
      const made=await this.app(['do','space.new',JSON.stringify({name:params.label,folder:params.cwd,...(kind?{argv:[AGENT_COMMANDS[kind]]}:{})})]);
      created={address:made.terminal};
      if(Object.keys(labels).length)await this.session(timeout,client=>client.rpc('terminal.label',{terminal:made.terminal,labels}));
    }
    if(typeof created?.address!=='string')throw new BridgeError('invalid_response','The Herdr app did not report the new terminal.',502);
    return {root_pane:{pane_id:CORE_PREFIX+created.address},agent_started:Boolean(kind)};
  }

  async call(method,params={},timeout=8000) {
    switch(method) {
    case 'ping':return this.session(timeout,async client=>({pong:true,core:await this.coreId(client)}));
    case 'session.snapshot':return {snapshot:await this.snapshot(timeout)};
    case 'pane.get':return this.session(timeout,async client=>({type:'pane_info',pane:corePane(await this.terminal(client,params.pane_id),await this.coreId(client))}));
    case 'pane.process_info':return this.session(timeout,async client=>{
      const t=await this.terminal(client,params.pane_id),fg=t.foreground;
      return {process_info:{pane_id:params.pane_id,shell_pid:t.pid,foreground_process_group_id:fg?.pid??null,
        foreground_processes:fg?[{pid:fg.pid,name:fg.name,argv:fg.argv,cmdline:fg.argv.join(' '),cwd:fg.cwd}]:[]}};
    });
    case 'pane.read': {
      const recent=params.source==='recent_unwrapped';
      const lines=Math.max(1,Math.min(1000,Number(params.lines)||120));
      const ansi=params.format==='ansi'&&params.strip_ansi!==true;
      // The terminal view is display only; reads that can authorize input are verified.
      const {lines:rows,complete,pane}=await this.render(params.pane_id,{history:recent?lines:0,ansi,verify:!recent},Math.max(timeout,10000));
      return {read:{pane_id:params.pane_id,workspace_id:pane.workspace_id,tab_id:pane.tab_id,source:params.source,format:params.format,
        text:rows.slice(-lines).join('\n'),revision:pane.revision,truncated:!complete||rows.length>lines}};
    }
    case 'pane.send_text':return this.write(params.pane_id,String(params.text??''),timeout);
    case 'pane.send_input': {
      if(params.text)await this.write(params.pane_id,String(params.text).replace(/\r?\n/g,'\r'),timeout);
      if(Array.isArray(params.keys)&&params.keys.length)return this.call('pane.send_keys',{pane_id:params.pane_id,keys:params.keys},timeout);
      return {ok:true};
    }
    // hc holds input while a person is typing at the desktop, then delivers it.
    case 'pane.send_keys':return this.session(Math.max(timeout,15000),client=>client.rpc('terminal.keys',{terminal:address(params.pane_id),keys:params.keys}));
    case 'agent.prompt':return this.session(Math.max(timeout,15000),async client=>{
      const t=await this.terminal(client,params.target);
      if(!agentKind(t))throw new BridgeError('agent_not_found','This pane has no detected agent.',409);
      return client.rpc('terminal.send',{terminal:t.address,text:params.text});
    });
    case 'agent.get':return this.session(timeout,async client=>{
      const t=await this.terminal(client,params.target);
      const pane=corePane(t,await this.coreId(client));
      if(!pane.agent)throw new BridgeError('agent_not_found',`agent target ${params.target} not found`,409);
      return {agent:{pane_id:pane.pane_id,terminal_id:pane.terminal_id,name:t.labels['herdr-remote.name']??null,kind:pane.agent,
        agent_status:pane.agent_status,interactive_ready:['idle','done'].includes(pane.agent_status)}};
    });
    case 'agent.list':return {agents:(await this.snapshot(timeout)).agents};
    case 'agent.start':throw new BridgeError('agent_start_unsupported','Herdr app panes start agents when they are created.',409);
    case 'pane.rename':return this.session(timeout,client=>client.rpc('terminal.label',{terminal:address(params.pane_id),labels:{'herdr-remote.title':String(params.label)}}));
    case 'pane.focus':return this.app(['do','pane.focus',JSON.stringify({terminal:address(params.pane_id)})]);
    case 'pane.close':return this.session(timeout,async client=>{
      const result=await client.rpc('terminal.kill',{terminal:address(params.pane_id)});
      await client.rpc('terminal.rm',{terminal:address(params.pane_id)}).catch(()=>{});
      return result;
    });
    case 'tab.create':case 'workspace.create':return this.create(params,Math.max(timeout,15000));
    default:throw new BridgeError('unsupported_method',`The Herdr app backend does not support ${method}.`,409);
    }
  }
}
