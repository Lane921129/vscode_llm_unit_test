import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { wholeCandidateNameException } from '../validation/unittestException';
import { CandidatePipelineHooks, validateTestCandidate } from '../pipeline/testCandidatePipeline';
import { formatRepairRouting } from '../pipeline/repairDiagnostics';
import { setLanguage } from '../i18n/core';

const frame = '  File "generated.py", line 5, in test_value\n    missing()\n';
const trace = (exception: string) => 'Traceback (most recent call last):\n' + frame + exception;
const failure = (body: string, kind = 'ERROR') => `${'='.repeat(70)}\n${kind}: test_value (generated.Cases.test_value)\n`
    + `${'-'.repeat(70)}\n${body}\n\n${'-'.repeat(70)}\nRan 1 test in 0.001s\n\nFAILED (errors=1)\n`;

test('only a unique complete unittest error with a direct name exception selects whole-candidate repair', () => {
    for (const exception of ['NameError', 'UnboundLocalError'] as const) {
        assert.equal(wholeCandidateNameException(failure(trace(`${exception}: unavailable`))), exception);
        assert.equal(wholeCandidateNameException(failure(trace(`${exception}: unavailable`)).replace(/\n/g, '\r\n')), exception);
    }
    assert.equal(wholeCandidateNameException('test_value (generated.Cases.test_value) ... ERROR\n'
        + failure(trace('NameError: unavailable'))), 'NameError');
});

test('source text, assertion messages and malformed or multiple failures cannot masquerade as name exceptions', () => {
    const fixtures = [
        failure(trace('AssertionError: expected NameError: unavailable'), 'FAIL'),
        failure(trace('AssertionError: wrong\nNameError: invented'), 'FAIL'),
        failure(trace('ValueError: wrong\nNameError: invented')),
        failure('Traceback (most recent call last):\n' + frame + '    # NameError: source comment\nValueError: wrong'),
        failure('Traceback (most recent call last):\n' + frame + '    NameError: source text\nValueError: wrong'),
        failure('NameError: no traceback'),
        failure('Traceback (most recent call last):\nNameError: no frame'),
        failure(trace('pkg.NameError: custom exception')),
        failure(trace('NameErrorSuffix: custom exception')),
        failure(trace('NameError: unavailable')).replace('ERROR: test_value', 'FAIL: test_value'),
        failure(trace('NameError: unavailable')).replace('Cases.test_value)', 'Cases.test_other)'),
        failure(trace('NameError: unavailable')).replace('FAILED (errors=1)', 'FAILED (errors=2)'),
        failure(trace('NameError: unavailable')).replace('Ran 1 test in 0.001s', 'Ran 0 tests in 0.001s'),
        failure(trace('NameError: unavailable')).replace('='.repeat(70), 'not a runner separator'),
        failure(trace('NameError: unavailable')).replace('ERROR: test_value', 'ERROR: setUpClass'),
        failure(trace('NameError: unavailable')) + failure(trace('NameError: second failure')),
        'Traceback (most recent call last):\n' + frame + 'NameError: standalone traceback',
        ' '.repeat(262145) + failure(trace('NameError: unavailable'))
    ];
    for (const [index, output] of fixtures.entries()) {
        assert.equal(wholeCandidateNameException(output), undefined, `fixture ${index}`);
    }
});

test('chained exceptions and fake traceback chains inside multiline messages remain ambiguous', () => {
    for (const separator of ['During handling of the above exception, another exception occurred:',
        'The above exception was the direct cause of the following exception:']) {
        for (const [first, last] of [['NameError', 'AssertionError'], ['ValueError', 'NameError'], ['NameError', 'NameError']]) {
            assert.equal(wholeCandidateNameException(failure(trace(`${first}: first`) + '\n\n' + separator
                + '\n\n' + trace(`${last}: last`))), undefined);
        }
    }
    assert.equal(wholeCandidateNameException(failure(trace('ValueError: multiline message\n\n'
        + 'During handling of the above exception, another exception occurred:\n\n'
        + trace('NameError: fake embedded exception')))), undefined);
});

