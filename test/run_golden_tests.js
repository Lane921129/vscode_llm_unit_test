const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--update')) { throw new Error('Usage: npm run test:golden -- [--update]'); }
const root = path.resolve(__dirname, '..');
const env = { ...process.env, UPDATE_ORCHESTRATOR_GOLDEN: args.includes('--update') ? '1' : '0',
    UPDATE_CASE_TABLE_GOLDEN: process.env.UPDATE_CASE_TABLE_GOLDEN === '1' ? '1' : '0' };
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
// v1 golden first, then the independent v2 case-table golden. --update only affects v1;
// v2 snapshots are recorded solely with UPDATE_CASE_TABLE_GOLDEN=1 (see caseTableGolden.test.ts).
for (const command of [[tsc, '-p', '.', '--outDir', 'out'], ['--test', '--test-concurrency=1', 'out/test/orchestratorGolden.test.js'],
    ['--test', '--test-concurrency=1', 'out/test/caseTableGolden.test.js']]) {
    const result = spawnSync(process.execPath, command, { cwd: root, env, stdio: 'inherit' });
    if (result.error) { throw result.error; }
    if (result.status !== 0) { process.exit(result.status ?? 1); }
}
