#!/usr/bin/env bash
# Corresponding source from a clean committed revision, never arbitrary workspace files.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:-"$repo_dir/dist"}
mkdir -p -- "$output_dir"
python3 - "$repo_dir" "$output_dir" <<'PY'
import gzip, io, os, pathlib, re, subprocess, sys, tarfile
root, output = map(pathlib.Path, sys.argv[1:])
revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
if subprocess.check_output(['git','status','--porcelain','--untracked-files=all','--','.',':(exclude)artifacts'],cwd=root):
    raise SystemExit('Release source is dirty. Commit the tested source before packaging.')
paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '-z', revision], cwd=root).decode().split('\0')
# The hosted operator Worker is assembled in a separate private repository.
# Reject accidental copies in committed source before opening an archive.
private_parts = {'herdr-operator-dashboard', 'private-operator', 'operator-wrapper', '_private', '.private'}
private_paths = {
    'portal/src/operator.js', 'portal/src/operator-ui.js',
    'portal/src/cloudflare-usage.js', 'portal/src/cloudflare-pricing.js',
    'portal/scripts/operator-preview.mjs',
    'portal/test/operator.test.js', 'portal/test/operator-ui.test.js',
    'portal/test/cloudflare-pricing.test.js',
    'portal/src/herdr-public-worker.js', 'portal/src/herdr-public-access.js',
    'portal/src/herdr-public-relay.js',
    'docs/asset-preservation-operator-deploy.md',
}
private_import = re.compile(rb'''(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"](?:[^'"\n]*/)?(?:operator|operator-ui|cloudflare-usage|cloudflare-pricing|herdr-public-worker|herdr-public-access|herdr-public-relay)\.js['"]''')
for name in sorted(set(paths)):
    if not name: continue
    item = pathlib.PurePosixPath(name)
    if (name in private_paths or any(part in private_parts for part in item.parts)
            or name.startswith(('docs/operator-dashboard', 'docs/operator-pricing'))):
        raise SystemExit('Refusing source archive containing private operator file: '+name)
    if item.suffix in {'.js', '.mjs', '.ts', '.tsx'}:
        data = subprocess.check_output(['git', 'show', revision+':'+name], cwd=root)
        if private_import.search(data):
            raise SystemExit('Refusing source archive containing private operator import: '+name)
excluded_roots = {'artifacts','output','dist','.git'}
excluded_names = {'.env','.dev.vars','config.json','local.properties'}
excluded_paths = {'portal/wrangler.production.jsonc'}
excluded_suffixes = {'.pem','.key','.jks','.keystore','.apk','.token','.log','.p12','.pfx'}
archive = output / 'herdr-remote-source.tar.gz'
with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as compressed, tarfile.open(fileobj=compressed, mode='w|') as tar:
    for name in sorted(set(paths)):
        if not name: continue
        item = pathlib.PurePosixPath(name)
        if item.name.startswith(('.env.', '.dev.vars.')) or item.name.endswith('.private.json'): continue
        public_release_key = name == 'ops/companion-release-key.pem'
        if name in excluded_paths or item.parts[0] in excluded_roots or item.name in excluded_names or (item.suffix in excluded_suffixes and not public_release_key): continue
        if any(part in {'node_modules','.state','.wrangler','release-assets','build','.gradle'} for part in item.parts): continue
        entry = subprocess.check_output(['git','ls-tree',revision,'--',name],cwd=root,text=True).split()
        if not entry or entry[0] not in {'100644','100755'}: continue
        data = subprocess.check_output(['git','show',revision+':'+name],cwd=root)
        if public_release_key and not re.fullmatch(rb'-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?', data):
            raise SystemExit('Release trust file must contain only a public key.')
        # Refuse common private-key material even in an accidentally tracked file.
        if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?:\r?\n|\\n)[A-Za-z0-9+/=]{32,}', data):
            raise SystemExit('Refusing source archive containing private-key material: '+name)
        info=tarfile.TarInfo('herdr-remote/'+name);info.size=len(data);info.mode=int(entry[0][-3:],8);info.mtime=1577836800
        tar.addfile(info,io.BytesIO(data))
    data=(revision+'\n').encode();info=tarfile.TarInfo('herdr-remote/SOURCE_REVISION');info.size=len(data);info.mode=0o644;info.mtime=1577836800
    tar.addfile(info,io.BytesIO(data))
print('Source archive: '+str(archive))
PY
