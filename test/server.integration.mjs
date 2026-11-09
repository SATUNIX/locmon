import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('dashboard, telemetry, SSE, and settings work with an isolated configuration', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'locmon-smoke-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = path.join(home, 'inference.json');
  await writeFile(config, JSON.stringify({ journals: [], endpoints: [] }));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(port), LOCMON_INFERENCE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 10000);
    const failed = code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); };
    child.once('exit', failed);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('LOCMON listening')) {
        clearTimeout(timeout); child.off('exit', failed); resolve();
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(5000) });
  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  for (const asset of ['/', '/app.js', '/averages.js', '/style.css', '/vendor/proof/bundle.css', '/fonts/archivo-latin.woff2', '/telemetry.schema.json']) {
    const response = await get(asset);
    assert.equal(response.status, 200, asset);
    assert.ok(response.headers.get('content-security-policy'));
    assert.ok((await response.arrayBuffer()).byteLength);
  }
  const snapshot = await (await get('/api/snapshot')).json();
  assert.ok(snapshot.cpu && snapshot.memory && Array.isArray(snapshot.gpus));
  assert.deepEqual(snapshot.inference.sources, []);
  const telemetry = await (await get('/api/v1/telemetry')).json();
  assert.equal(telemetry.schema, 'locmon.telemetry/v1');
  assert.ok(telemetry.metrics.length > 0);
  assert.equal(await (await get('/', { method: 'HEAD' })).text(), '');
  assert.equal((await get('/missing')).status, 404);
  assert.equal((await get('/', { method: 'POST' })).status, 405);
  const unknownHostStatus = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(unknownHostStatus, 403);
  const malformedStatus = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: 'http://[' }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(malformedStatus, 400);
  const settings = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMs: 1000 }) };
  assert.equal((await get('/api/settings', settings)).status, 403);
  settings.headers.Origin = base;
  assert.equal((await get('/api/settings', { ...settings, body: '{' })).status, 400);
  const saved = await get('/api/settings', settings);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { intervalMs: 1000 });
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.config/locmon/settings.json'), 'utf8')), { intervalMs: 1000 });
  for (const [endpoint, event] of [['/api/events', 'snapshot'], ['/api/v1/stream', 'telemetry']]) {
    const response = await get(endpoint);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    try {
      let body = '';
      while (!body.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        body += new TextDecoder().decode(value);
      }
      assert.ok(body.includes(`event: ${event}\n`));
      assert.ok(body.includes('data: '));
    } finally { await reader.cancel(); }
  }
  assert.equal((await (await get('/health')).json()).status, 'ok');
});

test('service installation defaults to loopback and preserves configuration on replacement', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'locmon-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  delete env.HOST; delete env.PORT;
  const install = (args = [], overrides = {}) => spawnSync(process.execPath, ['scripts/install-service.mjs', ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8'
  });
  const unitDir = path.join(home, '.config/systemd/user');
  const unitPath = path.join(unitDir, 'locmon.service');
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  const original = await readFile(unitPath, 'utf8');
  assert.ok(original.includes('Environment=HOST=127.0.0.1'));
  assert.ok(original.includes(`ExecStart="${process.execPath}"`));
  assert.notEqual(install().status, 0);
  assert.equal(await readFile(unitPath, 'utf8'), original);
  assert.notEqual(install(['--replace'], { HOST: 'bad\nEnvironment=BAD=value' }).status, 0);
  assert.equal(await readFile(unitPath, 'utf8'), original);
  const replacement = install(['--replace'], { HOST: '192.0.2.10', PORT: '8123' });
  assert.equal(replacement.status, 0, replacement.stderr);
  const backups = (await readdir(unitDir)).filter(name => name.startsWith('locmon.service.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(unitDir, backups[0]), 'utf8'), original);
  assert.equal(install(['--replace']).status, 0);
  const retained = await readFile(unitPath, 'utf8');
  assert.ok(retained.includes('Environment=HOST=192.0.2.10'));
  assert.ok(retained.includes('Environment=PORT=8123'));
});
