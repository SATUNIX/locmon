import { readFile, readdir, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const processStartTime = Date.now() / 1000 - process.uptime();
const read = (p) => readFile(p, 'utf8').then(s => s.trim()).catch(() => null);
const list = (p) => readdir(p).catch(() => []);
const number = async (p) => { const s = await read(p); return s === null || s === '' ? null : Number(s); };
const clamp = n => Math.max(0, Math.min(100, n));
export const percent = (used, total) => total > 0 && used !== null ? clamp(100 * used / total) : null;

export function parseCpu(text) {
  return text.split('\n').filter(s => /^cpu\d*\s/.test(s)).map(line => {
    const [id, ...values] = line.trim().split(/\s+/);
    const n = values.map(Number);
    // guest and guest_nice are already included in user and nice.
    return { id, total: n.slice(0, 8).reduce((a, b) => a + b, 0), idle: n[3] + n[4] };
  });
}
export function cpuDelta(current, previous) {
  if (!previous || current.total <= previous.total) return null;
  return clamp(100 * (1 - (current.idle - previous.idle) / (current.total - previous.total)));
}
export function parseMemory(text) {
  const m = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)/gm)].map(x => [x[1], Number(x[2]) * 1024]));
  const used = m.MemTotal - m.MemAvailable;
  return { total: m.MemTotal, available: m.MemAvailable, used, percent: percent(used, m.MemTotal),
    cached: (m.Cached || 0) + (m.SReclaimable || 0), swapTotal: m.SwapTotal,
    swapUsed: m.SwapTotal - m.SwapFree, swapPercent: percent(m.SwapTotal - m.SwapFree, m.SwapTotal) };
}
export function parseFdinfo(text) {
  const fields = Object.fromEntries(text.split('\n').filter(s => s.includes(':')).map(s => {
    const colon = s.indexOf(':'); return [s.slice(0, colon), s.slice(colon + 1).trim()];
  }));
  if (!fields['drm-client-id'] || !fields['drm-pdev']) return null;
  const engines = {};
  for (const [key, value] of Object.entries(fields)) {
    const match = key.match(/^drm-(cycles|engine)-(.+)$/);
    if (!match || match[2].startsWith('capacity-')) continue;
    const engine = match[2];
    engines[engine] = { busy: Number(value.split(' ')[0]),
      total: fields[`drm-total-cycles-${engine}`] ? Number(fields[`drm-total-cycles-${engine}`]) : null,
      capacity: Number(fields[`drm-engine-capacity-${engine}`] || 1) };
  }
  return { id: `${fields['drm-pdev']}/${fields['drm-client-id']}`, pci: fields['drm-pdev'], engines };
}
export function engineDelta(current, previous, elapsedNs) {
  if (!previous || current.busy < previous.busy) return null;
  const elapsed = current.total === null ? elapsedNs : current.total - previous.total;
  return elapsed > 0 ? clamp(100 * (current.busy - previous.busy) / elapsed / current.capacity) : null;
}

