export interface GeneratedTestValidation {
    valid: boolean;
    reason?: string;
}

/**
 * Fast, deterministic guard before invoking Python's parser. This keeps prose,
 * Markdown plans, and incomplete snippets out of the generated test path.
 */
export function validateUnittestStructure(code: string): GeneratedTestValidation {
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
    if (!/^\s*class\s+\w+\s*\(\s*unittest\.TestCase\s*\)\s*:/m.test(trimmed)) {
        return { valid: false, reason: '缺少 unittest.TestCase 類別' };
    }
    if (!/^\s+def\s+test_[A-Za-z_]\w*\s*\(/m.test(trimmed)) {
        return { valid: false, reason: '缺少 test_ 測試方法' };
    }
    return { valid: true };
}
