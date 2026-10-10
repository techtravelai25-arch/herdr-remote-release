#!/usr/bin/env bash
# Community test builds have a separate package and preserve other paired apps.
set -euo pipefail
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sdk_dir=${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}
adb_tool=$sdk_dir/platform-tools/adb
aapt_tool=$sdk_dir/build-tools/35.0.0/aapt
serial=${HERDR_EMULATOR_SERIAL:-emulator-5554}
log_file=${HERDR_UI_TEST_LOG:-$repo_dir/output/emulator-ui-tests.log}
debug_apk=$repo_dir/android/app/build/outputs/apk/debug/app-debug.apk
test_apk=$repo_dir/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
(cd "$repo_dir/android" && ./gradlew --no-daemon --max-workers=1 '-Dorg.gradle.jvmargs=-Xmx896m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8' -Pkotlin.compiler.execution.strategy=in-process :app:assembleDebug :app:assembleDebugAndroidTest)
python3 - "$aapt_tool" "$debug_apk" "$test_apk" <<'VERIFY'
import subprocess, sys
for apk, expected in zip(sys.argv[2:], ('dev.herdr.remote.community.debug', 'dev.herdr.remote.community.debug.test')):
    output = subprocess.check_output([sys.argv[1], 'dump', 'badging', apk], text=True)
    if not output.startswith("package: name='" + expected + "'"):
        raise SystemExit('Refusing to install an unexpected package: ' + apk)
VERIFY
"$adb_tool" -s "$serial" get-state | grep -qx device
"$adb_tool" -s "$serial" install -r "$debug_apk" >/dev/null
"$adb_tool" -s "$serial" install -r "$test_apk" >/dev/null
# Tray tests use synthetic alerts and require permission on the fixture app only.
api_level=$("$adb_tool" -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')
[[ "$api_level" =~ ^[0-9]+$ ]] || { echo "Could not read emulator API level" >&2; exit 1; }
if (( api_level >= 33 )); then
    "$adb_tool" -s "$serial" shell pm grant dev.herdr.remote.community.debug android.permission.POST_NOTIFICATIONS
fi
mkdir -p "$(dirname -- "$log_file")"
"$adb_tool" -s "$serial" shell am instrument -w -r \
    dev.herdr.remote.community.debug.test/androidx.test.runner.AndroidJUnitRunner > "$log_file"
python3 - "$log_file" <<'VERIFY'
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text(errors='replace')
match = re.search(r'\bOK \((\d+) tests?\)', text)
if not match or 'FAILURES!!!' in text or 'INSTRUMENTATION_FAILED' in text:
    print(text[-3000:])
    raise SystemExit('UI instrumentation failed; see ' + sys.argv[1])
print('Community UI instrumentation passed:', match.group(1), 'tests')
VERIFY