export class Collector {
  constructor() {
    this.previousCpu = []; this.previousClients = new Map(); this.fdPaths = [];
    this.gpus = []; this.sensors = []; this.disks = []; this.networkPrevious = new Map();
    this.ioPrevious = new Map(); this.lastTime = performance.now(); this.sequence = 0;
    this.warnings = new Set();
    this.lastClientScan = 0; this.lastCapacityScan = 0; this.lastSensorScan = 0;
  }
  async init() {
    this.model = os.cpus()[0]?.model || os.arch();
    await Promise.all([this.discoverSensors(), this.discoverGpus(), this.diskCapacity()]);
    await this.discoverClients();
  }
  async discoverSensors() {
    const groups = await Promise.all((await list('/sys/class/hwmon')).map(async dir => {
      const base = `/sys/class/hwmon/${dir}`;
      const chip = await read(`${base}/name`);
      const devicePath = await readlink(`${base}/device`).catch(() => '');
      return Promise.all((await list(base)).filter(f => /^(temp\d+|fan\d+)_input$/.test(f)).map(async f => {
        const id = f.replace('_input', '');
        return { id: `${dir}/${id}`, path: `${base}/${f}`, chip,
          label: await read(`${base}/${id}_label`) || id,
          critical: await number(`${base}/${id}_crit`), max: await number(`${base}/${id}_max`),
          kind: f.startsWith('temp') ? 'temperature' : 'fan', devicePath };
      }));
    }));
    this.sensors = groups.flat();
    this.lastSensorScan = performance.now();
  }
  async temperatures() {
    return (await Promise.all(this.sensors.map(async s => {
      const value = await number(s.path);
      if (value === null || !Number.isFinite(value)) return null;
      const scale = s.kind === 'temperature' ? 1000 : 1;
      return { id: s.id, chip: s.chip, label: s.label, kind: s.kind, value: value / scale,
        critical: s.critical > 0 ? s.critical / scale : null, max: s.max > 0 ? s.max / scale : null };
    }))).filter(Boolean);
  }
  async discoverGpus() {
    this.gpus = await Promise.all((await list('/sys/class/drm')).filter(s => /^card\d+$/.test(s)).map(async card => {
      const base = `/sys/class/drm/${card}/device`;
      const driver = path.basename(await readlink(`${base}/driver`).catch(() => 'unknown'));
      const pci = (await read(`${base}/uevent`))?.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
      const render = (await list(`${base}/drm`)).find(s => s.startsWith('renderD'));
      let name = `${driver.toUpperCase()} GPU`;
      try { name = (await exec('/usr/bin/lspci', ['-s', pci || '', '-mm'], { timeout: 3000 })).stdout.match(/"(?:VGA compatible controller|Display controller|3D controller)"\s+"([^"]+)"\s+"([^"]+)"/)?.slice(1).join(' ') || name; } catch {}
      return { card, base, driver, pci, render, name, memory: null };
    }));
  }
  async discoverClients() {
    // Inspect fd symlinks first; read only actual DRM fdinfo files. Limit concurrency.
    const pids = (await list('/proc')).filter(s => /^\d+$/.test(s));
    const paths = [];
    for (let i = 0; i < pids.length; i += 24) {
      await Promise.all(pids.slice(i, i + 24).map(async pid => {
        const base = `/proc/${pid}/fd`;
        await Promise.all((await list(base)).map(async fd => {
          const target = await readlink(`${base}/${fd}`).catch(() => '');
          if (/^\/dev\/dri\/(card|renderD)\d+$/.test(target)) paths.push(`/proc/${pid}/fdinfo/${fd}`);
        }));
      }));
    }
    this.fdPaths = paths;
    this.lastClientScan = performance.now();
  }
  async gpuMetrics(elapsedNs) {
    const clients = new Map();
    for (const text of await Promise.all(this.fdPaths.map(read))) {
      const client = text && parseFdinfo(text);
      if (client) clients.set(client.id, client); // shared/duplicated fds count once
    }
    const output = await Promise.all(this.gpus.map(async gpu => {
      const engines = {};
      for (const c of clients.values()) {
        if (c.pci !== gpu.pci) continue;
        const previous = this.previousClients.get(c.id);
        for (const [name, current] of Object.entries(c.engines)) {
          const value = engineDelta(current, previous?.engines[name], elapsedNs);
          if (value !== null) engines[name] = (engines[name] || 0) + value;
        }
      }
      for (const key in engines) engines[key] = clamp(engines[key]);
      const busy = await number(`${gpu.base}/gpu_busy_percent`);
      if (!gpu.memoryAt || performance.now() - gpu.memoryAt >= 6000) {
        if (gpu.driver === 'xe' && gpu.render) {
          try {
            const result = await exec('/usr/bin/python3', [path.join(here, 'scripts/xe-memory.py'), `/dev/dri/${gpu.render}`], { timeout: 2000 });
            gpu.memory = JSON.parse(result.stdout);
          } catch { gpu.memory = { total: null, used: null, error: 'Xe memory query unavailable' }; }
        } else {
          gpu.memory = { total: await number(`${gpu.base}/mem_info_vram_total`), used: await number(`${gpu.base}/mem_info_vram_used`) };
        }
        gpu.memoryAt = performance.now(); gpu.memory.sampledAt = Date.now();
      }
      return { id: gpu.card, name: gpu.name, driver: gpu.driver, pci: gpu.pci,
        usage: busy ?? (Object.keys(engines).length ? Math.max(...Object.values(engines)) : null),
        usageSource: busy !== null ? 'Device utilization' : 'Busiest engine · accessible user processes',
        engines, memory: { ...gpu.memory, percent: percent(gpu.memory?.used ?? null, gpu.memory?.total) } };
    }));
    this.previousClients = clients;
    return output;
  }
  async diskCapacity() {
    try {
      const { stdout } = await exec('/usr/bin/df', ['-B1', '--output=source,fstype,size,used,avail,pcent,target', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs'], { timeout: 4000, env: { ...process.env, LC_ALL: 'C' } });
      const devices = new Map();
      for (const line of stdout.trim().split('\n').slice(1)) {
        const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
        if (!m) continue;
        const [, source, type, total, used, available, usePercent, mount] = m;
        // Btrfs subvolumes share capacity; show that filesystem once.
        const key = `${source}:${total}`;
        if (devices.has(key)) { devices.get(key).mounts.push(mount); continue; }
        devices.set(key, { source, type, total: +total, used: +used, available: +available, percent: percent(+used, +total), mount, mounts: [mount] });
      }
      this.disks = [...devices.values()].map(d => ({ ...d, sampledAt: Date.now() })); this.lastCapacityScan = performance.now(); this.warnings.delete('Disk capacity unavailable');
    } catch { this.warnings.add('Disk capacity unavailable'); }
  }
  async network(elapsed) {
    const text = await read('/proc/net/dev');
    const result = [];
    for (const line of (text || '').split('\n').slice(2)) {
      const [iface, values] = line.split(':');
      if (!values) continue;
      const name = iface.trim();
      if (/^(lo|veth|br-|docker|virbr)/.test(name)) continue;
      const n = values.trim().split(/\s+/).map(Number);
      const old = this.networkPrevious.get(name);
      const state = await read(`/sys/class/net/${name}/operstate`);
      result.push({ name, state, received: n[0], sent: n[8],
        rx: old ? Math.max(0, n[0] - old[0]) / elapsed : null, tx: old ? Math.max(0, n[8] - old[1]) / elapsed : null });
      this.networkPrevious.set(name, [n[0], n[8]]);
    }
    return result;
  }
  async diskIo(elapsed) {
    const text = await read('/proc/diskstats');
    const output = [];
    for (const line of (text || '').trim().split('\n')) {
      const n = line.trim().split(/\s+/); const name = n[2];
      if (!/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/.test(name)) continue;
      const now = [+n[5] * 512, +n[9] * 512, +n[12]];
      const old = this.ioPrevious.get(name);
      output.push({ name, readTotal: now[0], writeTotal: now[1], read: old ? Math.max(0, now[0] - old[0]) / elapsed : null,
        write: old ? Math.max(0, now[1] - old[1]) / elapsed : null,
        busy: old ? clamp((now[2] - old[2]) / elapsed / 10) : null });
      this.ioPrevious.set(name, now);
    }
    return output;
  }
  async sample() {
    const now = performance.now(); const elapsed = Math.max(0.001, (now - this.lastTime) / 1000); this.lastTime = now;
    if (now - this.lastClientScan >= 10000) await this.discoverClients();
    if (now - this.lastCapacityScan >= 30000) await this.diskCapacity();
    if (now - this.lastSensorScan >= 60000) await this.discoverSensors();
    const [cpuText, memText, temperatures, gpus, network, io] = await Promise.all([
      read('/proc/stat'), read('/proc/meminfo'), this.temperatures(), this.gpuMetrics(elapsed * 1e9), this.network(elapsed), this.diskIo(elapsed)
    ]);
    if (!cpuText || !memText) throw new Error('Cannot read Linux CPU or memory counters');
    const current = parseCpu(cpuText);
    const usage = current.map((c, i) => ({ id: c.id, usage: cpuDelta(c, this.previousCpu[i]) }));
    this.previousCpu = current; this.sequence++;
    const own = process.memoryUsage();
    const clocks = os.cpus().map(c => c.speed).filter(v => v > 0);
    return { time: Date.now(), interval: 2000, observedIntervalSeconds: elapsed, sequence: this.sequence,
      host: { name: os.hostname(), kernel: os.release(), arch: os.arch(), uptime: os.uptime() },
      cpu: { model: this.model, usage: usage[0]?.usage ?? null, cores: usage.slice(1), load: os.loadavg(), speed: clocks.length ? clocks.reduce((a, b) => a + b, 0) / clocks.length : null },
      memory: parseMemory(memText), gpus, temperatures, disks: this.disks, network, io,
      monitor: { rss: own.rss, uptime: process.uptime(), startTime: processStartTime, cpuSeconds: Object.values(process.cpuUsage()).reduce((a, b) => a + b, 0) / 1e6, collectionMs: performance.now() - now }, warnings: [...this.warnings] };
  }
}
