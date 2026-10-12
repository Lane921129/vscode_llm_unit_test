import { getLanguage } from '../i18n/core';
import { redactCredentialStrings } from './artifactSafety';

const text = (zh: string, en: string) => getLanguage() === 'en' ? en : zh;
const cell = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/[&<>|`\[\]]/g, character => `&#${character.charCodeAt(0)};`);
const descriptions: Record<string, [string, string]> = {
    'invalid-json': ['回覆無法解析成 JSON', 'The response could not be parsed as JSON'],
    'invalid-envelope': ['JSON 頂層或多物件包裝不符合契約', 'The JSON envelope or multiple objects violate the contract'],
    'too-many-findings': ['提出超過 5 個問題', 'More than 5 findings were returned'],
    'invalid-finding': ['問題項目的欄位或型別不符合契約', 'A finding has invalid fields or types'],
    'invalid-excerpt': ['引用片段缺漏或不符合契約', 'The cited excerpt is missing or invalid'],
    'excerpt-not-in-test': ['引用片段不在這份測試內', 'The cited excerpt is absent from this test'],
    'non-actionable-reason': ['理由缺漏或無法對應具體問題', 'The reason is missing or not concrete'],
    'non-actionable-action': ['建議缺漏或沒有可執行的修改', 'The action is missing or not actionable'],
    'duplicate-reason-action': ['理由與建議動作重複', 'The reason and action are identical'],
    'invalid-legacy-finding': ['舊格式問題不符合相容契約', 'A legacy finding violates its compatibility contract'],
    'invalid-category': ['問題類別不在允許的清單', 'The finding category is unsupported'],
    'invalid-test-line': ['測試行號不存在或不能引用', 'The cited test line is absent or not reviewable'],
    'target-binding-contradiction': ['目標綁定說法與已核實事實矛盾', 'The target binding claim contradicts verified facts'],
    'target-implementation-edit': ['要求修改受測實作而非測試', 'The action asks to edit the target implementation'],
    'target-self-mock': ['要求模擬受測目標本身', 'The action asks to mock the selected target itself'],
    'unrelated-test-line': ['引用行不能證明所聲稱的問題', 'The cited line does not demonstrate the claimed problem'],
    'review-facts-identity-mismatch': ['審查事實不屬於相同測試或來源', 'Review facts do not match this test/source identity'],
    'observed-outcome-contradiction': ['預期結果建議與已執行觀測矛盾', 'The proposed outcome contradicts executed observations'],
    'existing-assertion-contradiction': ['聲稱缺少已存在且核實的斷言', 'The claim contradicts an existing verified assertion'],
    'expected-exception-contradiction': ['把已驗證的預期例外誤認為失敗', 'A verified expected exception is mistaken for a failure'],
    'scalar-mock-contradiction': ['要求模擬已核實的純量值', 'The action asks to mock a verified scalar value'],
    'assertion-weakening': ['要求削弱已核實斷言', 'The action weakens a verified assertion'],
    'existing-import-contradiction': ['匯入說法與已核實事實矛盾', 'The import claim contradicts verified facts'],
    'existing-definition-contradiction': ['定義說法與已執行事實矛盾', 'The definition claim contradicts executed facts'],
    'existing-harness-contradiction': ['把已執行的 unittest 框架誤認為無效', 'The executed unittest harness is incorrectly claimed to be invalid']
};

/** A report projection only: no verdict is promoted or removed here. */
export function renderReviewerDiagnostics(events: readonly any[]): string {
    const sections: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
        if (event.stage !== 'reviewer' || !['parsed', 'assessed', 'invalid-response'].includes(event.status)) { continue; }
        const detail = event.detail || {};
        const rejected = event.status === 'invalid-response';
        const source = rejected ? detail.rejectedFindings : detail.result?.issues ?? detail.review?.issues;
        const findings = Array.isArray(source) ? source.slice(0, 5).map(item => {
            const value = item && typeof item === 'object' ? item : {};
            const bounded = (field: unknown, max: number): string | undefined => typeof field === 'string'
                ? (redactCredentialStrings(field) as string).slice(0, max) : undefined;
            return { category: bounded(value.category, 80),
                test_line: bounded(value.test_line, 32) ?? (Number.isSafeInteger(value.testLine) ? `L${value.testLine}` : undefined),
                reason: bounded(value.reason, 600), action: bounded(value.action, 600),
                excerpt: bounded(value.excerpt ?? value.evidence, 400) };
        }) : [];
        const diagnostics = Array.isArray(detail.diagnostics) ? detail.diagnostics.filter((value: unknown) =>
            typeof value === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(value)) : [];
        const key = JSON.stringify([event.loop, rejected, findings, diagnostics]);
        if (event.status === 'assessed' && seen.has(key)) { continue; }
        seen.add(key);
        sections.push(`#### ${text('第', 'Round ')}${event.loop ?? '?'}${text(' 輪', '')} · ${text('事件', 'Event ')}${event.sequence ?? '?'}`,
            rejected ? text('**Assessment 未採用；以下是模型提出的診斷資料，不是已證明的測試缺陷。**',
                '**Assessment rejected; the diagnostic claims below are not proven test defects.**')
                : findings.length ? text('**Finding 通過契約檢查，仍是待 Writer 處理的審查建議；未知語意尚未核實，不是執行或突變結果。**',
                    '**Findings passed contract checks and remain review suggestions for the Writer; unknown semantics are unverified, and these are not execution or mutation results.**')
                    : text('**零 finding；正式批准仍須核對同一候選的執行與雜湊，不能由本表替代。**',
                        '**Zero findings; formal approval still requires the executed candidate and matching hashes, which this table cannot replace.**'), '');
        if (diagnostics.length) {
            sections.push(text('Assessment 拒絕原因：', 'Assessment rejection reasons: ')
                + diagnostics.map((code: string) => `${cell(code)}${descriptions[code] ? ' — ' + text(...descriptions[code]) : ''}`).join('; '), '');
        }
        if (findings.length) {
            sections.push(text('| 類別 | 測試行 | 引用片段 | 模型理由 | 建議動作 |', '| Category | Test line | Cited excerpt | Model reason | Proposed action |'),
                '| --- | --- | --- | --- | --- |', ...findings.map(finding =>
                    `| ${cell(finding.category) || text('缺漏', 'Missing')} | ${cell(finding.test_line) || text('缺漏', 'Missing')} | ${cell(finding.excerpt) || text('未保存', 'Not retained')} | ${cell(finding.reason) || text('缺漏', 'Missing')} | ${cell(finding.action) || text('缺漏', 'Missing')} |`), '');
        } else if (rejected) {
            sections.push(text('沒有可安全還原的 finding 欄位；僅保留診斷碼與回覆雜湊，不保存完整供應商回覆。',
                'No finding fields could be safely recovered; only diagnostic codes and the response hash are retained, without the full provider response.'), '');
        }
    }
    return sections.length ? '\n' + text('### Reviewer 問題與拒絕診斷', '### Reviewer findings and rejection diagnostics')
        + '\n\n' + text('每份 assessment 最多顯示 5 項；文字有長度上限並去除憑證。未知語意保留為模型說法。',
            'At most 5 findings are shown per assessment; text is bounded and credentials are withheld. Unknown semantics remain model claims.')
        + '\n\n' + sections.join('\n') : '';
}
