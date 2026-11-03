import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { relevantSourceImports } from '../prompts/dependencyMockContract';

test('source import projection matches Python normalized aliases including combining identifier marks', () => {
    const imports = [{ kind: 'import', module: 'math', alias: 'K', bound_name: 'K' },
        { kind: 'from', module: 'decimal', name: 'Decimal' }];
    for (const code of ['def target():\n    return K.inf\n', 'def target():\n    return K.inf\n']) {
        assert.deepEqual(relevantSourceImports({ code, file_imports: imports }), [imports[0]]);
    }
    const unicodeImport = [{ kind: 'import', module: 'math', alias: 'K' }];
    assert.deepEqual(relevantSourceImports({ code: 'def target(): return K.inf', file_imports: unicodeImport }), unicodeImport);
    for (const [sourceBinding, astBinding] of [['e\u0301', 'é'], ['a\u0301\u0327', 'á\u0327']]) {
        const combiningImports = [{ kind: 'import', module: 'math', alias: astBinding }, imports[1]];
        assert.deepEqual(relevantSourceImports({ code: `def target(): return ${sourceBinding}.inf`, file_imports: combiningImports }),
            [combiningImports[0]]);
    }
});

test('Chinese comments and docstrings do not disable known import projection or rewrite source facts', () => {
    const imports = [{ kind: 'import', module: 'math' }, { kind: 'import', module: 'unused' }];
    const context = { code: 'def target():\n    """取得無限大"""\n    # 保留真正使用的模組\n    return math.inf\n', file_imports: imports };
    const before = JSON.stringify(context);
    assert.deepEqual(relevantSourceImports(context), [imports[0]]);
    assert.equal(JSON.stringify(context), before);
});

test('computed namespace names and aliased namespace tools disable optional import filtering', () => {
    const imports = [{ kind: 'from', module: 'math', name: 'inf' }, { kind: 'import', module: 'unused' }];
    for (const expression of ['globals()["i" + "nf"]', 'locals()["i" + "nf"]', 'vars()["i" + "nf"]',
        'eval("i" + "nf")', 'exec("i" + "nf")', 'getattr(namespace, "i" + "nf")',
        'namespace.__dict__["i" + "nf"]', '__builtins__["globals"]()["i" + "nf"]']) {
        assert.equal(relevantSourceImports({ code: `def target(): return ${expression}`, file_imports: imports }), imports);
    }
    const aliased = [...imports, { kind: 'from', module: 'builtins', name: 'globals', alias: 'lookup' }];
    assert.equal(relevantSourceImports({ code: 'def target(): return lookup()["i" + "nf"]', file_imports: aliased }), aliased);
    for (const setup of [{ referenced_globals: [{ name: 'lookup', code: 'lookup = globals' }] },
        { class_context: { init: { code: 'self.values = vars()' } } }]) {
        assert.equal(relevantSourceImports({ code: 'def target(): return lookup()', file_imports: imports, ...setup }), imports);
    }
});

test('known ASCII source bindings still omit unrelated imports without mutating source facts', () => {
    const imports = [{ kind: 'import', module: 'math', alias: 'arithmetic' }, { kind: 'import', module: 'unused' },
        { kind: 'from', module: 'unknown_exports', name: '*' }, { kind: 'import' }];
    const context = { code: 'def target(): return arithmetic.inf', file_imports: imports };
    const before = JSON.stringify(context);
    assert.deepEqual(relevantSourceImports(context), [imports[0], imports[2], imports[3]]);
    assert.equal(JSON.stringify(context), before);
});
