import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { getLanguage, setLanguage } from '../i18n/core';
import { pythonToolPath } from '../pipeline/pythonTools';
import { resolvePythonExecutable } from '../utils/pythonTestEnvironment';
import { validateUnittestStructure } from '../validation/generatedTestValidator';

function candidate(imports = '', call = '_read()'): string {
    return `import unittest\n${imports}\nclass Cases(unittest.TestCase):\n`
        + `    def test_value(self):\n        self.assertEqual(${call}, 3)\n`;
}

test('missing selected-target imports receive explicit binding guidance without a target-patch alternative', () => {
    const previous = getLanguage();
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            const result = validateUnittestStructure(candidate(), '_read', 'neutral');
            assert.equal(result.valid, false);
            assert.match(result.reason!, /from neutral import _read/);
            assert.match(result.reason!, /不可 patch|never patch/);
            assert.doesNotMatch(result.reason!, /point-of-use patch/);
            if (language === 'en') { assert.doesNotMatch(result.reason!, /[\u3400-\u9fff]/); }
        }
    } finally { setLanguage(previous); }
});

test('missing method bindings retain the owner and never propose importing a same-named module function', () => {
    const previous = getLanguage();
    try {
        for (const language of ['zh-tw', 'en']) {
            setLanguage(language);
            for (const [target, owner] of [['_read', 'Owner'], ['Owner._read', undefined]] as const) {
                const result = validateUnittestStructure(candidate(), target, 'neutral', 'call', [], owner);
                assert.equal(result.valid, false);
                assert.match(result.reason!, /from neutral import Owner/);
                assert.match(result.reason!, /Target binding/);
                assert.match(result.reason!, /同名頂層函式|same-named top-level function/);
                assert.doesNotMatch(result.reason!, /from neutral import _read|point-of-use patch/);
                if (language === 'en') { assert.doesNotMatch(result.reason!, /[\u3400-\u9fff]/); }
            }
        }
    } finally { setLanguage(previous); }
});

test('missing module metadata refers to Target import without inventing an import path', () => {
    const previous = getLanguage();
    try {
        setLanguage('en');
        for (const owner of [undefined, 'Owner']) {
            const result = validateUnittestStructure(candidate(), '_read', undefined, 'call', [], owner);
            assert.equal(result.valid, false);
            assert.match(result.reason!, /Target import/);
            assert.doesNotMatch(result.reason!, /from undefined|from null|from .* import/);
            if (owner) { assert.match(result.reason!, /owner class|Target binding/); }
        }
    } finally { setLanguage(previous); }
});

test('explicit target imports and owner-qualified calls retain their existing structural acceptance', () => {
    for (const [imports, call, owner] of [
        ['from neutral import _read', '_read()', undefined],
        ['from neutral import _read as read_value', 'read_value()', undefined],
        ['from neutral import Owner', 'Owner._read()', 'Owner'],
        ['import neutral as subject', 'subject._read()', undefined]
    ] as const) {
        const result = validateUnittestStructure(candidate(imports, call), '_read', 'neutral', 'call', [], owner);
        assert.equal(result.valid, true, result.reason);
    }
});

test('unimported non-target helpers retain their existing dependency guidance', () => {
    const previous = getLanguage();
    try {
        setLanguage('en');
        const code = candidate('from neutral import target', 'target()')
            .replace('        self.assertEqual', '        _prepare()\n        self.assertEqual');
        const result = validateUnittestStructure(code, 'target', 'neutral');
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'Test calls unimported private helper _prepare; use a module point-of-use patch or explicit import.');
    } finally { setLanguage(previous); }
});

test('Python binding validation still rejects target replacement and class-to-module fallback', () => {
    const python = resolvePythonExecutable(undefined, path.resolve(__dirname, '../..'));
    const cases = [
        {
            code: candidate('from unittest.mock import patch\nfrom neutral import _read')
                .replace('        self.assertEqual(_read(), 3)', "        with patch('neutral._read', return_value=3):\n            self.assertEqual(_read(), 3)"),
            source: 'def _read():\n    return 3\n', className: undefined
        },
        {
            code: candidate('from neutral import _read'),
            source: 'def _read():\n    return 3\nclass Owner:\n    @staticmethod\n    def _read():\n        return 4\n', className: 'Owner'
        }
    ];
    for (const fixture of cases) {
        const structure = validateUnittestStructure(fixture.code, '_read', 'neutral', 'call', [], fixture.className, true);
        assert.equal(structure.valid, true, 'the existing Python binding gate still decides these cases');
        const result = spawnSync(python, ['-B', pythonToolPath('bindings'), '--payload'], {
            encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            input: JSON.stringify({ code: fixture.code, context: { module: 'neutral', target: '_read',
                source: fixture.source, className: fixture.className, dependencies: {}, targetUsage: 'call',
                requireTargetBehavior: structure.requiresTargetBehaviorEvidence,
                requireMockBehavior: structure.requiresMockBehaviorEvidence } })
        });
        assert.equal(result.status, 0, result.stderr);
        const binding = JSON.parse(result.stdout);
        assert.equal(binding.valid, false, 'diagnostic changes never authorize patching or substituting the selected target');
        assert.match(binding.reason, fixture.className
            ? /Import class Owner from neutral; _read is a class member, not a module-level target\./
            : /Do not mock or replace the selected target or its class\./);
    }
});
