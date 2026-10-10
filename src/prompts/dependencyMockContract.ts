/** Source consumption is setup guidance, never a dependency or target oracle. */
export const DEPENDENCY_MOCK_SHAPE_GUIDANCE = 'Mock only source-shown receivers: factory(...).finish() needs factory_mock.return_value.finish.return_value; keep its return object. '
    + 'A direct factory(...) uses factory_mock.return_value. Never add layers or infer expected values from this pattern. '
    + 'Source connection.cursor() needs separate connection/cursor objects: put scalar/row results on the consumed method, never replace the connection with a string. '
    + 'Source with/async with needs __enter__/__aenter__; do not invent that layer otherwise.';

export const TEST_IMPORT_GUIDANCE = 'Import test helpers (patch/Mock aliases) in test scope; target or other-method imports do not bind them. '
    + 'Use explicit target imports, never wildcard imports: underscore-prefixed targets are not imported by *. '
    + 'Patch the binding read by the target, preserving import aliases; never patch the selected target or its owner class.';

const TOPOLOGY_LEGEND = 'sourceConsumption steps: return_value = preceding call result; member = attribute; context-enter = source-proven with only. '
    + 'Keep each recorded receiver; never add a return_value or __enter__ layer. Unknown steps remain unknown.';

/** A conservative relevance filter, not a Python resolver or patch permission check.
 * Keep unknown/star bindings and identifier mentions even in strings. This can
 * retain extra context, but never removes a binding merely because it is used
 * through a string or in constructor setup. Without source, retain everything.
 */
export function relevantSourceImports(context?: any): any[] {
    const imports: any[] = context?.file_imports || [];
    if (typeof context?.code !== 'string' || !context.code.trim()) { return imports; }
    const setup = [context.code, JSON.stringify(context.class_context || null),
        JSON.stringify(context.property_context || null), JSON.stringify(context.referenced_globals || []),
        JSON.stringify(context.callerContexts || []), JSON.stringify(context.dependency_fixture_contract || null)].join('\n');
    const identifiers = new Set(setup.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []);
    return imports.filter(item => {
        const binding = item.bound_name || item.alias || item.name || item.module?.split('.')[0];
        return !binding || binding === '*' || identifiers.has(binding);
    });
}

/** Display existing AST bindings, not guessed patch permissions or return values. */
export function formatDependencyMockContract(module: string, context?: any, allowedMockTargets?: readonly string[],
    includeTopology = true): string {
    const imports = relevantSourceImports(context);
    const calls: string[] = (context?.calls || []).filter((call: unknown): call is string => typeof call === 'string');
    const bindings = imports.map(item => ({
        import: formatSourceImport(item),
        binding: item.bound_name || item.alias || item.name || item.module?.split('.')[0],
    })).filter(item => item.import);
    const topology = includeTopology ? context?.dependency_fixture_contract : undefined;
    if (!bindings.length && !calls.length && !allowedMockTargets?.length && !topology) { return ''; }
    return 'DEPENDENCY USE-SITE CONTRACT (source setup only, never an output oracle):\n'
        + JSON.stringify({ targetModule: module, imports: bindings, sourceCalls: calls,
            ...(topology ? { sourceConsumption: topology } : {}),
            ...(allowedMockTargets ? { suppliedUsePoints: allowedMockTargets } : {}) })
        + '\nPatch source-shown use points: from-import alias => target_module.alias; module alias => target_module.alias.member. '
        + 'Check scope/rebindings; locals and constructor-injected objects are not module patch targets. '
        + (allowedMockTargets ? 'Supplied use points are setup hints, not an exhaustive whitelist; verify every patch against the source binding. ' : 'No patch list was supplied; source imports alone do not prove a patch is allowed. ')
        + (topology ? TOPOLOGY_LEGEND + ' '
            : 'Configure only return objects and context-manager layers actually consumed in TARGET SOURCE. ')
        + 'A configured mock alone is not an assertion: assert the real target result or the source-shown dependency call with controlled arguments.';
}

/** This optional generation block is indivisible: identity, all flows/diagnostics and their legend travel together. */
export function formatDependencyTopology(context?: any): string {
    const topology = context?.dependency_fixture_contract;
    if (!topology) { return ''; }
    return 'SOURCE CONSUMPTION TOPOLOGY (source setup only, not an output oracle or patch permission):\n'
        + JSON.stringify({ sourceConsumption: topology })
        + '\n' + TOPOLOGY_LEGEND;
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
