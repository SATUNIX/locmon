import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCpu, cpuDelta, parseMemory, parseFdinfo, engineDelta, percent } from '../metrics.mjs';

test('CPU counters exclude guest time and include iowait in idle', () => {
  const [old] = parseCpu('cpu  100 0 50 800 50 0 0 0 80 0\ncpu0 100 0 50 800 50 0 0 0 80 0');
  const [now] = parseCpu('cpu  150 0 75 820 55 0 0 0 90 0');
  assert.equal(old.total, 1000);
  assert.equal(cpuDelta(now, old), 75);
  assert.equal(cpuDelta(now), null);
  assert.equal(cpuDelta(now, now), null);
});
test('memory usage uses MemAvailable, preserving reclaimable cache as available', () => {
  const m = parseMemory('MemTotal: 10000 kB\nMemFree: 100 kB\nMemAvailable: 4000 kB\nCached: 3000 kB\nSReclaimable: 500 kB\nSwapTotal: 2000 kB\nSwapFree: 1500 kB');
  assert.equal(m.used, 6000 * 1024);
  assert.equal(m.percent, 60);
  assert.equal(m.swapUsed, 500 * 1024);
  assert.equal(m.cached, 3500 * 1024);
});
test('Xe cycles normalize by elapsed GPU cycles and engine capacity', () => {
  const a = parseFdinfo('drm-driver: xe\ndrm-client-id: 3\ndrm-pdev: 0000:03:00.0\ndrm-cycles-vcs: 100\ndrm-total-cycles-vcs: 1000\ndrm-engine-capacity-vcs: 2');
  const b = parseFdinfo('drm-driver: xe\ndrm-client-id: 3\ndrm-pdev: 0000:03:00.0\ndrm-cycles-vcs: 600\ndrm-total-cycles-vcs: 2000\ndrm-engine-capacity-vcs: 2');
  assert.equal(a.id, b.id);
  assert.equal(a.pci, '0000:03:00.0');
  assert.equal(engineDelta(b.engines.vcs, a.engines.vcs, 1e9), 25);
  assert.equal(engineDelta(a.engines.vcs, b.engines.vcs, 1e9), null);
  assert.equal(parseFdinfo('pos: 0'), null);
});
test('DRM nanosecond engine counters and unknown metrics', () => {
  const a = parseFdinfo('drm-client-id: 7\ndrm-pdev: 0000:03:00.0\ndrm-engine-render: 100 ns');
  const b = parseFdinfo('drm-client-id: 7\ndrm-pdev: 0000:03:00.0\ndrm-engine-render: 500000100 ns');
  assert.equal(engineDelta(b.engines.render, a.engines.render, 1e9), 50);
  assert.equal(percent(null, 100), null);
  assert.equal(percent(1, 0), null);
  assert.equal(percent(150, 100), 100);
});
