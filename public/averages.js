/** Time-weighted mean of interval-end readings; missing intervals are excluded. */
export function movingAverage(points, key, seconds, end = points.at(-1)?.time) {
  if (!points.length || end == null) return { value: null, coveredSeconds: 0 };
  if (!seconds) return { value: points.at(-1)?.[key] ?? null, coveredSeconds: 0 };
  const start = end - seconds * 1000;
  let weighted = 0, duration = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i], previous = points[i - 1];
    if (p.time > end || p.time < start || p[key] == null || !Number.isFinite(p[key])) continue;
    // Avoid bridging a collector outage with a synthetic constant value.
    if (p.time - previous.time > Math.max(60000, (p.interval || 2000) * 2.5)) continue;
    const overlap = Math.max(0, p.time - Math.max(previous.time, start));
    weighted += p[key] * overlap; duration += overlap;
  }
  return { value: duration > 0 ? weighted / duration : points.at(-1)?.[key] ?? null, coveredSeconds: duration / 1000 };
}
