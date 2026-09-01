import * as assert from 'assert';
import { test } from 'node:test';
import * as path from 'path';
import { formatPythonImport, inferTargetImportModule, resolvePythonDependencyPath } from '../dependencyResolver';

test('resolves an absolute Python import from the project root', () => {
    const resolved = resolvePythonDependencyPath(
        path.join('workspace', 'package', 'consumer.py'),
        'workspace',
        { module: 'package.helpers', name: 'normalize' }
    );
    assert.strictEqual(resolved, path.join('workspace', 'package', 'helpers.py'));
});

test('resolves relative imports from the importing file and preserves their display form', () => {
    const target = path.join('workspace', 'package', 'feature', 'consumer.py');
    assert.strictEqual(
        resolvePythonDependencyPath(target, 'workspace', { module: 'helpers', name: 'normalize', level: 1 }),
        path.join('workspace', 'package', 'feature', 'helpers.py')
    );
    assert.strictEqual(
        resolvePythonDependencyPath(target, 'workspace', { module: 'shared', name: 'validate', level: 2 }),
        path.join('workspace', 'package', 'shared.py')
    );
    assert.strictEqual(
        resolvePythonDependencyPath(target, 'workspace', { module: '', name: 'sibling', level: 1 }),
        path.join('workspace', 'package', 'feature', 'sibling.py')
    );
    assert.strictEqual(formatPythonImport({ module: 'helpers', name: 'normalize', level: 1 }), '.helpers');
    assert.strictEqual(formatPythonImport({ module: 'shared', name: 'validate', level: 2 }), '..shared');
});

test('infers the canonical target import path from package-aware imports', () => {
    assert.strictEqual(
        inferTargetImportModule(path.join('workspace', 'src', 'service.py'), [
            { module: 'src.helpers' }
        ]),
        'src.service'
    );
    assert.strictEqual(
        inferTargetImportModule(path.join('workspace', 'package', 'service.py'), [
            { module: 'helpers', level: 1 }
        ]),
        'package.service'
    );
    assert.strictEqual(inferTargetImportModule(path.join('workspace', 'single.py')), 'single');
});
