# Telemetry API

All endpoints are on the same host and port as the dashboard. Examples assume `http://127.0.0.1:1521`.


The integration-facing contract is separate from the dashboard snapshot:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/telemetry` | Versioned metric families in JSON |
| `GET /api/v1/stream` | The same envelope streamed as SSE `telemetry` events |
| `GET /telemetry.schema.json` | JSON Schema 2020-12 contract |
| `GET /api/snapshot` | Dashboard metrics and history |
| `GET /api/events` | Dashboard SSE snapshots/samples/settings |
| `GET /health` | Collector freshness, adjusted for the configured interval |
| `GET /api/settings` | Current sampling interval |
| `PUT /api/settings` | Same-origin JSON `{ "intervalMs": 2000 }` |

Metric envelopes have `schema: "locmon.telemetry/v1"`, Unix `timestamp_ms`, configured `interval_seconds`, host `resource` attributes, and `metrics`. Each family has `name`, `type` (`gauge`/`counter`), `unit`, `help`, and `samples: [{ "labels": { "instance": "linux-host", ... }, "value": 42 }]`.

Names use a `locmon_` prefix, base-unit suffixes and `_total` for counters. Utilization is a 0–1 ratio, memory/storage are bytes, durations are seconds, and temperature is Celsius. Unsupported measurements are omitted rather than emitted as zero or NaN. Labels use bounded hardware/source/model/phase dimensions; no task IDs, request IDs, PIDs, prompts, or responses are exported. Journal and counter-based inference rates carry distinct `measurement` labels. Counter reset scope is documented above; process start time is stable for a LOCMON process lifetime. The configured interval and actual observed interval are also exposed as separate gauges.

A later exporter can map families directly to Prometheus text exposition or another monitoring transport. No Prometheus server, remote-write client, cluster integration, or outbound metrics push is configured. The server accepts its configured IP and loopback Host names; the sole write operation changes the bounded sampling interval and requires same-origin JSON.

## Example

```sh
curl http://127.0.0.1:1521/health
curl http://127.0.0.1:1521/api/v1/telemetry
curl --no-buffer http://127.0.0.1:1521/api/v1/stream
```

`/health` returns HTTP 200 with a JSON `status` of `ok` or `stale`; consumers must inspect the JSON status. Unknown Host headers receive 403. General methods are GET and HEAD; settings also accept PUT. The stream limit is 32 clients across both SSE endpoints.
