import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLanguage } from '../i18n/core';
import { renderFinalReport, renderMutationDiagnostics } from '../pipeline/targetReport';
import { MutationRecord } from '../mutation/mutationResult';

test('mutation diagnostics preserve the two existing tables and show only recorded attribution', () => {
    const mutant: MutationRecord = { id: 'a'.repeat(64), kind: 'binary', line: 2, column: 4, position: 0,
        from: 'Div', to: 'FloorDiv', status: 'KILLED', killedBy: ['test_target.Cases.test_value'], elapsedMs: 123,
        codeChange: { schemaVersion: 'mutation-code-v1', before: 'ratio = a / b', after: 'ratio = a // b' } };
    try {
        for (const language of ['en', 'zh-tw'] as const) {
            setLanguage(language);
            const report = renderFinalReport({ schemaVersion: 'target-report-v1', sourcePath: 'source.py', sourceFile: 'source.py',
                target: 'target', modelIdentity: 'local/neutral', requestedTier: 'tier2', requestedMutationEngine: 'mutatest' },
            { included: true, outcome: 'passed', reason: '', coverage: '100%', mutation: '100%',
                mutationEngine: 'mutatest', mutationOperatorSet: 'mutatest-ast-3.1.0-v1', mutationElapsedMs: 1000,
                mutants: [mutant, { ...mutant, status: 'SURVIVED', killedBy: undefined }] }, false);
            assert.match(report, /mutatest \/ mutatest-ast-3.1.0-v1/);
            assert.match(report, /\| 2:4 \| Div \| FloorDiv \| KILLED \|/);
            assert.match(report, /`ratio = a \/ b`/);
            assert.match(report, /test_target.Cases.test_value \| 123/);
            assert.match(report, /Div → FloorDiv \| — \| 123/);
            if (language === 'en') { assert.doesNotMatch(report, /[\u4e00-\u9fff]/); }
        }
        assert.equal(renderMutationDiagnostics([{ ...mutant, killedBy: undefined, elapsedMs: undefined }]), '');
    } finally { setLanguage('zh-tw'); }
});
