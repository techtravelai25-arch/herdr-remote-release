# Release validation: 0.8.26

Verified locally on 2026-10-03 before publication.

- Android: 226 unit tests, 223 passed and 3 opt-in live checks skipped; debug/release lint has zero errors (14 warnings in each variant).
- Community UI: all 56 Compose instrumentation tests passed on Android 15 / API 35, including review isolation, limited-height terminal layout, stale attachment deletion, and first-run PC setup.
- Signed release APK installed and launched as `dev.herdr.remote.community`, version 0.8.26 (61). Setup and Settings opened successfully with optional cloud endpoints disabled. The existing paired app was preserved.
- Bridge: all 285 tests passed. Portal: 86 passed and 1 optional check skipped; types, type checking and deployment dry-run passed.
- Linux setup generator and shell syntax checks passed. After establishing a separate public companion trust key, all 14 companion tests and both source packaging tests passed.
- Source export passed checksum-verified Gitleaks scanning with one narrow exception for a deterministic public relay test vector. The source and unpacked APK contain no excluded prior-owner identity or production operator domain.
- All 160 resolved Android release runtime components match the dependency notice inventory. The APK's LICENSE, NOTICE and THIRD_PARTY_NOTICES.md match the source byte for byte.
- Release package, version, non-debuggable status, APK signature and bytecode linkage passed. Packaging rejects a mismatched version tag and a different signing certificate.

APK: 14,844,489 bytes. SHA-256: `377a0f4ea73becbb4b120de1d064ca490aa85ed3443ab61f863157ec7f6dea93`.
Certificate SHA-256: `fb79225bfd54ca4158db75befca85ec8980a742fcf2b13b6ae86d779325dc73e`.

The GitHub snapshot uses a fresh root commit and the release account identity. CI and anonymous download checks run after pushing; this document does not claim hosted CI or build provenance before they have run.

No physical Android phone was attached. The community package was not paired to an active user's pane, and no commands were sent to active user sessions. Optional portal/email/FCM and managed companion deployments require acceptance checks with the operator's own configuration.
