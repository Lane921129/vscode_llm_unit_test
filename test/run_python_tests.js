const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { workspaceRoot, pythonTests, partitionTests, selectTests } = require('./verificationConfig');
const { parseRunnerArguments } = require('./run_unit_tests');
const { pythonExecutable } = require('./verificationRunner');

function runPythonTests(argv = process.argv.slice(2), { root = workspaceRoot, spawn = spawnSync,
    log = console.log, error = console.error, fileSystem = fs, env = process.env, platform = process.platform } = {}) {
    try {
        const options = parseRunnerArguments(argv);
        const files = options.selectors.length ? selectTests(pythonTests, options.selectors, root)
            : partitionTests({ node: [], python: pythonTests }, options.tier || 'full').python;
        if (files.length === 0) { throw new Error('No Python test files selected.'); }
        const scan = !options.skipSecretScan && !options.selectors.length && (!options.tier || options.tier === 'full');
        log(`[Python:${options.tier || (options.selectors.length ? 'related' : 'full')}] ${files.length} files; history secret scan ${scan ? 'included' : 'not included'}.`);
        if (options.list) { files.forEach(file => log(file)); return 0; }
        const executable = pythonExecutable(root, platform);
        if (!fileSystem.existsSync(executable)) { throw new Error('Project virtual environment is missing. Create .venv and install requirements.txt before running Python tests.'); }
        const run = args => spawn(executable, args, { cwd: root, stdio: 'inherit', shell: false,
            env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
        const result = run(['-m', 'unittest', ...files]);
        if (result.status !== 0) { return typeof result.status === 'number' && result.status > 0 ? result.status : 1; }
        if (!scan) { return 0; }
        const scanResult = run(['python_scripts/secret_scan.py', '--history']);
        return scanResult.status === 0 ? 0 : typeof scanResult.status === 'number' && scanResult.status > 0 ? scanResult.status : 1;
    } catch (failure) { error(failure.message); return 1; }
}

if (require.main === module) { process.exitCode = runPythonTests(); }
module.exports = { runPythonTests };
