import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telemetry } from '../telemetry.mjs';

const snapshot = () => ({
  time: 1000000, interval: 1000, observedIntervalSeconds: 1.02,
  host: { name: 'test-host', arch: 'x64', uptime: 900 },
  cpu: { usage: 25, cores: [{ id: 'cpu0', usage: 50 }], load: [1, 2, 3] },
  memory: { total: 1000, used: 400, available: 600, cached: 200, swapTotal: 100, swapUsed: 10 },
  gpus: [{ id: 'card0', driver: 'xe', pci: '0000:03:00.0', usage: null, usageSource: 'Busiest engine', engines: {}, memory: { used: null, total: null } }],
  disks: [], io: [{ name: 'sda', read: 1024, write: 2048, readTotal: 8192, writeTotal: 16384, busy: 25 }], network: [], temperatures: [],
  inference: { sources: [{ source: 'bonsai', backend: 'llama.cpp', model: 'model', kind: 'journal', status: 'watching', prefillTps: 10, decodeTps: 2, totals: { prefill: 100, decode: 20 }, lastSample: 999000 }], aggregate: { prefillTps: 10, decodeTps: 2, combinedTps: 12, partial: false, mixedRateBases: false, reportingSources: 1 } },
  monitor: { rss: 20000000, cpuSeconds: 5, uptime: 40, startTime: 960, collectionMs: 25 }
});
test('telemetry uses base units, stable labels, counters and omission for unavailable values', () => {
  const t = telemetry(snapshot());
  assert.equal(t.schema, 'locmon.telemetry/v1'); assert.equal(t.timestamp_ms, 1000000);
  const get = name => t.metrics.find(m => m.name === `locmon_${name}`);
  assert.equal(get('cpu_utilization_ratio').samples[0].value, 0.25);
  assert.equal(get('disk_bytes_total').type, 'counter'); assert.equal(get('disk_bytes_total').unit, 'bytes');
  assert.equal(get('inference_aggregate_tokens_per_second').samples.find(s => s.labels.phase === 'combined').value, 12);
  assert.equal(get('inference_tokens_total').samples[0].labels.measurement, 'completed_window');
  assert.equal(get('gpu_utilization_ratio'), undefined); assert.equal(get('gpu_memory_bytes'), undefined);
  assert.equal(get('process_start_time_seconds').samples[0].value, 960);
  assert.equal(get('observed_sampling_interval_seconds').samples[0].value, 1.02);
});
test('all exported series have finite numeric values, safe names, unique labels and explicit types', () => {
  const t = telemetry(snapshot());
  for (const metric of t.metrics) {
    assert.match(metric.name, /^locmon_[a-zA-Z_][a-zA-Z0-9_]*$/);
    assert.ok(['gauge', 'counter'].includes(metric.type));
    const seen = new Set();
    for (const sample of metric.samples) {
      assert.ok(Number.isFinite(sample.value)); assert.equal(sample.labels.instance, 'test-host');
      for (const [key, value] of Object.entries(sample.labels)) { assert.match(key, /^[a-zA-Z_][a-zA-Z0-9_]*$/); assert.equal(typeof value, 'string'); }
      const key = JSON.stringify(Object.entries(sample.labels).sort()); assert.ok(!seen.has(key)); seen.add(key);
    }
  }
});
