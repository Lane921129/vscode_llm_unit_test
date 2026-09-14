import * as assert from 'assert';
import { test } from 'node:test';
import { mergeTestSnippets } from '../validation/testMerger';

test('keeps independently validated Tier 2 TestCase setup isolated during merge', () => {
    const first = [
        'import unittest',
        'from sample import target',
        '',
        'class TestTarget(unittest.TestCase):',
        '    def setUp(self):',
        "        self.value = 'first'",
        '',
        '    def test_first(self):',
        "        self.assertEqual(target(self.value), 'first')",
    ].join('\n');
    const second = [
        'import unittest',
        'from unittest.mock import patch',
        'from sample import target',
        '',
        'class TestTarget(unittest.TestCase):',
        '    def setUp(self):',
        "        self.value = 'second'",
        '',
        '    def test_second(self):',
        "        self.assertEqual(target(self.value), 'second')",
    ].join('\n');

    const merged = mergeTestSnippets([first, second], 'TestTargetMerged');

    assert.strictEqual(merged.totalMethodsCount, 2);
    assert.match(merged.mergedCode, /class TestTargetMerged_Site1\(unittest\.TestCase\):/);
    assert.match(merged.mergedCode, /class TestTargetMerged_Site2\(unittest\.TestCase\):/);
    assert.match(merged.mergedCode, /self\.value = 'first'/);
    assert.match(merged.mergedCode, /self\.value = 'second'/);
    assert.match(merged.mergedCode, /from unittest\.mock import patch/);
    assert.doesNotMatch(merged.mergedCode, /class TestTarget\(unittest\.TestCase\):/);
});

test('keeps a structurally valid unittest alias subtask instead of silently dropping it', () => {
    const aliased = [
        'import unittest as ut',
        'from sample import target',
        '',
        'class TestTarget(ut.TestCase):',
        '    def test_alias_style(self):',
        "        self.assertEqual(target('value'), 'value')",
    ].join('\n');

    const directAlias = [
        'from unittest import IsolatedAsyncioTestCase as AsyncCase',
        'from sample import target_async',
        '',
        'class TestAsyncTarget(AsyncCase):',
        '    async def test_direct_alias_style(self):',
        "        self.assertEqual(await target_async('value'), 'value')",
    ].join('\n');
    const merged = mergeTestSnippets([aliased, directAlias], 'TestTargetMerged');

    assert.strictEqual(merged.totalMethodsCount, 2);
    assert.match(merged.mergedCode, /import unittest as ut/);
    assert.match(merged.mergedCode, /class TestTargetMerged_Site1\(ut\.TestCase\):/);
    assert.match(merged.mergedCode, /def test_alias_style/);
    assert.match(merged.mergedCode, /from unittest import IsolatedAsyncioTestCase as AsyncCase/);
    assert.match(merged.mergedCode, /class TestTargetMerged_Site2\(AsyncCase\):/);
    assert.match(merged.mergedCode, /async def test_direct_alias_style/);
});

test('preserves multiline parenthesized imports in merged snippets', () => {
    const snippet = [
        'import unittest',
        'from my_package.calculator import (',
        '    add,',
        '    subtract',
        ')',
        '',
        'class TestCalc(unittest.TestCase):',
        '    def test_add(self):',
        '        self.assertEqual(add(1, 2), 3)',
    ].join('\n');

    const merged = mergeTestSnippets([snippet], 'TestCalcMerged');
    assert.strictEqual(merged.totalMethodsCount, 1);
    assert.match(merged.mergedCode, /from my_package\.calculator import \(\n\s*add,\n\s*subtract\n\)/);
});

