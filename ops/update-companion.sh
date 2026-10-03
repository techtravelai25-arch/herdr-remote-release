#!/usr/bin/env bash
# Run the installed, trusted updater; never execute a freshly downloaded bootstrap.
set -euo pipefail
base=${HERDR_REMOTE_INSTALL_ROOT:?Run herdr-remote update from a managed installation.}
origin=${HERDR_REMOTE_UPDATE_ORIGIN:?Set HERDR_REMOTE_UPDATE_ORIGIN to your HTTPS portal before updating.}
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo 'Update origin must be an HTTPS origin.' >&2; exit 1; }
for tool in node curl tar flock; do command -v "$tool" >/dev/null || { echo "Missing update tool: $tool" >&2; exit 1; }; done
test -f "$base/trusted-release-key.pem" || { echo 'No installed update trust key. Follow the documented one-time migration.' >&2; exit 1; }
exec 8>"$base/update.lock"
flock -n 8 || { echo 'Another companion update is running.' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cp "$base/current/verify-companion.mjs" "$work/verify.mjs"
fetch() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 --max-filesize "$3" -fsSL --retry 2 "$origin$1" -o "$work/$2"; }
fetch /v1/companion/manifest release.json 8192
fetch /v1/companion/signature release.sig 64
node "$work/verify.mjs" metadata "$work/release.json" "$work/release.sig" "$base/trusted-release-key.pem" "$base/accepted-release.json"
fetch /v1/companion/archive herdr-remote-companion.tar.gz 26214400
node "$work/verify.mjs" archive "$work/release.json" "$work/release.sig" "$base/trusted-release-key.pem" "$base/accepted-release.json" "$work/herdr-remote-companion.tar.gz"
# The archive is now authenticated by the installed trust anchor. Advance the
# download floor before installation; failed installs may restore the local backup.
node "$work/verify.mjs" accept "$work/release.json" "$work/release.sig" "$base/trusted-release-key.pem" "$base/accepted-release.json" "$work/herdr-remote-companion.tar.gz"
tar --no-same-owner --no-same-permissions -xzf "$work/herdr-remote-companion.tar.gz" -C "$work"
bash "$work/herdr-remote/install.sh"
