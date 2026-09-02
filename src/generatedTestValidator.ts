export interface GeneratedTestValidation {
    valid: boolean;
    reason?: string;
}

export type TargetUsage = 'call' | 'property';

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

/**
 * Preserve Python's executable layout while blanking comments and string
 * contents. This validator runs before the Python AST process, so a small
 * lexer keeps prose, docstrings, and commented-out examples from
 * impersonating an assertion or target call in the regex behavior gate.
 */
function executablePythonText(code: string): string {
    let result = '';
    let quote: '\'' | '"' | undefined;
    let triple = false;
    let escaped = false;
    let inComment = false;

    for (let index = 0; index < code.length; index++) {
        const char = code[index];
        const nextThree = code.slice(index, index + 3);

        if (inComment) {
            if (char === '\n') {
                inComment = false;
                result += char;
            } else {
                result += ' ';
            }
            continue;
        }
        if (quote) {
            if (char === '\n' && !triple) {
                // Preserve an invalid unterminated string for Python's AST gate.
                quote = undefined;
                escaped = false;
                result += char;
                continue;
            }
            if (!escaped && triple && nextThree === quote.repeat(3)) {
                result += '   ';
                index += 2;
                quote = undefined;
                triple = false;
                continue;
            }
            if (!escaped && !triple && char === quote) {
                result += ' ';
                quote = undefined;
                continue;
            }
            result += char === '\n' ? '\n' : ' ';
            escaped = !escaped && char === '\\';
            if (char !== '\\') {
                escaped = false;
            }
            continue;
        }
        if (char === '#') {
            inComment = true;
            result += ' ';
            continue;
        }
        if (char === '\'' || char === '"') {
            quote = char;
            triple = nextThree === char.repeat(3);
            result += triple ? '   ' : ' ';
            if (triple) {
                index += 2;
            }
            continue;
        }
        result += char;
    }
    return result;
}

function definesCallable(code: string, callableName: string): boolean {
    const escapedName = escapeRegex(callableName);
    return new RegExp(
        '^\\s*(?:async\\s+)?def\\s+' + escapedName + '\\s*\\(',
        'm'
    ).test(code);
}

function invokesCallable(code: string, callableName: string): boolean {
    const escapedName = escapeRegex(callableName);
    const invocation = new RegExp('\\b' + escapedName + '\\s*\\(');
    const definition = new RegExp(
        '^\\s*(?:async\\s+)?def\\s+' + escapedName + '\\s*\\('
    );
    return code.split(/\r?\n/).some(line => !definition.test(line) && invocation.test(line));
}

interface TargetCallReference {
    callableNames: string[];
    moduleExpressions: string[];
    importedAliases: string[];
}

function targetCallReference(code: string, callableName: string, targetModule?: string): TargetCallReference {
    const importedAliases = new Set<string>();
    const callableNames = new Set<string>([callableName]);
    const moduleExpressions = new Set<string>();
    const escapedCallable = escapeRegex(callableName);

    for (const line of code.split(/\r?\n/)) {
        if (/^\s*from\s+/.test(line)) {
            const aliasMatch = line.match(new RegExp('\\b' + escapedCallable + '\\s+as\\s+([A-Za-z_]\\w*)'));
            if (aliasMatch) {
                callableNames.add(aliasMatch[1]);
                importedAliases.add(aliasMatch[1]);
            }
        }

        if (!targetModule || !/^\s*import\s+/.test(line)) {
            continue;
        }
        const imported = line.replace(/^\s*import\s+/, '').split('#', 1)[0];
        for (const part of imported.split(',')) {
            const match = part.trim().match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
            if (!match || match[1].split('.').pop() !== targetModule.split('.').pop()) {
                continue;
            }
            moduleExpressions.add(match[2] || match[1]);
            if (match[2]) {
                importedAliases.add(match[2]);
            }
        }
    }
    return {
        callableNames: [...callableNames],
        moduleExpressions: [...moduleExpressions],
        importedAliases: [...importedAliases],
    };
}

