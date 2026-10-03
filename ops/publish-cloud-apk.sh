#!/usr/bin/env bash
# Stage exactly two verified public release files, then publish one Worker version.
set -euo pipefail
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_ROOT=${HERDR_LOCAL_BUILD_ROOT:-$HOME/.local/share/herdr-remote-build}
export PATH="$BUILD_ROOT/jdk-17/bin:$PATH"
MODE=${1:---stage-only}
if [[ "$MODE" != --publish && "$MODE" != --stage-only ]]; then
  echo 'Usage: ops/publish-cloud-apk.sh [--stage-only | --publish]' >&2
  exit 2
fi
exec 9>"$PROJECT_ROOT/portal/.publish-cloud.lock"
flock 9
python3 - "$PROJECT_ROOT" "$BUILD_ROOT" <<'PY'
import hashlib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
root, tools = map(Path, sys.argv[1:])
portal = root / 'portal'
assets = portal / 'release-assets'
source_apk = root / 'artifacts/herdr-remote.apk'
source_metadata = root / 'artifacts/app-update.json'
bin_dir = tools / 'android-sdk/build-tools/35.0.0'

def certificate(apk):
    output = subprocess.check_output([str(bin_dir/'apksigner'), 'verify', '--print-certs', str(apk)], text=True)
    cert = re.findall(r'certificate SHA-256 digest: ([0-9a-f]+)', output)
    if not cert:
        raise ValueError('APK has no verified signing certificate.')
    return cert

stage = Path(tempfile.mkdtemp(prefix='.release-assets-', dir=portal))
try:
    if source_metadata.stat().st_size > 16384:
        raise ValueError('Release metadata is too large.')
    if not 0 < source_apk.stat().st_size <= 25 * 1024 * 1024:
        raise ValueError('APK exceeds the Cloudflare Static Assets 25 MiB file limit.')
    # Validate the actual staged copy, not a file that can change before upload.
    apk = stage/'herdr-remote.apk'
    shutil.copyfile(source_apk, apk)
    if not 0 < apk.stat().st_size <= 25 * 1024 * 1024:
        raise ValueError('Staged APK exceeds the Cloudflare Static Assets 25 MiB file limit.')
    metadata = json.loads(source_metadata.read_text())
    hasher = hashlib.sha256()
    with apk.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): hasher.update(chunk)
    digest = hasher.hexdigest()
    if metadata.get('apkPath') != '/v1/app-update/apk' or metadata.get('size') != apk.stat().st_size or metadata.get('sha256') != digest:
        raise ValueError('Published APK size/hash/path does not match its metadata; run ops/publish-apk.sh first.')
    cert = certificate(apk)
    subprocess.run([sys.executable, str(root/'ops/check-apk-linkage.py'), str(apk)], check=True)
    local_build = root / 'android/app/build/outputs/apk/release/app-release.apk'
    if not local_build.is_file() or certificate(local_build) != cert:
        raise ValueError('APK signer does not match the locally built Android app.')
    policy = json.loads((root/'release-signing.json').read_text())
    if cert[0] != policy.get('certificateSha256'):
        raise ValueError('APK signer does not match the release signing policy.')
    badging = subprocess.check_output([str(bin_dir/'aapt'), 'dump', 'badging', str(apk)], text=True)
    if 'application-debuggable' in badging:
        raise ValueError('Refusing to stage a debuggable APK.')
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    if not match or match[1] != 'dev.herdr.remote.community' or metadata.get('applicationId') not in (None, match[1]) or type(metadata.get('versionCode')) is not int or int(match[2]) != metadata['versionCode'] or match[3] != metadata.get('versionName'):
        raise ValueError('APK package/version does not match release metadata.')
    if (assets/'app-update.json').exists():
        previous = json.loads((assets/'app-update.json').read_text())
        if previous['versionCode'] > metadata['versionCode']:
            raise ValueError('Refusing to stage an older APK version.')
        if previous['versionCode'] == metadata['versionCode'] and previous.get('sha256') != digest:
            raise ValueError('Changed APK requires a new version code.')
        if certificate(assets/'herdr-remote.apk') != cert:
            raise ValueError('Refusing to replace an APK signed with a different certificate.')
    clean = {key: metadata[key] for key in ('versionCode','versionName','size','sha256','apkPath')}
    clean['applicationId'] = match[1]
    clean['certificateSha256'] = cert[0]
    for optional in ('downloadUrl','sourceRevision'):
        if optional in metadata: clean[optional] = metadata[optional]
    (stage/'app-update.json').write_text(json.dumps(clean,indent=2)+'\n')
    for file in stage.iterdir(): os.chmod(file,0o644)
    backup = portal/'.release-assets-previous'
    if backup.exists(): shutil.rmtree(backup)
    if assets.exists(): assets.rename(backup)
    try: stage.rename(assets)
    except BaseException:
        if backup.exists(): backup.rename(assets)
        raise
    if backup.exists(): shutil.rmtree(backup)
    print(f"Staged {clean['versionName']} ({clean['versionCode']}): {clean['size']} bytes, SHA-256 {digest}")
except (ValueError, OSError, subprocess.CalledProcessError) as error:
    raise SystemExit(str(error))
finally:
    if stage.exists(): shutil.rmtree(stage)
PY
if [[ "$MODE" == --stage-only ]]; then
  exit 0
fi
cd "$PROJECT_ROOT/portal"
npm run types
npm run check
npm test
npm run dry-run
[[ -f wrangler.local.jsonc ]] || { echo "Create portal/wrangler.local.jsonc for your deployment." >&2; exit 1; }
npx wrangler deploy --config wrangler.local.jsonc
echo 'Deployment complete. Use the download URL configured for your portal.'
