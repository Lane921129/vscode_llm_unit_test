const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const mochaTests = new Set(['core.test.ts', 'extension.test.ts']);

// Explicit, reviewed low-cost contracts/parsers/mocked traffic. New Node files
// default to integration; runtime duration never decides whether tests execute.
const fastNodeTests = new Set([
    'analysisTargetBudget', 'analystPlanContract', 'artifactSafety',
    'batchPreflightPartition', 'batchPreflightSnapshot', 'batchRuntimeQualification',
    'candidateCheckpoint', 'candidateRejectionTracing', 'candidateToolFailureRouting',
    'cleanerQualityRegression', 'cloudApi', 'cloudCredentials', 'connectionTimeout',
    'contextGrowth', 'customApi', 'dependencyResolver', 'exceptionEvidence',
    'executionContext', 'executionFailureCategory', 'focusedQualityProgress',
    'focusedWriterAdditions', 'generatedTestValidator', 'localRuntimeContext',
    'localRuntimeMetadata', 'modelQualification', 'modelRequestProgress',
    'modelRequestTimingPresentation', 'moduleGlobalBindingAndMethodRepair', 'mutantTriageParser', 'mutationProcessFailure',
    'mutationResult', 'mutationSelection', 'noChangeRecovery', 'numericEvidenceLedger',
    'ollamaGenerationResponse', 'ollamaOutputLimitDiagnostics', 'ollamaPrompt',
    'ollamaQualificationStreaming', 'ollamaRuntimeMetadata', 'outputRecoveryTiming',
    'promptBudgetReservation', 'promptCapacity', 'promptContextReuse', 'promptPurity',
    'providerResponseDeadline', 'qualityContractVersion', 'qualityPolicy',
    'repairReviewPromptBudget', 'requestTiming', 'reviewContractRepair',
    'reviewerCommunicationContract', 'reviewerDiagnosticProjection',
    'reviewerDiagnosticsReport', 'reviewerEvidencePrompt', 'reviewerExpectedEvidencePrompt',
    'rolePipeline', 'roleQualificationDiagnostics', 'roleTransportMatrix',
    'runtimeQualificationSession', 'seedCandidatePipeline', 'semanticAnalysisParser',
    'semanticContractRepair', 'semanticPromptBudget', 'semanticPromptCompaction',
    'serialRequestQueue', 'sidebarProviderResponseDeadline', 'sourceExpectationPipeline',
    'sourceImportProjection', 'stubClassifier', 'stubSmokeAssertion', 'stubTestPlan',
    'supplementalProbeInputs', 'targetBudget', 'targetCoverage', 'testRuleLibrary',
    'tier1Literals', 'tier1TestBuilder', 'tier1TestFileBuilder', 'tier2SubtaskGate',
    'tierFailurePolicy', 'tierRouter', 'traceRecovery', 'traceTestAugmenter',
    'traceTimingReport', 'unittestExceptionRouting', 'verificationRunner',
    'writerContextProjection', 'writerInstructionCompaction', 'writerOutputGrowth',
    'writerPhases', 'writerPromptCompression', 'writerPromptProjection',
    'writerRevisionContext', 'writerRevisionOutputBudget', 'writerSeedOutputBudget',
    'writerSeedScenario', 'writerSourceSetup'
].map(name => `${name}.test.ts`));

