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
        trigger_hint: 'Use when function has multiple if/elif branches based on numeric comparisons',
        rules: [
            'BRANCH THRESHOLD COVERAGE: the function has multiple if/elif numeric thresholds.',
            '  - Write at least one test per branch (including the final else).',
            '  - Use values that are clearly on each side of every threshold boundary.',
            '  - Example for thresholds [18.5, 24, 27]: test values like 15, 20, 25, 30.',
        ]
    },
    {
        id: 'pattern_matching',
        title: 'Structural Pattern Matching',
        trigger_hint: 'Use when the function contains Python match/case branches',
        rules: [
            'PATTERN MATCHING:',
            '  - Add one test for each literal case value shown in the source, including each value in an OR pattern.',
            '  - If the source has case _, add one value that does not equal any literal case to verify the default path.',
            '  - Do not invent patterns or domain values that are absent from the source.',
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
            '  - Correct: from module_name import target_function',
            '  - WRONG:   from target_function import target_function',
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
        title: 'Instance and Property Testing',
        trigger_hint: 'Use when the target is an instance method or property that needs an object instance',
        rules: [
            'INSTANCE / PROPERTY TESTING:',
            '  - Instantiate the class in setUp: self.obj = ClassName()',
            '  - Call method via instance: result = self.obj.method_name(...)',
            '  - Read a property as self.obj.property_name without parentheses.',
            '  - Do NOT call an instance method or property as a standalone function.',
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
    {
        id: 'database_state_isolation',
        title: 'Database State Isolation',
        trigger_hint: 'Use when the source file imports or calls a database driver such as sqlite3 or SQLAlchemy',
        rules: [
            'DATABASE STATE ISOLATION:',
            '  - Never connect to the application default, configured, or shared database from a generated test.',
            '  - Patch the connection boundary at the module-under-test point of use; use a fresh in-memory database, temporary database, or MagicMock per test.',
            '  - Do not call a private helper by bare name (for example `_connect()`) unless it was explicitly imported. Prefer `import module_under_test` and patch `module_under_test._connect`.',
            '  - Keep setup and teardown independent so one test cannot leave rows, locks, or configuration that change another test.',
            '  - Only use assertRaises for an explicit source `raise` or a verified Dynamic Trace exception. Never infer validation exceptions from parameter names.',
        ]
    },
    {
        id: 'async_coroutine_testing',
        title: 'Async Coroutine Testing',
        trigger_hint: 'Use when the target is async or awaits another coroutine',
        rules: [
            'ASYNC COROUTINE TESTING:',
            '  - Use unittest.IsolatedAsyncioTestCase and await the target coroutine in an async test method.',
            '  - Patch coroutine dependencies with AsyncMock when they must not perform real work.',
            '  - Assert returned values and raised exceptions after awaiting the coroutine.',
        ]
    },
    {
        id: 'file_io_mocking',
        title: 'File I/O Mocking',
        trigger_hint: 'Use when the target opens, reads, writes, or closes files',
        rules: [
            'FILE I/O MOCKING:',
            '  - Use unittest.mock.mock_open and patch the name at the point where the target uses it.',
            '  - Exercise read and write paths without creating or changing real files.',
            '  - Assert the expected path, mode, and written content when the source code makes them observable.',
        ]
    },
    {
        id: 'datetime_freezing',
        title: 'Time Control',
        trigger_hint: 'Use when the target reads the current date, time, or timezone',
        rules: [
            'TIME CONTROL:',
            '  - Patch the time provider at its point of use; do not depend on the real clock.',
            '  - Use a fixed date or time and assert the exact observable output.',
            '  - Cover timezone or formatting boundaries only when the source code handles them.',
        ]
    },
    {
        id: 'context_manager_testing',
        title: 'Context Manager Testing',
        trigger_hint: 'Use when the target contains a Python with or async with statement',
        rules: [
            'CONTEXT MANAGER TESTING:',
            '  - Exercise the observable behavior inside the with block, not only construction of the manager.',
            '  - When a dependency supplies the manager, patch it at the module-under-test use point and configure its __enter__ return value with MagicMock.',
            '  - Assert __enter__/__exit__ calls only when that interaction is observable and relevant to the target behavior.',
            '  - Do not open real resources merely to test the context-manager syntax.',
        ]
    },
    {
        id: 'http_client_mocking',
        title: 'HTTP Client Mocking',
        trigger_hint: 'Use when the target calls an imported HTTP client such as requests, httpx, aiohttp, or urllib',
        rules: [
            'HTTP CLIENT MOCKING:',
            '  - Never make a real network request from a generated test.',
            '  - Patch the imported client at the module-under-test use point and provide a minimal response mock for only the members read by the source.',
            '  - Assert request arguments and observable return or error behavior from the source; do not invent HTTP status handling that is absent from it.',
            '  - For async HTTP calls, use AsyncMock for the awaited call or async context-manager boundary.',
        ]
    },
];

export function getSkillCards(skillIds: string[]): SkillCard[] {
    return skillIds
        .map(id => SKILL_LIBRARY.find(s => s.id === id))
        .filter((s): s is SkillCard => s !== undefined);
}

/**
 * A conservative, domain-neutral safety net for when the semantic model is
 * unavailable or omits an obvious language construct.  It only reacts to
 * Python syntax and standard-library usage, never names from an application.
 */
export function inferSkillIdsFromCode(
    sourceCode: string,
    context?: {
        class_name?: string;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
    }
): string[] {
    const ids = new Set<string>(['import_module_name']);
    const source = sourceCode || '';

    if (/\blen\s*\([^)]*\)\s*[<>]=?\s*\d+/.test(source)) { ids.add('string_length_boundary'); }
    if (/\w+\s*\[\s*-?\d*\s*:\s*-?\d*\s*\]/.test(source)) { ids.add('python_slicing'); }
    if (/\b(?:if|elif)\b[^\n]*[<>]=?\s*\d+/.test(source)) { ids.add('branch_threshold_coverage'); }
    if (/^\s*match\s+[^\n]+\s*:/m.test(source)) { ids.add('pattern_matching'); }
    if (/\bround\s*\(|\bfloat\s*\(|\bmath\./.test(source)) { ids.add('float_precision'); }
    if (/\breturn\s*\{/.test(source)) { ids.add('dict_return'); }
    if (/\breturn\s*\(\s*[^()\n]+,\s*[^()\n]+\)|\breturn\s+(?![^#\n]*\()[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*/.test(source)) { ids.add('tuple_return'); }
    if (/\bNone\b|\bnot\s+\w+/.test(source)) { ids.add('none_input_handling'); }
    if (/\braise\s+[A-Za-z_]/.test(source)) { ids.add('assert_raises_syntax'); }
    if (/\btry\s*:[\s\S]*\bexcept\b[\s\S]*\breturn\b/.test(source)) { ids.add('try_except_returns_string'); }
    if (/(?:\b\w+\s*\/\s*(?:\w+|\d+)|\b\d+\s*\/\s*\w+)/.test(source)) { ids.add('zero_division'); }
    const needsInstance = context?.method_kind === 'instance' || context?.method_kind === 'property';
    const bindingUnknown = (context?.class_name || context?.class_context) && !context?.method_kind;
    if (needsInstance || bindingUnknown) { ids.add('class_method_testing'); }
    if ((context?.dependencies?.length || 0) > 0) { ids.add('mock_external_dependency'); }
    const importedModuleText = (context?.file_imports || [])
        .map(item => `${item.module || ''} ${item.name || ''}`)
        .join(' ');
    if (/\b(?:sqlite3|sqlalchemy|psycopg(?:2|3)?|pymysql|mysql\.connector|asyncpg)\b/i.test(`${source}\n${importedModuleText}`)) {
        ids.add('database_state_isolation');
        ids.add('mock_external_dependency');
    }
    if (/\basync\s+def\b|\bawait\b/.test(source)) { ids.add('async_coroutine_testing'); }
    if (/\bopen\s*\(|\.(?:read|write|read_text|write_text)\s*\(/.test(source)) { ids.add('file_io_mocking'); }
    if (/\b(?:datetime|date|time|timezone)\b|\.(?:now|today)\s*\(/.test(source)) { ids.add('datetime_freezing'); }
    if (/^\s*(?:async\s+)?with\s+.+:/m.test(source)) { ids.add('context_manager_testing'); }

    // Match a verified call binding instead of names in comments, strings, or
    // unrelated imports elsewhere in the module. HTTP library names are
    // technical dependency evidence, never application-domain vocabulary.
    const httpModules = /^(?:requests|httpx|aiohttp|urllib(?:\.request)?)$/;
    const httpBindings = new Set(
        (context?.file_imports || [])
            .filter(item => httpModules.test(item.module || ''))
            .map(item => item.bound_name || item.name || (item.module || '').split('.')[0])
            .filter((name): name is string => Boolean(name))
    );
    const httpCall = (context?.calls || []).some(call => {
        const root = call.split('.')[0];
        return httpBindings.has(root)
            || /^(?:requests|httpx|aiohttp)\.(?:get|post|put|patch|delete|request|stream)$/i.test(call)
            || /^urllib\.request\.urlopen$/i.test(call);
    });
    if (httpCall) { ids.add('http_client_mocking'); }

    return [...ids];
}

/**
 * Keep the semantic-model shopping cart evidence-bound. A model may prioritize
 * applicable cards, but it cannot inject unrelated cards which AST evidence
 * does not support. This prevents malformed or over-broad JSON from polluting
 * prompts across unrelated projects.
 */
export function mergeEvidenceBoundSkillIds(
    sourceCode: string,
    semanticSkillIds: unknown,
    context?: {
        class_name?: string;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
    }
): string[] {
    const baseline = inferSkillIdsFromCode(sourceCode, context);
    const allowed = new Set(baseline);
    const semantic = Array.isArray(semanticSkillIds)
        ? semanticSkillIds.filter((id): id is string => typeof id === 'string')
        : [];
    return [...new Set([...baseline, ...semantic.filter(id => allowed.has(id))])];
}

export function formatSkillCardsForPrompt(cards: SkillCard[]): string {
    if (cards.length === 0) {return '';}
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
