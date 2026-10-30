import * as path from 'path';

/** One map from the TypeScript workflow to the Python executables it owns. */
export const PYTHON_TOOLS = {
    testRunner: 'generated_test_runner.py',
    complexity: 'complexity_assessor.py',
    ast: 'ast_extractor.py',
    callers: 'ast_caller_finder.py',
    trace: 'dynamic_tracer.py',
    probeFixtureBuilder: 'probe_fixture_builder.py',
    preflight: 'module_preflight.py',
    initializationPlan: 'plan_import_initialization.py',
    sqliteSchemaPlan: 'sqlite_schema_plan.py',
    environment: 'environment_probe.py',
    installer: 'package_installer.py',
    scaffold: 'mock_scaffold_generator.py',
    bindings: 'validate_test_bindings.py',
    calls: 'validate_target_calls.py',
    assertionEvidence: 'validate_assertion_evidence.py',
    repairScope: 'validate_repair_scope.py',
    passingPreservation: 'passing_test_preservation.py',
    testMerge: 'merge_test_snippets.py',
    methodEdit: 'edit_test_methods.py',
    reviewFacts: 'review_test_facts.py',
    sourceExpectations: 'repair_source_expectations.py',
    sourceLiteralRepair: 'source_literal_argument_repair.py',
    sourceMockReceiverRepair: 'source_mock_receiver_repair.py',
    sourceTestBindingRepair: 'source_test_binding_repair.py',
    sourceMockSetupRepair: 'source_mock_setup_repair.py',
    sourceParameterMockRepair: 'source_parameter_mock_repair.py',
    rescue: 'rescue_unittest.py',
    scenarios: 'scenario_inventory.py',
    traceDeduplication: 'deduplicate_trace_tests.py',
    mutationInputs: 'mutation_probe_plan.py',
    qualityExperiments: 'quality_experiment_runner.py',
    parameterFixtureExperiments: 'parameter_fixture_experiments.py',
    mutation: 'basic_mutation_runner.py',
    externalMutation: 'external_mutation_runner.py',
    coverage: 'coverage_read.py'
} as const;

export function pythonToolPath(tool: keyof typeof PYTHON_TOOLS): string {
    // __dirname is src/pipeline (tsc: out/pipeline) or dist (bundled extension).
    const root = path.basename(__dirname) === 'pipeline' ? path.resolve(__dirname, '../..') : path.resolve(__dirname, '..');
    return path.join(root, 'python_scripts', PYTHON_TOOLS[tool]);
}

/** Only extension-owned scripts receive this bootstrap policy; arbitrary subprocesses do not. */
export function preparePythonToolProcess(args: string[], environment: NodeJS.ProcessEnv): { args: string[]; env: NodeJS.ProcessEnv } {
    const owned = Object.keys(PYTHON_TOOLS).some(tool => args.includes(pythonToolPath(tool as keyof typeof PYTHON_TOOLS)));
    if (!owned) { return { args, env: environment }; }
    const env = { ...environment };
    if (env.PYTHONPATH !== undefined) {
        env.LLM_UNIT_TEST_IMPORT_PATHS = JSON.stringify([...new Set(env.PYTHONPATH.split(path.delimiter).filter(Boolean))]);
    }
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    delete env.PYTHONINSPECT;
    // -E ignores interpreter configuration from the parent environment; the
    // explicit UTF-8 flag keeps stdout/stdin portable even on Windows.
    return { args: ['-E', '-X', 'utf8', ...args], env };
}
