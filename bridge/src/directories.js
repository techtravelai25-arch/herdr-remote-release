import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from './herdr.js';
import {canonicalDirectory,within} from './projects.js';
const PAGE_SIZE=200;
const fail=(code,message,status=400)=>{throw new BridgeError(code,message,status);};

export class Directories {
  constructor(home,store) {this.home=canonicalDirectory(home);this.store=store;}
  resolve(value=this.home) {
    if(!this.home)fail('directory_unavailable','The home directory is unavailable.',409);
    if(typeof value!=='string'||!path.isAbsolute(value)||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_directory','Choose an absolute folder path.');
    const directory=canonicalDirectory(value);
    if(!directory)fail('directory_unavailable','This folder is unavailable. Refresh and choose another folder.',409);
    if(!within(this.home,directory))fail('directory_not_allowed','Choose a folder inside your home directory.',403);
    return directory;
  }
  recent() {
    let stored;try {stored=this.store.read('recent-directories.json',[]);}catch {return [];}
    if(!Array.isArray(stored))return [];
    return [...new Set(stored.filter(value=>typeof value==='string'))].flatMap(value=>{
      const canonical=canonicalDirectory(value);
      return canonical&&this.home&&within(this.home,canonical)?[{name:canonical===this.home?'Home':path.basename(canonical),path:canonical}]:[];
    }).slice(0,12);
  }
  record(directory) {
    const canonical=canonicalDirectory(directory);
    if(!canonical||!this.home||!within(this.home,canonical))return;
    this.store.write('recent-directories.json',[canonical,...this.recent().map(item=>item.path).filter(value=>value!==canonical)].slice(0,12));
  }
  async list(value,cursor) {
    const current=this.resolve(value);
    if(cursor!==undefined && (typeof cursor!=='string'||!/^\d{1,9}$/.test(cursor)))fail('invalid_cursor','Invalid folder page.');
    const offset=Number(cursor??0);
    let entries;try {entries=await fs.promises.readdir(current,{withFileTypes:true});}catch {fail('directory_unavailable','This folder cannot be read.',409);}
    const eligible=entries.filter(entry=>entry.isDirectory()||entry.isSymbolicLink()).sort((a,b)=>a.name.localeCompare(b.name)||(a.name<b.name?-1:a.name>b.name?1:0));
    // The cursor counts inspected entries, so symlinks outside home cannot make
    // pagination repeat or skip valid siblings. Resolve at most one page here.
    const page=eligible.slice(offset,offset+PAGE_SIZE);
    const directories=page.flatMap(entry=>{
      const canonical=canonicalDirectory(path.join(current,entry.name));
      return canonical&&within(this.home,canonical)?[{name:entry.name,path:canonical}]:[];
    });
    return {home:this.home,current,parent:current===this.home?null:path.dirname(current),directories,recent:this.recent(),nextCursor:offset+PAGE_SIZE<eligible.length?String(offset+PAGE_SIZE):null};
  }
}
