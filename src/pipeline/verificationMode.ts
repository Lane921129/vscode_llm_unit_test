import { localize } from '../i18n/core';
export type VerificationMode = 'execution' | 'full';

/** Unknown explicit values must not silently lower a requested quality gate. */
export function verificationMode(value: unknown = 'full'): VerificationMode {
    if (value === 'execution' || value === 'full') { return value; }
    throw new Error(localize("未知驗證目標；請選擇「執行驗證」或「完整品質驗證」。"));
}
