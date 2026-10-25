// Runs every CDE basis unit test suite (plain Node, no dependencies):  node tests/cde_basis/run_all.js
const { spawnSync } = require('child_process');
const path = require('path');
const suites = ['test_positions.js', 'test_bidask.js', 'test_fetcher.js'];
let failed = 0;
for (const f of suites) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
