import '../runtime.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function checkDirectory(dir) {
  for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const url = new URL(`${dir}${entry.name}`, import.meta.url);
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules', '__pycache__', '.venv', 'venv'].includes(entry.name)) await checkDirectory(`${dir}${entry.name}/`);
    } else if (/\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(url)], { stdio: 'inherit' });
      assert.equal(result.status, 0, `Syntax check failed: ${url.pathname}`);
    } else if (entry.name.endsWith('.json')) {
      JSON.parse(await readFile(url, 'utf8'));
    } else if (entry.name.endsWith('.py')) {
      const result = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', fileURLToPath(url)], { stdio: 'inherit' });
      assert.equal(result.status, 0, `Python syntax check failed: ${url.pathname}`);
    }
  }
}

await checkDirectory('../');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const minimum = (await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim();
const mise = await readFile(new URL('../mise.toml', import.meta.url), 'utf8');
assert.ok(mise.includes(`node = "${minimum}"`), 'mise.toml must match .node-version');
assert.equal(pkg.engines.node, `>=${minimum} <${Number(minimum.split('.')[0]) + 1}`);
console.log('JavaScript/Python syntax, JSON files, and runtime pins are valid.');
