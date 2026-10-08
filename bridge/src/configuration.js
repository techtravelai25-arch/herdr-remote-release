import path from 'node:path';
/** A legacy process never adopts another installation's configuration implicitly. */
export function configurationPath({root,explicit=process.env.HERDR_REMOTE_CONFIG}) {
  return path.resolve(explicit || path.join(root,'config.json'));
}
/** `serve` listens here when a config has no port (README and config.example.json). */
export const DEFAULT_PORT=8787;
/** A new managed companion config uses this port so a checkout bridge can keep 8787. */
export const MANAGED_PORT=8788;