function invokesTargetCall(code: string, reference: TargetCallReference): boolean {
    return code.split(/\r?\n/).some(line => {
        for (const name of reference.callableNames) {
            if (invokesCallable(line, name)) {
                return true;
            }
        }
        return reference.moduleExpressions.some(moduleExpression =>
            new RegExp('\\b' + escapeRegex(moduleExpression) + '\\s*\\.\\s*'
                + escapeRegex(reference.callableNames[0]) + '\\s*\\(').test(line)
        );
    });
}

function shadowsImportedAlias(code: string, aliases: string[]): string | undefined {
    return aliases.find(alias => {
        const escapedAlias = escapeRegex(alias);
        return new RegExp('^\\s*(?:async\\s+)?def\\s+' + escapedAlias + '\\s*\\(', 'm').test(code)
            || new RegExp('^\\s*' + escapedAlias + '\\s*=(?!=)', 'm').test(code);
    });
}

function accessesProperty(code: string, propertyName: string): boolean {
    const escapedName = escapeRegex(propertyName);
    const access = new RegExp('\\.\\s*' + escapedName + '\\b');
    return code.split(/\r?\n/).some(line => !/^\s*(?:from|import)\b/.test(line) && access.test(line));
}

function testMethodBlocks(code: string): string[] {
    const headers = [...code.matchAll(/^\s+(?:async\s+)?def\s+test_[A-Za-z_]\w*\s*\([^\n]*\)\s*:/gm)];
    return headers.map((header, index) => {
        const start = header.index || 0;
        const end = headers[index + 1]?.index ?? code.length;
        return code.slice(start, end);
    });
}

function hasAssertion(code: string): boolean {
    return /\bself\.assert[A-Za-z_]*\s*\(|(?<![\w.])assert\s+/m.test(code);
}

function lineUsesTarget(line: string, callableName: string, targetUsage: TargetUsage,
                        callReference?: TargetCallReference): boolean {
    return targetUsage === 'property'
        ? accessesProperty(line, callableName)
        : invokesTargetCall(line, callReference || targetCallReference('', callableName));
}

function hasTargetResultAssertion(block: string, callableName: string, targetUsage: TargetUsage,
                                  callReference: TargetCallReference): boolean {
    const lines = block.split(/\r?\n/);
    const assignedResults = new Set<string>();

    for (const line of lines) {
        if (hasAssertion(line) && lineUsesTarget(line, callableName, targetUsage, callReference)) {
            return true;
        }

        const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)/);
        if (assignment && lineUsesTarget(line, callableName, targetUsage, callReference)) {
            assignedResults.add(assignment[1]);
            continue;
        }

        if (hasAssertion(line) && [...assignedResults].some(name =>
            new RegExp('\\b' + escapeRegex(name) + '\\b').test(line)
        )) {
            return true;
        }
    }
    return false;
}

function hasTargetInAssertRaises(block: string, callableName: string, targetUsage: TargetUsage,
                                 callReference: TargetCallReference): boolean {
    const lines = block.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const context = lines[index].match(/^(\s*)with\s+.*\bself\.assertRaises(?:Regex)?\s*\(/);
        if (!context) {
            continue;
        }
        const contextIndent = context[1].length;
        for (let nested = index + 1; nested < lines.length; nested++) {
            const line = lines[nested];
            if (!line.trim()) {
                continue;
            }
            const indent = line.match(/^\s*/)?.[0].length ?? 0;
            if (indent <= contextIndent) {
                break;
            }
            if (lineUsesTarget(line, callableName, targetUsage, callReference)) {
                return true;
            }
        }
    }
    return false;
}

function hasBehavioralTargetTest(code: string, callableName: string, targetUsage: TargetUsage,
                                 callReference: TargetCallReference): boolean {
    return testMethodBlocks(code).some(block =>
        hasTargetResultAssertion(block, callableName, targetUsage, callReference)
        || hasTargetInAssertRaises(block, callableName, targetUsage, callReference)
    );
}

/**
 * Detect a common LLM hallucination in dependency tests: it mutates a local
 * object returned by some helper, then calls the target without ever passing
 * that object to it or configuring it as a mock return value.  Such a change
 * cannot affect the target invocation and therefore cannot validate the
 * claimed dependency path.
 */
