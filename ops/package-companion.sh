#!/usr/bin/env bash
# Production artifacts are built from an immutable clean revision, never ignored files.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
development=false
if [ "${1:-}" = --dev ]; then development=true; shift; fi
if [ "$development" = false ] && [ -n "$(git -C "$repo_dir" status --porcelain --untracked-files=all -- . ':(exclude)artifacts')" ]; then printf 'Commit the clean release source before packaging (or use --dev for a test artifact).\n' >&2; exit 1; fi
output_dir=${1:-"$repo_dir/dist"}
mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
staging_dir=$(mktemp -d)
trap 'rm -rf -- "$staging_dir"' EXIT
mkdir -p "$staging_dir/herdr-remote/bridge"
if [ "$development" = true ]; then
  cp -R "$repo_dir/bridge/src" "$staging_dir/herdr-remote/bridge/"
  cp "$repo_dir/bridge/package.json" "$repo_dir/bridge/package-lock.json" "$staging_dir/herdr-remote/bridge/"
  cp "$repo_dir/docs/companion-setup.md" "$staging_dir/herdr-remote/README.md"
  cp "$repo_dir/ops/install-companion.sh" "$staging_dir/herdr-remote/install.sh"
  cp "$repo_dir/ops/update-companion.sh" "$staging_dir/herdr-remote/update.sh"
  cp "$repo_dir/ops/verify-companion.mjs" "$repo_dir/ops/companion-release-key.pem" "$staging_dir/herdr-remote/"
  cp "$repo_dir/ops/companion-version.json" "$staging_dir/herdr-remote/companion-version.json"
  for legal_file in LICENSE NOTICE; do if [ -f "$repo_dir/$legal_file" ]; then cp "$repo_dir/$legal_file" "$staging_dir/herdr-remote/"; fi; done
else
  git -C "$repo_dir" archive HEAD bridge/src bridge/package.json bridge/package-lock.json | tar -x -C "$staging_dir/herdr-remote"
  git -C "$repo_dir" show HEAD:docs/companion-setup.md > "$staging_dir/herdr-remote/README.md"
  git -C "$repo_dir" show HEAD:ops/install-companion.sh > "$staging_dir/herdr-remote/install.sh"
  git -C "$repo_dir" show HEAD:ops/update-companion.sh > "$staging_dir/herdr-remote/update.sh"
  for trusted_file in verify-companion.mjs companion-release-key.pem; do git -C "$repo_dir" show "HEAD:ops/$trusted_file" > "$staging_dir/herdr-remote/$trusted_file"; done
  git -C "$repo_dir" show HEAD:ops/companion-version.json > "$staging_dir/herdr-remote/companion-version.json"
  for legal_file in LICENSE NOTICE; do if git -C "$repo_dir" cat-file -e "HEAD:$legal_file" 2>/dev/null; then git -C "$repo_dir" show "HEAD:$legal_file" > "$staging_dir/herdr-remote/$legal_file"; fi; done
fi
git -C "$repo_dir" rev-parse HEAD > "$staging_dir/herdr-remote/SOURCE_REVISION"
if [ "$development" = true ]; then printf 'development\n' >> "$staging_dir/herdr-remote/SOURCE_REVISION"; fi
if [ -n "$(find "$staging_dir/herdr-remote" -type l -print -quit)" ]; then
  printf 'Companion archives cannot contain symbolic links.\n' >&2; exit 1
fi
(cd "$staging_dir/herdr-remote" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum) > "$staging_dir/herdr-remote/MANIFEST.sha256"
COPYFILE_DISABLE=1 tar --format=ustar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner -czf "$output_dir/herdr-remote-companion.tar.gz" -C "$staging_dir" herdr-remote
(cd "$output_dir" && sha256sum herdr-remote-companion.tar.gz > herdr-remote-companion.tar.gz.sha256)
printf 'Companion artifact: %s\n' "$output_dir/herdr-remote-companion.tar.gz"
