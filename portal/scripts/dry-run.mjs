import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
mkdirSync(new URL('../release-assets/', import.meta.url), {recursive:true});
const result = spawnSync('wrangler', ['deploy','--dry-run'], {stdio:'inherit',shell:false});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
