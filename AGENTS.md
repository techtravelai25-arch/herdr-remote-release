# Release repository instructions

These instructions apply to this repository and all files within it.

## GitHub publishing identity

- Publish only to `https://github.com/techtravelai25-arch/herdr-remote-release` unless the user explicitly selects another destination.
- Always authenticate GitHub writes, including pushes, tags, pull requests and release updates, for this repository as `techtravelai25-arch`.
- Both Git author and committer names must be `techtravelai25-arch`.
- Both Git author and committer emails must be `334168460+techtravelai25-arch@users.noreply.github.com`.
- Verify the active account with `gh api user --jq .login` before writing to GitHub. Verify the commit's author and committer before pushing.
- Use HTTPS with the GitHub CLI credential helper. Do not rely on a shared SSH key to select the publishing account.
- Keep repository-local Git identity configured to this account. If switching from another active GitHub account for this task, restore the previously active account when finished.
- Push to `main`; create extra branches only when explicitly requested.
- Keep published source, documentation, screenshots and release metadata free of unrelated personal identities and private data. Preserve required third-party copyright and license notices.

## Screenshots and release artifacts

Use the community app or native UI previews with example data for public screenshots. Do not publish real conversations, credentials, pairing QR codes or private workstation paths. Keep signing keys and local configuration outside Git.
