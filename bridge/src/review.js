import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BridgeError} from './herdr.js';
import {listProjectArtifacts} from './artifacts.js';
import {associatedProject} from './projects.js';

const run = promisify(execFile);
const MAX_OUTPUT = 256 * 1024;
const within = (root,file) => file===root || file.startsWith(root+path.sep);
const fail=(code,message,status=400)=>{throw new BridgeError(code,message,status);};

function approvedCwd(config, cwd) {
  let resolved;
  try { resolved=fs.realpathSync(cwd); } catch { fail('project_unavailable','The project directory is unavailable.',409); }
  const project=associatedProject(config,resolved);
  if(!project) fail('project_not_allowed','Review is only available inside an approved folder.',403);
  return {cwd:resolved, project};
}

async function git(cwd,args) {
  try {
    const result=await run('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd, shell:false, timeout:5000, maxBuffer:MAX_OUTPUT});
    return {text:result.stdout||'', error:null};
  } catch(error) {
    if(error.code==='ENOENT') fail('review_unavailable','Git is not installed on the laptop.',503);
    if(error.killed||error.code==='ETIMEDOUT') fail('review_timeout','The bounded review query timed out.',504);
    return {text:error.stdout||'',error:error.stderr||error.message||'Git query failed.',truncated:error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'};
  }
}

/** Porcelain -z keeps filenames literal, including tabs, newlines and Unicode. */
export function parseChangedFiles(text) {
  const records=text.split('\0');
  const complete=text==='' || text.endsWith('\0');
  records.pop(); // Never expose an unterminated (possibly truncated) record.
  const files=[];
  for(let i=0;i<records.length;i++) {
    const record=records[i];
    if(record.length<4 || record[2]!==' ' || !/^[ MADRCUT?!]{2}$/.test(record.slice(0,2))) return {files,complete:false};
    const xy=record.slice(0,2), file={path:record.slice(3),indexStatus:xy[0],worktreeStatus:xy[1]};
    if(/[RC]/.test(xy)) {
      // With -z the destination precedes the original path, without an arrow.
      if(!records[i+1]) return {files,complete:false};
      file.previousPath=records[++i];
    }
    file.status=['DD','AU','UD','UA','DU','AA','UU'].includes(xy)?'conflicted'
      :xy==='??'?'untracked':xy.includes('R')?'renamed':xy.includes('C')?'copied'
      :xy.includes('D')?'deleted':xy.includes('A')?'added':xy.includes('T')?'typeChanged'
      :xy.includes('M')?'modified':'unknown';
    files.push(file);
  }
  return {files,complete};
}

export async function reviewProject(config,cwd,attachments,deviceId,paneId) {
  const approved=approvedCwd(config,cwd);
  const owned=attachments.list(deviceId,paneId).attachments;
  const artifacts=[...owned.filter(item=>within(approved.cwd,item.cwd)).map(item=>({...item,url:`/v1/attachments/${encodeURIComponent(item.id)}/content`})),...listProjectArtifacts(config,approved.cwd,paneId)];
  const rootResult=await git(approved.cwd,['rev-parse','--show-toplevel']);
  if(rootResult.error||!rootResult.text.trim()) return {available:false,projectId:approved.project.id,reason:'This folder is not a Git worktree.',tests:{status:'unknown',reason:'No structured test result was observed.'},artifacts};
  const root=path.resolve(rootResult.text.trim());
  let configuredRoot; try {configuredRoot=fs.realpathSync(approved.project.authorizationRoot||approved.project.path);} catch {configuredRoot=approved.cwd;}
  if(!within(configuredRoot,root)) fail('project_not_allowed','The Git worktree is outside the approved folder.',403);
  const status=await git(approved.cwd,['status','--porcelain=v1','--branch','--untracked-files=all','--','.']);
  const fileStatus=await git(approved.cwd,['status','--porcelain=v1','-z','--untracked-files=all','--','.']);
  const parsed=parseChangedFiles(fileStatus.text);
  let diff=await git(approved.cwd,['diff','HEAD','--no-ext-diff','--no-textconv','--unified=3','--','.']);
  if(diff.error && !diff.text) diff=await git(approved.cwd,['diff','--no-ext-diff','--no-textconv','--unified=3','--','.']);
  if(status.error&& !status.text) fail('review_unavailable','Git status could not be read.',503);
  return {available:true,projectId:approved.project.id,root,status:status.text.slice(0,MAX_OUTPUT),
    ...(!fileStatus.error || fileStatus.text ? {changedFiles:parsed.files} : {}),
    changedFilesComplete:parsed.complete&&!fileStatus.error&&!fileStatus.truncated,
    ...(fileStatus.error ? {statusError:'The changed-file list could not be fully read. Refresh to try again.'} : {}),
    diff:diff.text.slice(0,MAX_OUTPUT),truncated:!!status.truncated||!!fileStatus.truncated||!!diff.truncated||status.text.length>MAX_OUTPUT||diff.text.length>MAX_OUTPUT,tests:{status:'unknown',reason:'Herdr exposes no structured test result for this pane.'},artifacts};
}
