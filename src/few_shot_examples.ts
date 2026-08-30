/**
 * Domain-neutral few-shot examples used only to demonstrate output format.
 * Business-specific examples must not be added here: specialization belongs in
 * the skill-card pipeline selected from the target source code.
 */
export interface FewShotExample {
    label: string;
    sourceCode: string;
    thinking: string;
    testCode: string;
}

export function getBaseFewShotExamples(): FewShotExample[] {
    return [
        {
            label: 'Arithmetic return value',
            sourceCode: 'def add(left, right):\n    return left + right',
            thinking: 'Cover representative positive and negative operands. Assert the observable return value.',
            testCode: `import unittest
from target_module import add

class TestAdd(unittest.TestCase):
    def test_adds_values(self):
        self.assertEqual(add(2, 3), 5)
        self.assertEqual(add(-2, 3), 1)
`,
        },
        {
            label: 'Exception behaviour',
            sourceCode: 'def divide(numerator, denominator):\n    if denominator == 0:\n        raise ValueError("denominator must not be zero")\n    return numerator / denominator',
            thinking: 'Cover the normal path and the explicit exceptional boundary. Assert the declared exception type.',
            testCode: `import unittest
from target_module import divide

class TestDivide(unittest.TestCase):
    def test_divides_values(self):
        self.assertEqual(divide(8, 2), 4)

    def test_rejects_zero_denominator(self):
        with self.assertRaises(ValueError):
            divide(1, 0)
`,
        },
        {
            label: 'Boolean branch',
            sourceCode: 'def is_palindrome(text):\n    normalized = text.lower()\n    return normalized == normalized[::-1]',
            thinking: 'Exercise both boolean outcomes and a normalization branch without relying on implementation-only details.',
            testCode: `import unittest
from target_module import is_palindrome

class TestIsPalindrome(unittest.TestCase):
    def test_returns_true_for_normalized_palindrome(self):
        self.assertTrue(is_palindrome("Level"))

    def test_returns_false_for_non_palindrome(self):
        self.assertFalse(is_palindrome("python"))
`,
        },
    ];
}

export function getDynamicFewShotExamples(astContext: any, sourceCode: string): FewShotExample[] {
    const examples: FewShotExample[] = [];

    if (/\bif\b/.test(sourceCode)) {
        examples.push({
            label: 'Conditional boundary',
            sourceCode: 'def get_discount(amount):\n    return 0.1 if amount >= 100 else 0',
            thinking: 'Test both sides of the comparison, including the exact boundary value.',
            testCode: `import unittest
from target_module import get_discount

class TestGetDiscount(unittest.TestCase):
    def test_boundary_and_lower_value(self):
        self.assertEqual(get_discount(100), 0.1)
        self.assertEqual(get_discount(99), 0)
`,
        });
    }

    if (/\bfor\b|\bwhile\b/.test(sourceCode)) {
        examples.push({
            label: 'Collection iteration',
            sourceCode: 'def sum_list(values):\n    total = 0\n    for value in values:\n        total += value\n    return total',
            thinking: 'Cover an empty collection and multiple elements to expose loop and accumulator mutations.',
            testCode: `import unittest
from target_module import sum_list

class TestSumList(unittest.TestCase):
    def test_empty_and_multiple_values(self):
        self.assertEqual(sum_list([]), 0)
        self.assertEqual(sum_list([1, 2, 3]), 6)
`,
        });
    }

    return examples;
}

export function getMutationOperatorHints(survivedMutants: string): string {
    const hints: string[] = [];
    if (/ast\.(Add|Sub|Mult|Div)/.test(survivedMutants)) {
        hints.push('Arithmetic mutations survived: use inputs whose exact numeric result distinguishes the operator.');
    }
    if (/ast\.(Lt|LtE|Gt|GtE|Eq|NotEq)/.test(survivedMutants)) {
        hints.push('Comparison mutations survived: cover the exact boundary and values immediately on each side.');
    }
    if (/If_(true|false)|ast\.If/.test(survivedMutants)) {
        hints.push('Conditional mutations survived: add assertions for both observable branches.');
    }
    return hints.join('\n');
}

export function formatFewShotForPrompt(examples: FewShotExample[], useThinking = true): string {
    return examples.map((example, index) => {
        const thinkingBlock = useThinking
            ? `(Start directly with <thinking>; do not add other headings.)\n<thinking>\n${example.thinking}\n</thinking>\n\n`
            : '(Analyze boundary conditions, then write test code directly.)\n';
        return `==== Example ${index + 1}: ${example.label} ====\n${thinkingBlock}Source:\n${example.sourceCode}\n\nTest:\n${example.testCode}`;
    }).join('\n\n\n');
}