// Full Python suite; append new reviewed coverage without removing prior files.
const pythonTests = [
    'python_scripts/test_rescue_unittest.py',
    'python_scripts/test_ast_pipeline.py',
    'python_scripts/test_static_type_shape.py',
    'python_scripts/test_probe_case_plan.py',
    'python_scripts/test_probe_fixture_builder.py',
    'python_scripts/test_mock_source_contract.py',
    'python_scripts/test_mock_namespace_behavior.py',
    'python_scripts/test_source_setup_call_contract.py',
    'python_scripts/test_dependency_fixture_contract.py',
    'python_scripts/test_pipeline_reliability.py',
    'python_scripts/test_target_result_imports.py',
    'python_scripts/test_target_state_evidence.py',
    'python_scripts/test_generated_test_runner.py',
    'python_scripts/test_environment_probe.py',
    'python_scripts/test_trace_observation_guard.py',
    'python_scripts/test_trace_case_isolation.py',
    'python_scripts/test_trace_timing.py',
    'python_scripts/test_typed_caller_transport.py',
    'python_scripts/test_assertion_evidence.py',
    'python_scripts/test_source_expectations.py',
    'python_scripts/test_validate_repair_scope.py',
    'python_scripts/test_numeric_skill.py',
    'python_scripts/test_passing_test_preservation.py',
    'python_scripts/test_merge_test_snippets.py',
    'python_scripts/test_review_test_facts.py',
    'python_scripts/test_mutation_baseline_repair.py',
    'python_scripts/test_mutation_import_layout.py',
    'python_scripts/test_mutation_activation.py',
    'python_scripts/test_mutation_improvement.py',
    'python_scripts/test_mutation_v2.py',
    'python_scripts/test_mutation_engine_policy.py',
    'python_scripts/test_mutation_code_change.py',
    'python_scripts/test_external_mutation_runner.py',
    'python_scripts/test_quality_experiments.py',
    'python_scripts/test_parameter_fixture_experiments.py',
    'python_scripts/test_quality_policy.py',
    'python_scripts/test_runtime_policy.py',
    'python_scripts/test_isolated_resources.py',
    'python_scripts/test_external_isolated_resources.py',
    'python_scripts/test_unc_virtual_resources.py',
    'python_scripts/test_import_fixtures.py',
    'python_scripts/test_import_setup_advisor.py',
    'python_scripts/test_plan_import_initialization.py',
    'python_scripts/test_sqlite_schema_plan.py',
    'python_scripts/test_export_results.py',
    'python_scripts/test_caller_artifacts.py',
    'python_scripts/test_writer_retrieval.py',
    'python_scripts/test_fixture_corpus.py',
    'python_scripts/test_lab_batch_plan.py',
    'python_scripts/test_fixture_scorecard.py',
    'python_scripts/test_secret_scan.py',
    'python_scripts/test_edit_test_methods.py'
];
const fastPythonTests = new Set([
    'python_scripts/test_static_type_shape.py',
    'python_scripts/test_numeric_skill.py',
    'python_scripts/test_mutation_engine_policy.py',
    'python_scripts/test_quality_policy.py'
]);

function discoverTests(root = workspaceRoot) {
    const node = fs.readdirSync(path.join(root, 'src', 'test'))
        .filter(name => name.endsWith('.test.ts') && !mochaTests.has(name))
        .sort()
        .map(name => `src/test/${name}`);
    if (node.length === 0) { throw new Error('No Node test sources found in src/test.'); }
    return { node, python: [...pythonTests] };
}

function partitionTests(tests, tier) {
    if (!['fast', 'integration', 'full'].includes(tier)) { throw new Error(`Unknown verification tier: ${tier}`); }
    const select = (files, fast) => files.filter(file => tier === 'full'
        || fast.has(file.startsWith('src/test/') ? path.posix.basename(file) : file) === (tier === 'fast'));
    return { node: select(tests.node, fastNodeTests), python: select(tests.python, fastPythonTests) };
}

function compiledNodePath(source) {
    return source.replace(/^src\/test\//, 'out/test/').replace(/\.ts$/, '.js');
}

/** Select only inventoried files, never executable arguments or external paths. */
function selectTests(files, selectors, root = workspaceRoot) {
    const selected = new Set();
    const normalize = value => value.replace(/\\/g, '/').toLowerCase();
    for (const selector of selectors) {
        if (typeof selector !== 'string' || !selector.trim() || /^[\s]*-/.test(selector)
            || /[\x00-\x1f\x7f]/.test(selector)) { throw new Error('A selector must name a repository test file or a filename fragment.'); }
        const wanted = normalize(selector.trim());
        const exact = files.filter(file => {
            const aliases = [file, path.posix.basename(file), path.resolve(root, file)];
            if (file.endsWith('.test.ts')) {
                const compiled = compiledNodePath(file);
                aliases.push(compiled, path.posix.basename(compiled), path.resolve(root, compiled));
            }
            return aliases.some(alias => normalize(alias) === wanted);
        });
        const matches = exact.length ? exact : /[/:]/.test(wanted) ? []
            : files.filter(file => normalize(path.posix.basename(file)).includes(wanted));
        if (matches.length === 0) { throw new Error(`No repository tests match selector: ${selector}`); }
        for (const file of matches) { selected.add(file); }
    }
    return files.filter(file => selected.has(file));
}

module.exports = { workspaceRoot, mochaTests, pythonTests, fastNodeTests, fastPythonTests,
    discoverTests, partitionTests, compiledNodePath, selectTests };