function hasIneffectiveLocalDependencyMutation(block: string, callableName: string,
                                               callReference: TargetCallReference): boolean {
    const lines = block.split(/\r?\n/);
    const targetLines = lines.filter(line => invokesTargetCall(line, callReference));
    if (targetLines.length === 0) {
        return false;
    }

    for (let index = 0; index < lines.length; index++) {
        const assignment = lines[index].match(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/);
        if (!assignment || callReference.callableNames.includes(assignment[2])) {
            continue;
        }
        const localName = assignment[1];
        const escapedLocal = escapeRegex(localName);
        const localMutation = new RegExp(
            '^\\s*' + escapedLocal + '(?:\\s*\\[[^\\]]+\\]|\\.[A-Za-z_]\\w*)\\s*='
        );
        const mutatesLocalValue = lines.slice(index + 1).some(line => localMutation.test(line));
        if (!mutatesLocalValue) {
            continue;
        }
        const reachesTarget = targetLines.some(line => new RegExp('\\b' + escapedLocal + '\\b').test(line));
        const injectsIntoMock = lines.some(line =>
            new RegExp('\\b' + escapedLocal + '\\b').test(line)
            && /\b(?:patch|return_value|side_effect)\b/.test(line)
        );
        if (!reachesTarget && !injectsIntoMock) {
            return true;
        }
    }
    return false;
}

function shadowsTargetModule(code: string, moduleName: string): boolean {
    const quotedModule = "['\"]" + escapeRegex(moduleName) + "['\"]";
    const moduleRegistryWrite = new RegExp(
        '\\bsys\\.modules\\s*\\[\\s*' + quotedModule + '\\s*\\]\\s*='
    );
    const dynamicTargetModule = new RegExp(
        '\\b(?:types\\.)?ModuleType\\s*\\(\\s*' + quotedModule
    );
    return moduleRegistryWrite.test(code) || dynamicTargetModule.test(code);
}

