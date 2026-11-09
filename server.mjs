import './runtime.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Collector } from './metrics.mjs';
import { Inference } from './inference.mjs';
import { telemetry } from './telemetry.mjs';
import { loadSettings, saveSettings, validateSettings } from './settings.mjs';

const port = Number(process.env.PORT || 1521);
const host = process.env.HOST || '127.0.0.1';
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const base = new URL('./public/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/schema+json' };
const assets = new Map();
for (const filename of ['index.html', 'app.js', 'averages.js', 'style.css', 'favicon.svg', 'fonts.css', 'telemetry.schema.json', 'vendor/proof/tokens.css', 'vendor/proof/bundle.css', 'fonts/archivo-latin.woff2', 'fonts/archivo-latin-ext.woff2', 'fonts/martian-mono-latin.woff2', 'fonts/martian-mono-latin-ext.woff2']) {
  const ext = filename.slice(filename.lastIndexOf('.'));
  assets.set(`/${filename === 'index.html' ? '' : filename}`, { body: await readFile(new URL(filename, base)), type: types[ext] });
}
const collector = new Collector();
const inference = new Inference();
let settings = await loadSettings();
await Promise.all([collector.init(), inference.init()]);
let latest = await collector.sample();
latest.interval = settings.intervalMs;
latest.inference = await inference.sample(Date.now(), settings.intervalMs);
const history = [];
const clients = new Set();
const telemetryClients = new Set();
let timer, settingsWriting = false, stopping = false;
const point = s => ({ time: s.time, interval: s.interval, cpu: s.cpu.usage, memory: s.memory.percent,
  gpu: s.gpus[0]?.usage ?? null, vram: s.gpus[0]?.memory.percent ?? null,
  cpuTemp: s.temperatures.find(t => t.chip === 'coretemp' && /package/i.test(t.label))?.value ?? null,
  gpuTemp: s.temperatures.find(t => t.chip === 'xe' && t.label === 'pkg')?.value ?? null,
  rx: s.network.reduce((a, n) => a + (n.rx || 0), 0), tx: s.network.reduce((a, n) => a + (n.tx || 0), 0),
  prefill: s.inference.aggregate.prefillTps, decode: s.inference.aggregate.decodeTps, combined: s.inference.aggregate.combinedTps });
const snapshot = () => JSON.stringify({ ...latest, history });
async function tick() {
  timer = undefined;
  const started = performance.now();
  try {
    latest = await collector.sample(); latest.interval = settings.intervalMs;
    latest.inference = await inference.sample(Date.now(), settings.intervalMs);
    history.push(point(latest));
    while (history.length > 1801 || history[0]?.time < latest.time - 1800000) history.shift();
    const event = `event: sample\ndata: ${JSON.stringify({ ...latest, point: history.at(-1) })}\n\n`;
    for (const client of clients) { if (!client.write(event)) { client.destroy(); clients.delete(client); } }
    if (telemetryClients.size) {
      const metricEvent = `event: telemetry\ndata: ${JSON.stringify(telemetry(latest))}\n\n`;
      for (const client of telemetryClients) { if (!client.write(metricEvent)) { client.destroy(); telemetryClients.delete(client); } }
    }
  } catch (error) { console.error('Collection failed:', error.message); }
  if (!stopping) timer = setTimeout(tick, Math.max(0, settings.intervalMs - (performance.now() - started)));
}
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  // Limit accepted Host names to loopback and the explicitly configured address.
  if (!allowedHosts.has((req.headers.host || '').replace(/:\d+$/, ''))) { res.writeHead(403).end('Unknown host'); return; }
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400).end('Invalid request URL'); return; }
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(403).end('Same-origin JSON required'); return; }
    if (settingsWriting) { res.writeHead(409).end('Settings update in progress'); return; }
    let body = '', size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 1024) { res.writeHead(413).end(); req.destroy(); } else body += chunk; });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let clean;
      try { clean = validateSettings(JSON.parse(body)); }
      catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); return; }
      settingsWriting = true;
      try {
        settings = await saveSettings(clean); latest.interval = settings.intervalMs;
        if (timer) { clearTimeout(timer); timer = setTimeout(tick, settings.intervalMs); }
        for (const client of clients) client.write(`event: settings\ndata: ${JSON.stringify(settings)}\n\n`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(settings));
      } catch { res.writeHead(500).end('Could not save sampling interval'); }
      finally { settingsWriting = false; }
    }); return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  if (url.pathname === '/api/settings') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(settings)); return; }
  if (['/api/events', '/api/v1/stream'].includes(url.pathname) && req.method === 'GET') {
    if (clients.size + telemetryClients.size >= 32) { res.writeHead(503).end('Too many clients'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const metrics = url.pathname === '/api/v1/stream', set = metrics ? telemetryClients : clients;
    res.write(`retry: 3000\nevent: ${metrics ? 'telemetry' : 'snapshot'}\ndata: ${metrics ? JSON.stringify(telemetry(latest)) : snapshot()}\n\n`); set.add(res);
    req.on('close', () => set.delete(res)); return;
  }
  if (['/api/snapshot', '/api/v1/telemetry', '/health'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : url.pathname === '/health' ? JSON.stringify({ status: Date.now() - latest.time < Math.max(15000, settings.intervalMs * 3) ? 'ok' : 'stale', time: latest.time }) : url.pathname === '/api/v1/telemetry' ? JSON.stringify(telemetry(latest)) : snapshot()); return;
  }
  const asset = assets.get(url.pathname);
  if (!asset) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'Content-Length': asset.body.length });
  res.end(req.method === 'HEAD' ? undefined : asset.body);
});
server.requestTimeout = 10000;
server.on('error', error => { console.error(error.message); process.exit(1); });
server.listen(port, host, () => {
  console.log(`LOCMON listening at http://${host}:${port} · ${fileURLToPath(base)}`);
  timer = setTimeout(tick, 1000);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true; clearTimeout(timer); inference.close(); for (const client of [...clients, ...telemetryClients]) client.end(); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
