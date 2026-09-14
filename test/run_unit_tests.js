const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.resolve(__dirname, '../out/test');
const mochaTests = new Set(['core.test.js', 'extension.test.js']);

if (!fs.existsSync(testDir)) {
    console.error(`Test directory not found: ${testDir}. Did you run "npm run compile-tests"?`);
    process.exit(1);
}

const testFiles = fs.readdirSync(testDir)
    .filter(f => f.endsWith('.test.js') && !mochaTests.has(f))
    .map(f => path.join(testDir, f));

if (testFiles.length === 0) {
    console.error('No unit test files found in out/test');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
