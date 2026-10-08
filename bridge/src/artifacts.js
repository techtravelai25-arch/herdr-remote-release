import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BridgeError} from './herdr.js';
import {associatedProject} from './projects.js';
import {browseProjectFiles, resolveBrowsedFile, validRelative} from './project-files.js';

const MAX_BYTES=20*1024*1024;
const folders=['artifacts','output','outputs','docs/images'];
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.md':'text/plain','.json':'application/json','.html':'text/html','.htm':'text/html','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
const within=(root,file)=>file.startsWith(root+path.sep);
function rootFor(config,cwd) {
  let root;try {root=fs.realpathSync(cwd);}catch {throw new BridgeError('project_unavailable','The project directory is unavailable.',409);}
  if(!associatedProject(config,root)) throw new BridgeError('project_not_allowed','Files are available only inside an approved project.',403);
  return root;
}
function scan(root) {
  const files=[];let inspected=0;
  function walk(folder,depth) {
    if(depth>2||inspected>=500)return;
    let entries;try{if(fs.realpathSync(folder)!==folder||!fs.lstatSync(folder).isDirectory())return;entries=fs.readdirSync(folder,{withFileTypes:true});}catch{return;}
    for(const entry of entries) {
      if(++inspected>500)break;
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())walk(file,depth+1);
      else if(entry.isFile()&&types[path.extname(file).toLowerCase()]) {
        try {
          const stat=fs.lstatSync(file);
          if(stat.size>MAX_BYTES||!stat.isFile()||stat.nlink!==1||fs.realpathSync(file)!==file)continue;
          const relative=path.relative(root,file);
          // Automatic artifact discovery must follow the same credential and
          // hidden-path exclusions as explicit project file browsing.
          if(!validRelative(relative))continue;
          const id='project-'+createHash('sha256').update(root+'\n'+relative).digest('hex');
          files.push({id,name:relative,size:stat.size,modifiedAt:new Date(stat.mtimeMs).toISOString(),source:'project',file,contentType:types[path.extname(file).toLowerCase()]});
        }catch{ /* Removed or changed during a bounded scan. */ }
      }
    }
  }
  folders.forEach(folder=>walk(path.join(root,folder),0));
  return files.sort((a,b)=>b.modifiedAt.localeCompare(a.modifiedAt)).slice(0,40);
}
export function listProjectArtifacts(config,cwd,paneId) {
  const root=rootFor(config,cwd);
  return scan(root).map(({file,contentType,...item})=>({...item,paneId,url:`/v1/panes/${encodeURIComponent(paneId)}/artifacts/${item.id}`}));
}
export function listProjectFiles(config,cwd,directory,cursor) {
  return browseProjectFiles(rootFor(config,cwd),directory,cursor);
}
export function openProjectArtifact(config,cwd,id) {
  const root=rootFor(config,cwd);
  const item=resolveBrowsedFile(root,id) || scan(root).find(file=>file.id===id);
  if(!item)throw new BridgeError('artifact_not_found','Refresh results; this file is unavailable.',404);
  let fd;try {fd=fs.openSync(item.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch {throw new BridgeError('artifact_changed','The file changed. Refresh results and try again.',409);}
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES||fs.realpathSync(item.file)!==item.file||fs.realpathSync(`/proc/self/fd/${fd}`)!==item.file)throw Error('changed');
    return {...item,fd,size:stat.size};
  }catch{fs.closeSync(fd);throw new BridgeError('artifact_changed','The file changed. Refresh results and try again.',409);}
}
