import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movingAverage } from '../public/averages.js';
import { validateSettings } from '../settings.mjs';

test('moving averages weight elapsed time when sampling intervals change', () => {
  const points = [{ time: 0, cpu: 0 }, { time: 1000, cpu: 100 }, { time: 10000, cpu: 0 }];
  const result = movingAverage(points, 'cpu', 10);
  assert.equal(result.value, 10); assert.equal(result.coveredSeconds, 10);
  assert.equal(movingAverage(points, 'cpu', 5).value, 0);
  assert.equal(movingAverage(points, 'cpu', 0).value, 0);
});
test('moving averages exclude unknown values, outages, and unobserved startup time', () => {
  const points = [{ time: 1000, cpu: 50 }, { time: 2000, cpu: 40 }, { time: 3000, cpu: null }];
  assert.deepEqual(movingAverage(points, 'cpu', 30), { value: 40, coveredSeconds: 1 });
  assert.equal(movingAverage([{ time: 0, cpu: 0 }, { time: 120000, cpu: 100 }], 'cpu', 300).coveredSeconds, 0);
  assert.equal(movingAverage([], 'cpu', 30).value, null);
});
test('sampling bounds reject coercions, extra fields, and malformed settings', () => {
  assert.deepEqual(validateSettings({ intervalMs: 1000 }), { intervalMs: 1000 });
  assert.deepEqual(validateSettings({ intervalMs: 30000 }), { intervalMs: 30000 });
  for (const value of [null, [], {}, { intervalMs: '1000' }, { intervalMs: 999 }, { intervalMs: 30001 }, { intervalMs: 1500.5 }, { intervalMs: 2000, host: '0.0.0.0' }]) assert.throws(() => validateSettings(value));
});
