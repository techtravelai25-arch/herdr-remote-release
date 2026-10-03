# Set up the laptop companion

Herdr Remote requires a running Herdr 0.9.0 session with protocol 22, Node.js 22 or newer, and an HTTPS address that reaches the bridge on your laptop. The phone and bridge support direct QR pairing without an account or portal. The bridge listens only on loopback; put it behind a named HTTPS tunnel or reverse proxy that you control.

## Direct HTTPS pairing

From the source checkout, install bridge dependencies and generate your user configuration:

```sh
npm ci --prefix bridge
python3 ops/setup.py --output /tmp/herdr-setup-preview
python3 ops/setup.py --install
systemctl --user daemon-reload
systemctl --user enable --now herdr-remote-bridge.service
```

Review the preview before `--install`. The setup script does not overwrite an existing config or start services. Edit `~/.config/herdr-remote/config.json` to set your Herdr socket and project paths, then restart the bridge if you changed it. Keep its state directory private. Start or attach to your Herdr session yourself.

Point your HTTPS tunnel or proxy at `http://127.0.0.1:8787`. Do not publish the plain HTTP port. When the HTTPS endpoint is ready, run:

```sh
~/.local/bin/herdr-remote pair --url https://laptop.example.com
```

Scan the QR from the Android app. The one-use pairing code expires in five minutes. To revoke a phone later, use `herdr-remote devices` and `herdr-remote revoke DEVICE_ID`. Use `herdr-remote access status` to inspect local access modes. Terminal input requires an explicit laptop grant and `allowTerminalInput: true` in the config.

## Optional encrypted relay

If you operate the portal described in [portal setup](../portal/README.md), you can use a signed companion archive and its managed installer. Its first setup needs `--portal https://your-portal.example`; later upgrades reuse the registered portal in the private laptop state. Relay registration and pairing never default to somebody else's hosted service. Keep the portal's signing key and any relay credentials outside this repository.

Managed updates require an explicit portal origin, for example:

```sh
HERDR_REMOTE_UPDATE_ORIGIN=https://your-portal.example herdr-remote update
```

The updater verifies signed release metadata and the companion archive against the public key installed with the companion. An operator must package and sign those assets before the portal's `/install.sh` or update route can serve them. Direct HTTPS pairing does not need those assets.
