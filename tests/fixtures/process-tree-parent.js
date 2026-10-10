// tests/fixtures/process-tree-parent.js
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(__dirname, 'process-tree-child.js');
const child = spawn(process.execPath, [childScript], {
  stdio: ['ignore', 'pipe', 'inherit'],
});

child.stdout.on('data', () => {
  // child started
});

console.log(JSON.stringify({
  type: 'parent_ready',
  parentPid: process.pid,
  childPid: child.pid,
}));

const timer = setInterval(() => {}, 1000);

function cleanup() {
  clearInterval(timer);
  try {
    child.kill();
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
