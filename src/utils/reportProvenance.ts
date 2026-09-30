import { localize } from '../i18n/core';
export interface ReportProvenance {
    extensionId: string;
    extensionVersion: string;
    buildTimestamp: string;
    extensionMode: 'development' | 'production' | 'test' | 'unknown';
    /** Provider-neutral transport identity; model names alone are not globally unique. */
    modelProvider: 'local' | 'cloud' | 'custom';
    modelName: string;
    requestedTier: string;
    resolvedTier: number;
    qualified: boolean | undefined;
    qualificationReason?: string;
    qualificationMode?: string;
    roleQualification?: {
        writer: { state: string; reason: string };
        reviewer: { state: string; reason: string };
        bugFixer: { state: string; reason: string };
    };
}

/** Render portable execution facts without disclosing a user's local paths. */
export function formatReportProvenance(provenance: ReportProvenance): string {
    const qualification = provenance.qualified === true
        ? localize("通過")
        : provenance.qualified === false ? localize("未通過") : localize("尚未探測");
    const qualificationDetails = provenance.qualificationReason
        ? [
            provenance.qualificationMode ? localize("- **驗證方式**: {0}", localize(provenance.qualificationMode)) : '',
            localize("- **驗證說明**: {0}", provenance.qualificationReason),
        ].filter(Boolean)
        : [];
    return [
        localize("### 執行環境追溯"),
        localize("- **擴充功能**: `{0}@{1}`", provenance.extensionId, provenance.extensionVersion),
        localize("- **建置識別**: `{0}`", provenance.buildTimestamp),
        localize("- **執行模式**: {0}", provenance.extensionMode),
        localize("- **模型識別**: `{0}/{1}`", provenance.modelProvider, provenance.modelName),
        localize("- **模型**: `{0}`", provenance.modelName),
        localize("- **起始策略**: 請求 {0}，起始 Tier {1}（中途切換見策略執行摘要）", provenance.requestedTier, provenance.resolvedTier),
        localize("- **模型 unittest 生成能力（測試連線驗證）**: {0}", qualification),
        ...qualificationDetails,
        ...(provenance.roleQualification ? [
            localize("- **角色資格**: Writer={0}；Reviewer={1}；Bug Fixer={2}", provenance.roleQualification.writer.state, provenance.roleQualification.reviewer.state, provenance.roleQualification.bugFixer.state)
        ] : []),
        ''
    ].join('\n');
}
