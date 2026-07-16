import { t } from './i18n';

export interface FewShotExample {
    label: string;
    sourceCode: string;
    thinking: string;
    testCode: string;
}

/**
 * Foundation Examples (Math, Exception, String) - Fully English
 */
export function getBaseFewShotExamples(): FewShotExample[] {
    return [
        {
            label: 'Arithmetic addition with boundary values',
            sourceCode: `def add(a, b):\n    return a + b`,
            thinking: `The \`add\` function returns the sum of \`a\` and \`b\`.
I need to test:
1. Two positive numbers
2. Two negative numbers
3. A positive and a negative number
4. Zeros

I will use \`self.assertEqual(add(x, y), expected)\` for these cases.`,
            testCode: `import unittest
from module_name import add

class TestAdd(unittest.TestCase):
    def test_add_positive_numbers(self):
        self.assertEqual(add(2, 3), 5)
        
    def test_add_negative_numbers(self):
        self.assertEqual(add(-1, -5), -6)
        
    def test_add_mixed_numbers(self):
        self.assertEqual(add(10, -3), 7)
        
    def test_add_zeros(self):
        self.assertEqual(add(0, 0), 0)

if __name__ == '__main__':
    unittest.main()`
        },
        {
            label: 'Division with Exception Handling',
            sourceCode: `def divide(a, b):\n    if b == 0:\n        raise ValueError("Cannot divide by zero")\n    return a / b`,
            thinking: `The \`divide\` function returns the quotient of \`a\` divided by \`b\`.
It raises a \`ValueError\` if \`b\` is 0.

I need to test:
1. Normal division (float result)
2. Division of negative numbers
3. Division by zero exception

I will use \`self.assertAlmostEqual\` for float division, and \`self.assertRaises\` for the exception.`,
            testCode: `import unittest
from module_name import divide

class TestDivide(unittest.TestCase):
    def test_divide_normal(self):
        self.assertAlmostEqual(divide(10, 2), 5.0)
        
    def test_divide_negative(self):
        self.assertAlmostEqual(divide(-9, 3), -3.0)
        
    def test_divide_by_zero(self):
        with self.assertRaises(ValueError):
            divide(1, 0)

if __name__ == '__main__':
    unittest.main()`
        },
        {
            label: 'String processing (Boolean returns)',
            sourceCode: `def is_palindrome(s):\n    if not s:\n        return False\n    return s == s[::-1]`,
            thinking: `The \`is_palindrome\` function checks if a string reads the same forwards and backwards.
It explicitly returns False for empty strings.

I need to test:
1. A valid palindrome (even and odd length)
2. A non-palindrome
3. An empty string
4. A single character (which is a palindrome)

I will use \`self.assertTrue\` and \`self.assertFalse\`.`,
            testCode: `import unittest
from module_name import is_palindrome

class TestIsPalindrome(unittest.TestCase):
    def test_valid_palindromes(self):
        self.assertTrue(is_palindrome("racecar"))
        self.assertTrue(is_palindrome("abba"))
        self.assertTrue(is_palindrome("a"))
        
    def test_invalid_palindrome(self):
        self.assertFalse(is_palindrome("hello"))
        
    def test_empty_string(self):
        self.assertFalse(is_palindrome(""))

if __name__ == '__main__':
    unittest.main()`
        }
    ];
}

/**
 * Dynamic Examples based on AST features
 */
