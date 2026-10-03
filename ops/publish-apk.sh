#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_ROOT=${HERDR_LOCAL_BUILD_ROOT:-$HOME/.local/share/herdr-remote-build}
export PATH="$BUILD_ROOT/jdk-17/bin:$PATH"
python3 - "$PROJECT_ROOT" "$BUILD_ROOT" <<'PY'
import hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path
root, tools = map(Path, sys.argv[1:])
source = root / 'android/app/build/outputs/apk/release/app-release.apk'
target = root / 'artifacts/herdr-remote.apk'
manifest = root / 'artifacts/app-update.json'
bin_dir = tools / 'android-sdk/build-tools/35.0.0'

def certificate(apk):
    output = subprocess.check_output([str(bin_dir/'apksigner'), 'verify', '--print-certs', str(apk)], text=True)
    return re.findall(r'certificate SHA-256 digest: ([0-9a-f]+)', output)

cert = certificate(source)
subprocess.run([sys.executable, str(root/'ops/check-apk-linkage.py'), str(source)], check=True)
policy = json.loads((root/'release-signing.json').read_text())
if not cert or cert[0] != policy.get('certificateSha256'):
    raise SystemExit('APK signer does not match the release signing policy.')
if not cert or (target.exists() and certificate(target) != cert):
    raise SystemExit('APK signing certificate differs from the published APK; refusing to publish.')
badging = subprocess.check_output([str(bin_dir/'aapt'), 'dump', 'badging', str(source)], text=True)
match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
if not match or match[1] != 'dev.herdr.remote.community':
    raise SystemExit('Unexpected APK application ID.')
if 'application-debuggable' in badging:
    raise SystemExit('Refusing to publish a debuggable APK.')
version = int(match[2])
if manifest.exists() and json.loads(manifest.read_text())['versionCode'] > version:
    raise SystemExit('Refusing to publish an older APK version.')
size = source.stat().st_size
if not 0 < size <= 100 * 1024 * 1024:
    raise SystemExit('APK has an unexpected size.')
digest = hashlib.sha256()
with source.open('rb') as apk_file:
    for chunk in iter(lambda: apk_file.read(1024 * 1024), b''):
        digest.update(chunk)
metadata = {'versionCode': version, 'versionName': match[3], 'size': size,
            'sha256': digest.hexdigest(),
            'apkPath': '/v1/app-update/apk',
            'applicationId': match[1], 'certificateSha256': cert[0],
            'downloadUrl': f'https://github.com/techtravelai25-arch/herdr-remote-release/releases/download/v{match[3]}/herdr-remote.apk'}
if manifest.exists():
    previous = json.loads(manifest.read_text())
    if previous['versionCode'] == version and previous.get('sha256') != metadata['sha256']:
        raise SystemExit('Changed APK requires a new version code.')
target.parent.mkdir(exist_ok=True)
partial = target.with_suffix('.apk.part')
shutil.copyfile(source, partial)
os.chmod(partial, 0o644)
os.replace(partial, target)
partial_manifest = manifest.with_suffix('.json.part')
partial_manifest.write_text(json.dumps(metadata, indent=2) + '\n')
os.replace(partial_manifest, manifest)
(target.parent / 'SHA256SUMS').write_text(f"{metadata['sha256']}  {target.name}\n")
print(f"Packaged {match[3]} (versionCode {version}), {size} bytes")
print(f"SHA-256: {metadata['sha256']}")
PY
