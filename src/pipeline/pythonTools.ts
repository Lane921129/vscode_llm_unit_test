import * as path from 'path';

/** One map from the TypeScript workflow to the Python executables it owns. */
export const PYTHON_TOOLS = {
    complexity: 'complexity_assessor.py',
    ast: 'ast_extractor.py',
    callers: 'ast_caller_finder.py',
    trace: 'dynamic_tracer.py',
    preflight: 'module_preflight.py',
    scaffold: 'mock_scaffold_generator.py',
    bindings: 'validate_test_bindings.py',
    calls: 'validate_target_calls.py',
    assertionEvidence: 'validate_assertion_evidence.py',
    repairScope: 'validate_repair_scope.py',
    rescue: 'rescue_unittest.py',
    scenarios: 'scenario_inventory.py',
    mutation: 'basic_mutation_runner.py'
} as const;

export function pythonToolPath(tool: keyof typeof PYTHON_TOOLS): string {
    // __dirname is src/pipeline (tsc: out/pipeline) or dist (bundled extension).
    const root = path.basename(__dirname) === 'pipeline' ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..');
    return path.join(root, 'python_scripts', PYTHON_TOOLS[tool]);
}
