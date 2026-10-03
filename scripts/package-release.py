#!/usr/bin/env python3
"""Verify a signed public APK and produce GitHub release assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--apk', type=Path, required=True)
p.add_argument('--tag', required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
sdk = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or '')
tools = sdk / 'build-tools' / '35.0.0'
if not tools.is_dir():
    raise SystemExit('Set ANDROID_HOME to an SDK with build-tools 35.0.0.')
cert = subprocess.check_output([str(tools/'apksigner'), 'verify', '--print-certs', str(a.apk)], text=True)
fingerprints = re.findall(r'certificate SHA-256 digest: ([0-9a-f]+)', cert)
policy = json.loads((root/'release-signing.json').read_text())
if fingerprints != [policy['certificateSha256']]:
    raise SystemExit('APK does not have the public release signing certificate.')
badging = subprocess.check_output([str(tools/'aapt'), 'dump', 'badging', str(a.apk)], text=True)
match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
if not match or match[1] != policy['applicationId'] or 'application-debuggable' in badging:
    raise SystemExit('Expected a non-debuggable community release APK.')
if a.tag != 'v' + match[3]:
    raise SystemExit('Git tag does not match APK version.')
with zipfile.ZipFile(a.apk) as archive:
    for name in ('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'):
        try:
            packaged = archive.read('assets/' + name)
        except KeyError:
            raise SystemExit('APK is missing distribution notice: ' + name)
        if packaged != (root / name).read_bytes():
            raise SystemExit('APK contains stale distribution notice: ' + name)
size = a.apk.stat().st_size
if not 0 < size <= 100 * 1024 * 1024:
    raise SystemExit('Unexpected APK size.')
digest = hashlib.sha256(a.apk.read_bytes()).hexdigest()
a.out.mkdir(parents=True, exist_ok=True)
shutil.copyfile(a.apk, a.out/'herdr-remote.apk')
metadata = {'versionCode':int(match[2]), 'versionName':match[3], 'size':size, 'sha256':digest, 'applicationId':match[1], 'apkPath':'/v1/app-update/apk', 'certificateSha256':policy['certificateSha256'], 'downloadUrl':f'https://github.com/techtravelai25-arch/herdr-remote-release/releases/download/{a.tag}/herdr-remote.apk'}
(a.out/'app-update.json').write_text(json.dumps(metadata, indent=2)+'\n')
(a.out/'SHA256SUMS').write_text(digest+'  herdr-remote.apk\n')
print('Verified release', match[3], 'package', match[1], 'bytes', size)
