import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function parseTiming(message, timestamp) {
  const m = message.match(/\b(prompt eval|eval) time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens\s*\([^,]+,\s*([\d.]+) tokens per second\)/);
  if (!m) return null;
  const slot = message.match(/\bid\s+(\d+)/)?.[1] || '0';
  const task = message.match(/\btask\s+(\d+)/)?.[1] || String(timestamp);
  return { phase: m[1] === 'prompt eval' ? 'prefill' : 'decode', seconds: Number(m[2]) / 1000,
    tokens: Number(m[3]), tps: Number(m[4]), slot, task, time: timestamp };
}

export function parseExposition(text) {
  const series = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{((?:[^"}]|"(?:\\.|[^"\\])*")*)\})?\s+([-+\d.eE]+)(?:\s+\d+)?\s*$/);
    if (!m || !Number.isFinite(Number(m[3]))) continue;
    const labels = {};
    for (const l of (m[2] || '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      labels[l[1]] = l[2].replace(/\\([\\"n])/g, (_, c) => c === 'n' ? '\n' : c);
    }
    series.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return series;
}

export function extractCounters(series) {
  const definitions = {
    'llamacpp:prompt_tokens_total': ['prefill', 'llama.cpp'],
    'llamacpp:tokens_predicted_total': ['decode', 'llama.cpp'],
    'vllm:prompt_tokens_total': ['prefill', 'vLLM'],
    'vllm:generation_tokens_total': ['decode', 'vLLM']
  };
  const groups = new Map();
  for (const s of series) {
    const definition = definitions[s.name]; if (!definition) continue;
    const [phase, backend] = definition;
    const model = s.labels.model_name || s.labels.model || 'default';
    const key = `${backend}/${model}`;
    if (!groups.has(key)) groups.set(key, { model, backend, prefill: null, decode: null, series: [] });
    const g = groups.get(key); g[phase] = (g[phase] || 0) + s.value;
    // Preserve each engine's identity so counter resets don't hide behind another engine's increase.
    g.series.push({ phase, key: `${s.name}/${JSON.stringify(Object.entries(s.labels).sort())}`, value: s.value });
  }
  return [...groups.values()];
}

export function counterRate(current, previous, elapsed) {
  if (!previous || !(elapsed > 0)) return null;
  const prior = new Map(previous.map(s => [s.key, s.value]));
  let delta = 0, matched = false;
  for (const s of current) {
    const old = prior.get(s.key);
    if (old === undefined) continue;
    matched = true;
    delta += s.value >= old ? s.value - old : s.value; // Prometheus-style reset handling
  }
  return matched ? delta / elapsed : null;
}

export function windowRate(records, phase, now, windowSeconds = 60) {
  const start = now - windowSeconds * 1000;
  let tokens = 0;
  for (const r of records) {
    if (r.phase !== phase) continue;
    if (r.end <= start || r.start > now) continue;
    const overlap = Math.max(0, Math.min(now, r.end) - Math.max(start, r.start));
    tokens += r.end > r.start ? r.tokens * overlap / (r.end - r.start) : r.tokens;
  }
  return tokens / windowSeconds;
}

export class Inference {
  constructor(config = {}) {
    this.config = config;
    this.journals = [];
    this.httpSources = [];
    this.closed = false;
  }
  async init() {
    // Read configured targets only; no LAN scanning or model generation calls.
    const configPath = process.env.LOCMON_INFERENCE_CONFIG || path.join(os.homedir(), '.config/locmon/inference.json');
    let configured;
    try { configured = JSON.parse(await readFile(configPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') console.error('Inference configuration could not be loaded:', e.message); }
    this.config = configured || this.config;
    for (const target of (this.config.journals || []).slice(0, 8)) {
      if (!/^[a-zA-Z0-9_.@-]+\.service$/.test(target.unit) || !/^[a-zA-Z0-9_-]+$/.test(target.id)) continue;
      const source = { id: target.id, unit: target.unit, model: target.model || target.id, backend: 'llama.cpp',
        kind: 'journal', status: 'connecting', records: [], pending: new Map(), seen: new Set(),
        totals: { prefill: 0, decode: 0 }, latest: {}, recent: [], lastSample: null, child: null };
      this.journals.push(source); this.watchJournal(source);
    }
    for (const target of (this.config.endpoints || []).slice(0, 8)) {
      try {
        const url = new URL(target.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        if (!/^[a-zA-Z0-9_-]+$/.test(target.id)) continue;
        this.httpSources.push({ ...target, url: url.href, status: 'connecting', kind: 'metrics', previous: new Map(), results: [] });
      } catch {}
    }
    const ids = [...this.journals, ...this.httpSources].map(s => s.id);
    if (new Set(ids).size !== ids.length) throw new Error('Inference source IDs must be unique');
  }
  watchJournal(source) {
    if (this.closed) return;
    const args = ['--user', '--unit', source.unit, '--output=json', '--output-fields=MESSAGE,__REALTIME_TIMESTAMP,__CURSOR,_SYSTEMD_INVOCATION_ID', '--grep', 'print_timing.*(prompt eval time| eval time)', '--since=-15min', '-n', '400', '--follow', '--no-pager'];
    const child = spawn('/usr/bin/journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    source.child = child; let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { buffer = ''; return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { this.ingestJournal(source, JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', () => {});
    child.on('spawn', () => { source.status = 'watching'; });
    child.on('error', () => { source.status = 'unavailable'; });
    child.on('exit', () => { source.status = 'unavailable'; source.retry = setTimeout(() => this.watchJournal(source), 10000); source.retry.unref(); });
  }
  ingestJournal(source, entry) {
    if (source.seen.has(entry.__CURSOR)) return;
    const r = parseTiming(entry.MESSAGE || '', Number(entry.__REALTIME_TIMESTAMP) / 1000);
    if (!r || !Number.isFinite(r.time)) return;
    source.seen.add(entry.__CURSOR);
    if (source.seen.size > 2000) source.seen.delete(source.seen.values().next().value);
    source.lastSample = r.time;
    const key = `${entry._SYSTEMD_INVOCATION_ID || ''}/${r.slot}/${r.task}`;
    if (r.phase === 'prefill') { source.pending.set(key, r); if (source.pending.size > 200) source.pending.delete(source.pending.keys().next().value); return; }
    const prompt = source.pending.get(key); source.pending.delete(key);
    r.end = r.time; r.start = r.time - r.seconds * 1000;
    for (const record of [r, ...(prompt ? [{ ...prompt, end: r.start, start: r.start - prompt.seconds * 1000 }] : [])]) {
      source.records.push(record); source.totals[record.phase] += record.tokens; source.latest[record.phase] = record;
    }
    source.recent.unshift({ time: r.time, prefill: prompt?.tps ?? null, decode: r.tps,
      promptTokens: prompt?.tokens ?? null, generatedTokens: r.tokens, seconds: r.seconds + (prompt?.seconds || 0) });
    source.recent = source.recent.slice(0, 8);
    source.records = source.records.filter(x => x.end > Date.now() - 15 * 60 * 1000).slice(-1000);
  }
  async pollEndpoint(source, now) {
    const headers = { Accept: 'text/plain' };
    if (source.bearerTokenEnv && process.env[source.bearerTokenEnv]) headers.Authorization = `Bearer ${process.env[source.bearerTokenEnv]}`;
    try {
      const response = await fetch(source.url, { headers, signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let body = '', size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Metrics response too large'); } body += decoder.decode(value, { stream: true }); }
      const groups = extractCounters(parseExposition(body)).slice(0, 32);
      if (!groups.length) throw new Error('No supported token counters');
      source.results = groups.map(g => {
        const key = `${g.backend}/${g.model}`, previous = source.previous.get(key);
        const phaseRate = phase => counterRate(g.series.filter(s => s.phase === phase), previous?.series.filter(s => s.phase === phase), (now - (previous?.time || now)) / 1000);
        const prefill = phaseRate('prefill'), decode = phaseRate('decode');
        source.previous.set(key, { ...g, time: now });
        return { id: `${source.id}/${g.model}`, source: source.id, model: g.model, backend: g.backend,
          kind: 'metrics', status: 'up', lastSample: now, prefillTps: prefill, decodeTps: decode,
          combinedTps: prefill === null || decode === null ? null : prefill + decode,
          totals: { prefill: g.prefill, decode: g.decode }, counterScope: 'backend lifetime', recent: [],
          rateBasis: 'Token counter delta / elapsed wall time', windowSeconds: previous ? (now - previous.time) / 1000 : null };
      });
      source.status = 'up'; source.error = null;
    } catch (error) { source.status = 'unavailable'; source.error = error.message; source.results = []; }
  }
  async sample(now = Date.now(), intervalMs = 2000) {
    // Poll independently of hardware sampling cadence; a slow target cannot block CPU/GPU collection.
    if (!this.polling && (!this.lastPoll || now - this.lastPoll >= intervalMs)) {
      this.lastPoll = now;
      this.polling = Promise.all(this.httpSources.map(s => this.pollEndpoint(s, now))).finally(() => { this.polling = null; });
    }
    const journals = this.journals.map(s => {
      const fresh = s.records.filter(r => r.end > now - 15 * 60 * 1000);
      s.records = fresh;
      const prefill = s.lastSample === null || s.status === 'unavailable' ? null : windowRate(fresh, 'prefill', now);
      const decode = s.lastSample === null || s.status === 'unavailable' ? null : windowRate(fresh, 'decode', now);
      return { id: s.id, source: s.id, model: s.model, backend: s.backend, kind: 'journal', status: s.status,
        lastSample: s.lastSample, prefillTps: prefill, decodeTps: decode,
        combinedTps: prefill === null || decode === null ? null : prefill + decode,
        totals: { ...s.totals }, counterScope: 'LOCMON session including initial 15-minute journal backfill',
        latestPrefillTps: s.latest.prefill?.tps ?? null, latestDecodeTps: s.latest.decode?.tps ?? null,
        rateBasis: '60s wall-time estimate from completed requests; in-flight work is excluded', windowSeconds: 60,
        recent: [...s.recent], unit: s.unit };
    });
    const endpoints = this.httpSources.flatMap(s => s.results.length ? s.results : [{ id: s.id, source: s.id, model: 'unknown',
      backend: 'auto', kind: 'metrics', status: s.status, error: s.error, prefillTps: null, decodeTps: null, combinedTps: null, totals: {}, recent: [] }]);
    const sources = [...journals, ...endpoints];
    const usable = sources.filter(s => s.prefillTps !== null && s.decodeTps !== null);
    const sum = phase => usable.length ? usable.reduce((a, s) => a + s[phase], 0) : null;
    return { sources, aggregate: { prefillTps: sum('prefillTps'), decodeTps: sum('decodeTps'), combinedTps: sum('combinedTps'),
      reportingSources: usable.length, configuredSources: sources.length, partial: usable.length < sources.length,
      mixedRateBases: new Set(usable.map(s => s.kind)).size > 1,
      note: 'Sums reporting sources only. Combined TPS = prefill + decode. Journal sources reflect completed requests over 60s; metrics sources use scrape-interval counter deltas.' } };
  }
  close() { this.closed = true; for (const s of this.journals) { clearTimeout(s.retry); s.child?.kill(); } }
}
