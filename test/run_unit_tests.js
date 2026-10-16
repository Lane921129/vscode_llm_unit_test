const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { workspaceRoot, discoverTests, partitionTests, compiledNodePath, selectTests } = require('./verificationConfig');

function parseRunnerArguments(argv) {
    const options = { tier: undefined, selectors: [], list: false, skipSecretScan: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--list') { options.list = true; }
        else if (argument === '--skip-secret-scan') { options.skipSecretScan = true; }
        else if (argument === '--tier' || argument === '--select') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) { throw new Error(`${argument} requires a value.`); }
            if (argument === '--tier') {
                if (options.tier || !['fast', 'integration', 'full'].includes(value)) { throw new Error('Specify one --tier fast|integration|full.'); }
                options.tier = value;
            } else { options.selectors.push(value); }
        } else { throw new Error(`Unknown test runner argument: ${argument}`); }
    }
    if (options.tier && options.selectors.length) { throw new Error('--tier and --select cannot be combined.'); }
    return options;
}

function runNodeTests(argv = process.argv.slice(2), { root = workspaceRoot, spawn = spawnSync,
    log = console.log, error = console.error, fileSystem = fs } = {}) {
    try {
        const options = parseRunnerArguments(argv);
        let testFiles;
        if (!options.tier && options.selectors.length === 0 && !options.list) {
            // Backward-compatible CI entry: run every compiled Node test as before.
            const testDir = path.join(root, 'out', 'test');
            if (!fileSystem.existsSync(testDir)) { throw new Error(`Test directory not found: ${testDir}. Did you run "npm run compile-tests"?`); }
            testFiles = fileSystem.readdirSync(testDir).filter(name => name.endsWith('.test.js')
                && !['core.test.js', 'extension.test.js'].includes(name)).sort().map(name => path.join(testDir, name));
        } else {
            const inventory = discoverTests(root);
            const sources = options.selectors.length ? selectTests(inventory.node, options.selectors, root)
                : partitionTests(inventory, options.tier || 'full').node;
            testFiles = sources.map(file => path.join(root, compiledNodePath(file)));
            if (!options.list) {
                const missing = testFiles.find(file => !fileSystem.existsSync(file));
                if (missing) { throw new Error(`Compiled test not found: ${missing}. Run "npm run compile-tests" first.`); }
            }
        }
        if (testFiles.length === 0) { throw new Error('No Node test files selected.'); }
        log(`[Node:${options.tier || (options.selectors.length ? 'related' : 'full')}] ${testFiles.length} files; VS Code/Mocha core and extension tests remain separate.`);
        if (options.list) { testFiles.forEach(file => log(file)); return 0; }
        // Files launch bounded Python workers: keep files serial, as before.
        const result = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles],
            { cwd: root, stdio: 'inherit', shell: false });
        return result.status === 0 ? 0 : typeof result.status === 'number' && result.status > 0 ? result.status : 1;
    } catch (failure) { error(failure.message); return 1; }
}

if (require.main === module) { process.exitCode = runNodeTests(); }
module.exports = { parseRunnerArguments, runNodeTests };
