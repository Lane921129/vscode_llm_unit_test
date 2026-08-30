/**
 * prompt_skill_library.ts
 * 技能卡庫 - Unittest Writer 可用的專項提示規則集合
 *
 * 運作原理：
 *   語意分析師讀取目標函式原始碼後，輸出 required_skills 陣列。
 *   格式化函式依此清單從庫中取出對應技能卡，組合成給 Unittest Writer 的專屬 prompt。
 *   就像購物車：有用到的模式才加入，不做全量注入。
 */

export interface SkillCard {
    id: string;
    title: string;
    trigger_hint: string;
    rules: string[];
}

export const SKILL_LIBRARY: SkillCard[] = [
    {
        id: 'string_length_boundary',
        title: 'String Length Boundary',
        trigger_hint: 'Use when function has len(x) < N or len(x) > N checks that raise exceptions',
        rules: [
            'STRING LENGTH BOUNDARY: identify the exact threshold N in `len(x) < N` or `len(x) > N`.',
            '  - Test with len = N-1 (should raise), len = N (should NOT raise), len = N+1 (should NOT raise).',
            '  - Do NOT use [:-1] slicing to create a shorter string — e.g. "abc123"[:-1] still has len=5, may not cross boundary.',
            '  - Use explicit short strings like "" (len=0), "abc" (len=3), "123456789" (len=9).',
        ]
    },
    {
        id: 'python_slicing',
        title: 'Python Slicing Semantics',
        trigger_hint: 'Use when function uses x[:N], x[-N:], x[a:b] to extract substrings',
        rules: [
            'PYTHON SLICING SEMANTICS:',
            '  - `x[:5]`  takes the FIRST 5 chars. e.g. "ABCDEFGH"[:5] == "ABCDE"',
            '  - `x[-5:]` takes the LAST  5 chars. e.g. "ABCDEFGH"[-5:] == "DEFGH"',
            '  - `x[2:5]` takes chars at index 2,3,4. e.g. "ABCDEFGH"[2:5] == "CDE"',
            '  - Always compute expected slice values from the EXACT input string you pass in the test.',
        ]
    },
    {
        id: 'branch_threshold_coverage',
        title: 'Multi-Branch Threshold Coverage',
        trigger_hint: 'Use when function has multiple if/elif branches based on numeric comparisons (e.g. bmi < 18.5, elif bmi < 24)',
        rules: [
            'BRANCH THRESHOLD COVERAGE: the function has multiple if/elif numeric thresholds.',
            '  - Write at least one test per branch (including the final else).',
            '  - Use values that are clearly on each side of every threshold boundary.',
            '  - Example for thresholds [18.5, 24, 27]: test values like 15, 20, 25, 30.',
        ]
    },
    {
        id: 'float_precision',
        title: 'Float Precision',
        trigger_hint: 'Use when function uses round(), math operations, or returns float values',
        rules: [
            'FLOAT PRECISION:',
            '  - Use assertAlmostEqual(result, expected, places=N) for floats from math operations.',
            '  - Or use assertEqual only when the function explicitly calls round(x, N) — then the result is exact.',
            '  - Avoid comparing raw float arithmetic results with == (e.g. 0.1+0.2 != 0.3).',
        ]
    },
    {
        id: 'tuple_return',
        title: 'Tuple Return Value',
        trigger_hint: 'Use when function returns multiple values via tuple (e.g. return a, b)',
        rules: [
            'TUPLE RETURN VALUE: this function returns a tuple.',
            '  - Unpack or index the result: `val1, val2 = func(...)` or `result[0]`, `result[1]`.',
            '  - Use assertEqual for each element separately, or assertEqual on the full tuple.',
            '  - Do NOT use assertEqual(result, single_value) — the result is a tuple.',
        ]
    },
    {
        id: 'dict_return',
        title: 'Dict Return Value',
        trigger_hint: 'Use when function returns a dict with specific keys',
        rules: [
            'DICT RETURN VALUE: this function returns a dict.',
            '  - Check specific keys: self.assertEqual(result["key"], expected_value)',
            '  - Or check the whole dict: self.assertEqual(result, {"key1": v1, "key2": v2})',
            '  - Use self.assertIn("key", result) to verify key existence.',
        ]
    },
    {
        id: 'none_input_handling',
        title: 'None and Empty Input Handling',
        trigger_hint: 'Use when function explicitly checks for None or empty string/list',
        rules: [
            'NONE / EMPTY INPUT:',
            '  - If the function raises for None input, use `with self.assertRaises(...):`.',
            '  - If it returns a default/error value for None, use assertEqual.',
            '  - Always determine None behavior from the SOURCE CODE, not by guessing.',
        ]
    },
    {
        id: 'assert_raises_syntax',
        title: 'assertRaises Correct Syntax',
        trigger_hint: 'Use when function has raise statements that tests should catch',
        rules: [
            'assertRaises SYNTAX — CRITICAL:',
            '  - CORRECT:   with self.assertRaises(ValueError): followed by the call',
            '  - WRONG:     self.assertRaises(ValueError, "message") — TypeError!',
            '  - WRONG:     result = func(...) then assertRaises — exception already propagated!',
            '  - Only use assertRaises when the source code has an explicit raise ExceptionType.',
        ]
    },
    {
        id: 'try_except_returns_string',
        title: 'try/except Returns Error String',
        trigger_hint: 'Use when function catches exceptions internally and returns an error message string instead of re-raising',
        rules: [
            'try/except RETURNS STRING: this function catches exceptions and returns an error string.',
            '  - Do NOT use assertRaises — the exception is swallowed internally.',
            '  - Use assertEqual(result, "exact error message string").',
            '  - Check the exact return statement in the source code for the error string.',
        ]
    },
    {
        id: 'import_module_name',
        title: 'Correct Import Module Name',
        trigger_hint: 'Always include — reminds writer to use the correct module name in imports',
        rules: [
            'IMPORT MODULE NAME:',
            '  - Import from the MODULE FILE NAME, not from the function name.',
            '  - Correct: from bmi import calculate_bmi',
            '  - WRONG:   from calculate_bmi import calculate_bmi',
            '  - WRONG:   from c:\\path\\to\\file import ... — never use filesystem paths.',
        ]
    },
    {
        id: 'zero_division',
        title: 'Zero Division Handling',
        trigger_hint: 'Use when function performs division and may raise ZeroDivisionError',
        rules: [
            'ZERO DIVISION:',
            '  - Test with denominator = 0: with self.assertRaises(ZeroDivisionError):',
            '  - If the function guards against zero (returns 0 or raises ValueError), check source code.',
        ]
    },
    {
        id: 'class_method_testing',
        title: 'Class Method Testing',
        trigger_hint: 'Use when the target function is a method of a class (has self parameter)',
        rules: [
            'CLASS METHOD TESTING:',
            '  - Instantiate the class in setUp: self.obj = ClassName()',
            '  - Call method via instance: result = self.obj.method_name(...)',
            '  - Do NOT call as standalone function: method_name(...) — NameError!',
        ]
    },
    {
        id: 'mock_external_dependency',
        title: 'Mock External Dependencies',
        trigger_hint: 'Use when function calls external modules, file I/O, network, or DB',
        rules: [
            'MOCK EXTERNAL DEPENDENCIES:',
            '  - Use from unittest.mock import patch, MagicMock',
            '  - Patch at the point of USE: @patch("module_under_test.external_function")',
            '  - Set mock return value: mock_fn.return_value = expected_value',
        ]
    },
];

export function getSkillCards(skillIds: string[]): SkillCard[] {
    return skillIds
        .map(id => SKILL_LIBRARY.find(s => s.id === id))
        .filter((s): s is SkillCard => s !== undefined);
}

export function formatSkillCardsForPrompt(cards: SkillCard[]): string {
    if (cards.length === 0) return '';
    let out = '=== FUNCTION-SPECIFIC RULES (Selected for this function) ===\n';
    out += '(Derived from actual source code analysis — follow them precisely)\n\n';
    for (const card of cards) {
        out += `[${card.title}]\n`;
        for (const rule of card.rules) {
            out += `  ${rule}\n`;
        }
        out += '\n';
    }
    return out;
}

export function getSkillLibrarySummaryForPrompt(): string {
    return SKILL_LIBRARY.map(s =>
        `  - "${s.id}": ${s.trigger_hint}`
    ).join('\n');
}
