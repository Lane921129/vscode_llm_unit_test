/**
 * test_rule_library.ts
 * 測試生成規則庫 - Unittest Writer 可用的專項提示規則集合
 *
 * 運作原理：
 *   TestRuleDispatcher 在語意分析完成後，依原始碼與 AST 情境確定性選取規則。
 *   格式化函式只注入選中的規則卡，分析師負責情境規劃而不選規則 ID。
 */

export interface TestGenerationRuleCard {
    id: string;
    title: string;
    trigger_hint: string;
    rules: string[];
}

export const TEST_RULE_LIBRARY: TestGenerationRuleCard[] = [
    {
        id: 'string_length_boundary',
        title: 'String Length Boundary',
        trigger_hint: 'Use when source has a len(x) comparison against a literal threshold',
        rules: [
            'STRING LENGTH BOUNDARY: use the exact comparison and threshold from source (including <, <=, >, or >=).',
            '  - Choose inputs on each reachable side of that condition; N-1, N, and N+1 are candidates only when they fit the source comparison and input type.',
            '  - Do NOT infer that either side raises, returns normally, or returns a specific value. Assertions require an explicit source path or exact verified behavior observation.',
            '  - Build strings with a deliberately known length; do not use a slice unless its resulting length is independently clear.',
            '  - Make a case table: exact predicate, threshold, concrete input length, prerequisite guards, and verified observation. A lower bound never implies an upper bound.',
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
            '  - Cover each reachable source branch, including a final else/default branch when present.',
            '  - Use values on the appropriate side of every source threshold; derive expected results from the matching source branch or exact behavior observation, not from this rule.',
        ]
    },
    {
        id: 'boolean_truthiness_coverage',
        title: 'Boolean Truthiness Branch Coverage',
        trigger_hint: 'Use when AST confirms an annotated boolean parameter is itself a branch condition',
        rules: [
            'BOOLEAN TRUTHINESS BRANCH COVERAGE:',
            '  - Cover both True and False for the annotated boolean parameter when the AST branch fact identifies it directly.',
            '  - A truthiness condition identifies inputs to explore, not the expected result or exception; derive assertions from source paths or exact verified behavior observation evidence.',
            '  - Do not apply this card to a complex condition or to an untyped parameter merely because it appears in an if statement.',
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
            '  - Only use assertRaises for an explicit source raise, an exact verified behavior observation, or a configured mock side_effect that propagates out of the target.',
        ]
    },
    {
        id: 'try_except_returns_string',
        title: 'try/except Returns Error String',
        trigger_hint: 'Use when function catches exceptions internally and returns an error message string instead of re-raising',
        rules: [
            'try/except RETURNS STRING: this function catches exceptions and returns an error string.',
            '  - Only the exception types named by the matching except clause are caught. Other exceptions may propagate; do not invent a catch-all contract.',
            '  - For the caught path, configure the dependency side_effect with that exception. return_value is a normal return and cannot enter except.',
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
            '  - Use the exact canonical module path supplied by the runner, including its package prefix. Do not mix bare-file and package imports.',
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
            '  - Treat zero as a boundary candidate only for the operand used as a denominator in the source.',
            '  - Use assertRaises only for an explicit source raise or exact verified behavior observation; a division expression alone is not permission to invent an exception contract.',
            '  - If the source guards zero, assert the observable guarded behavior from that branch.',
        ]
    },
    {
        id: 'class_method_testing',
        title: 'Instance and Property Testing',
        trigger_hint: 'Use when the target is an instance method or property that needs an object instance',
        rules: [
            'INSTANCE / PROPERTY TESTING:',
            '  - Build an instance only with AST constructor defaults or verified caller literals; do not guess required constructor dependencies.',
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
            '  - Derive the full patch target from the canonical target module and its imported binding (including aliases), never the dependency definition module.',
            '  - Verify mock.assert_called_once_with using the actual target-source call arguments so an unused patch cannot pass accidentally.',
        ]
    },
    {
        id: 'observation_mock_isolation',
        title: 'Executed Observation and Mock Isolation',
        trigger_hint: 'Use when dependencies may be mocked alongside executed-observation tests',
        rules: [
            'EXECUTED OBSERVATION / MOCK ISOLATION:',
            '  - Executed-observation assertions belong to a separate TestCase without the model test class setUp, decorators, or mock state.',
            '  - Prefer a per-test patch context and explicit return_value or side_effect. Never apply a module-wide patch to executed-observation tests.',
            '  - Do not copy or change runner-owned TestVerifiedTrace_* classes; the runner restores them after repair.',
        ]
    },
    {
        id: 'caller_dependency_contract',
        title: 'Caller Constraints and Dependency Outcomes',
        trigger_hint: 'Use when the target has resolved dependencies',
        rules: [
            'CALLER / DEPENDENCY CONTRACT:',
            '  - Bind the actual positional and keyword arguments at the target call site before selecting dependency observations.',
            '  - A dependency observation under different fixed arguments is not an observation of this target call.',
            '  - If a target branch requires a controlled dependency result, patch its use point and execute the target under that exact mock before trusting the assertion.',
            '  - For and/or conditions, explore mixed truth values as well as all-true/all-false when inputs or mocks can reach them. Short-circuiting and accessed keys still apply.',
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
            '  - Keep setup and teardown independent so one test cannot leave rows, locks, or configuration that change another test.',
            '  - Only use assertRaises for an explicit source `raise` or a verified behavior observation. Never infer validation exceptions from parameter names.',
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
            '  - For ordinary with, when a dependency supplies the manager, patch it at the module-under-test use point and configure its __enter__ return value with MagicMock.',
            '  - For async with, use the async context-manager protocol (__aenter__/__aexit__) instead; do not reuse the ordinary __enter__ setup.',
            '  - Assert __enter__/__exit__ calls only when that interaction is observable and relevant to the target behavior.',
            '  - Do not open real resources merely to test the context-manager syntax.',
        ]
    },
    {
        id: 'async_context_manager_testing',
        title: 'Async Context Manager Testing',
        trigger_hint: 'Use only when the selected callable contains an async with statement',
        rules: [
            'ASYNC CONTEXT MANAGER TESTING:',
            '  - Configure the value consumed by async with as an async context manager with __aenter__ and __aexit__.',
            '  - Distinguish `async with client.method(...)` from `await client.method(...)`: a bare AsyncMock call returns a coroutine and is not automatically an async context manager.',
            '  - For the unawaited call in `async with client.method(...)`, use MagicMock for client/method, configure method.return_value.__aenter__.return_value as the resource, and use AsyncMock for awaited resource members. Setting __aenter__ on an AsyncMock return_value does not fix the coroutine returned by calling that AsyncMock.',
            '  - Use AsyncMock only for members the source actually awaits, and assert observable results rather than mock implementation details.',
            '  - Do not make real asynchronous network, file, or database calls.',
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
            '  - Use AsyncMock for explicitly awaited calls and __aenter__/__aexit__; an unawaited call inside async with must return a context manager directly (for example from MagicMock).',
        ]
    },
    {
        id: 'generator_result_testing',
        title: 'Generator Result Testing',
        trigger_hint: 'Use only when AST confirms that the selected callable contains yield or yield from',
        rules: [
            'GENERATOR RESULT TESTING:',
            '  - A generator call is lazy. Materialize a finite result with list(target(...)) before comparing values; never assert a generator repr.',
            '  - Use finite, source-supported inputs and assert the emitted sequence only when source logic or exact verified behavior observation supports it.',
            '  - Include an empty or boundary input only when it exercises a reachable source path; do not invent iteration behavior.',
        ]
    },
];

