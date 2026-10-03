const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const downloads={
  '/v1/release-manifest':['/release-manifest.json','application/json',null],
  '/v1/companion/archive':['/herdr-remote-companion.tar.gz','application/gzip','herdr-remote-companion.tar.gz'],
  '/v1/companion/checksum':['/herdr-remote-companion.tar.gz.sha256','text/plain; charset=utf-8',null],
  '/v1/companion/manifest':['/companion-release.json','application/json',null],
  '/v1/companion/signature':['/companion-release.sig','text/plain; charset=utf-8',null],
  '/v1/companion/public-key':['/companion-release-key.pem','application/x-pem-file',null],
  '/v1/source/archive':['/herdr-remote-source.tar.gz','application/gzip','herdr-remote-source.tar.gz'],
};
/** @param {Request} request @param {Env} env */
export async function handleSetup(request,env) {
  const url=new URL(request.url), asset=downloads[url.pathname];
  if(!asset&&!['/setup','/install.sh','/source'].includes(url.pathname))return null;
  if(url.search||!['GET','HEAD'].includes(request.method))return Response.json({error:{code:'invalid_request',message:'Use GET without query parameters.'}},{status:400,headers});
  if(asset){
    if(!env.ASSETS)return Response.json({error:{code:'download_unavailable',message:'This download is not available yet.'}},{status:503,headers});
    const result=await env.ASSETS.fetch(new Request(new URL(asset[0],env.PORTAL_ORIGIN),{method:request.method}));
    if(result.status!==200)return Response.json({error:{code:'download_unavailable',message:'This download is not available yet.'}},{status:503,headers});
    return new Response(request.method==='HEAD'?null:result.body,{headers:{...headers,'Content-Type':asset[1],...(asset[2]?{'Content-Disposition':`attachment; filename="${asset[2]}"`}:{})}});
  }
  const origin=new URL(env.PORTAL_ORIGIN);
  const local=origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname);
  if((origin.protocol!=='https:'&&!local)||!/^[a-z0-9.-]+$/i.test(origin.hostname)||(origin.port&&!local))throw Error('Invalid setup origin');
  const curlProtocol=local?'=http':'=https';
  const defaultPortal=origin.origin;
  if(url.pathname==='/install.sh'){
    const script=`#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo 'This installer supports Linux.' >&2; exit 1; }
for tool in curl tar sha256sum; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
printf '\\nWhere should Herdr Remote connect?\\n  1) This server (recommended)\\n  2) Another self-hosted server\\n'
if ! read -r -p 'Choose 1 or 2 [1]: ' choice </dev/tty; then
  echo 'A terminal is required to choose a server. Run this installer in an interactive terminal.' >&2
  exit 1
fi
case "$choice" in
  ''|1) portal='${defaultPortal}';;
  2)
    if ! read -r -p 'Your server URL (https://your-domain.example): ' portal </dev/tty; then
      echo 'A server URL is required.' >&2; exit 1
    fi
    if [[ ! "$portal" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
      echo 'Enter an HTTPS origin without a path, query, or credentials.' >&2; exit 1
    fi
    ;;
  *) echo 'Choose 1 or 2.' >&2; exit 1;;
esac
printf 'Installing the companion for %s\\n' "$portal"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl --proto '${curlProtocol}' --tlsv1.2 -fsSL --retry 3 '${origin.origin}/v1/companion/archive' -o "$work/herdr-remote-companion.tar.gz"
curl --proto '${curlProtocol}' --tlsv1.2 -fsSL --retry 3 '${origin.origin}/v1/companion/checksum' -o "$work/checksum"
(cd "$work" && sha256sum --check --strict checksum)
tar -xzf "$work/herdr-remote-companion.tar.gz" -C "$work"
bash "$work/herdr-remote/install.sh" --portal "$portal"
`;
    return new Response(request.method==='HEAD'?null:script,{headers:{...headers,'Content-Type':'text/x-shellscript; charset=utf-8'}});
  }
  const content=url.pathname==='/source'
    ? '<h1>Herdr Remote source code</h1><p>Herdr Remote is free software under AGPL-3.0-or-later.</p><p><a class="button" href="/v1/source/archive">Download this release’s source</a></p><p>The archive includes the Android client, laptop bridge, Cloudflare service, build scripts, tests, licence, and contribution guide. Account credentials and private device data are not part of the source.</p><p><a href="/setup">Set up your laptop</a></p>'
    : `<p class="eyebrow">HERDR REMOTE · LINUX</p><h1>Your laptop.<br>Your agents.<br>On your phone.</h1><p>Set up the companion once, then scan its QR code. Choose this server or enter another server URL in the terminal.</p><h2>1. Install on your Linux laptop</h2><p>Paste this one-line command into a terminal:</p><pre>curl --proto '${curlProtocol}' --tlsv1.2 -fsSL ${origin.origin}/install.sh | bash</pre><p class="muted">The installer asks where to connect, then installs the companion and missing Node.js and Herdr under your user account. Self-hosting requires a deployed compatible Herdr Remote portal at an HTTPS URL. Supports Linux x86_64 and arm64 with a systemd user session. No root required.</p><p><a href="/install.sh">Read the installer</a> · <a href="/v1/companion/archive">Download the companion</a></p><h2>2. Scan the QR on your phone</h2><p><a href="/download">Install Herdr Remote for Android</a>, choose <strong>Scan QR and connect</strong>, and scan the code shown on your laptop. Optional email sign-in can save your laptop list when the portal operator enables it.</p><h2>3. Pick up where you left off</h2><p>Your paired connection is remembered. Keep your laptop awake and online; the companion starts when you log in.</p><aside><strong>Private between your devices</strong><p>Paired relay connections encrypt prompts, history, and files between your phone and laptop. The portal forwards encrypted traffic and sees connection metadata. Your chosen AI providers still receive what you send to their agents.</p></aside><p><a href="/source">Open source · AGPL-3.0-or-later</a></p>`;
  return new Response(request.method==='HEAD'?null:`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up Herdr Remote</title><style>body{margin:0;background:#f5f5f0;color:#202821;font:17px/1.65 system-ui,sans-serif}main{max-width:680px;margin:64px auto;padding:0 24px 48px}h1{font-size:clamp(38px,7vw,62px);line-height:1.08;letter-spacing:-.04em;margin:18px 0 28px}h2{font-size:22px;margin-top:38px}a{color:#275b36;text-underline-offset:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e7ebe2;padding:20px;border-radius:10px;font-size:14px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em}.muted{color:#526052;font-size:14px}aside{border-left:3px solid #4b6e47;margin-top:36px;padding-left:20px}.button{display:inline-block;padding:12px 20px;background:#275b36;color:white;border-radius:8px;text-decoration:none}</style></head><body><main>${content}</main></body></html>`,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}});
}
