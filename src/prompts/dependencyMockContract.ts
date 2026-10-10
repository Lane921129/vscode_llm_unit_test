/** Source consumption is setup guidance, never a dependency or target oracle. */
export const DEPENDENCY_MOCK_SHAPE_GUIDANCE = 'Mock only source-shown receivers: factory(...).finish() needs factory_mock.return_value.finish.return_value; keep its return object. '
    + 'A direct factory(...) uses factory_mock.return_value. Never add layers or infer expected values from this pattern. '
    + 'Source connection.cursor() needs separate connection/cursor objects: put scalar/row results on the consumed method, never replace the connection with a string. '
    + 'Source with/async with needs __enter__/__aenter__; do not invent that layer otherwise.';

export const TEST_IMPORT_GUIDANCE = 'Import test helpers (patch/Mock aliases) in test scope; target or other-method imports do not bind them. '
    + 'Use explicit target imports, never wildcard imports: underscore-prefixed targets are not imported by *. '
    + 'Patch the binding read by the target, preserving import aliases; never patch the selected target or its owner class.';

/** Display existing AST bindings, not guessed patch permissions or return values. */
export function formatDependencyMockContract(module: string, context?: any, allowedMockTargets?: readonly string[]): string {
    const imports: any[] = context?.file_imports || [];
    const calls: string[] = (context?.calls || []).filter((call: unknown): call is string => typeof call === 'string');
    const bindings = imports.map(item => ({
        import: formatSourceImport(item),
        binding: item.bound_name || item.alias || item.name || item.module?.split('.')[0],
    })).filter(item => item.import);
    if (!bindings.length && !calls.length && !allowedMockTargets?.length) { return ''; }
    return 'DEPENDENCY USE-SITE CONTRACT (source setup only, never an output oracle):\n'
        + JSON.stringify({ targetModule: module, imports: bindings, sourceCalls: calls,
            ...(allowedMockTargets ? { suppliedUsePoints: allowedMockTargets } : {}) })
        + '\nFor a module-level from-import alias, patch target_module.alias; for a module import alias, patch target_module.alias.member. '
        + 'These are binding rules, not permission to invent paths. Check source scope/rebindings; locals and constructor-injected objects are not module patch targets. '
        + (allowedMockTargets ? 'Supplied use points are setup hints, not an exhaustive whitelist; verify every patch against the source binding. ' : 'No patch list was supplied; source imports alone do not prove a patch is allowed. ')
        + 'A configured mock alone is not an assertion: assert the real target result or the source-shown dependency call with controlled arguments.';
}

export function formatSourceImport(item: any): string {
    if (typeof item?.module !== 'string') { return ''; }
    const alias = item.alias ? ` as ${item.alias}` : '';
    if (item.kind === 'from' || typeof item.name === 'string') {
        return `from ${'.'.repeat(Number.isInteger(item.level) && item.level > 0 ? item.level : 0)}${item.module} import ${item.name}${alias}`;
    }
    return `import ${item.module}${alias}`;
}

/** Keep this diagnostic bounded; an unresolved name does not identify a package. */
export function missingNameRepairGuidance(output: string): string {
    const names = [...output.matchAll(/^NameError: name '([A-Za-z_][A-Za-z_0-9]{0,79})' is not defined(?:\.[^\r\n]*)?\r?$/gm)];
    const name = names.at(-1)?.[1];
    if (!name) { return ''; }
    return `IMPORT REPAIR CHECK: The runner reports undefined name "${name}". Check the failing frame and binding scope first; this does not prove a missing package. `
        + 'For a test-owned helper, add its explicit import. If that is the only correction, put the import inside the failing method and return the complete method; '
        + 'otherwise include at most 3 missing import statements before the corrected method. Do not alter assertions to hide NameError or repair target-source bindings.';
}
