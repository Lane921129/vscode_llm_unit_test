export interface GeneratedTestValidation {
    valid: boolean;
    reason?: string;
}

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
    targetModule?: string
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
    if (!/\bself\.assert[A-Za-z_]*\s*\(|(?<![\w.])assert\s+/m.test(trimmed)) {
        return { valid: false, reason: '缺少可驗證行為的 assertion 或 assertRaises' };
    }
    if (targetCallable) {
        if (definesCallable(trimmed, targetCallable)) {
            return { valid: false, reason: '測試檔重新定義了被測函式 ' + targetCallable + '，可能沒有測到原始模組' };
        }
        if (!invokesCallable(trimmed, targetCallable)) {
            return { valid: false, reason: '測試沒有呼叫被測函式 ' + targetCallable };
        }
    }
    if (targetModule && shadowsTargetModule(trimmed, targetModule)) {
        return { valid: false, reason: '測試檔嘗試以動態模組替換被測模組 ' + targetModule };
    }
    return { valid: true };
}
