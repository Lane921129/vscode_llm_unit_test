import * as assert from 'assert';
import { test } from 'node:test';
import { buildOllamaPlainTestGenerationProbe, buildOllamaStructuredProbe, buildOllamaTestGenerationProbe, buildOllamaRoleQualificationProbe } from '../llm/ollamaCapability';
import { assessStructuredOutputProbe, assessTestGenerationProbe } from '../llm/testGenerationQualification';
import { assessIsolatedProbeCode, isIsolatedProbeCode, runIsolatedProbe, verifyRunnableTestGenerationProbe } from '../llm/modelProbeExecution';

test('Ollama structured probe is small, deterministic, and domain neutral', () => {
    const request = buildOllamaStructuredProbe('local-model', 8192);

    assert.deepStrictEqual(request, {
        model: 'local-model',
        system: ' ',
        prompt: '\nReturn exactly one JSON object with a boolean field named "ok" set to true. Do not include any other text.',
        stream: false,
        format: 'json',
        options: { temperature: 0, num_ctx: 8192 }
    });
});

test('every local probe carries the same explicit context and complete prompt envelope', () => {
    for (const numCtx of [5000, 8192]) {
        const probes = [buildOllamaStructuredProbe('neutral-model', numCtx),
            buildOllamaTestGenerationProbe('neutral-model', numCtx), buildOllamaPlainTestGenerationProbe('neutral-model', numCtx),
            buildOllamaRoleQualificationProbe('neutral-model', 'Complete reviewer role instructions.', 'json', numCtx),
            buildOllamaRoleQualificationProbe('neutral-model', 'Complete repair role instructions.', 'text', numCtx)];
        for (const request of probes) {
            assert.deepStrictEqual(request.options, { temperature: 0, num_ctx: numCtx });
            assert.equal(request.system, ' ');
            assert.ok(request.prompt.startsWith('\n'));
            assert.equal('raw' in request, false);
            assert.equal('template' in request, false);
        }
        assert.equal(probes[3].prompt, '\nComplete reviewer role instructions.');
        assert.equal(probes[4].prompt, '\nComplete repair role instructions.');
    }
});

test('probe builders reject invalid context instead of falling back to the server default', () => {
    for (const numCtx of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => buildOllamaPlainTestGenerationProbe('neutral-model', numCtx), /invalid-runtime-context/);
        assert.throws(() => buildOllamaRoleQualificationProbe('neutral-model', 'role', 'text', numCtx), /invalid-runtime-context/);
    }
});

test('shared structured qualification accepts the expected JSON object only', () => {
    assert.deepStrictEqual(
        assessStructuredOutputProbe({ response: '{"ok":true}' }),
        { capability: 'verified', reason: '模型已通過結構化 JSON 輸出驗證。' }
    );
    assert.strictEqual(assessStructuredOutputProbe({ response: '{}' }).capability, 'unverified');
    assert.strictEqual(assessStructuredOutputProbe({ response: '{' }).capability, 'unverified');
    assert.strictEqual(assessStructuredOutputProbe({ response: '' }).capability, 'unverified');
});