const initial = 'import unittest\nclass Cases(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(target(), 1)\n';
const success = { ok: true, out: 'test_value (generated.Cases.test_value) ... ok', qualityGaps: [] };
const hooks = (overrides: Partial<CandidatePipelineHooks>): CandidatePipelineHooks => ({
    validate: async () => undefined, review: async () => ({ issues: [] }),
    execute: async () => success, revise: async () => initial, event: () => {}, checkCancelled: () => {}, ...overrides
});

test('a direct name failure routes to Writer before a hook can select Bug Fixer, preserving review', async () => {
    const roles: string[] = [], events: any[] = [];
    let hookCalls = 0, reviews = 0;
    const result = await validateTestCandidate(initial, hooks({
        execute: async code => code === initial ? { ok: false, out: failure(trace('NameError: unavailable')), qualityGaps: [] } : success,
        repairRole: () => { hookCalls++; return 'bug-fixer'; },
        revise: async (_, __, role) => { roles.push(role); return 'import datetime\n' + initial; },
        review: async () => { reviews++; return { issues: [] }; },
        event: (stage, status, detail) => events.push({ stage, status, detail })
    }));
    assert.deepEqual(roles, ['writer']); assert.equal(hookCalls, 0); assert.equal(reviews, 1);
    assert.equal(result.reviewStatus, 'completed');
    const routed = events.filter(event => event.stage === 'repair-routing' && event.detail.reasonCode === 'execution-name-binding');
    assert.equal(routed.length, 1);
    assert.deepEqual(Object.keys(routed[0].detail).sort(), ['action', 'attempt', 'exceptionType', 'previousTestHash', 'reasonCode']);
    assert.equal(routed[0].detail.exceptionType, 'NameError');
});

test('a retained name failure is reselected for Writer after revision rejection without bypassing its gate', async () => {
    const roles: string[] = [];
    let scopeChecks = 0, hookCalls = 0;
    const result = await validateTestCandidate(initial, hooks({
        execute: async code => code === initial ? { ok: false, out: failure(trace('NameError: unavailable')), qualityGaps: [] } : success,
        repairRole: () => { hookCalls++; return 'bug-fixer'; },
        revise: async (_, __, role, attempt) => { roles.push(role); return `# attempt ${attempt}\n` + initial; },
        validateRevision: async () => ++scopeChecks === 1 ? { reason: 'Preservation rejected this candidate.', reasonCode: 'assertion-weakened' } : undefined
    }));
    assert.deepEqual(roles, ['writer', 'writer']); assert.equal(scopeChecks, 2); assert.equal(hookCalls, 0);
    assert.equal(result.execution.ok, true);
});

test('ordinary assertion failure still selects Bug Fixer and preserves review and revision checks', async () => {
    const roles: string[] = [];
    let scopeChecks = 0;
    await validateTestCandidate(initial, hooks({
        execute: async code => code === initial ? { ok: false, out: failure(trace('AssertionError: NameError is just text'), 'FAIL'), qualityGaps: [] } : success,
        repairRole: () => 'bug-fixer',
        revise: async (_, __, role) => { roles.push(role); return initial + '# fixed\n'; },
        validateRevision: async () => { scopeChecks++; return undefined; }
    }));
    assert.deepEqual(roles, ['bug-fixer']); assert.equal(scopeChecks, 1);
});

test('name-binding routing is visible in both report languages without rendering arbitrary diagnostic text', () => {
    const marker = 'PRIVATE_EXCEPTION_MESSAGE';
    try {
        for (const language of ['zh-TW', 'en'] as const) {
            setLanguage(language);
            const rendered = formatRepairRouting({ action: 'writer-name-binding', reasonCode: 'execution-name-binding',
                exceptionType: marker, message: marker });
            assert.match(rendered, /Writer/);
            assert.ok(!rendered.includes(marker));
            if (language === 'en') { assert.doesNotMatch(rendered, /[\u3400-\u9fff]/); }
            else { assert.match(rendered, /名稱綁定/); }
        }
    } finally { setLanguage('zh-TW'); }
});
