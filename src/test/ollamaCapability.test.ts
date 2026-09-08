import * as assert from 'assert';
import { test } from 'node:test';
import { buildOllamaPlainTestGenerationProbe, buildOllamaStructuredProbe, buildOllamaTestGenerationProbe } from '../llm/ollamaCapability';
import { assessStructuredOutputProbe, assessTestGenerationProbe } from '../llm/testGenerationQualification';
import { assessIsolatedProbeCode, isIsolatedProbeCode, runIsolatedProbe, verifyRunnableTestGenerationProbe } from '../llm/modelProbeExecution';

test('Ollama structured probe is small, deterministic, and domain neutral', () => {
    const request = buildOllamaStructuredProbe('local-model');

    assert.deepStrictEqual(request, {
        model: 'local-model',
        prompt: 'Return exactly one JSON object with a boolean field named "ok" set to true. Do not include any other text.',
        stream: false,
        format: 'json',
        options: { temperature: 0 }
    });
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
    const request = buildOllamaTestGenerationProbe('local-model');
    assert.strictEqual(request.format, 'json');
    assert.ok(request.prompt.includes('def increment(value): return value + 1'));
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
    const request = buildOllamaPlainTestGenerationProbe('local-model');
    assert.strictEqual('format' in request, false);
    assert.ok(request.prompt.startsWith('Return only one complete runnable Python unittest file.'));
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
    assert.deepStrictEqual(
        await verifyRunnableTestGenerationProbe(payload, async isolatedCode => isolatedCode === code),
        { capability: 'verified', reason: '模型已通過 unittest 結構、雙案例行為 assertion 與隔離執行驗證。' }
    );
    assert.strictEqual(
        (await verifyRunnableTestGenerationProbe(payload, async () => false)).capability,
        'unverified'
    );
});
