# Security and data handling

## Reporting

Use GitHub's **Report a vulnerability** / private vulnerability reporting on this repository. Do not put credentials, private terminal captures, or exploitable details in a public issue. The latest tagged release is the supported version; this is an early project without a guaranteed response time.

## Trust boundary

A paired phone is a trusted remote controller for the laptop account running the bridge. It can read agent terminal output and send agent commands. New agents can work anywhere under that account's Home directory. Configured projects can additionally authorize directories outside Home. The folder picker is not a sandbox for the coding agent: the agent process retains the operating-system permissions of the laptop user.

Keep the bridge bound to loopback. Expose it through HTTPS, never by forwarding its plain HTTP port directly to the Internet. Pairing codes expire and are single use. Revoke a lost phone using the bridge CLI. Protect the bridge state directory and local configuration with user-only permissions.

The optional portal uses a shared device registry: every allowed account can access every configured laptop and receive shared notifications. Deploy it only for one owner or a group intentionally sharing those privileges. Do not enable public signup. A shared public service needs a separate ownership and authorization design.

## Data and external services

The phone can store credentials, drafts and conversation history locally. Android application storage/encryption and backup exclusions protect these within the supported platform's limits. The bridge stores pairing/device credentials and operation receipts locally. Attachments and review/artifact access can expose files within authorized roots. Use the app's history and connection controls and the CLI's revocation commands to manage retained access.

Your configured HTTPS/tunnel provider carries bridge traffic. Optional email login uses Cloudflare Access; optional cloud notifications use Firebase Cloud Messaging. Voice transcription contacts the configured transcription service when used, and AI agents use their own configured providers. Read those services' policies before enabling them. Cloud features are optional in self-hosted builds.

## Release hygiene

Never commit configuration, pairing codes, access tokens, provider keys, service-account private keys, keystores, or captured user data. Firebase client identifiers are not a substitute for authorization. If a real credential is exposed, revoke or rotate it first, then address repository history and artifacts.

Public release APKs are signed independently of development builds. Verify the release checksums and build provenance where supplied. A change in signing identity is a migration, not an ordinary update.
