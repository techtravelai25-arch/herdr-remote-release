import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
export function rollbackCompatible(configPath,previous){
  if(fs.existsSync(path.join(previous,'bridge/src/routing-capabilities.js')))return true;
  try{const config=JSON.parse(fs.readFileSync(configPath,'utf8')),state=path.resolve(path.dirname(configPath),config.stateDir||'.state');return !JSON.parse(fs.readFileSync(path.join(state,'routing-mode.json'),'utf8')).strict;}catch(error){return error.code==='ENOENT';}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))process.exitCode=rollbackCompatible(process.argv[2],process.argv[3])?0:1;
