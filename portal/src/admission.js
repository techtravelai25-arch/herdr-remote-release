import {sha256Hex} from './crypto-utils.js';
/** Atomically charge all business quotas, or none. Accepted delivery failures remain charged. */
export async function admit(env,operation,quotas,clock=Math.floor(Date.now()/1000)) {
  const entries=await Promise.all(quotas.map(async q=>({key:await sha256Hex(q.key+(q.cooldown?'':`:${Math.floor(clock/q.window)}`)),limit:q.limit,expires:q.cooldown?clock+q.window:(Math.floor(clock/q.window)+1)*q.window})));
  const statements=entries.map(q=>env.DB.prepare('INSERT INTO quota_counters(key,count,expires_at) VALUES (?,0,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 0 ELSE count END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END').bind(q.key,q.expires,clock,clock));
  const condition=entries.map(()=>'(SELECT count FROM quota_counters WHERE key=?)<?').join(' AND ');
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO admissions(id,expires_at) SELECT ?,? WHERE ${condition}`).bind(operation,clock+86400,...entries.flatMap(q=>[q.key,q.limit])));
  for(const q of entries)statements.push(env.DB.prepare('UPDATE quota_counters SET count=count+1 WHERE key=? AND EXISTS(SELECT 1 FROM admissions WHERE id=? AND state=0)').bind(q.key,operation));
  statements.push(env.DB.prepare('UPDATE admissions SET state=1 WHERE id=? AND state=0 RETURNING id').bind(operation));
  const result=await env.DB.batch(statements);
  return result.at(-1).results.length===1;
}
/** Expiration does not depend on a user starting email sign-in. Batches remain bounded. */
export async function cleanup(env) {
  const clock=Math.floor(Date.now()/1000);
  await env.DB.batch(['quota_counters','admissions','rate_limits','email_challenges','auth_requests','sessions'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at<=? ORDER BY expires_at LIMIT 1000)`).bind(clock)));
}
