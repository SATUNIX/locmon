import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const settingsPath = path.join(os.homedir(), '.config/locmon/settings.json');
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'intervalMs') || !Number.isInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 30000) throw new Error('intervalMs must be an integer between 1000 and 30000');
  return { intervalMs: value.intervalMs };
}
export async function loadSettings() {
  try { return validateSettings(JSON.parse(await readFile(settingsPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Using default sampling interval:', error.message); return { intervalMs: 2000 }; }
}
export async function saveSettings(value) {
  const clean = validateSettings(value);
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(`${settingsPath}.tmp`, JSON.stringify(clean) + '\n', { mode: 0o600 });
  await rename(`${settingsPath}.tmp`, settingsPath);
  return clean;
}
