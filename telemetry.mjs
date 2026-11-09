/** Versioned, transport-independent metric families. Prometheus base units and labels. */
export function telemetry(snapshot) {
  const s = snapshot;
  const families = new Map();
  const add = (name, type, unit, help, value, labels = {}) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    if (!families.has(name)) families.set(name, { name, type, unit, help, samples: [] });
    families.get(name).samples.push({ labels: { instance: s.host.name, ...labels }, value });
  };
  const gauge = (name, unit, help, value, labels) => add(`locmon_${name}`, 'gauge', unit, help, value, labels);
  const counter = (name, unit, help, value, labels) => add(`locmon_${name}`, 'counter', unit, help, value, labels);
  const ratio = n => n == null ? null : n / 100;
  gauge('cpu_utilization_ratio', 'ratio', 'CPU busy fraction, with iowait treated as idle.', ratio(s.cpu.usage), { cpu: 'all' });
  for (const c of s.cpu.cores) gauge('cpu_utilization_ratio', 'ratio', 'CPU busy fraction, with iowait treated as idle.', ratio(c.usage), { cpu: c.id });
  for (const [i, load] of s.cpu.load.entries()) gauge('load_average', '1', 'System load average.', load, { window: ['1m', '5m', '15m'][i] });
  for (const key of ['total', 'used', 'available', 'cached']) gauge('memory_bytes', 'bytes', 'System memory by category; categories overlap and must not be summed.', s.memory[key], { category: key });
  for (const key of ['total', 'used']) gauge('swap_bytes', 'bytes', 'Swap memory.', s.memory[key === 'total' ? 'swapTotal' : 'swapUsed'], { category: key });
  for (const g of s.gpus) {
    const labels = { device: g.id, pci: g.pci || 'unknown', driver: g.driver };
    gauge('gpu_utilization_ratio', 'ratio', 'GPU utilization; client-based readings cover accessible processes only.', ratio(g.usage), { ...labels, scope: g.usageSource.startsWith('Device') ? 'device' : 'accessible_clients' });
    for (const [engine, value] of Object.entries(g.engines)) gauge('gpu_engine_utilization_ratio', 'ratio', 'GPU engine utilization across accessible clients.', ratio(value), { ...labels, engine });
    gauge('gpu_memory_bytes', 'bytes', 'Device-wide VRAM allocation estimate.', g.memory.used, { ...labels, category: 'used' });
    gauge('gpu_memory_bytes', 'bytes', 'Device-wide VRAM allocation estimate.', g.memory.total, { ...labels, category: 'total' });
  }
  for (const d of s.disks) {
    const labels = { device: d.source, mountpoint: d.mount, fstype: d.type };
    for (const key of ['total', 'used', 'available']) gauge('filesystem_bytes', 'bytes', 'Filesystem capacity; shared Btrfs subvolumes are deduplicated.', d[key], { ...labels, category: key });
  }
  for (const d of s.io) {
    for (const direction of ['read', 'write']) {
      gauge('disk_bytes_per_second', 'bytes_per_second', 'Physical disk throughput.', d[direction], { device: d.name, direction });
      counter('disk_bytes_total', 'bytes', 'Physical disk bytes transferred since boot.', d[`${direction}Total`], { device: d.name, direction });
    }
    gauge('disk_utilization_ratio', 'ratio', 'Physical disk busy fraction.', ratio(d.busy), { device: d.name });
  }
  for (const n of s.network) {
    for (const [direction, rate, total] of [['receive', n.rx, n.received], ['transmit', n.tx, n.sent]]) {
      gauge('network_bytes_per_second', 'bytes_per_second', 'Physical or VPN network interface throughput.', rate, { device: n.name, direction });
      counter('network_bytes_total', 'bytes', 'Network bytes transferred since boot.', total, { device: n.name, direction });
    }
  }
  for (const t of s.temperatures) {
    const labels = { chip: t.chip || 'unknown', sensor: t.id, label: t.label };
    if (t.kind === 'temperature') gauge('temperature_celsius', 'celsius', 'Hardware temperature sensor.', t.value, labels);
    else gauge('fan_speed_rpm', 'rpm', 'Hardware fan speed.', t.value, labels);
  }
  for (const source of s.inference?.sources || []) {
    const labels = { source: source.source, backend: source.backend, model: source.model,
      measurement: source.kind === 'journal' ? 'completed_window' : 'counter_delta' };
    gauge('inference_source_up', '1', 'Whether the inference source is readable.', ['up', 'watching'].includes(source.status) ? 1 : 0, { source: source.source, backend: source.backend, model: source.model });
    for (const phase of ['prefill', 'decode']) {
      gauge('inference_tokens_per_second', 'tokens_per_second', 'Token throughput. Journal sources estimate completed work over 60 seconds; counter sources use elapsed scrape time.', source[`${phase}Tps`], { ...labels, phase });
      if (source.kind === 'journal' || source.status === 'up') counter('inference_tokens_total', 'tokens', 'Observed token count. Journal counters reset with LOCMON; metrics counters reset with their backend.', source.totals[phase], { ...labels, phase });
      gauge('inference_last_request_tokens_per_second', 'tokens_per_second', 'Last completed request phase speed; not an aggregate throughput rate.', source[`latest${phase === 'prefill' ? 'Prefill' : 'Decode'}Tps`], { ...labels, phase });
    }
    gauge('inference_last_observation_timestamp_seconds', 'seconds', 'Unix timestamp of last inference timing observation.', source.lastSample == null ? null : source.lastSample / 1000, { source: source.source });
  }
  const aggregate = s.inference?.aggregate;
  if (aggregate) {
    for (const phase of ['prefill', 'decode', 'combined']) gauge('inference_aggregate_tokens_per_second', 'tokens_per_second', 'Sum of reporting sources; combined equals prefill plus decode, with unavailable sources excluded.', aggregate[`${phase}Tps`], { phase, coverage: aggregate.partial ? 'partial' : 'complete', measurement: aggregate.mixedRateBases ? 'mixed' : s.inference.sources.find(x => x.prefillTps !== null)?.kind === 'journal' ? 'completed_window' : 'counter_delta' });
    gauge('inference_reporting_sources', '1', 'Number of inference sources contributing rates.', aggregate.reportingSources);
  }
  gauge('host_uptime_seconds', 'seconds', 'System uptime.', s.host.uptime);
  gauge('process_resident_memory_bytes', 'bytes', 'LOCMON resident memory.', s.monitor.rss);
  counter('process_cpu_seconds_total', 'seconds', 'LOCMON accumulated user and system CPU time.', s.monitor.cpuSeconds);
  gauge('process_start_time_seconds', 'seconds', 'LOCMON process start Unix timestamp.', s.monitor.startTime);
  gauge('collection_duration_seconds', 'seconds', 'Duration of hardware collection.', s.monitor.collectionMs / 1000);
  gauge('sampling_interval_seconds', 'seconds', 'Configured hardware sampling interval.', s.interval / 1000);
  gauge('observed_sampling_interval_seconds', 'seconds', 'Actual wall time between collection starts.', s.observedIntervalSeconds);
  return { schema: 'locmon.telemetry/v1', timestamp_ms: s.time, interval_seconds: s.interval / 1000,
    resource: { host: s.host.name, os: 'linux', arch: s.host.arch, collector: 'locmon', version: '1.0.0' },
    metrics: [...families.values()] };
}
