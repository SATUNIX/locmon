# LOCMON

[![CI](https://github.com/SATUNIX/locmon/actions/workflows/ci.yml/badge.svg)](https://github.com/SATUNIX/locmon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight Linux hardware and local inference monitor with a live web dashboard. Track CPU, RAM, GPU, VRAM, thermals, storage, network traffic, and prefill/decode throughput in one place.

Built with Node.js and native browser APIs. No npm dependencies, frontend build, database, CDN, or outbound telemetry. Fonts and styles are bundled locally.

## Quick start

Requires **Linux** and **Node.js 26.13.0 or newer in the 26.x LTS line**. `df` supplies filesystem capacity; `lspci` supplies graphics names. Python 3 is optional unless you want Intel Xe VRAM readings. Journal inference monitoring also requires `journalctl` and access to the relevant user journal.

```sh
git clone https://github.com/SATUNIX/locmon.git
cd locmon
npm start
```

Open **http://127.0.0.1:1521**. No `npm install` or build step is needed.

With [mise](https://mise.jdx.dev/), use `mise install` followed by `mise exec -- npm start` to select the pinned runtime. `.node-version` also supports other version managers. Startup rejects older Node versions; it does not automatically upgrade an installed service.

## What it shows

- CPU usage per core, load averages, RAM, cache, and swap.
- GPU activity and memory where the Linux driver exposes counters. Intel Xe and AMD memory counters are supported; NVIDIA-specific collection is not implemented.
- Temperatures, fans, filesystem capacity, disk I/O, and network rates.
- llama.cpp journal timing records or llama.cpp/vLLM token counters, configured explicitly.
- Thirty minutes of in-memory history, adjustable sampling, weighted card averages, light/dark themes, and rearrangeable panels.
- A versioned JSON telemetry API and server-sent event streams.

Unavailable hardware readings appear as unavailable. The monitor runs without root and only reads process counters accessible to its user.

## Configure

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `1521` | HTTP port |
| `LOCMON_INFERENCE_CONFIG` | `~/.config/locmon/inference.json` | Inference source configuration |

Sampling settings persist in `~/.config/locmon/settings.json`. Layout, theme, and chart preferences stay in the browser. History is cleared when the server restarts.

Inference monitoring is off until you configure sources. See [inference setup](docs/inference.md) for journal and metrics examples. LOCMON does not load models or generate requests.

For a persistent user service, LAN access, and upgrades, see [installation](docs/installation.md). LOCMON has no built-in authentication or TLS; read [deployment security](SECURITY.md) before enabling remote access.

## Documentation

- [Installation and systemd service](docs/installation.md)
- [Inference sources and rate interpretation](docs/inference.md)
- [Metrics and dashboard controls](docs/metrics.md)
- [Telemetry API](docs/api.md)
- [Contributing, tests, and runtime updates](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

```sh
npm run check
npm test
npm run test:smoke
```

Use the pinned Node runtime, or prefix commands with `mise exec --`. The smoke tests require Linux and loopback networking, but do not require a GPU or inference server. GitHub CI runs these checks on the pinned runtime and latest Node 26, audits npm dependencies, and scans Git history for secrets.

## License and credits

[MIT](LICENSE). The dashboard uses [Proof](https://github.com/SATUNIX/proof) styles, with bundled Archivo and Martian Mono fonts. See [third-party notices](THIRD_PARTY_NOTICES.md) for their sources and licenses.