export function getDynamicFewShotExamples(astContext: any, sourceCode: string): FewShotExample[] {
    const examples: FewShotExample[] = [];
    
    // Feature 1: Branches (if/elif/else)
    if (sourceCode.includes('if ') || sourceCode.includes('elif ') || sourceCode.includes('else:')) {
        examples.push({
            label: 'Branch Coverage (if/else)',
            sourceCode: `def get_discount(price):\n    if price >= 100:\n        return price * 0.9\n    return price`,
            thinking: `The \`get_discount\` function contains an \`if\` branch.
I need to test:
1. The \`if\` branch condition is met (price >= 100) -> e.g., price=100 (boundary) and price=150
2. The \`if\` branch condition is not met (price < 100) -> e.g., price=99 (boundary) and price=50`,
            testCode: `import unittest
from module_name import get_discount

class TestGetDiscount(unittest.TestCase):
    def test_discount_applied(self):
        self.assertEqual(get_discount(100), 90.0)
        self.assertEqual(get_discount(150), 135.0)
        
    def test_no_discount(self):
        self.assertEqual(get_discount(99), 99)
        self.assertEqual(get_discount(50), 50)

if __name__ == '__main__':
    unittest.main()`
        });
    }

    // Feature 2: Loops (for/while)
    if (sourceCode.includes('for ') || sourceCode.includes('while ')) {
        examples.push({
            label: 'Loop Boundary Conditions',
            sourceCode: `def sum_list(numbers):\n    total = 0\n    for n in numbers:\n        total += n\n    return total`,
            thinking: `The \`sum_list\` function contains a \`for\` loop iterating over \`numbers\`.
I need to test:
1. Zero iterations (empty list)
2. One iteration (single element)
3. Multiple iterations (multiple elements)`,
            testCode: `import unittest
from module_name import sum_list

class TestSumList(unittest.TestCase):
    def test_empty_list(self):
        self.assertEqual(sum_list([]), 0)
        
    def test_single_element(self):
        self.assertEqual(sum_list([5]), 5)
        
    def test_multiple_elements(self):
        self.assertEqual(sum_list([1, 2, 3]), 6)

if __name__ == '__main__':
    unittest.main()`
        });
    }

    return examples;
}

/**
 * Mutation Operator Hints
 */
export function getMutationOperatorHints(survivedMutants: string): string {
    const hints: string[] = [];
    
    if (survivedMutants.includes('<class \'ast.Add\'> to <class \'ast.Sub\'>') || survivedMutants.includes('Add to Sub')) {
        hints.push(`- Operator \`+\` changed to \`-\`: Ensure your tests fail if addition becomes subtraction. (e.g. testing \`add(0,0)\` is BAD because 0+0 = 0-0=0, so the mutant survives. Use \`add(3,5)\` instead because 3+5=8 but 3-5=-2).`);
    }
    
    if (survivedMutants.includes('<class \'ast.LtE\'> to <class \'ast.Lt\'>') || survivedMutants.includes('LtE to Lt')) {
        hints.push(`- Operator \`<=\` changed to \`<\`: You MUST test the exact boundary value. (e.g. if the code is \`x <= 10\`, you must write a test case where \`x = 10\`. If you only test \`x = 5\`, the mutant \`x < 10\` will survive because 5 < 10 is also true).`);
    }

    if (survivedMutants.includes('If_Statement to If_False')) {
        hints.push(`- \`If_Statement to If_False\`: The mutation engine removed the \`if\` condition entirely (making it always False). You MUST write a test case that specifically targets the code inside the \`if\` block to ensure it executes.`);
    }
    
    if (hints.length > 0) {
        return `\n【Mutation Operator Killing Strategy】\n` + hints.join('\n');
    }
    return '';
}

/**
 * Formats Few-Shot examples into strict Input/Output markers
 */
export function formatFewShotForPrompt(examples: FewShotExample[]): string {
    return examples.map((ex, i) => {
        return `==== 【Example ${i + 1}: ${ex.label}】 ====

[Simulated System Input (User Prompt)]
【Target File】: example_${i + 1}.py
【Target Scope】: function \`example_func\`
【Original Source Code】:
\`\`\`python
${ex.sourceCode}
\`\`\`

Now, based on the above information, you MUST immediately generate the test suite following the strict output format rules.

[Expected AI Response]
(You MUST start your output directly with <thinking> and do NOT output any other headings!)
<thinking>
${ex.thinking}
</thinking>

\`\`\`python
${ex.testCode}
\`\`\``;
    }).join('\n\n\n');
}
