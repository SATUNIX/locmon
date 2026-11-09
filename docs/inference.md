# Inference monitoring

LOCMON reads explicitly configured sources. It does not scan for servers, load models, restart model services, or send inference requests. With no configuration, hardware monitoring works and the inference panel has no sources.

Put a JSON configuration in `~/.config/locmon/inference.json`, or set `LOCMON_INFERENCE_CONFIG` to another file. Restart LOCMON after changing sources. The sample [inference.example.json](../inference.example.json) uses generic placeholders; adapt it to the service that actually launches your model server.

## llama.cpp user journal

```json
{
  "journals": [
    { "id": "local-llama", "unit": "llama-server.service", "model": "local-model" }
  ],
  "endpoints": []
}
```

The unit must run as a systemd user service with accessible journal records. Only matching llama.cpp `print_timing` messages are read. Prompts and generated text are not retained. Model servers launched by a router must be configured using the unit whose journal receives their timing records; a model alias alone cannot identify it.

Journal throughput is a **60-second wall-time estimate from completed requests**, reconstructed from prefill/decode durations. In-flight work is excluded until final timing records arrive. Last-request phase speeds are shown separately and are not summed as live aggregate throughput. Counters cover this LOCMON session, including up to fifteen minutes of initial journal backfill.

A `watching` source means journal collection has started; it does not prove that the service is running, that a model is loaded, or that timing records have arrived. Missing rates stay unavailable until records arrive.

## llama.cpp or vLLM metrics endpoint

```json
{
  "journals": [],
  "endpoints": [
    { "id": "local-server", "url": "http://127.0.0.1:8001/metrics" }
  ]
}
```

Enable your server's metrics endpoint separately. LOCMON recognizes `llamacpp:prompt_tokens_total`, `llamacpp:tokens_predicted_total`, `vllm:prompt_tokens_total`, and `vllm:generation_tokens_total`. It preserves model/engine identities and handles counter resets per series. Rates need two successful samples; unavailable sources are excluded from aggregates and coverage is labeled partial.

For a protected endpoint, add `"bearerTokenEnv": "INFERENCE_METRICS_TOKEN"` to the endpoint and set that environment variable for the LOCMON process. Do not put a token in the JSON file or URL. Token values are not returned to the browser. For a user service, configure its environment through a local systemd override.

URLs must use HTTP(S), contain no embedded credentials, and not redirect. Polling follows the dashboard sampling interval with a 1.2-second timeout and a 1 MiB response limit. Configuration permits up to eight journals and eight endpoints, with up to 32 model groups per endpoint. Source IDs must be unique.

## Interpret rates

The callouts show prefill, decode, and their sum across reporting sources. Card averages apply an additional display average. Counter-derived rates and completed-request journal estimates measure different things; the dashboard labels their basis. Do not configure journal and metrics sources for the same server, as this would double-count its work.

An empty source list disables inference collection explicitly:

```json
{ "journals": [], "endpoints": [] }
```
