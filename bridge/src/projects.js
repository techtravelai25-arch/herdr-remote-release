import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const within = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
export function canonicalDirectory(directory) {
  if(typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f\u007f]/.test(directory)) return null;
  try {const canonical=fs.realpathSync(directory);return fs.statSync(canonical).isDirectory()?canonical:null;} catch {return null;}
}

/** Authorization and grouping are separate: home access does not group every folder as Home. */
export function associatedProject(config, cwd) {
  const canonical=canonicalDirectory(cwd);if(!canonical)return null;
  const home=canonicalDirectory(config.homeDirectory);
  const insideHome=home&&within(home,canonical);
  const configured=config.projects.map(project=>({project,root:canonicalDirectory(project.path)}))
    .filter(entry=>entry.root&&within(entry.root,canonical)).sort((a,b)=>b.root.length-a.root.length)[0];
  if(configured)return {...configured.project,authorizationRoot:insideHome?home:configured.root};
  if(!insideHome)return null;
  return {id:'directory-'+createHash('sha256').update(canonical).digest('hex').slice(0,24),label:canonical===home?'Home':path.basename(canonical),path:canonical,authorizationRoot:home};
}
