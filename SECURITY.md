# Security

Security fixes target the latest commit on `main` and the supported Node 26 runtime. Install current patches from the [Node release index](https://nodejs.org/dist/index.json); an npm audit does not audit Node's native dependencies.

## Reporting

Please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/SATUNIX/locmon/security/advisories/new). Do not publish credentials or exploit details in a public issue before a fix is available.

## Deployment

LOCMON binds to loopback by default and runs as your user. It has no built-in authentication or TLS. For remote access, use an SSH tunnel, or put an authenticated TLS reverse proxy in front of a loopback instance. Only bind a LAN address when everyone with access to that network may view host telemetry and change the shared sampling interval. Do not expose it directly to the internet.

The server restricts Host headers, applies a Content Security Policy, and requires same-origin JSON for settings writes. These checks do not replace authentication. Hardware telemetry includes host names, device names, network interface names, and filesystem paths.

Inference endpoints are explicitly configured by the local administrator. Optional bearer tokens are read from environment variables and are not sent to the dashboard. LOCMON does not send generation requests. Journal collection filters timing lines; raw prompts and responses are not retained. Do not configure an endpoint you do not trust.

There are no production or development npm dependencies. Vendored CSS and font licenses are listed in [third-party notices](THIRD_PARTY_NOTICES.md). CI scans Git history for secrets and uses SHA-pinned Actions with read-only repository permissions.
