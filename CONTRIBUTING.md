# Contributing

Open an issue to discuss significant changes. Keep LOCMON dependency-free and buildless unless a proposed dependency has a clear benefit that cannot reasonably be provided by Node or browser APIs.

## Development

Use Linux, Python 3 for the helper syntax check, and the Node version in `.node-version`. With mise:

```sh
mise install
mise exec -- npm ci --ignore-scripts
mise exec -- npm run check
mise exec -- npm test
mise exec -- npm run test:smoke
```

With the pinned Node already on `PATH`, omit `mise exec --`. No dependency install is required to run the app; `npm ci` verifies the lockfile for CI parity.

Use built-in `node:test` tests for metric parsing, counter behavior, and important regressions. Integration tests use a temporary home directory and inference configuration; they do not change your installed service or settings. The smoke suite requires Linux and permission to bind a loopback socket. GPU hardware is optional: unavailable metrics must remain unavailable, rather than becoming fabricated zero readings.

Keep changes focused, update the relevant documentation, and include the checks you ran in the pull request. Never commit real inference credentials, generated systemd units, host snapshots, personal paths, or model prompts/responses.

## Runtime updates

Check the [official Node releases](https://nodejs.org/dist/index.json) and [security announcements](https://nodejs.org/en/blog/vulnerability). Update `.node-version`, `mise.toml`, and the minimum in `package.json`, regenerate `package-lock.json`, and run all checks above. Keep these versions consistent. `runtime.mjs` reads its minimum directly from `.node-version`.

The CI matrix tests the pinned runtime and the newest Node 26 release. Its weekly run exercises new patches without silently changing the installed service. GitHub Dependabot proposes updates to pinned Actions. Update `packageManager` when adopting a new npm release.

After a local runtime update, replace and restart your installed unit using the commands in [installation](docs/installation.md). Changing the project pin alone does not change an existing service's absolute Node path.