test('shared test-generation qualification requires a complete unittest structure, not merely JSON', () => {
    const request = buildOllamaTestGenerationProbe('local-model', 8192);
    assert.strictEqual(request.format, 'json');
    assert.ok(request.prompt.includes('safe runtime already provides increment(value)'));
    assert.ok(request.prompt.includes('do not define or import increment'));
    assert.ok(request.prompt.includes('self.assertEqual(increment(1), 2)'));
    assert.ok(request.prompt.includes('self.assertEqual(increment(-1), 0)'));
    assert.strictEqual(assessTestGenerationProbe({ response: '{"code":"string"}' }).capability, 'unverified');
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: [
                    'import unittest',
                    '',
                    'def increment(value):',
                    '    return value + 1',
                    '',
                    'class TestIncrement(unittest.TestCase):',
                    '    def test_increment(self):',
                    '        self.assertEqual(increment(1), 2)',
                    '        self.assertEqual(increment(-1), 0)',
                    ''
                ].join('\n')
            })
        }).capability,
        'verified'
    );
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: [
                    'import unittest',
                    '',
                    'class TestIncrement(unittest.TestCase):',
                    '    def test_increment(self):',
                    '        self.assertEqual(increment(1), 2)',
                    '        self.assertEqual(increment(-1), 0)',
                    ''
                ].join('\n')
            })
        }).capability,
        'verified'
    );
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: 'import unittest\n\nclass TestIncrement(unittest.TestCase):\n    def test_increment(self):\n        self.assertEqual(2, 2)\n'
            })
        }).capability,
        'unverified'
    );
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: [
                    'import unittest',
                    '',
                    'def increment(value):',
                    '    return value + 1',
                    '',
                    'class TestIncrement(unittest.TestCase):',
                    '    def test_increment(self):',
                    '        self.assertEqual(increment(1), 2)',
                    ''
                ].join('\n')
            })
        }).capability,
        'unverified'
    );
    assert.strictEqual(
        assessTestGenerationProbe({
            response: JSON.stringify({
                code: [
                    'import unittest',
                    '',
                    'def increment(value):',
                    '    return value + 1',
                    '',
                    'class TestIncrement(unittest.TestCase):',
                    '    def test_increment(self):',
                    '        self.assertTrue(increment(1))',
                    ''
                ].join('\n')
            })
        }).capability,
        'unverified'
    );
});

test('plain Ollama probe does not require JSON mode and shared qualification accepts fenced Python', () => {
    const request = buildOllamaPlainTestGenerationProbe('local-model', 8192);
    assert.strictEqual('format' in request, false);
    assert.ok(request.prompt.startsWith('\nReturn only one complete runnable Python unittest file.'));
    assert.ok(request.prompt.includes('safe runtime already provides increment(value)'));
    assert.ok(request.prompt.includes('self.assertEqual(increment(1), 2)'));
    assert.ok(request.prompt.includes('self.assertEqual(increment(-1), 0)'));
    assert.strictEqual(assessTestGenerationProbe({
        response: [
            '```python',
            'import unittest',
            '',
            'def increment(value):',
            '    return value + 1',
            '',
            'class TestIncrement(unittest.TestCase):',
            '    def test_increment(self):',
            '        self.assertEqual(increment(1), 2)',
            '        self.assertEqual(increment(-1), 0)',
            '```'
        ].join('\n')
    }).capability, 'verified');
});

test('shared qualification extracts a valid unittest fence surrounded by provider prose', () => {
    const code = [
        'import unittest',
        '',
        'def increment(value):',
        '    return value + 1',
        '',
        'class TestIncrement(unittest.TestCase):',
        '    def test_increment(self):',
        '        self.assertEqual(increment(1), 2)',
        '        self.assertEqual(increment(-1), 0)',
    ].join('\n');

    assert.strictEqual(assessTestGenerationProbe({
        response: `Here is the requested test file:\n\`\`\`python\n${code}\n\`\`\``
    }).capability, 'verified');
});

test('shared runnable qualification requires the safe fixture and an isolated execution pass', async () => {
    const code = [
        'import unittest',
        '',
        'def increment(value):',
        '    return value + 1',
        '',
        'class TestIncrement(unittest.TestCase):',
        '    def test_increment(self):',
        '        self.assertEqual(increment(1), 2)',
        '        self.assertEqual(increment(-1), 0)',
    ].join('\n');
    const payload = { response: JSON.stringify({ code }) };

    assert.strictEqual(isIsolatedProbeCode(code), true);
    assert.strictEqual(isIsolatedProbeCode(code + '\n# A harmless generated comment\nunittest.main(verbosity=2)'), true);
    assert.strictEqual(isIsolatedProbeCode(code + '\nopen("unsafe", "w")'), false);
    assert.match(
        assessIsolatedProbeCode(code + '\nopen("unsafe", "w")').reason || '',
        /1 行最小安全 fixture 不允許的語句/
    );
    assert.strictEqual(await runIsolatedProbe(code), true);
    const testOnlyCode = [
        'import unittest',
        '',
        'class TestIncrement(unittest.TestCase):',
        '    def test_increment(self):',
        '        self.assertEqual(increment(1), 2)',
        '        self.assertEqual(increment(-1), 0)',
    ].join('\n');
    assert.strictEqual(await runIsolatedProbe(testOnlyCode), true);
    assert.strictEqual(await runIsolatedProbe(code, 3000, '__missing_project_probe_python__'), false);
    assert.deepStrictEqual(
        await verifyRunnableTestGenerationProbe(payload, async isolatedCode => isolatedCode === code),
        {
            capability: 'verified',
            reason: '模型已通過 unittest 結構、雙案例行為 assertion 與隔離執行驗證。',
            responsePreview: JSON.stringify({ code })
        }
    );
    assert.strictEqual(
        (await verifyRunnableTestGenerationProbe(payload, async () => false)).capability,
        'unverified'
    );
});

