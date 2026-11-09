import { readFileSync } from 'node:fs';

const minimum = readFileSync(new URL('./.node-version', import.meta.url), 'utf8').trim();
const required = minimum.split('.').map(Number);
const current = process.versions.node.split('.').map(Number);
if (current[0] !== required[0] || current[1] < required[1] ||
    (current[1] === required[1] && current[2] < required[2])) {
  throw new Error(`LOCMON requires Node.js >=${minimum} <${required[0] + 1}; found ${process.versions.node}. Run mise install, then mise exec -- npm start.`);
}
