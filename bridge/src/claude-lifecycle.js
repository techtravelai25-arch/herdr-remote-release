import fs from 'node:fs';
import path from 'node:path';

const LIMIT=2*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// These are transcript bookkeeping records observed in local 2.1.29x logs.
// An unrecognized record or system subtype could be a new turn boundary.
const neutralRecords=new Set(['attachment','atis-latch','last-prompt','mode','ai-title',
  'permission-mode','queue-operation','frame-link','agent-name','file-history-delta',
  'custom-title','pr-link','file-history-snapshot','artifact-comment-monitor',
  'artifact-autoreact-ledger','cost-state','fork-context-ref']);
const neutralSystem=new Set(['stop_hook_summary','away_summary','informational']);
const activitySystem=new Set(['local_command','scheduled_task_fire']);

function locate(root,session) {
  if(session.kind==='path')return path.resolve(session.value);
  if(session.kind!=='id'||!UUID.test(session.value))return null;
  let inspected=0,found=null;
  function inspect(folder,projects=false) {
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      if(++inspected>10000)throw Error('search_limit');
      const file=path.join(folder,entry.name);
      if(entry.name.toLowerCase()===session.value.toLowerCase()+'.jsonl') {
        if(!entry.isFile()||found)throw Error('ambiguous_session');
        found=file;
      } else if(projects&&entry.isDirectory())inspect(file);
    }
  }
  // Main conversations live directly in a project folder. Nested subagent and
  // artifact directories do not identify the pane's main conversation.
  inspect(root,true);return found;
}

// Claude's assistant records are also written during tool calls and thinking.
// Require a final text response AND the CLI's post-loop turn-duration boundary.
// Only structural metadata leaves this reader; no reply or tool text is retained.
export function readClaudeLifecycle(session,home,{maxBytes=LIMIT,diagnostic}={}) {
  const fail=reason=>{if(diagnostic)diagnostic.reason=reason;return null;};
  if(diagnostic)diagnostic.reason='native_unavailable';
  if(!home||!session||(session.agent&&session.agent!=='claude')||typeof session.value!=='string')return fail('unknown_identity');
  let fd;
  try {
    const root=path.resolve(home,'.claude/projects');
    if(fs.realpathSync(root)!==root)return fail('unsafe_path');
    const file=locate(root,session);
    if(!file)return fail('native_unavailable');
    if(!file.endsWith('.jsonl')||!file.startsWith(root+path.sep)||fs.realpathSync(file)!==file)return fail('unsafe_path');
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.nlink!==1)return fail('unsafe_path');
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.dev!==before.dev||stat.ino!==before.ino)return fail('stale_evidence');
    if(process.platform==='linux'&&fs.realpathSync(`/proc/self/fd/${fd}`)!==file)return fail('stale_evidence');
    if(!Number.isSafeInteger(maxBytes)||maxBytes<64)return fail('unsupported_schema');
    const length=Math.min(stat.size,maxBytes,LIMIT),start=stat.size-length;
    if(!length)return fail('native_unavailable');
    const bytes=Buffer.alloc(length);
    if(fs.readSync(fd,bytes,0,length,start)!==length)return fail('stale_evidence');
    if(bytes[length-1]!==10)return fail('partial_append');
    let offset=0;
    if(start) {
      const previous=Buffer.alloc(1);
      if(fs.readSync(fd,previous,0,1,start-1)!==1)return fail('stale_evidence');
      if(previous[0]!==10) {const newline=bytes.indexOf(10);if(newline<0)return fail('bounded_tail');offset=newline+1;}
    }
    let latest=null,malformed=false;
    while(offset<length) {
      const end=bytes.indexOf(10,offset);
      if(end<0)return fail('partial_append');
      const line=bytes.subarray(offset,end).toString('utf8');
      const recordOffset=start+offset;offset=end+1;
      if(!line.trim())continue;
      let record;
      try {record=JSON.parse(line);} catch {latest=null;malformed=true;continue;}
      if(record?.isSidechain)continue;
      const type=record?.type;
      // Auto compaction writes a synthetic user summary after a finished turn.
      // It is visible history, not submitted input, and must preserve both the
      // previous lifecycle state and completion identity. Real meta prompts
      // (including scheduled tasks) and tool results still start activity.
      if(type==='user'&&record.isCompactSummary===true&&record.isVisibleInTranscriptOnly===true)continue;
      if(type==='system'&&record.subtype==='compact_boundary') {
        // Do not pair a later duration with a preliminary final from before
        // compaction. An already confirmed completion remains valid.
        if(latest?.state==='final')latest={...latest,state:'active'};
        continue;
      }
      if(neutralRecords.has(type))continue;
      if(type!=='user'&&type!=='assistant'&&type!=='system')return fail('unsupported_schema');
      if(type==='system'&&neutralSystem.has(record.subtype))continue;
      if(type==='system'&&record.subtype!=='turn_duration'&&!activitySystem.has(record.subtype))return fail('unsupported_schema');
      const timestamp=Date.parse(record.timestamp);
      if(!Number.isFinite(timestamp))return fail('unsupported_schema');
      const key=`${stat.dev}:${stat.ino}:${recordOffset}`;
      if(type==='user'||(type==='system'&&activitySystem.has(record.subtype))) {
        latest={state:'active',key,timestamp};
      } else if(type==='assistant') {
        const content=record.message?.content;
        const final=record.message?.stop_reason==='end_turn'&&Array.isArray(content)&&
          content.some(block=>block?.type==='text'&&typeof block.text==='string'&&block.text.trim())&&
          !content.some(block=>block?.type==='tool_use');
        latest={state:final?'final':'active',key,timestamp};
      } else if(latest?.state==='final'&&timestamp>=latest.timestamp) {
        latest={...latest,state:'complete'};
      }
    }
    const after=fs.fstatSync(fd);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)return fail('stale_evidence');
    if(!latest)return fail(malformed?'unsupported_schema':start?'bounded_tail':'native_unavailable');
    if(diagnostic)diagnostic.reason=latest.state==='complete'?'native_complete':latest.state==='final'?'native_final':'native_active';
    return latest;
  } catch {return fail('native_unavailable');} finally {if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
