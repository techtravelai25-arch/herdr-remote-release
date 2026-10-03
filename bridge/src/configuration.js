import path from 'node:path';
/** A legacy process never adopts another installation's configuration implicitly. */
export function configurationPath({root,explicit=process.env.HERDR_REMOTE_CONFIG}) {
  return path.resolve(explicit || path.join(root,'config.json'));
}
