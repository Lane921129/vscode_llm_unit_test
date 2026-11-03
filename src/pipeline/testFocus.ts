import { localize } from '../i18n/core';

export const TEST_FOCUSES = ['full', 'boundary', 'coverage', 'mutation'] as const;
export type TestFocus = typeof TEST_FOCUSES[number];
export function isTestFocus(value: unknown): value is TestFocus {
    return typeof value === 'string' && (TEST_FOCUSES as readonly string[]).includes(value);
}
/** Old settings remain readable; the sidebar migrates them to the shared workflow. */
export function resolveTestFocus(value: unknown): TestFocus { return isTestFocus(value) ? value : 'full'; }
export function testFocusLabel(focus: TestFocus): string {
    return { full: localize('完整'), boundary: localize('邊界優先'), coverage: localize('覆蓋率優先'), mutation: localize('突變強化') }[focus];
}
export function testFocusInstruction(focus: TestFocus): string {
    const emphasis = {
        full: 'Balance normal, source-supported boundary and exception paths, then improve measured coverage and surviving mutants.',
        boundary: 'Prioritize source-supported comparison boundaries, empty/limit cases and exception paths. Use observed inputs when available; do not invent validation requirements.',
        coverage: 'Prioritize measured uncovered target lines and branches. When measurements do not exist yet, establish one executable seed first.',
        mutation: 'Prioritize measured surviving mutants. When no mutation evidence exists yet, establish one executable seed first.'
    }[focus];
    return `TEST_FOCUS_V1 (${focus}; priority only): ${emphasis} Work on one case/gap at a time. Keep the current seed/addition scope. All execution, review, coverage and mutation gates still apply. This instruction supplies no expected values.`;
}
/** A new focus is not permission to bypass model-role qualification. */
export function requiresQualifiedRoles(strategy: string | undefined): boolean {
    return !strategy || strategy === 'auto' || isTestFocus(strategy);
}

/** A maximum, not a generation target; normal EOS still ends a short answer.
 * Reserve the complete prompt and correction space, never consume all Context. */
export function focusedSeedOutputFloor(context: number, input: number, correction = 0): number {
    if (![context, input, correction].every(value => Number.isSafeInteger(value) && value >= 0)) { return 0; }
    return Math.max(0, Math.min(4096, context - input - correction - 128));
}