test('failed isolated qualification retains the fixed-fixture reply for local diagnostics', async () => {
    const code = [
        'import unittest',
        'def increment(value): return value + 1',
        'class TestIncrement(unittest.TestCase):',
        '    def test_increment(self):',
        '        self.assertEqual(increment(1), 2)',
        '        self.assertEqual(increment(-1), 0)',
        'open("unsafe", "w")',
    ].join('\n');
    const result = await verifyRunnableTestGenerationProbe({ response: JSON.stringify({ code }) });

    assert.strictEqual(result.capability, 'unverified');
    assert.match(result.responsePreview || '', /open/);
});

test('runnable qualification accepts safe conventional unittest aliases and result variables', async () => {
    const code = [
        'from unittest import TestCase as Case',
        '',
        'class TestIncrement(Case):',
        '    def test_positive(self) -> None:',
        '        actual = increment(1)',
        '        expected = 2',
        "        self.assertEqual(actual, expected, 'positive input')",
        '',
        '    def test_negative(self) -> None:',
        '        actual = increment(-1)',
        '        expected = 0',
        "        self.assertEqual(actual, expected, 'negative input')",
    ].join('\n');
    const payload = { response: code };

    assert.strictEqual(assessTestGenerationProbe(payload).capability, 'verified');
    assert.strictEqual(isIsolatedProbeCode(code), true);
    assert.strictEqual(await runIsolatedProbe(code), true);
    assert.strictEqual(
        (await verifyRunnableTestGenerationProbe(payload, async isolatedCode => isolatedCode === code)).capability,
        'verified'
    );
    assert.strictEqual(isIsolatedProbeCode(code + '\nopen("unsafe", "w")'), false);
});

function probeWithBody(lines: string[]): string {
    return ['import unittest as unit', '', 'class TestIncrement(unit.TestCase):',
        '    def test_observed(self):', ...lines.map(line => `        ${line}`)].join('\n');
}

test('qualification links each result to a fixed expected scalar in either assertion order', async () => {
    for (const body of [
        ['self.assertEqual(increment(1), 2)', 'self.assertEqual(0, increment(-1))'],
        ['self.assertEqual(2, increment(1))', 'self.assertEqual(increment(-1), 0)'],
        ['actual = increment(1)', 'expected = 2', 'self.assertEqual(expected, actual)',
            'actual = increment(-1)', 'expected = 0', 'self.assertEqual(actual, expected)'],
        ['actual = 2', 'actual = increment(1)', 'self.assertEqual(actual, 2)',
            'actual = 0', 'actual = increment(-1)', 'self.assertEqual(0, actual)'],
    ]) {
        const code = probeWithBody(body);
        assert.strictEqual((await verifyRunnableTestGenerationProbe({ response: code })).capability, 'verified', code);
    }
    const trailingWhitespace = probeWithBody(['self.assertEqual(increment(1), 2)',
        'self.assertEqual(increment(-1), 0)']).replace('def test_observed(self):', 'def test_observed(self):  ');
    assert.strictEqual((await verifyRunnableTestGenerationProbe({ response: trailingWhitespace })).capability, 'verified');
});

test('qualification rejects unused target calls and constant-only assertions before execution', async () => {
    const code = probeWithBody(['unused = increment(1)', 'unused_negative = increment(-1)',
        'self.assertEqual(2, 2)', 'self.assertEqual(0, 0)']);
    let executed = false;
    const result = await verifyRunnableTestGenerationProbe({ response: code }, async () => {
        executed = true;
        return true;
    });
    assert.strictEqual(result.capability, 'unverified');
    assert.strictEqual(executed, false);
});