export function getTestRuleCards(ruleIds: string[]): TestGenerationRuleCard[] {
    return ruleIds
        .map(id => TEST_RULE_LIBRARY.find(rule => rule.id === id))
        .filter((rule): rule is TestGenerationRuleCard => rule !== undefined);
}

/**
 * A conservative, domain-neutral safety net for when the semantic model is
 * unavailable or omits an obvious language construct.  It only reacts to
 * Python syntax and standard-library usage, never names from an application.
 */
export function inferTestRuleIdsFromCode(
    sourceCode: string,
    context?: {
        class_name?: string | null;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        is_generator?: boolean;
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
        condition_facts?: Array<{ kind?: string; parameter?: string; subject?: string; polarity?: string }>;
    }
): string[] {
    const ids = new Set<string>(['import_module_name']);
    const source = sourceCode || '';

    if (/\blen\s*\([^)]*\)\s*[<>]=?\s*\d+/.test(source)) { ids.add('string_length_boundary'); }
    if (/\w+\s*\[\s*-?\d*\s*:\s*-?\d*\s*\]/.test(source)) { ids.add('python_slicing'); }
    if (/\b(?:if|elif)\b[^\n]*[<>]=?\s*\d+/.test(source)) { ids.add('branch_threshold_coverage'); }
    if ((context?.condition_facts || []).some(fact => fact?.kind === 'truthiness')) { ids.add('boolean_truthiness_coverage'); }
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
    if ((context?.dependencies?.length || 0) > 0) {
        ids.add('mock_external_dependency');
        ids.add('observation_mock_isolation');
        ids.add('caller_dependency_contract');
    }
    const importedModuleText = (context?.file_imports || [])
        .map(item => `${item.module || ''} ${item.name || ''}`)
        .join(' ');
    if (/\b(?:sqlite3|sqlalchemy|psycopg(?:2|3)?|pymysql|mysql\.connector|asyncpg)\b/i.test(`${source}\n${importedModuleText}`)) {
        ids.add('database_state_isolation');
        ids.add('mock_external_dependency');
    }
    if (/\basync\s+def\b|\bawait\b/.test(source)) { ids.add('async_coroutine_testing'); }
    if (context?.is_generator === true) { ids.add('generator_result_testing'); }
    if (/\bopen\s*\(|\.(?:read|write|read_text|write_text)\s*\(/.test(source)) { ids.add('file_io_mocking'); }
    if (/\b(?:datetime|date|time|timezone)\b|\.(?:now|today)\s*\(/.test(source)) { ids.add('datetime_freezing'); }
    if (/^\s*(?:async\s+)?with\s+.+:/m.test(source)) { ids.add('context_manager_testing'); }
    if (/^\s*async\s+with\s+.+:/m.test(source)) { ids.add('async_context_manager_testing'); }

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
 * Keep the semantic-plan rule selection evidence-bound. A model may prioritize
 * applicable rules, but it cannot inject unrelated rules which AST evidence
 * does not support. This prevents malformed or over-broad JSON from polluting
 * prompts across unrelated projects.
 */
export function mergeEvidenceBoundTestRuleIds(
    sourceCode: string,
    semanticRuleIds: unknown,
    context?: {
        class_name?: string | null;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        is_generator?: boolean;
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null }>;
        condition_facts?: Array<{ kind?: string; parameter?: string; subject?: string; polarity?: string }>;
    }
): string[] {
    const baseline = inferTestRuleIdsFromCode(sourceCode, context);
    const allowed = new Set(baseline);
    const semantic = Array.isArray(semanticRuleIds)
        ? semanticRuleIds.filter((id): id is string => typeof id === 'string')
        : [];
    return [...new Set([...baseline, ...semantic.filter(id => allowed.has(id))])];
}

export function formatTestRuleCardsForPrompt(cards: TestGenerationRuleCard[]): string {
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
