// tests/fixtures/process-tree-child.js
console.log(JSON.stringify({ type: 'child_ready', pid: process.pid }));

const timer = setInterval(() => {}, 1000);

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
