# Contributing

Open an issue describing the problem, expected behavior, and relevant versions before a substantial change. Small fixes can go straight to a pull request.

Run bridge tests, portal tests/type checking, and Android unit tests/lint for the areas you change. Add regression tests for behavior changes, especially pane identity, uncertain delivery, authentication, filesystem authorization, and terminal parsing. Keep fixtures synthetic or sanitized; never include real conversations, credentials, local configuration, or signing keys.

Use ordinary debug signing for development. Pull-request workflows have no release secrets. Do not deploy to the maintainer's infrastructure as part of testing.

Contributions are provided under the repository's AGPL-3.0-or-later license. Preserve notices for any third-party material you introduce and describe its source in the pull request. No contributor license agreement is required.

Please keep discussion respectful and focused on the work. Report vulnerabilities privately using the process in SECURITY.md.
