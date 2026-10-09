/** Source consumption is setup guidance, never a dependency or target oracle. */
export const DEPENDENCY_MOCK_SHAPE_GUIDANCE = 'Mock only source-shown receivers: factory(...).finish() needs factory_mock.return_value.finish.return_value; keep its return object. '
    + 'A direct factory(...) uses factory_mock.return_value. Never add layers or infer expected values from this pattern.';

export const TEST_IMPORT_GUIDANCE = 'Import test helpers (patch/Mock aliases) in test scope; target or other-method imports do not bind them.';

/** Keep this diagnostic bounded; an unresolved name does not identify a package. */
export function missingNameRepairGuidance(output: string): string {
    const names = [...output.matchAll(/^NameError: name '([A-Za-z_][A-Za-z_0-9]{0,79})' is not defined(?:\.[^\r\n]*)?\r?$/gm)];
    const name = names.at(-1)?.[1];
    if (!name) { return ''; }
    return `IMPORT REPAIR CHECK: The runner reports undefined name "${name}". Check the failing frame and binding scope first; this does not prove a missing package. `
        + 'For a test-owned helper, add its explicit import. If that is the only correction, put the import inside the failing method and return the complete method; '
        + 'otherwise include at most 3 missing import statements before the corrected method. Do not alter assertions to hide NameError or repair target-source bindings.';
}
