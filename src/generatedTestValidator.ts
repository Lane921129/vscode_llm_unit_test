export interface GeneratedTestValidation {
    valid: boolean;
    reason?: string;
}

export type TargetUsage = 'call' | 'property';

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
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

function hasBehavioralTargetTest(code: string, callableName: string, targetUsage: TargetUsage): boolean {
    return testMethodBlocks(code).some(block => {
        const usesTarget = targetUsage === 'property'
            ? accessesProperty(block, callableName)
            : invokesCallable(block, callableName);
        return usesTarget && hasAssertion(block);
    });
}

/**
 * Detect a common LLM hallucination in dependency tests: it mutates a local
 * object returned by some helper, then calls the target without ever passing
 * that object to it or configuring it as a mock return value.  Such a change
 * cannot affect the target invocation and therefore cannot validate the
 * claimed dependency path.
 */
function hasIneffectiveLocalDependencyMutation(block: string, callableName: string): boolean {
    const escapedTarget = escapeRegex(callableName);
    const targetInvocation = new RegExp('\\b' + escapedTarget + '\\s*\\(');
    const lines = block.split(/\r?\n/);
    const targetLines = lines.filter(line => targetInvocation.test(line));
    if (targetLines.length === 0) {
        return false;
    }

    for (let index = 0; index < lines.length; index++) {
        const assignment = lines[index].match(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/);
        if (!assignment || assignment[2] === callableName) {
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
    { pattern: /\b(?:shutil\s*\.\s*rmtree|os\s*\.\s*(?:remove|unlink|rmdir|replace)|pathlib\s*\.\s*Path\s*\([^\n]*\)\s*\.\s*(?:unlink|rmdir))\s*\(/, label: '破壞性檔案操作' },
];

function unsafeTestOperation(code: string): string | undefined {
    return UNSAFE_TEST_OPERATIONS.find(operation => operation.pattern.test(code))?.label;
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
 * Fast, deterministic guard before invoking Python's parser. This keeps prose,
 * Markdown plans, and incomplete snippets out of the generated test path.
 */
export function validateUnittestStructure(
    code: string,
    targetCallable?: string,
    targetModule?: string,
    targetUsage: TargetUsage = 'call'
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
        if (definesCallable(trimmed, targetCallable)) {
            return { valid: false, reason: '測試檔重新定義了被測函式 ' + targetCallable + '，可能沒有測到原始模組' };
        }
        if (targetUsage === 'property' ? !accessesProperty(trimmed, targetCallable) : !invokesCallable(trimmed, targetCallable)) {
            return { valid: false, reason: targetUsage === 'property'
                ? '測試沒有讀取被測 property ' + targetCallable
                : '測試沒有呼叫被測函式 ' + targetCallable };
        }
        if (!hasBehavioralTargetTest(trimmed, targetCallable, targetUsage)) {
            return { valid: false, reason: targetUsage === 'property'
                ? '沒有同時讀取被測 property 並驗證行為的 test_ 方法'
                : '沒有同時呼叫被測函式並驗證行為的 test_ 方法' };
        }
        if (targetUsage === 'call' && testMethodBlocks(trimmed).some(block =>
            hasIneffectiveLocalDependencyMutation(block, targetCallable)
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
