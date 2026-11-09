# Installation

## Requirements

Use Linux with procfs/sysfs mounted and Node.js 26.13.0 or a newer Node 26 patch. The runtime minimum is recorded in `.node-version`, `mise.toml`, and `package.json`. npm 12.2.2 is the recorded development toolchain; running the app requires no npm packages.

`df` collects filesystem capacity. `lspci` improves GPU names. Intel Xe memory queries use Python 3's standard library and a read-only DRM ioctl. Other supported metrics are collected in Node. Missing hardware counters remain unavailable.

## Run locally

```sh
npm start
```

Or select the runtime with mise:

```sh
mise install
mise exec -- npm start
```

Open http://127.0.0.1:1521. Stop with Ctrl+C.

## Install a systemd user service

With the supported Node on `PATH`:

```sh
node scripts/install-service.mjs
systemctl --user daemon-reload
systemctl --user enable --now locmon.service
systemctl --user status locmon.service
journalctl --user -u locmon.service -f
```

If you use mise, prefix the installer with `mise exec --`. The installer writes `~/.config/systemd/user/locmon.service`, recording the checkout's location and the exact Node executable used. It defaults to loopback port 1521 and refuses to overwrite an existing unit. No root is needed.

The unit applies no-new-privileges, task and memory limits. Filesystem namespace isolation is omitted because it interferes with reading DRM fdinfo for other accessible user processes. With user lingering enabled, the service starts at boot; otherwise it starts with your session.

## Remote access

Prefer an SSH tunnel to a loopback instance:

```sh
ssh -L 1521:127.0.0.1:1521 user@your-linux-host
```

Then open http://127.0.0.1:1521 locally. For direct access on a trusted LAN, bind the machine's specific LAN address:

```sh
HOST=192.0.2.10 PORT=1521 npm start
```

`192.0.2.10` is a documentation example; replace it with your machine's address. For a fresh user-service installation, pass the same `HOST` and `PORT` environment variables to the installer. For an existing installation, add `--replace` as below. Prefer a specific address rather than a wildcard: the server checks request Host headers against loopback and its configured address.

There is no built-in authentication or TLS. See [SECURITY.md](../SECURITY.md) before changing the listen address. Everyone who can reach the dashboard can view host telemetry and change its sampling interval.

## Upgrade

```sh
git pull --ff-only
mise install
mise exec -- npm run check
mise exec -- npm test
mise exec -- npm run test:smoke
mise exec -- node scripts/install-service.mjs --replace
systemctl --user daemon-reload
systemctl --user restart locmon.service
```

`--replace` preserves the existing unit in a timestamped `locmon.service.bak.*` file before replacing it. It keeps the previous HOST and PORT unless you override them with environment variables. Review other custom unit edits before replacing them. To change the bind address explicitly:

```sh
HOST=127.0.0.1 PORT=1521 mise exec -- node scripts/install-service.mjs --replace
```

Reinstall the unit whenever you move the checkout or adopt another Node runtime. Updating a version pin alone does not change the service's absolute executable path. Configuration and settings under `~/.config/locmon` are separate from the checkout.

## Uninstall

```sh
systemctl --user disable --now locmon.service
rm ~/.config/systemd/user/locmon.service
systemctl --user daemon-reload
```

Remove the checkout when no longer needed. Browser preferences and `~/.config/locmon` are retained unless you remove them separately.
