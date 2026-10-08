# Release validation: 0.8.34

Verified locally on 2026-10-08 before publication.

- Android: 260 unit tests, 257 passed and 3 opt-in live checks skipped. Debug and release lint have zero errors (15 warnings in each variant). The release build is shrunk with R8.
- Community UI: all 70 Compose instrumentation tests passed on Android 15 / API 35, including HTML previews, the conversation transcript, notification acknowledgement, review isolation and first-run PC setup.
- The signed release APK installed over community 0.8.26 (61) in place as `dev.herdr.remote.community`, version 0.8.34 (69), with no signature change or reinstall. First-run setup and Settings opened with optional cloud endpoints disabled, and the crash log stayed empty. A separately installed app on the emulator was left installed and untouched.
- Bridge: all 350 tests passed. Portal: 93 passed and 1 optional check skipped (94 total); types, type checking and deployment dry-run passed. Linux setup generator tests passed.
- All 158 resolved Android release runtime components match the dependency notice inventory. The Compose tooling-preview library is no longer shipped and its entries were removed. The APK's LICENSE, NOTICE and THIRD_PARTY_NOTICES.md match the source byte for byte.
- Release package, version, non-debuggable status, APK signature and bytecode linkage passed.

APK: 3,235,352 bytes. SHA-256: `32a2da9e69f820a3f3e9254ff9acf95e56782198c393f4a603f01866579cf4a4`.
Certificate SHA-256: `fb79225bfd54ca4158db75befca85ec8980a742fcf2b13b6ae86d779325dc73e` (unchanged since 0.8.26).

CI and anonymous download checks run after pushing; this document does not claim hosted CI or build provenance before they have run.

No physical Android phone was attached. The community package was not paired to an active user's pane, and no commands were sent to active user sessions. Optional portal/email/FCM and managed companion deployments require acceptance checks with the operator's own configuration.
