import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { test } from 'node:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectMutationEngineForPlatform, extractFunctionsWithAst } from '../utils';

test('uses mutatest for Python 3.11 and earlier', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.11.9', 'win32'), 'mutatest');
    assert.strictEqual(detectMutationEngineForPlatform('3.10.14', 'linux'), 'mutatest');
});

test('uses mutmut for Python 3.12+ on non-Windows platforms', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.13.2', 'linux'), 'mutmut');
});

test('reports no native engine for Python 3.12+ on Windows', () => {
    assert.strictEqual(detectMutationEngineForPlatform('3.13.2', 'win32'), null);
});

test('lists only independently selectable module functions and direct class methods', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'llm-unit-function-list-'));
    try {
        const sourcePath = join(directory, 'sample.py');
        writeFileSync(sourcePath, [
            'def module_target(value):',
            '    def local_helper():',
            '        return value',
            '    return local_helper()',
            '',
            'class Service:',
            '    def process(self, value):',
            '        async def deferred():',
            '            return value',
            '        return value',
            '',
            '    class Internal:',
            '        def hidden(self):',
            '            return 1',
        ].join('\n'), 'utf8');

        const functions = await extractFunctionsWithAst(sourcePath);
        assert.deepStrictEqual(functions.map(item => item.fullName), ['module_target', 'Service.process']);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