test('qualification rejects target-self comparisons and result variables reused as expected values', () => {
    for (const body of [
        ['self.assertEqual(increment(1), increment(1))', 'self.assertEqual(increment(-1), increment(-1))'],
        ['actual = increment(1)', 'self.assertEqual(actual, actual)',
            'actual = increment(-1)', 'self.assertEqual(actual, actual)'],
        ['actual = increment(1)', 'expected = increment(1)', 'self.assertEqual(actual, expected)',
            'actual = increment(-1)', 'expected = increment(-1)', 'self.assertEqual(expected, actual)'],
    ]) {
        assert.strictEqual(assessTestGenerationProbe({ response: probeWithBody(body) }).capability, 'unverified');
    }
});

test('qualification invalidates result provenance when a variable is rebound to a constant', () => {
    for (const assertion of ['self.assertEqual(actual, 2)', 'self.assertEqual(2, actual)']) {
        const code = probeWithBody(['actual = increment(1)', 'actual = 2', assertion,
            'self.assertEqual(increment(-1), 0)']);
        assert.strictEqual(assessTestGenerationProbe({ response: code }).capability, 'unverified');
    }
    const code = probeWithBody(['actual = increment(1)', 'expected = 2', 'expected = increment(1)',
        'self.assertEqual(actual, expected)', 'self.assertEqual(increment(-1), 0)']);
    assert.strictEqual(assessTestGenerationProbe({ response: code }).capability, 'unverified');
});

test('qualification does not carry local result provenance across test methods', () => {
    const code = ['import unittest', 'class TestIncrement(unittest.TestCase):',
        '    def test_positive(self):', '        actual = increment(1)',
        '    def test_negative(self):', '        self.assertEqual(actual, 2)',
        '        self.assertEqual(increment(-1), 0)'].join('\n');
    assert.strictEqual(assessTestGenerationProbe({ response: code }).capability, 'unverified');
});

test('qualification rejects assertions in a nested TestCase that unittest never discovers', async () => {
    const code = ['import unittest', 'class TestOuter(unittest.TestCase):',
        '    def test_outer(self):', '        class TestInner(unittest.TestCase):',
        '            def test_inner(self):', '                self.assertEqual(increment(1), 2)',
        '                self.assertEqual(increment(-1), 0)'].join('\n');
    // Python really runs the empty outer test successfully; that is not evidence
    // that either assertion inside the merely defined inner class was executed.
    assert.strictEqual(await runIsolatedProbe(code), true);
    assert.strictEqual(assessIsolatedProbeCode(code).valid, false);
    assert.strictEqual((await verifyRunnableTestGenerationProbe({ response: code })).capability, 'unverified');
});

test('qualification rejects overwritten classes and methods instead of counting their dead assertions', async () => {
    const original = probeWithBody(['self.assertEqual(increment(1), 2)', 'self.assertEqual(increment(-1), 0)']);
    const overwritten = [
        original + '\n    def test_observed(self):\n        self.assertEqual(2, 2)\n',
        original + '\nclass TestIncrement(unit.TestCase):\n    def test_replacement(self):\n        self.assertEqual(2, 2)\n',
    ];
    for (const code of overwritten) {
        assert.strictEqual(await runIsolatedProbe(code), true, 'the replacement alone passes Python unittest');
        assert.strictEqual(assessIsolatedProbeCode(code).valid, false);
        assert.strictEqual((await verifyRunnableTestGenerationProbe({ response: code })).capability, 'unverified');
    }
});

test('qualification rejects nested functions and conditional assertions outside direct test execution', () => {
    for (const body of [
        ['def test_inner(self):', '    self.assertEqual(increment(1), 2)', '    self.assertEqual(increment(-1), 0)'],
        ["if __name__ == '__main__':", '    self.assertEqual(increment(1), 2)', '    self.assertEqual(increment(-1), 0)'],
    ]) {
        assert.strictEqual(isIsolatedProbeCode(probeWithBody(body)), false);
    }
});

test('isolated qualification runner never certifies a module containing zero discovered tests', async () => {
    assert.strictEqual(await runIsolatedProbe('import unittest\n'), false);
});
