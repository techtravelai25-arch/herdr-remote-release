#!/usr/bin/env bash
# Run from the extracted companion archive. No root or Cloudflare account needed.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [ ! -f "$package_dir/bridge/package-lock.json" ]; then package_dir=$(cd "$package_dir/.." && pwd); fi
[ "$(uname -s)" = Linux ] || { printf 'Automatic installation currently supports Linux.\n' >&2; exit 1; }
for required in curl tar sha256sum systemctl flock; do command -v "$required" >/dev/null || { printf 'Required system tool missing: %s\n' "$required" >&2; exit 1; }; done
export PATH="$HOME/.local/bin:$PATH"
systemctl --user show-environment >/dev/null || { printf 'A running systemd user session is required. Sign in locally and retry.\n' >&2; exit 1; }
install_dir="$HOME/.local/share/herdr-remote-companion"
mkdir -p "$install_dir/releases" "$HOME/.local/bin"
chmod 700 "$install_dir"
exec 9>"$install_dir/install.lock"
flock -n 9 || { printf 'Another companion installation is in progress. Retry after it finishes.\n' >&2; exit 1; }
installer_tmp=$(mktemp -d)
trap 'rm -rf -- "$installer_tmp"' EXIT
if ! command -v node >/dev/null || ! node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'; then
  case "$(uname -m)" in x86_64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) printf 'Unsupported Linux architecture.\n' >&2; exit 1;; esac
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$installer_tmp/SHASUMS256.txt"
  node_archive=$(awk -v suffix="-linux-$node_arch.tar.xz" 'index($2,suffix) && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$installer_tmp/SHASUMS256.txt")
  [[ "$node_archive" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { printf 'Invalid Node release manifest.\n' >&2; exit 1; }
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "https://nodejs.org/dist/latest-v22.x/$node_archive" -o "$installer_tmp/$node_archive"
  (cd "$installer_tmp" && awk -v name="$node_archive" '$2==name' SHASUMS256.txt | sha256sum --check --strict -)
  mkdir -p "$HOME/.local/share/herdr-remote-node" "$HOME/.local/bin"
  tar -xJf "$installer_tmp/$node_archive" --strip-components=1 -C "$HOME/.local/share/herdr-remote-node"
  for binary in node npm npx; do ln -sf "$HOME/.local/share/herdr-remote-node/bin/$binary" "$HOME/.local/bin/$binary"; done
  hash -r
fi
command -v npm >/dev/null || { printf 'npm is required alongside Node.\n' >&2; exit 1; }
if ! command -v herdr >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://herdr.dev/install.sh -o "$installer_tmp/herdr-install.sh"
  # The official installer verifies each binary against its HTTPS release manifest SHA-256.
  HERDR_INSTALL_DIR="$HOME/.local/bin" sh "$installer_tmp/herdr-install.sh"
fi
companion_config="${HERDR_REMOTE_CONFIG:-$HOME/.config/herdr-remote/config.json}"
# Recover an interrupted switch before preparing another release.
if [ -f "$install_dir/pending-previous" ]; then
  recovery_target=$(cat "$install_dir/pending-previous")
  if [ -n "$recovery_target" ] && [ -f "$recovery_target/bridge/src/cli.js" ] && node "$package_dir/bridge/src/upgrade-guard.js" "$companion_config" "$recovery_target"; then
    case "$recovery_target" in "$install_dir"|"$install_dir"/releases/*) ;; *) printf 'Invalid upgrade recovery target.\n' >&2; exit 1;; esac
    rm -f -- "$install_dir/.current-recovery"
    ln -s "$recovery_target" "$install_dir/.current-recovery"
    mv -Tf "$install_dir/.current-recovery" "$install_dir/current"
    if systemctl --user is-active --quiet herdr-remote-companion.service; then systemctl --user restart herdr-remote-companion.service; fi
  else
    rm -f -- "$install_dir/current"
  fi
  rm -f -- "$install_dir/pending-previous"
fi
source_checkout=false
# Git worktrees use a .git file. Require Git to verify the exact source root;
# an extracted archive with a stray .git marker still needs its manifest.
if { [ -d "$package_dir/.git" ] || [ -f "$package_dir/.git" ]; } &&
   command -v git >/dev/null &&
   [ "$(git -C "$package_dir" rev-parse --show-toplevel 2>/dev/null)" = "$package_dir" ]; then
  source_checkout=true
fi
if [ -f "$package_dir/MANIFEST.sha256" ]; then
  (cd "$package_dir" && sha256sum --check --strict MANIFEST.sha256)
elif [ "$source_checkout" = false ]; then
  printf 'Companion package checksum manifest is missing. Download a fresh archive.\n' >&2; exit 1
fi
version_source="$package_dir/companion-version.json"
if [ "$source_checkout" = true ]; then version_source="$package_dir/ops/companion-version.json"; fi
initial_sequence=$(node -e 'const fs=require("node:fs");const release=JSON.parse(fs.readFileSync(process.argv[1]));if(!Number.isSafeInteger(release.sequence)||release.sequence<36||!/^\d+\.\d+\.\d+$/.test(release.version))process.exit(1);console.log(release.sequence)' "$version_source") || {
  printf 'Invalid companion release version.\n' >&2; exit 1
}
# Existing trust is never replaced by a downloaded package. Checkout installs
# use the same checked-in public key; a key change needs an explicit migration.
trust_dir="$package_dir"
if [ "$source_checkout" = true ]; then trust_dir="$package_dir/ops"; fi
if [ -f "$install_dir/trusted-release-key.pem" ] && ! cmp -s "$install_dir/trusted-release-key.pem" "$trust_dir/companion-release-key.pem"; then
  printf 'The installed companion update key differs. Follow the documented key migration; refusing replacement.\n' >&2; exit 1
fi
previous_target=""
if [ -L "$install_dir/current" ]; then previous_target=$(readlink -f "$install_dir/current");
elif [ -f "$install_dir/bridge/src/cli.js" ]; then previous_target="$install_dir"; fi
release_dir=$(mktemp -d "$install_dir/releases/release.XXXXXXXX")
switched=false
committed=false
cleanup_install() {
  result=$?
  if [ "$switched" = true ] && [ "$committed" = false ]; then
    if [ -n "$previous_target" ] && node "$release_dir/bridge/src/upgrade-guard.js" "$companion_config" "$previous_target"; then
      rm -f -- "$install_dir/.current-restore"
      ln -s "$previous_target" "$install_dir/.current-restore"
      mv -Tf "$install_dir/.current-restore" "$install_dir/current"
      systemctl --user restart herdr-remote-companion.service || true
      printf 'Upgrade failed; the previous companion was restored.\n' >&2
    elif [ -n "$previous_target" ]; then
      committed=true # retain the new release for recovery; never downgrade strict routing
      systemctl --user stop herdr-remote-companion.service || true
      printf 'Rollback blocked: the previous version lacks required relay capability checks. Reinstall a compatible companion; keys and Herdr sessions are preserved.\n' >&2
    else
      rm -f -- "$install_dir/current"
    fi
    rm -f -- "$install_dir/pending-previous"
  fi
  if [ "$committed" = false ]; then rm -rf -- "$release_dir"; fi
  rm -rf -- "$installer_tmp"
  exit "$result"
}
trap cleanup_install EXIT
mkdir -p "$release_dir/bridge"
cp -R "$package_dir/bridge/src" "$release_dir/bridge/"
cp "$package_dir/bridge/package.json" "$package_dir/bridge/package-lock.json" "$release_dir/bridge/"
for extra in MANIFEST.sha256 SOURCE_REVISION LICENSE NOTICE README.md; do if [ -f "$package_dir/$extra" ]; then cp "$package_dir/$extra" "$release_dir/"; fi; done
cp "$version_source" "$release_dir/companion-version.json"
cp "$trust_dir/verify-companion.mjs" "$release_dir/verify-companion.mjs"
if [ "$source_checkout" = true ]; then cp "$trust_dir/update-companion.sh" "$release_dir/update.sh";
else cp "$package_dir/update.sh" "$release_dir/update.sh"; fi
(cd "$release_dir/bridge" && npm ci --omit=dev --ignore-scripts && node --input-type=module -e 'await import("./src/server.js"); await import("./src/relay.js"); await import("./src/companion.js")')
printf '%s' "$previous_target" > "$install_dir/pending-previous"
rm -f -- "$install_dir/.current-next"
ln -s "$release_dir" "$install_dir/.current-next"
mv -Tf "$install_dir/.current-next" "$install_dir/current"
switched=true
launcher_tmp=$(mktemp "$HOME/.local/bin/.herdr-remote.XXXXXX")
companion_config="${HERDR_REMOTE_CONFIG:-$HOME/.config/herdr-remote/config.json}"
printf '#!/usr/bin/env bash\nexport PATH=%q:"$PATH"\nexport HERDR_REMOTE_CONFIG=%q\nexport HERDR_REMOTE_INSTALL_ROOT=%q\nexec %q %q "$@"\n' "$HOME/.local/bin" "$companion_config" "$install_dir" "$(command -v node)" "$install_dir/current/bridge/src/cli.js" > "$launcher_tmp"
chmod 755 "$launcher_tmp"
mv -f -- "$launcher_tmp" "$HOME/.local/bin/herdr-remote"
"$HOME/.local/bin/herdr-remote" setup --no-pair "$@"
"$HOME/.local/bin/herdr-remote" doctor --wait
if [ -n "$previous_target" ]; then printf '%s' "$previous_target" > "$install_dir/previous"; fi
committed=true
rm -f -- "$install_dir/pending-previous"
if [ ! -f "$install_dir/trusted-release-key.pem" ]; then install -m 600 "$trust_dir/companion-release-key.pem" "$install_dir/trusted-release-key.pem"; fi
if [ ! -f "$install_dir/accepted-release.json" ]; then printf '{"sequence":%s}\n' "$initial_sequence" > "$install_dir/accepted-release.json"; chmod 600 "$install_dir/accepted-release.json"; fi
printf 'Companion installed. Your keys and existing Herdr sessions were preserved.\n'
# Offline relay status does not roll back a locally healthy release.
"$HOME/.local/bin/herdr-remote" pair || printf 'The relay is not ready. Run herdr-remote pair after reconnecting.\n' >&2
