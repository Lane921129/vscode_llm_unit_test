export interface ReportProvenance {
    extensionEntry: string;
    workingDirectory: string;
    modelName: string;
    requestedTier: string;
    resolvedTier: number;
    qualified: boolean | undefined;
    qualificationReason?: string;
    qualificationMode?: string;
}

/** Render execution facts that distinguish an installed extension from a stale build. */
export function formatReportProvenance(provenance: ReportProvenance): string {
    const qualification = provenance.qualified === true
        ? '通過'
        : provenance.qualified === false ? '未通過' : '尚未探測';
    const qualificationDetails = provenance.qualificationReason
        ? [
            provenance.qualificationMode ? `- **驗證方式**: ${provenance.qualificationMode}` : '',
            `- **驗證說明**: ${provenance.qualificationReason}`,
        ].filter(Boolean)
        : [];
    return [
        '### 執行環境追溯',
        `- **擴充功能執行檔**: \`${provenance.extensionEntry}\``,
        `- **工作目錄**: \`${provenance.workingDirectory}\``,
        `- **模型**: \`${provenance.modelName}\``,
        `- **策略**: 請求 ${provenance.requestedTier}，實際 Tier ${provenance.resolvedTier}`, 
        `- **模型 unittest 生成能力（測試連線驗證）**: ${qualification}`,
        ...qualificationDetails,
        ''
    ].join('\n');
}
