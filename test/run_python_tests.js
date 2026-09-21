const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const pythonExecutable = process.platform === 'win32'
    ? path.join(workspaceRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(workspaceRoot, '.venv', 'bin', 'python');

if (!fs.existsSync(pythonExecutable)) {
    console.error('Project virtual environment is missing. Create .venv and install requirements.txt before running Python tests.');
    process.exitCode = 1;
} else {
    const unittestFiles = [
        'python_scripts/test_rescue_unittest.py',
        'python_scripts/test_ast_pipeline.py',
        'python_scripts/test_pipeline_reliability.py',
        'python_scripts/test_generated_test_runner.py',
        'python_scripts/test_environment_probe.py',
        'python_scripts/test_trace_observation_guard.py',
        'python_scripts/test_trace_case_isolation.py',
        'python_scripts/test_runtime_policy.py',
        'python_scripts/test_caller_artifacts.py',
        'python_scripts/test_writer_retrieval.py',
        'python_scripts/test_fixture_corpus.py',
        'python_scripts/test_lab_batch_plan.py',
        'python_scripts/test_fixture_scorecard.py',
        'python_scripts/test_secret_scan.py'
    ];
    const run = (arguments_) => spawnSync(pythonExecutable, arguments_, {
        cwd: workspaceRoot,
        stdio: 'inherit',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    const unittestResult = run(['-m', 'unittest', ...unittestFiles]);
    if (unittestResult.status === 0) {
        const scanResult = run(['python_scripts/secret_scan.py', '--history']);
        process.exitCode = scanResult.status === 0 ? 0 : 1;
    } else {
        process.exitCode = 1;
    }
}
