import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTiming, parseExposition, extractCounters, counterRate, windowRate, Inference } from '../inference.mjs';

test('llama timings preserve phase speed without retaining prompts or progress text', () => {
  const prompt = parseTiming('slot print_timing: id  2 | task 123 | prompt eval time = 500.00 ms / 100 tokens (5.00 ms per token, 200.00 tokens per second)', 1000);
  const decode = parseTiming('slot print_timing: id  2 | task 123 | eval time = 1000.00 ms / 20 tokens (50.00 ms per token, 20.00 tokens per second)', 1000);
  assert.equal(prompt.phase, 'prefill'); assert.equal(prompt.tps, 200); assert.equal(prompt.tokens, 100);
  assert.equal(decode.phase, 'decode'); assert.equal(decode.seconds, 1); assert.equal(decode.task, prompt.task);
  assert.equal(parseTiming('prompt processing, n_tokens = 100, progress = 0.7', 1000), null);
  assert.equal(parseTiming('a private prompt body', 1000), null);
});
test('metric parser handles labels, escaped model IDs and distinct engines', () => {
  const parsed = parseExposition('# TYPE vllm:prompt_tokens_total counter\nvllm:prompt_tokens_total{model_name="a:b,}\\\"c",engine="0"} 100\nvllm:prompt_tokens_total{engine="1",model_name="a:b,}\\\"c"} 50\nvllm:generation_tokens_total{model_name="a:b,}\\\"c",engine="0"} 20\ninvalid NaN');
  const groups = extractCounters(parsed);
  assert.equal(groups.length, 1); assert.equal(groups[0].prefill, 150); assert.equal(groups[0].decode, 20);
  assert.equal(groups[0].model, 'a:b,}"c'); assert.equal(groups[0].series.length, 3);
});
test('counter rates handle per-engine resets, first samples and missing series', () => {
  const previous = [{ key: 'a', value: 100 }, { key: 'b', value: 100 }];
  const current = [{ key: 'a', value: 10 }, { key: 'b', value: 200 }];
  assert.equal(counterRate(current, previous, 2), 55);
  assert.equal(counterRate(current, null, 2), null);
  assert.equal(counterRate(current, [{ key: 'c', value: 0 }], 2), null);
});
test('completed-request window rate weights phase overlap instead of summing phase speeds', () => {
  const records = [{ phase: 'prefill', tokens: 600, start: 0, end: 30000 }, { phase: 'decode', tokens: 300, start: 30000, end: 90000 }];
  assert.equal(windowRate(records, 'prefill', 90000), 0);
  assert.equal(windowRate(records, 'decode', 90000), 5);
  assert.equal(windowRate(records, 'decode', 60000), 2.5);
});
test('journal pairing reconstructs prefill interval before decode and deduplicates cursors', () => {
  const inference = new Inference();
  const source = { seen: new Set(), pending: new Map(), records: [], latest: {}, totals: { prefill: 0, decode: 0 }, recent: [] };
  const now = Date.now();
  const entry = (cursor, phase, milliseconds, tokens, tps) => ({ __CURSOR: cursor, __REALTIME_TIMESTAMP: String(now * 1000), _SYSTEMD_INVOCATION_ID: 'first', MESSAGE: `slot print_timing: id  0 | task 5 | ${phase} time = ${milliseconds} ms / ${tokens} tokens (1 ms per token, ${tps} tokens per second)` });
  inference.ingestJournal(source, entry('a', 'prompt eval', 1000, 100, 100));
  const decode = entry('b', 'eval', 2000, 40, 20);
  inference.ingestJournal(source, decode); inference.ingestJournal(source, decode);
  assert.deepEqual(source.totals, { prefill: 100, decode: 40 });
  const prefill = source.records.find(r => r.phase === 'prefill');
  assert.equal(prefill.start, now - 3000); assert.equal(prefill.end, now - 2000);
  assert.equal(source.recent.length, 1);
});
test('aggregate marks absent rates as unavailable and sums only reporting sources', async () => {
  const inference = new Inference(); inference.lastPoll = Date.now();
  inference.httpSources = [{ id: 'a', status: 'up', results: [{ id: 'a/model', source: 'a', kind: 'metrics', prefillTps: 10, decodeTps: 5, combinedTps: 15 }] }, { id: 'b', status: 'unavailable', error: 'HTTP 401', results: [] }];
  const result = await inference.sample();
  assert.equal(result.aggregate.combinedTps, 15); assert.equal(result.aggregate.partial, true);
  assert.equal(result.aggregate.reportingSources, 1); assert.equal(result.sources[1].prefillTps, null);
});
