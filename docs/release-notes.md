# Herdr Remote 0.8.39

Android 0.8.39 (74) and laptop companion 0.8.39 (sequence 75). This signed community APK updates 0.8.38 in place with the same certificate. Update both the app and companion for the new trust control.

- When Claude Code starts in a new folder, the app shows its full workspace path and safety warning in a native card. **No, exit** and **Yes, I trust this folder** are the two explicit choices. Trust is sent only after tapping that choice.
- The companion accepts a trust action only while the complete startup screen still belongs to the selected folder and pane. A partial, changed, or ambiguous screen stays in the terminal fallback.
- The local Claude Code/Herdr fixture also covers choosing Exit on the startup trust screen.

Download [herdr-remote.apk](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) and follow [laptop setup](setup.md). Android 8.0+ is required. Physical-device and optional self-hosted cloud acceptance are separate checks.

## Herdr Remote 0.8.38

Android 0.8.38 (73) and laptop companion 0.8.38 (sequence 74). Update both the app and companion for the question controls. This signed community APK updates 0.8.34 in place with the same certificate.

- Claude Code questions now show structured answer cards for single choices, multiple selections, custom answers, and review. The companion checks the current question, cursor, selections, and typed draft before sending input; stale or ambiguous state is rejected. Terminal controls remain available for recovery.
- Optional self-hosted app updates validate the installed community package ID while keeping the same signing-key and version checks.
- Question controls remain reachable in the conversation view, with clearer button labels and spacing.
- Codex status and completion handling follow the active session. Live monitoring sends a reply-ready alert only after explicit completion, and preserves unsent drafts when a dispatch has not completed.

The release includes an opt-in local Claude Code/Herdr fixture that checks the actual tool result after phone-style HTTP actions. It uses isolated test panes and a local fake model endpoint; it requires installed Claude Code and Herdr and makes no paid model request. See [release checks](releases.md).

Download [herdr-remote.apk](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) and follow [laptop setup](setup.md). Android 8.0+ is required. Physical-device and optional self-hosted cloud acceptance are separate checks.

## Herdr Remote 0.8.34

Android 0.8.34 (69) and laptop companion 0.8.34 (sequence 70). This release updates community 0.8.26 in place with the same signing certificate. Update both the app and the companion (`herdr-remote update` on a managed laptop) for the new controls. It includes all changes listed for 0.8.33 below, which was not published separately from this repository.

- The companion no longer crashes if `devices.json` is malformed; a failed device check closes only that connection.
- Relay replay protection writes a compact ID list per request and syncs it to disk only for actions, instead of a pretty-printed file with two disk syncs per request. It no longer rejects new requests after 10,000 IDs.
- Snapshots keep at most 8 notification event IDs per pane, so many long-lived panes stay under the relay's response limit.
- Previews of local web servers (`http://localhost`) now require a device with write access. Read-only devices can still preview project files.
- Android performs relay networking, decryption and JSON decoding off the main thread and caps direct HTTPS response size. Turning off cloud push clears only cloud-push notifications.
- The release APK is shrunk with R8 and is much smaller.
- Self-hosted portal: sign-in rate limits can no longer be exhausted by a few IP addresses, relay rate counters no longer cost a storage write per message, and unexpected errors are logged by route without identifiers.

Download [herdr-remote.apk](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) and follow [laptop setup](setup.md). Android 8.0+ is required. An iOS app is not included.

## Herdr Remote 0.8.33

Changes since community 0.8.26:

- **Clean transcript.** Claude Code and Codex conversations open as a saved transcript: your messages and the agent's replies are shown separately, tool steps collapse to one line, and new messages arrive while the pane is open. The raw terminal stays one tap away and remains the fallback. Earlier messages page in by conversation turn.
- **Session identity.** The companion finds a Codex or Claude Code pane's conversation itself when Herdr does not report one; ambiguous matches fall back to the terminal.
- **Local HTML previews.** Tap an HTML result link or an HTML file in Files/Results to open it with Back and Refresh controls. Nearby styles, images, and scripts load through the paired laptop connection. See [HTML previews](html-previews.md).
- **Questions.** Codex questions asked as a session opens, and questions using Codex's current footer, now appear as question cards. Live questions stay visible while native controls load.
- **Claude Code model switching.** The model picker works with custom status lines, lists every model in the scrolling picker, and handles the "Switch model?" confirmation.
- **Usage.** Claude usage appears for each account managed by claude-swap, with the active account first, alongside Codex usage. Credentials are never read.
- **Notifications.** Reading a completed reply on the PC clears the matching phone notification again. See [PC activity and notification dismissal](notification-acknowledgement.md).
- **Dashboard.** Waiting and working sessions are listed first and idle sessions last, keeping project grouping within each band.
- **Fixes.** Older sent messages no longer reappear as temporary bubbles, pending prompt rows expire after 90 seconds, and Claude Code terminal output renders tables and input boxes more cleanly.

## Herdr Remote 0.8.26

First Android release from this repository, published as a fresh source snapshot.

- Self-hosted QR pairing and a separate community Android package.
- Current bridge and Android protocol support, conversation history, attachments, and change review.
- Review state clears when selecting another pane, and failed review loads clear obsolete content.
- Landscape terminal and composer layouts remain reachable when space is limited.
- Stale attachment snapshots disable deletion until refreshed.
- Optional cloud features require an explicitly configured deployment.

Download [herdr-remote.apk](https://github.com/techtravelai25-arch/herdr-remote-release/releases/latest/download/herdr-remote.apk) and follow [laptop setup](setup.md). Android 8.0+ is required. This release uses a new signing identity; older community APKs signed with a different key require a fresh installation and pairing. An iOS app is not included.

The release is checked on an Android emulator. Physical-device and optional self-hosted cloud acceptance remain separate checks.
