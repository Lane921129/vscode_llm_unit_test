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
        },
        {
            label: 'String Slicing, Dictionary Return & Direct Exception',
            sourceCode: `def validate_and_format_token(token, provider):\n    if len(token) < 10:\n        raise ValueError("Invalid token length")\n    if provider == 'jwt':\n        return {'valid': True, 'type': 'user', 'claims': token[:5]}\n    elif provider == 'payment_gateway':\n        return {'valid': True, 'type': 'finance', 'partner': token[-5:]}\n    return {'valid': False, 'reason': 'Unknown provider'}`,
            thinking: `The \`validate_and_format_token\` function validates token length and returns structured dicts with slices:
1. If token length < 10, raises ValueError("Invalid token length").
2. If provider == 'jwt', returns dict where 'claims' is token[:5] (FIRST 5 chars: '123456789012'[:5] == '12345').
3. If provider == 'payment_gateway', returns dict where 'partner' is token[-5:] (LAST 5 chars: '123456789012'[-5:] == '89012').
4. If provider is unknown, returns dict {'valid': False, 'reason': 'Unknown provider'}.`,
            testCode: `import unittest
from core_utils import validate_and_format_token

class TestValidateAndFormatToken(unittest.TestCase):
    def test_short_token_raises_value_error(self):
        with self.assertRaises(ValueError):
            validate_and_format_token("abc123", provider="jwt")
            
    def test_valid_jwt_token_slice(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="jwt")
        self.assertEqual(result, {"valid": True, "type": "user", "claims": "12345"})
        
    def test_valid_payment_gateway_token_slice(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="payment_gateway")
        self.assertEqual(result, {"valid": True, "type": "finance", "partner": "89012"})
        
    def test_unknown_provider(self):
        token = "123456789012"
        result = validate_and_format_token(token, provider="other")
        self.assertEqual(result, {"valid": False, "reason": "Unknown provider"})

if __name__ == '__main__':
    unittest.main()`
        },
        {
            label: 'Caller with Internal Exception Catching (String Return)',
            sourceCode: `def login_user(user_input_token):\n    try:\n        token_info = validate_and_format_token(user_input_token, provider='jwt')\n        if token_info.get('valid') and token_info.get('type') == 'user':\n            return f"Welcome User (ID: {token_info.get('claims')})"\n        return "Login Failed: Invalid Token"\n    except ValueError as e:\n        return "Login Failed: Token too short"`,
            thinking: `The \`login_user\` function catches ValueError internally using try...except and returns error strings.
CRITICAL: Because it catches exceptions internally, it NEVER raises ValueError to the caller!
I must use self.assertEqual with the exact return strings:
1. Valid 10+ char token -> "Welcome User (ID: 12345)"
2. Short token (< 10 chars) -> "Login Failed: Token too short" (Use assertEqual, NOT assertRaises!)`,
            testCode: `import unittest
from service_auth import login_user

class TestLoginUser(unittest.TestCase):
    def test_login_success(self):
        result = login_user("123456789012")
        self.assertEqual(result, "Welcome User (ID: 12345)")
        
    def test_short_token_returns_error_string(self):
        result = login_user("abc")
        self.assertEqual(result, "Login Failed: Token too short")
        
    def test_empty_token_returns_error_string(self):
        result = login_user("")
        self.assertEqual(result, "Login Failed: Token too short")

if __name__ == '__main__':
    unittest.main()`
        },
        {
            label: 'Caller with Uncaught Exception Propagation',
            sourceCode: `def checkout_order(order_id, payment_token):\n    token_info = validate_and_format_token(payment_token, provider='payment_gateway')\n    if token_info.get('valid') and token_info.get('type') == 'finance':\n        print(f"Routing to partner: {token_info.get('partner')}")\n        return True\n    return False`,
            thinking: `The \`checkout_order\` function takes (order_id, payment_token) and does NOT catch exceptions from validate_and_format_token:
1. If payment_token is valid (>= 10 chars), returns True.
2. If payment_token is too short (< 10 chars), validate_and_format_token raises ValueError and it is NOT caught -> MUST use with self.assertRaises(ValueError):
3. Notice: checkout_order takes ONLY 2 positional arguments (order_id, payment_token). Do NOT pass provider=... keyword argument!`,
            testCode: `import unittest
from service_order import checkout_order

class TestCheckoutOrder(unittest.TestCase):
    def test_checkout_success(self):
        result = checkout_order("order_1001", "123456789012")
        self.assertTrue(result)
        
    def test_checkout_short_token_raises_value_error(self):
        with self.assertRaises(ValueError):
            checkout_order("order_1001", "abc123")

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
 * @param useThinking - if false, omit <thinking> blocks (for models that loop on the tag)
 */
export function formatFewShotForPrompt(examples: FewShotExample[], useThinking: boolean = true): string {
    return examples.map((ex, i) => {
        const thinkingBlock = useThinking
            ? `(You MUST start your output directly with <thinking> and do NOT output any other headings!)\n<thinking>\n${ex.thinking}\n</thinking>\n\n`
            : `(Analyze the boundary conditions, then write the test code directly)\n`;

        return `==== Example ${i + 1}: ${ex.label} ====

[Simulated System Input (User Prompt)]
Target file: example_${i + 1}.py
Target function: example_func
Source code:
\`\`\`python
${ex.sourceCode}
\`\`\`

[Expected AI Response]
${thinkingBlock}\`\`\`python
${ex.testCode}
\`\`\``;
    }).join('\n\n\n');
}
