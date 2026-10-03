import portal from './index.js';
import {cleanup} from './admission.js';
import {cleanupDownloadMetrics} from './download-metrics.js';

const CANONICAL_PAGES=new Set(['/','/download','/setup','/source','/install.sh']);

export default {
  ...portal,
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    const legacy=env.LEGACY_PORTAL_ORIGIN;
    if(legacy&&url.origin===legacy&&legacy!==env.PORTAL_ORIGIN){
      if((request.method==='GET'||request.method==='HEAD')&&!url.search&&CANONICAL_PAGES.has(url.pathname)){
        return new Response(null,{status:308,headers:{Location:env.PORTAL_ORIGIN+url.pathname,'Cache-Control':'public, max-age=3600'}});
      }
      // Existing clients keep their verification URL, CSRF origin and issuer.
      return portal.fetch(request,{...env,PORTAL_ORIGIN:legacy},ctx);
    }
    return portal.fetch(request,env,ctx);
  },
  async scheduled(_event,env,ctx){ctx.waitUntil(Promise.all([cleanup(env),cleanupDownloadMetrics(env)]));}
};
export {Relay} from './relay-object.js';
