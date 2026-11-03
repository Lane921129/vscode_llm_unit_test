const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { workspaceRoot, discoverTests, partitionTests, selectTests } = require('./verificationConfig');

function parseVerificationArguments(argv) {
    const [mode, ...remaining] = argv;
    if (!['fast', 'integration', 'full', 'related'].includes(mode)) {
        throw new Error('Usage: node test/verification.js fast|integration|full|related [--list] [--node selector] [--python selector]');
    }
    const options = { mode, list: false, node: [], python: [] };
    for (let index = 0; index < remaining.length; index++) {
        const argument = remaining[index];
        if (argument === '--list') { options.list = true; }
        else if (argument === '--node' || argument === '--python') {
            if (mode !== 'related') { throw new Error('--node and --python are only supported in related mode.'); }
            const value = remaining[++index];
            if (!value || value.startsWith('--')) { throw new Error(`${argument} requires a selector.`); }
            options[argument.slice(2)].push(value);
        } else { throw new Error(`Unknown verification argument: ${argument}`); }
    }
    if (mode === 'related' && options.node.length + options.python.length === 0) {
        throw new Error('related requires at least one --node or --python selector; no tests were selected.');
    }
    return options;
}

function pythonExecutable(root = workspaceRoot, platform = process.platform) {
    return path.join(root, '.venv', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');
}

function buildVerificationPlan(options, { root = workspaceRoot, inventory = discoverTests(root),
    execPath = process.execPath, platform = process.platform } = {}) {
    const selected = options.mode === 'related'
        ? { node: selectTests(inventory.node, options.node, root), python: selectTests(inventory.python, options.python, root) }
        : partitionTests(inventory, options.mode);
    const steps = [];
    const nodeStep = (name, relative, args = []) => steps.push({ name, command: execPath, args: [path.join(root, relative), ...args] });
    if (options.mode === 'fast' || options.mode === 'full') {
        nodeStep('check-types', 'node_modules/typescript/bin/tsc', ['--noEmit']);
        nodeStep('lint', 'node_modules/eslint/bin/eslint.js', ['src']);
    }
    nodeStep('compile-tests', 'node_modules/typescript/bin/tsc', ['-p', '.', '--outDir', 'out']);
    const selectionArgs = kind => options.mode === 'related'
        ? selected[kind].flatMap(file => ['--select', file]) : ['--tier', options.mode];
    if (selected.node.length) { nodeStep('Node regressions', 'test/run_unit_tests.js', selectionArgs('node')); }
    if (options.mode === 'fast' || options.mode === 'full') { nodeStep('Webview syntax', 'test/extract_script.js'); }
    if (selected.python.length) { nodeStep('Python regressions', 'test/run_python_tests.js', [...selectionArgs('python'), '--skip-secret-scan']); }
    if (options.mode === 'full') {
        steps.push({ name: 'tracked files and reachable history secret scan', command: pythonExecutable(root, platform),
            args: ['python_scripts/secret_scan.py', '--history'] });
        nodeStep('production package (types and lint already passed)', 'esbuild.js', ['--production']);
    }
    return { root, mode: options.mode, list: options.list, selected, totals: { node: inventory.node.length, python: inventory.python.length }, steps };
}

function printVerificationPlan(plan, log = console.log) {
    log(`[verification:${plan.mode}] Node files ${plan.selected.node.length}/${plan.totals.node}; Python files ${plan.selected.python.length}/${plan.totals.python}.`);
    log(plan.mode === 'full'
        ? '[scope] Full repository regressions and production build; live LLM/DGX and the separate VS Code/Mocha suite (npm test) are not included.'
        : '[scope] Partial verification only. A passing result does not mean full verification passed; run npm run test:full at a milestone or before a demo/release.');
    if (plan.list) {
        for (const file of [...plan.selected.node, ...plan.selected.python]) { log(`  ${file}`); }
        for (const step of plan.steps) { log(`  step: ${step.name} ${JSON.stringify([step.command, ...step.args])}`); }
        log('[list] Plan only; no compiler, tests, scan or build was executed.');
    }
}

function executeVerificationPlan(plan, { spawn = spawnSync, log = console.log, error = console.error, env = process.env } = {}) {
    printVerificationPlan(plan, log);
    if (plan.list) { return 0; }
    for (const step of plan.steps) {
        log(`[step] ${step.name}`);
        const result = spawn(step.command, step.args, { cwd: plan.root, stdio: 'inherit', shell: false,
            env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
        if (result.error || result.status !== 0) {
            error(`[failed] ${step.name}${result.error ? `: ${result.error.message}` : result.signal ? ` (${result.signal})` : ''}`);
            return typeof result.status === 'number' && result.status > 0 ? result.status : 1;
        }
    }
    log(`[verification:${plan.mode}] Selected scope passed${plan.mode === 'full' ? '.' : '; full verification remains outstanding.'}`);
    return 0;
}

function runVerification(argv = process.argv.slice(2), dependencies = {}) {
    try { return executeVerificationPlan(buildVerificationPlan(parseVerificationArguments(argv), dependencies), dependencies); }
    catch (error) { (dependencies.error || console.error)(error.message); return 1; }
}

module.exports = { parseVerificationArguments, pythonExecutable, buildVerificationPlan,
    printVerificationPlan, executeVerificationPlan, runVerification };
