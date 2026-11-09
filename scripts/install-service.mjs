import '../runtime.mjs';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--replace')) {
  throw new Error('Usage: node scripts/install-service.mjs [--replace]');
}
const replace = args.includes('--replace');
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const quote = value => '"' + value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const dir = path.join(os.homedir(), '.config/systemd/user');
const target = path.join(dir, 'locmon.service');
let previous = '';
if (replace) {
  try { previous = await readFile(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Keep the installed bind address on upgrades unless explicitly overridden.
const host = process.env.HOST || previous.match(/^Environment=HOST=(.+)$/m)?.[1] || '127.0.0.1';
const port = Number(process.env.PORT || previous.match(/^Environment=PORT=(.+)$/m)?.[1] || 1521);
if (host !== 'localhost' && !isIP(host)) throw new Error('HOST must be localhost or an IP address');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const unit = `[Unit]
Description=LOCMON local system monitor
Documentation=${pathToFileURL(path.join(root, 'README.md')).href.replace(/%/g, '%%')}
After=default.target

[Service]
Type=simple
WorkingDirectory=${quote(root)}
ExecStart=${quote(process.execPath)} --max-old-space-size=64 ${quote(path.join(root, 'server.mjs'))}
Environment=NODE_ENV=production
Environment=PORT=${port}
Environment=HOST=${host}
Restart=on-failure
RestartSec=5
TimeoutStopSec=5
NoNewPrivileges=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077
MemoryMax=192M
TasksMax=64

[Install]
WantedBy=default.target
`;
await mkdir(dir, { recursive: true });
if (replace) {
  const backup = `${target}.bak.${Date.now()}`;
  try {
    await copyFile(target, backup, constants.COPYFILE_EXCL);
    console.log(`Backed up ${backup}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await writeFile(target, unit, { flag: replace ? 'w' : 'wx' });
console.log(`Installed ${target} with Node.js ${process.versions.node}`);
