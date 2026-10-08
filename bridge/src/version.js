import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bridgeRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let cached;

/**
 * The companion release version has one source of truth, companion-version.json:
 * an installed companion ships it beside bridge/, a git checkout keeps it in ops/.
 */
export function readCompanionVersion(root=bridgeRoot) {
  for(const file of [path.join(root,'..','companion-version.json'),path.join(root,'..','ops','companion-version.json')]) {
    try {
      const {version}=JSON.parse(fs.readFileSync(file,'utf8'));
      if(typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version))return version;
    } catch {}
  }
  return 'unknown';
}
export const companionVersion=()=>cached??=readCompanionVersion();
