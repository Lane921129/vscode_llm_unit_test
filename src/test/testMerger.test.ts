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