const UNSAFE_TEST_OPERATIONS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\b(?:os\.)?(?:system|popen)\s*\(/, label: '啟動 shell 指令' },
    { pattern: /\bsubprocess\s*\.\s*(?:run|call|check_call|check_output|Popen)\s*\(/, label: '啟動子程序' },
    { pattern: /\b(?:socket\s*\.\s*(?:create_connection|socket)|requests\s*\.\s*\w+|urllib\s*\.\s*request\s*\.\s*urlopen|http\s*\.\s*client)\s*\(/, label: '直接網路存取' },
    { pattern: /\b(?:eval|exec|compile|__import__)\s*\(/, label: '動態執行程式碼' },
    { pattern: /\bopen\s*\(/, label: '直接檔案存取' },
    { pattern: /\b(?:pathlib\s*\.\s*)?Path\s*\([^\n]*\)\s*\.\s*(?:open|read_text|read_bytes|write_text|write_bytes|touch|mkdir|rename|replace)\s*\(/, label: '直接檔案存取' },
    { pattern: /\b[A-Za-z_]\w*(?:\s*\[[^\]]+\])?\s*\.\s*(?:read_text|read_bytes|write_text|write_bytes|touch|mkdir|rename|replace|unlink|rmdir)\s*\(/, label: '直接檔案存取' },
    { pattern: /\b(?:shutil\s*\.\s*rmtree|os\s*\.\s*(?:remove|unlink|rmdir|replace)|pathlib\s*\.\s*Path\s*\([^\n]*\)\s*\.\s*(?:unlink|rmdir))\s*\(/, label: '破壞性檔案操作' },
    { pattern: /\bsqlite3\s*\.\s*connect\s*\(\s*(?!['\"]:memory:['\"]\s*\))/, label: '非隔離 SQLite 資料庫連線' },
];

function unsafeTestOperation(code: string): string | undefined {
    return UNSAFE_TEST_OPERATIONS.find(operation => operation.pattern.test(code))?.label;
}

function unimportedPrivateHelperCall(code: string): string | undefined {
    const importedOrDefined = new Set<string>();
    for (const line of code.split(/\r?\n/)) {
        const definition = line.match(/^\s*(?:async\s+)?def\s+(_[A-Za-z_]\w*)\s*\(/);
        if (definition) {
            importedOrDefined.add(definition[1]);
        }
        const imported = line.match(/^\s*from\s+[^\s]+\s+import\s+(.+)$/);
        if (imported) {
            for (const item of imported[1].split(',')) {
                const name = item.trim().match(/^(_[A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
                if (name) {
                    importedOrDefined.add(name[2] || name[1]);
                }
            }
        }
    }
    for (const line of code.split(/\r?\n/)) {
        if (/^\s*(?:from|import|(?:async\s+)?def)\b/.test(line)) {
            continue;
        }
        const call = line.match(/(?:^|[^\w.])(_[A-Za-z_]\w*)\s*\(/);
        if (call && !importedOrDefined.has(call[1])) {
            return call[1];
        }
    }
    return undefined;
}

function invokesTargetPrivateHelper(code: string, callableName: string,
                                    callReference: TargetCallReference): string | undefined {
    for (const moduleExpression of callReference.moduleExpressions) {
        const match = code.match(new RegExp('\\b' + escapeRegex(moduleExpression)
            + '\\s*\\.\\s*(_[A-Za-z_]\\w*)\\s*\\('));
        if (match && match[1] !== callableName) {
            return match[1];
        }
    }
    return undefined;
}

function unsupportedAssertRaisesException(
    code: string,
    allowedExceptionNames: string[] | undefined
): string | undefined {
    // Omitted evidence preserves the standalone validator's compatibility.
    // An explicit empty list means the target has no verified exception facts.
    if (allowedExceptionNames === undefined) {
        return undefined;
    }
    const allowed = new Set([...allowedExceptionNames, 'TypeError']);
    const matches = code.matchAll(/\bself\.assertRaises(?:Regex)?\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g);
    for (const match of matches) {
        const fullName = match[1];
        const name = fullName.split('.').pop() || fullName;
        if (allowed.has(name)) {
            continue;
        }
        const escaped = escapeRegex(fullName);
        const mockProvidesException = new RegExp(
            '\\bside_effect\\s*=\\s*' + escaped + '\\b'
        ).test(code);
        if (!mockProvidesException) {
            return name;
        }
    }
    return undefined;
}

/** Extract code from the optional structured-output envelope used by capable APIs. */
export function unwrapGeneratedCodeEnvelope(response: string): string {
    try {
        const parsed = JSON.parse(response);
        if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') {
            return parsed.code;
        }
    } catch {
        // Plain code is the compatibility format for local and custom models.
    }
    return response;
}

/**
 * Extract the most plausible Python unittest fence from model output.
 * Models differ on whether they label a fence as python, Python, py, or leave
 * it blank.  The extractor never accepts prose: it returns a fence only when
 * it contains unittest/TestCase evidence, otherwise it leaves the response
 * for the normal structural validator to reject.
 */
export function extractPythonTestCode(response: string): string {
    const unwrapped = unwrapGeneratedCodeEnvelope(response).trim();
    const fencedBlocks: Array<{ language: string; code: string }> = [];
    const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(unwrapped)) !== null) {
        fencedBlocks.push({ language: match[1].trim().toLowerCase(), code: match[2].trim() });
    }
    if (fencedBlocks.length === 0) {
        const bracket = unwrapped.match(/\[PYTHON\]([\s\S]*?)\[\/PYTHON\]/i);
        return bracket ? bracket[1].trim() : unwrapped;
    }

    const hasUnittestEvidence = (block: { language: string; code: string }) =>
        /\b(?:unittest|TestCase|IsolatedAsyncioTestCase)\b/.test(block.code);
    const preferred = fencedBlocks.find(block =>
        (block.language === 'python' || block.language === 'py') && hasUnittestEvidence(block)
    ) || fencedBlocks.find(hasUnittestEvidence);
    return preferred ? preferred.code : unwrapped;
}

/**
 * Fast, deterministic guard before invoking Python's parser. This keeps prose,
 * Markdown plans, and incomplete snippets out of the generated test path.
 */
export function validateUnittestStructure(
    code: string,
    targetCallable?: string,
    targetModule?: string,
    targetUsage: TargetUsage = 'call',
    allowedExceptionNames?: string[]
): GeneratedTestValidation {
    const trimmed = code.trim();
    if (!trimmed) {
        return { valid: false, reason: '輸出為空' };
    }
    if (/```|^\s*[-*]\s+/m.test(trimmed)) {
        return { valid: false, reason: '輸出包含 Markdown，而不是純 Python 測試檔' };
    }
    if (!/^\s*(?:from\s+unittest\s+import|import\s+unittest\b)/m.test(trimmed)) {
        return { valid: false, reason: '缺少 unittest import' };
    }
    if (!/^\s*class\s+\w+\s*\(\s*unittest\.(?:TestCase|IsolatedAsyncioTestCase)\s*\)\s*:/m.test(trimmed)) {
        return { valid: false, reason: '缺少 unittest.TestCase 或 unittest.IsolatedAsyncioTestCase 類別' };
    }
    if (!/^\s+(?:async\s+)?def\s+test_[A-Za-z_]\w*\s*\(/m.test(trimmed)) {
        return { valid: false, reason: '缺少 test_ 測試方法' };
    }
    if (!hasAssertion(trimmed)) {
        return { valid: false, reason: '缺少可驗證行為的 assertion 或 assertRaises' };
    }
    const unsafeOperation = unsafeTestOperation(trimmed);
    if (unsafeOperation) {
        return {
            valid: false,
            reason: `測試包含不允許的${unsafeOperation}；請以 unittest.mock.patch 模擬外部或危險操作。`
        };
    }
    if (targetCallable) {
        const executable = executablePythonText(trimmed);
        const unsupportedException = unsupportedAssertRaisesException(executable, allowedExceptionNames);
        if (unsupportedException) {
            return {
                valid: false,
                reason: `assertRaises(${unsupportedException}) 沒有目標原始碼、Dynamic Trace 或 mock side_effect 的例外事實依據。`
            };
        }
        const callReference = targetCallReference(executable, targetCallable, targetModule);
        const barePrivateHelper = unimportedPrivateHelperCall(executable);
        if (barePrivateHelper) {
            return {
                valid: false,
                reason: `測試呼叫未匯入的私有 helper ${barePrivateHelper}；請改用 module point-of-use patch 或明確匯入。`
            };
        }
        const targetPrivateHelper = invokesTargetPrivateHelper(executable, targetCallable, callReference);
        if (targetPrivateHelper) {
            return {
                valid: false,
                reason: `測試直接呼叫被測模組私有 helper ${targetPrivateHelper}；請 patch 該使用點而非直接操作內部狀態。`
            };
        }
        if (definesCallable(executable, targetCallable)) {
            return { valid: false, reason: '測試檔重新定義了被測函式 ' + targetCallable + '，可能沒有測到原始模組' };
        }
        const shadowedAlias = shadowsImportedAlias(executable, callReference.importedAliases);
        if (shadowedAlias) {
            return { valid: false, reason: '測試檔重新定義了被測函式的匯入別名 ' + shadowedAlias + '，可能沒有測到原始模組' };
        }
        if (targetUsage === 'property' ? !accessesProperty(executable, targetCallable) : !invokesTargetCall(executable, callReference)) {
            return { valid: false, reason: targetUsage === 'property'
                ? '測試沒有讀取被測 property ' + targetCallable
                : '測試沒有呼叫被測函式 ' + targetCallable };
        }
        if (!hasBehavioralTargetTest(executable, targetCallable, targetUsage, callReference)) {
            return { valid: false, reason: targetUsage === 'property'
                ? '沒有同時讀取被測 property 並驗證行為的 test_ 方法'
                : '沒有同時呼叫被測函式並驗證行為的 test_ 方法' };
        }
        if (targetUsage === 'call' && testMethodBlocks(executable).some(block =>
            hasIneffectiveLocalDependencyMutation(block, targetCallable, callReference)
        )) {
            return {
                valid: false,
                reason: '測試只修改未傳入被測函式、也未注入 mock 的本地相依物件，無法驗證相依路徑'
            };
        }
    }
    if (targetModule && shadowsTargetModule(trimmed, targetModule)) {
        return { valid: false, reason: '測試檔嘗試以動態模組替換被測模組 ' + targetModule };
    }
    return { valid: true };
}
