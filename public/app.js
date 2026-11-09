import { movingAverage } from './averages.js';
const $ = id => document.getElementById(id);
$('listen-address').textContent = location.host.replace(':', ' : ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, digits = 1) => n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(digits);
const bytes = (n, digits = 1) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const i = n > 0 ? Math.min(4, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** i).toFixed(i ? digits : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`;
};
const duration = n => { const d = Math.floor(n / 86400), h = Math.floor(n / 3600) % 24, m = Math.floor(n / 60) % 60; return `${d ? d + 'd ' : ''}${h}h ${m}m`; };
const width = n => Math.max(0, Math.min(100, n || 0));
const track = n => `<div class="track"><span style="width:${width(n)}%"></span></div>`;
const row = (label, value) => `<div class="data-row"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
let state, viewState, history = [], frozenHistory = [], paused = false, lastReceived = 0;
const view = { averageSeconds: 30, windowMinutes: 10 };
try { const saved = JSON.parse(localStorage.getItem('locmon-view-v1')); if ([0, 10, 30, 60, 120, 300].includes(saved?.averageSeconds)) view.averageSeconds = saved.averageSeconds; if (Number.isInteger(saved?.windowMinutes) && saved.windowMinutes >= 1 && saved.windowMinutes <= 30) view.windowMinutes = saved.windowMinutes; } catch {}
const saveView = () => { try { localStorage.setItem('locmon-view-v1', JSON.stringify(view)); } catch {} };
$('average-window').value = String(view.averageSeconds); $('chart-window').value = view.windowMinutes;
$('window-value').textContent = `${view.windowMinutes} min`;
$('average-window').addEventListener('change', e => { view.averageSeconds = Number(e.target.value); saveView(); render(); });
$('chart-window').addEventListener('input', e => { view.windowMinutes = Number(e.target.value); $('window-value').textContent = `${view.windowMinutes} min`; saveView(); drawCharts(); });
function applyInterval(interval) {
  const select = $('sample-interval');
  if (![...select.options].some(o => Number(o.value) === interval)) { select.querySelector('[data-custom]')?.remove(); const option = new Option(`Every ${interval / 1000} seconds`, String(interval)); option.dataset.custom = 'true'; select.add(option); }
  if (!select.disabled) select.value = String(interval);
  $('live-interval').textContent = `Live / ${interval / 1000} second${interval === 1000 ? '' : 's'}`;
}
$('sample-interval').addEventListener('change', async e => {
  const select = e.target; select.disabled = true; $('settings-message').textContent = 'Saving sampling interval…';
  try {
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intervalMs: Number(select.value) }) });
    if (!response.ok) throw new Error('Could not save interval');
    const settings = await response.json(); if (state) state.interval = settings.intervalMs;
    $('settings-message').textContent = `Sampling every ${settings.intervalMs / 1000}s · saved for all viewers`;
  } catch (error) { $('settings-message').textContent = error.message; }
  finally { select.disabled = false; if (state) applyInterval(state.interval); }
});
const activeHistory = () => paused ? frozenHistory : history;
const averaged = (key, current) => view.averageSeconds ? movingAverage(activeHistory(), key, view.averageSeconds).value ?? current : current;
function averageNote(key) {
  if (!view.averageSeconds) return 'Current reading';
  const { coveredSeconds } = movingAverage(activeHistory(), key, view.averageSeconds);
  if (coveredSeconds < 1) return `Current · collecting ${view.averageSeconds}s average`;
  return `${view.averageSeconds}s time-weighted average${coveredSeconds < view.averageSeconds - 2 ? ` · ${Math.floor(coveredSeconds)}s observed` : ''}`;
}
let theme;
try { theme = localStorage.getItem('locmon-theme'); } catch {}
document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
function themeLabel() { const label = document.documentElement.dataset.theme === 'dark' ? 'Light theme' : 'Dark theme'; $('theme').textContent = label; $('theme').setAttribute('aria-label', `Switch to ${label.toLowerCase()}`); }
themeLabel();
$('theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('locmon-theme', next); } catch {} themeLabel(); drawCharts(); });
$('pause').addEventListener('click', () => { paused = !paused; if (paused) frozenHistory = history.slice(); $('pause').textContent = paused ? 'Resume view' : 'Pause view'; $('pause').setAttribute('aria-pressed', String(paused)); connection(); if (!paused && state) render(); });

function metric(label, number, unit, note, value, extra) {
  return `<article class="pf-stat metric"><p class="micro"><span>${esc(label)}</span><span>${esc(extra)}</span></p><p class="pf-stat__v">${esc(number)}<span class="unit">${esc(unit)}</span></p><div class="segments" aria-hidden="true">${Array.from({ length: 24 }, (_, i) => `<i class="${value !== null && i < Math.ceil(value * .24) ? 'filled' : ''}"></i>`).join('')}</div><p class="metric-note">${esc(note)}</p></article>`;
}
function connection() {
  const offline = !lastReceived || Date.now() - lastReceived > Math.max(9000, (state?.interval || 2000) * 2.5);
  $('connection').textContent = offline ? '○ Reconnecting · readings stale' : paused ? 'Ⅱ View paused · still collecting' : '● Live telemetry';
  $('connection').classList.toggle('offline', offline);
}
function render() {
  const s = paused ? viewState : state;
  if (!s) return;
  viewState = s;
  const gpu = s.gpus[0], mem = s.memory;
  const temps = s.temperatures.filter(t => t.kind === 'temperature');
  const cpuTemp = temps.find(t => /^(coretemp|k10temp|zenpower)$/.test(t.chip) && /package|tctl/i.test(t.label));
  const gpuTemp = temps.find(t => t.chip === gpu?.driver && /^(pkg|edge|junction)$/.test(t.label));
  $('host').textContent = `${s.host.name} / ${s.host.arch}`;
  $('uptime').textContent = `Uptime / ${duration(s.host.uptime)}`;
  $('kernel').textContent = `Linux / ${s.host.kernel}`;
  $('clock').textContent = new Date(s.time).toLocaleTimeString([], { hour12: false });
  const cpuAverage = averaged('cpu', s.cpu.usage), memoryAverage = averaged('memory', mem.percent), gpuAverage = averaged('gpu', gpu?.usage ?? null), vramAverage = averaged('vram', gpu?.memory.percent ?? null);
  $('cpu-stat').innerHTML = metric('CPU usage', fmt(cpuAverage), '%', `${averageNote('cpu')} · Current ${fmt(s.cpu.usage)}%`, cpuAverage, cpuTemp ? `${fmt(cpuTemp.value, 0)}°C now` : '');
  $('memory-stat').innerHTML = metric('Memory', fmt((view.averageSeconds ? memoryAverage * mem.total / 100 : mem.used) / 1024 ** 3), 'GiB', `${averageNote('memory')} · Current ${bytes(mem.used)} / ${bytes(mem.total)}`, memoryAverage, `${fmt(memoryAverage, 0)}%`);
  $('gpu-stat').innerHTML = metric('GPU usage', fmt(gpuAverage), '%', `${averageNote('gpu')} · Current ${fmt(gpu?.usage)}% · Accessible processes`, gpuAverage, gpuTemp ? `${fmt(gpuTemp.value, 0)}°C now` : '');
  $('vram-stat').innerHTML = metric('Video memory', vramAverage === null ? '—' : fmt((view.averageSeconds ? vramAverage * gpu.memory.total / 100 : gpu.memory.used) / 1024 ** 3), 'GiB', gpu?.memory.total ? `${averageNote('vram')} · ${bytes(gpu.memory.total)} total · Sample ${fmt(Math.max(0, s.time - gpu.memory.sampledAt) / 1000, 0)}s ago` : 'Device memory counter unavailable', vramAverage, 'VRAM');
  $('cpu-model').textContent = `${s.cpu.model} · ${s.cpu.cores.length} logical cores · ${fmt(s.cpu.speed / 1000, 2)} GHz mean core clock`;
  $('cores').innerHTML = s.cpu.cores.map((c, i) => `<div class="core" title="Logical CPU ${i}: ${fmt(c.usage)}%"><span class="micro">CPU ${String(i).padStart(2, '0')}</span><strong>${fmt(c.usage, 0)}<small>%</small></strong>${track(c.usage)}</div>`).join('');
  $('load').textContent = `Load / ${s.cpu.load.map(n => fmt(n, 2)).join(' · ')} / 1, 5, 15 min`;
  $('gpu-model').textContent = s.gpus.map(g => g.name).join(' / ') || 'No supported graphics device detected';
  const engineNames = { rcs: 'Render', ccs: 'Compute', bcs: 'Copy', vcs: 'Video decode', vecs: 'Video enhance' };
  $('gpu-detail').innerHTML = s.gpus.map(g => `${s.gpus.length > 1 ? `<h3>${esc(g.name)}</h3>` : ''}${row('Driver / PCI device', `${g.driver} / ${g.pci}`)}${Object.entries(g.engines).map(([name, n]) => `<div class="data-row"><span>${esc(engineNames[name] || name)}</span><strong>${fmt(n)}%${track(n)}</strong></div>`).join('')}${row('Video memory', `${bytes(g.memory.used)} / ${bytes(g.memory.total)}`)}${gpuTemp ? row('GPU temperature', `${fmt(gpuTemp.value)} °C`) : ''}<p class="source-note">${esc(g.usageSource)}. Engine counters exclude processes this user cannot read. ${g.memory.error ? esc(g.memory.error) : 'VRAM is the device-wide allocation reported by the driver.'}</p>`).join('') || '<p class="source-note">Graphics counters are unavailable on this machine.</p>';
  $('disks').innerHTML = s.disks.map(d => `<article class="disk ${d.percent >= 85 ? 'warning' : ''}" title="Used / total capacity. Available space excludes filesystem reservations."><div class="disk-title"><h3>${esc(d.mount)}</h3><strong>${fmt(d.percent)}%</strong></div><p>${esc(d.source)} · ${esc(d.type)}${d.mounts.length > 1 ? ` · ${d.mounts.length} shared mounts` : ''}</p>${track(d.percent)}<p class="capacity">${bytes(d.used)} / ${bytes(d.total)} · ${bytes(d.available)} available${d.percent >= 85 ? ' · Low space' : ''}</p></article>`).join('');
  $('capacity-age').textContent = `Capacity sample / ${fmt(Math.max(0, s.time - (s.disks[0]?.sampledAt || s.time)) / 1000, 0)}s ago`;
  $('disk-io').innerHTML = s.io.map(d => `<p><b>${esc(d.name)}</b> &nbsp; R ${bytes(d.read)}/s &nbsp; W ${bytes(d.write)}/s &nbsp; ${fmt(d.busy, 0)}% busy</p>`).join('');
  const diskTemps = temps.filter(t => t.chip === 'nvme' && t.label === 'Composite');
  const diskTemp = diskTemps.sort((a, b) => b.value - a.value)[0];
  $('thermal-summary').innerHTML = [['CPU package', cpuTemp], ['GPU package', gpuTemp], ['Hottest NVMe', diskTemp]].map(([label, t]) => `<div class="thermal"><p class="micro">${label}</p><strong class="${t?.critical && t.value >= t.critical ? 'danger-text' : t?.max && t.value >= t.max ? 'warning-text' : ''}">${fmt(t?.value, 0)}<span class="unit">°C</span></strong></div>`).join('');
  const sensorRow = t => `<div class="data-row"><span><span class="sensor-chip">${esc(t.chip)}</span> ${esc(t.label)}</span><strong class="${t.critical && t.value >= t.critical ? 'danger-text' : t.max && t.value >= t.max ? 'warning-text' : ''}">${fmt(t.value, t.kind === 'fan' ? 0 : 1)} ${t.kind === 'fan' ? 'RPM' : '°C'}</strong></div>`;
  $('temperatures').innerHTML = temps.map(sensorRow).join(''); $('sensor-count').textContent = temps.length;
  const fans = s.temperatures.filter(t => t.kind === 'fan'); $('fans').innerHTML = fans.map(sensorRow).join(''); $('fan-count').textContent = fans.length;
  $('network').innerHTML = s.network.filter(n => n.state === 'up').map(n => `<div class="network-block"><div class="network-name"><strong>${esc(n.name)}</strong><span class="micro">● Link up</span></div><div class="network-rates"><div><p class="micro">↓ Receive / sec</p><strong>${esc(bytes(n.rx))}</strong></div><div><p class="micro">↑ Send / sec</p><strong>${esc(bytes(n.tx))}</strong></div></div><p class="source-note">Received ${esc(bytes(n.received))} / Sent ${esc(bytes(n.sent))} since boot</p></div>`).join('') || '<p class="source-note">No active physical network interface.</p>';
  $('memory-detail').innerHTML = row('Available memory', bytes(mem.available)) + row('Page cache & reclaimable slab', bytes(mem.cached)) + row('Swap used / total', `${bytes(mem.swapUsed)} / ${bytes(mem.swapTotal)}`);
  $('footprint').textContent = `Collector / ${bytes(s.monitor.rss, 0)} RAM · ${fmt(s.monitor.collectionMs, 0)} ms / sample`;
  const points = activeHistory(), covered = points.length > 1 ? (points.at(-1).time - points[0].time) / 60000 : 0;
  $('history-note').textContent = `${points.length} samples / ${fmt(covered)} min observed`;
  applyInterval(state.interval);
  const notices = [...s.warnings];
  if (s.disks.some(d => d.percent >= 90)) notices.push(`Low disk space: ${s.disks.filter(d => d.percent >= 90).map(d => `${d.mount} is ${fmt(d.percent)}% full`).join(', ')}.`);
  $('notice').hidden = notices.length === 0; $('notice').textContent = notices.join(' ');
  renderInference(s.inference);
  drawCharts(); connection();
}
function renderInference(inference) {
  if (!inference) return;
  const a = inference.aggregate;
  $('inference-coverage').textContent = `${a.reportingSources} / ${a.configuredSources} sources reporting${a.partial ? ' · Partial coverage' : ''}`;
  $('inference-stats').innerHTML = [['Prefill', averaged('prefill', a.prefillTps), 'Prompt tokens processed'], ['Decode', averaged('decode', a.decodeTps), 'Output tokens generated'], ['Combined', averaged('combined', a.combinedTps), 'Prefill + decode / reporting sources']].map(([label, value, note]) => `<div><p class="micro">${label}</p><strong>${fmt(value)}<span class="unit">tok/s</span></strong><p class="source-note">${note} · ${view.averageSeconds ? `${view.averageSeconds}s card average` : 'Current rate'}</p></div>`).join('');
  const kinds = new Set(inference.sources.map(s => s.kind));
  $('inference-basis').textContent = !inference.sources.length ? 'No inference sources configured. Add journal units or llama.cpp / vLLM metrics endpoints in ~/.config/locmon/inference.json.' : kinds.has('journal') ? 'Journal rates estimate completed work over the last 60 seconds. Requests still running are excluded. Last-request phase speed is shown separately.' + (a.mixedRateBases ? ' Aggregate mixes journal estimates and live counter rates.' : '') : 'Live throughput from token counter deltas divided by elapsed wall time. Combined TPS is prefill plus decode.';
  $('inference-sources').innerHTML = inference.sources.map(s => `<div class="inference-source"><div><strong>${esc(s.model)}</strong><span class="micro muted">${esc(s.backend)} / ${esc(s.source)} / ${esc(s.status)}</span></div><div>${row('Prefill / decode', `${fmt(s.prefillTps)} / ${fmt(s.decodeTps)} tok/s`)}${s.kind === 'journal' ? row('Last request phase speed', `${fmt(s.latestPrefillTps)} prefill / ${fmt(s.latestDecodeTps)} decode tok/s`) : ''}${row('Observed tokens · prefill / decode', `${s.totals.prefill == null ? '—' : s.totals.prefill.toLocaleString()} / ${s.totals.decode == null ? '—' : s.totals.decode.toLocaleString()}`)}${row('Latest observation', s.lastSample ? `${new Date(s.lastSample).toLocaleTimeString([], { hour12: false })} · ${duration((Date.now() - s.lastSample) / 1000)} ago` : s.error || 'Waiting for timing data')}<p class="source-note">${esc(s.rateBasis || s.error || 'Waiting for a supported source')}</p></div></div>`).join('');
  const recent = inference.sources.flatMap(s => s.recent.map(r => ({ ...r, model: s.model }))).sort((a, b) => b.time - a.time).slice(0, 8);
  $('inference-recent').innerHTML = recent.length ? `<table><thead><tr><th>Completed / model</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>Tokens in / out</th></tr></thead><tbody>${recent.map(r => `<tr><td>${new Date(r.time).toLocaleTimeString([], { hour12: false })} / ${esc(r.model)}</td><td>${fmt(r.prefill)}</td><td>${fmt(r.decode)}</td><td>${r.promptTokens ?? '—'} / ${r.generatedTokens}</td></tr>`).join('')}</tbody></table>` : '<p class="source-note">No completed-request timings observed in the recent journal window. Counters remain available for metrics sources.</p>';
}
function drawChart(id, keys, dynamic = false) {
  const canvas = $(id), bounds = canvas.getBoundingClientRect();
  if (!bounds.width) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = bounds.width * ratio; canvas.height = bounds.height * ratio;
  const c = canvas.getContext('2d'); c.scale(ratio, ratio);
  const styles = getComputedStyle(document.documentElement), w = bounds.width, h = bounds.height - 8;
  const fg = styles.getPropertyValue('--fg').trim(), accent = styles.getPropertyValue('--accent').trim(), hair = styles.getPropertyValue('--hair').trim();
  c.strokeStyle = hair; c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = 4 + i * h / 4; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const points = activeHistory(), end = points.at(-1)?.time || Date.now(), windowMs = view.windowMinutes * 60000, start = end - windowMs;
  const visible = points.filter(p => p.time >= start);
  const max = dynamic ? Math.max(10, ...visible.flatMap(p => keys.map(k => p[k] || 0))) * 1.1 : 100;
  const plotY = n => 4 + h * (1 - Math.max(0, Math.min(max, n)) / max);
  if (dynamic) $('inference-scale').textContent = `0–${Math.ceil(max)} tokens / sec`;
  keys.forEach((key, index) => {
    c.beginPath(); c.strokeStyle = index ? fg : document.documentElement.dataset.theme === 'dark' ? accent : fg;
    c.lineWidth = index ? 1.5 : 2; c.setLineDash(index ? [4, 4] : []); let drawing = false;
    let previousTime;
    for (const p of points) {
      if (p[key] === null || p[key] === undefined || p.time < start) { drawing = false; continue; }
      if (previousTime && p.time - previousTime > Math.max(60000, p.interval * 2.5)) drawing = false;
      previousTime = p.time;
      const x = (p.time - start) / windowMs * w, y = plotY(p[key]);
      if (drawing) c.lineTo(x, y); else c.moveTo(x, y); drawing = true;
    }
    c.stroke(); c.setLineDash([]);
    const last = points.at(-1);
    if (last?.[key] != null) { c.beginPath(); c.arc(w - 3, plotY(last[key]), 2.5, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill(); }
  });
}
function drawCharts() { document.querySelectorAll('.axis>span:first-child').forEach(n => { n.textContent = `${view.windowMinutes} min ago`; }); drawChart('cpu-chart', ['cpu', 'memory']); drawChart('gpu-chart', ['gpu', 'vram']); drawChart('inference-chart', ['decode', 'prefill'], true); }
const stream = new EventSource('/api/events');
stream.addEventListener('snapshot', e => { state = JSON.parse(e.data); history = state.history || []; lastReceived = Date.now(); if (!paused && !document.hidden) render(); });
stream.addEventListener('sample', e => { state = JSON.parse(e.data); history.push(state.point); while (history.length > 1801 || history[0]?.time < state.time - 1800000) history.shift(); lastReceived = Date.now(); if (!paused && !document.hidden) render(); });
stream.addEventListener('settings', e => { const settings = JSON.parse(e.data); if (state) state.interval = settings.intervalMs; applyInterval(settings.intervalMs); });
stream.onerror = () => { lastReceived = 0; connection(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) render(); });
const resize = new ResizeObserver(() => { if (!paused) drawCharts(); });
for (const id of ['cpu-chart', 'gpu-chart', 'inference-chart']) resize.observe($(id).parentElement);
setInterval(connection, 3000);

// Dashboard layout is browser-local; telemetry and collection are independent of it.
const definitions = [
  ['cpu-stat', 'CPU usage', 'quarter'], ['memory-stat', 'Memory', 'quarter'], ['gpu-stat', 'GPU usage', 'quarter'], ['vram-stat', 'Video memory', 'quarter'],
  ['inference', 'Inference', 'full'], ['cpu-history', 'CPU & memory history', 'half'], ['gpu-history', 'GPU history', 'half'],
  ['processor', 'Processor', 'half'], ['graphics', 'Graphics', 'half'], ['storage', 'Storage', 'full'], ['thermals', 'Thermals', 'half'], ['network', 'Network & memory', 'half']
];
const defaults = () => definitions.map(([id, title, width]) => ({ id, title, width, collapsed: false, visible: true }));
const widgets = new Map([...document.querySelectorAll('[data-widget]')].map(el => [el.dataset.widget, el]));
let layout = defaults(), editing = false, dragging;
try {
  const saved = JSON.parse(localStorage.getItem('locmon-layout-v1'));
  if (saved?.version === 1 && Array.isArray(saved.widgets)) {
    const known = new Map(layout.map(w => [w.id, w])); const loaded = [];
    for (const w of saved.widgets) { if (!known.has(w.id)) continue; const d = known.get(w.id); loaded.push({ ...d, width: ['quarter', 'half', 'full'].includes(w.width) ? w.width : d.width, collapsed: w.collapsed === true, visible: w.visible !== false }); known.delete(w.id); }
    layout = [...loaded, ...known.values()];
  }
} catch {}
function saveLayout() {
  try { localStorage.setItem('locmon-layout-v1', JSON.stringify({ version: 1, widgets: layout.map(({ title, ...w }) => w) })); $('layout-state').textContent = 'Layout saved on this device'; }
  catch { $('layout-state').textContent = 'Storage unavailable · layout lasts this session'; }
}
function moveCard(id, delta) { const index = layout.findIndex(w => w.id === id), next = index + delta; if (next < 0 || next >= layout.length) return; const [item] = layout.splice(index, 1); layout.splice(next, 0, item); applyLayout(); saveLayout(); widgets.get(id).querySelector('[data-move]')?.focus(); }
function applyLayout() {
  const dashboard = $('dashboard');
  for (const item of layout) {
    const el = widgets.get(item.id); dashboard.append(el); el.dataset.width = item.width; el.hidden = !item.visible;
    const content = el.querySelector('.widget-content'); content.hidden = item.collapsed;
    const header = el.querySelector('.widget-header'); header.draggable = editing;
    const collapse = header.querySelector('[data-collapse]'); collapse.textContent = item.collapsed ? '+' : '−'; collapse.setAttribute('aria-expanded', String(!item.collapsed)); collapse.setAttribute('aria-label', `${item.collapsed ? 'Expand' : 'Collapse'} ${item.title}`);
    header.querySelector('select').value = item.width;
  }
  $('visibility-options').innerHTML = layout.map(w => `<label><input type="checkbox" data-visible="${w.id}" ${w.visible ? 'checked' : ''}>${esc(w.title)}</label>`).join('');
  requestAnimationFrame(drawCharts);
}
for (const item of layout) {
  const el = widgets.get(item.id), header = document.createElement('div'); header.className = 'widget-header';
  header.innerHTML = `<span class="micro widget-name"><span class="drag-glyph" aria-hidden="true">⠿ </span>${esc(item.title)}</span><div class="widget-actions"><button class="pf-btn pf-btn--sm edit-control" data-move="up" aria-label="Move ${esc(item.title)} earlier">↑</button><button class="pf-btn pf-btn--sm edit-control" data-move="down" aria-label="Move ${esc(item.title)} later">↓</button><select class="edit-control" aria-label="${esc(item.title)} card width"><option value="quarter">¼ width</option><option value="half">½ width</option><option value="full">Full width</option></select><button class="collapse-button" data-collapse aria-controls="content-${item.id}" aria-expanded="true">−</button></div>`;
  el.querySelector('.widget-content').id ||= `content-${item.id}`;
  header.querySelector('[data-collapse]').setAttribute('aria-controls', el.querySelector('.widget-content').id);
  el.prepend(header);
  header.querySelector('[data-collapse]').addEventListener('click', () => { const w = layout.find(w => w.id === item.id); w.collapsed = !w.collapsed; applyLayout(); saveLayout(); });
  header.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => moveCard(item.id, button.dataset.move === 'up' ? -1 : 1)));
  header.querySelector('select').addEventListener('change', e => { layout.find(w => w.id === item.id).width = e.target.value; applyLayout(); saveLayout(); });
  header.addEventListener('dragstart', e => { if (!editing || e.target.closest('button,select')) { e.preventDefault(); return; } dragging = item.id; e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  header.addEventListener('dragend', () => { dragging = null; document.querySelectorAll('.drop-target,.dragging').forEach(n => n.classList.remove('drop-target', 'dragging')); });
  el.addEventListener('dragover', e => { if (!editing || !dragging || dragging === item.id) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-target'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target'); });
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop-target'); if (!editing || !dragging || dragging === item.id) return; const from = layout.findIndex(w => w.id === dragging); const [moving] = layout.splice(from, 1); const to = layout.findIndex(w => w.id === item.id); layout.splice(to, 0, moving); applyLayout(); saveLayout(); });
}
$('edit-layout').addEventListener('click', () => { editing = !editing; document.body.classList.toggle('editing', editing); $('layout-editor').hidden = !editing; $('edit-layout').textContent = editing ? 'Done editing' : 'Edit dashboard'; $('edit-layout').setAttribute('aria-pressed', String(editing)); applyLayout(); });
$('visibility-options').addEventListener('change', e => { if (!e.target.dataset.visible) return; layout.find(w => w.id === e.target.dataset.visible).visible = e.target.checked; applyLayout(); saveLayout(); });
$('reset-layout').addEventListener('click', () => { layout = defaults(); applyLayout(); saveLayout(); });
applyLayout();
