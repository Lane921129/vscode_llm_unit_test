export interface ReportProvenance {
    extensionId: string;
    extensionVersion: string;
    buildTimestamp: string;
    extensionMode: 'development' | 'production' | 'test' | 'unknown';
    modelName: string;
    requestedTier: string;
    resolvedTier: number;
    qualified: boolean | undefined;
    qualificationReason?: string;
    qualificationMode?: string;
}

/** Render portable execution facts without disclosing a user's local paths. */
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
        `- **擴充功能**: \`${provenance.extensionId}@${provenance.extensionVersion}\``,
        `- **建置識別**: \`${provenance.buildTimestamp}\``,
        `- **執行模式**: ${provenance.extensionMode}`,
        `- **模型**: \`${provenance.modelName}\``,
        `- **策略**: 請求 ${provenance.requestedTier}，實際 Tier ${provenance.resolvedTier}`, 
        `- **模型 unittest 生成能力（測試連線驗證）**: ${qualification}`,
        ...qualificationDetails,
        ''
    ].join('\n');
}
