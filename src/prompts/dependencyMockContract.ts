import { createHash } from 'node:crypto';
import { sameRecordedFile } from '../utils/fileIdentity';

export const SOURCE_INPUT_SHAPE_GUIDANCE = 'Source parameter.member needs an attribute-bearing fixture (for example types.SimpleNamespace), not a dict of same-named keys. '
    + 'Follow mixed accesses one level at a time: obj.member["key"] needs a mapping-valued member; obj.member.key needs attribute-bearing values. '
    + 'Do not turn all nested values into namespaces.';

/** Source consumption is setup guidance, never a dependency or target oracle. */
export const DEPENDENCY_MOCK_SHAPE_GUIDANCE = 'Mock only source-shown receivers: factory(...).finish() needs factory_mock.return_value.finish.return_value; keep its return object. '
    + 'A direct factory(...) uses factory_mock.return_value. Never add layers or infer expected values from this pattern. '
    + 'Source connection.cursor() needs separate connection/cursor objects: put scalar/row results on the consumed method, never replace the connection with a string. '
    + 'Source with/async with needs __enter__/__aenter__; do not invent that layer otherwise. '
    + SOURCE_INPUT_SHAPE_GUIDANCE;

export const TEST_IMPORT_GUIDANCE = 'Import test helpers (patch/Mock aliases) in test scope; target or other-method imports do not bind them. '
    + 'Use explicit target imports, never wildcard imports: underscore-prefixed targets are not imported by *. '
    + 'Patch the binding read by the target, preserving import aliases; never patch the selected target or its owner class. '
    + 'Do not patch immutable built-in type members; replace the source module dependency binding with a scoped stand-in instead.';

/** Conditional setup guidance, not evidence that an arbitrary attribute exists or may be patched. */
export const OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE = "For a source-proven optional getattr(owner, 'name', default), the attribute may be absent. "
    + "Use scoped patch.object(actual_owner, 'name', controlled_value, create=True) only for that exact non-target use point; "
    + 'retain the absent/default case and restore the original owner and attribute existence/value. '
    + 'Do not invent APIs, patch the target/class, hide target AttributeError, or infer expected outputs from this setup. '
    + 'Source-location names such as __file__ belong to the target module, not the generated test. '
    + 'Control source-shown path conversions at their exact use points with explicit mocks; never run test-side Path.resolve() or file operations to compute expected values.';

export const EXECUTION_DEPENDENCY_BOUNDARY_GUIDANCE = 'Focus on the real target. Isolate unrelated UI/service helpers with scoped source-use-point patches. Use with patch(...) contexts. '
    + 'Host resources prepare imports; they do not require running every helper. Keep source-consumed return shapes and the declared resource contract. '
    + 'Never patch the target or its owner.';

/** Direct, uniquely bound same-module retrievals are setup hints, not permissions. */
export function sourceHelperUsePointNames(context: any): string[] {
    if (!Array.isArray(context?.calls) || !Array.isArray(context?.localDependencyContexts)
        || context.localDependencyContexts.length > 6) { return []; }
    return [...new Set<string>(context.localDependencyContexts.filter((helper: any) => helper
        && typeof helper.name === 'string' && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(helper.name)
        && helper.name !== context.name && context.calls.includes(helper.name)
        && helper.retrieval?.kind === 'same-module-symbol' && helper.retrieval.depth === 1
        && typeof helper.code === 'string' && typeof helper.sourceHash === 'string'
        && createHash('sha256').update(helper.code).digest('hex') === helper.sourceHash)
        .map((helper: any) => helper.name))];
}

/** A traceback navigates to a source-proven option; it never authorizes a patch. */
export function executionHelperRepairGuidance(failure: string, module: string, file: string,
    context: any, knownHelpers: readonly string[]): string {
    if (!/^AttributeError:/m.test(failure) || context?.class_name || !Array.isArray(context?.calls)
        || !/^[_\p{ID_Start}][_\p{ID_Continue}]*(?:\.[_\p{ID_Start}][_\p{ID_Continue}]*)*$/u.test(module)) { return ''; }
    const names = new Set(knownHelpers.filter(name => name !== context.name
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name) && context.calls.includes(name)));
    const mentioned = new Set<string>();
    for (const frame of failure.matchAll(/^\s{2}File "([^"\r\n]+)", line [1-9]\d*, in ([_\p{ID_Start}][_\p{ID_Continue}]*)\s*$/gmu)) {
        if (names.has(frame[2]) && sameRecordedFile(frame[1], file)) { mentioned.add(frame[2]); }
    }
    if (mentioned.size !== 1) { return ''; }
    const point = module + '.' + [...mentioned][0];
    return '\n\nEXECUTION_HELPER_BOUNDARY_REPAIR_V1\n'
        + `The failure traceback mentions direct source helper use point ${point}. This is a source-backed isolation option, not a new target. `
        + 'You may edit setup local to the failing test method. Keep passing methods and module/class fixtures unchanged. '
        + 'When isolating this helper, keep the real target call and its assertions inside the scoped context below; '
        + 'preserve consumed return shapes. This scaffold supplies no inputs or expected values and is not executable.\n'
        + 'from unittest.mock import patch\n' + `with patch("${point}"):\n`
        + '    # keep the real target call and its assertions here\n';
}

const TOPOLOGY_LEGEND = 'sourceConsumption steps: return_value = preceding call result; member = attribute; context-enter = source-proven with only. '
    + 'Keep each recorded receiver; never add a return_value or __enter__ layer. Unknown steps remain unknown.';

const MOCK_CALL_ASSERTION_GUIDANCE = 'Source call sites are not executed call counts: branches, loops and unpatched helpers may add calls. '
    + 'Do not guess call_count=1 or put several assert_called_once_with checks on the same mock. '
    + 'Keep meaningful, independently justified expectations and the exact argument types; do not weaken assertions just to pass.';

const dynamicNamespaceNames = new Set(['globals', 'locals', 'vars', 'eval', 'exec', 'compile', '__import__', 'import_module',
    'getattr', 'setattr', 'delattr', '__dict__', '__builtins__', '__getattribute__', '__getattr__']);

/** A conservative relevance filter, not a Python resolver or patch permission check.
 * Keep unknown/star bindings and identifier mentions even in strings. This can
 * retain extra context, but never removes a binding merely because it is used
 * through a string or in constructor setup. Without source or with dynamic
 * namespace uncertainty, retain everything rather than guessing bindings.
 */
export function relevantSourceImports(context?: any): any[] {
    const imports: any[] = context?.file_imports || [];
    if (typeof context?.code !== 'string' || !context.code.trim()) { return imports; }
    const setup = [context.code, JSON.stringify(context.class_context || null),
        JSON.stringify(context.property_context || null), JSON.stringify(context.referenced_globals || []),
        JSON.stringify(context.callerContexts || []), JSON.stringify(context.dependency_fixture_contract || null)].join('\n');
    const normalizedSetup = setup.normalize('NFKC');
    const bindingEvidence = normalizedSetup + '\n' + JSON.stringify(imports).normalize('NFKC');
    // Python normalizes identifiers using NFKC. Scan Unicode identifiers (also
    // inside strings/comments, conservatively) without changing source evidence.
    // Dynamic lookups can assemble names from fragments: disable this optional
    // projection in that case. Neither branch grants execution/patch permission.
    if ((bindingEvidence.match(/[_\p{ID_Start}][_\p{ID_Continue}]*/gu) || [])
        .some(name => dynamicNamespaceNames.has(name))) {
        return imports;
    }
    const identifiers = new Set(normalizedSetup.match(/[_\p{ID_Start}][_\p{ID_Continue}]*/gu) || []);
    return imports.filter(item => {
        const binding = item.bound_name || item.alias || item.name || item.module?.split('.')[0];
        if (typeof binding !== 'string') { return true; }
        const normalizedBinding = binding.normalize('NFKC');
        return !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(normalizedBinding)
            || identifiers.has(normalizedBinding);
    });
}

/** Display existing AST bindings, not guessed patch permissions or return values. */
export function formatDependencyMockContract(module: string, context?: any, allowedMockTargets?: readonly string[],
    includeTopology = true, options: { sourceImportsListed?: boolean } = {}): string {
    const imports = relevantSourceImports(context);
    const calls: string[] = (context?.calls || []).filter((call: unknown): call is string => typeof call === 'string');
    const bindings = imports.map(item => ({
        import: formatSourceImport(item),
        binding: item.bound_name || item.alias || item.name || item.module?.split('.')[0],
    })).filter(item => item.import);
    const topology = includeTopology ? context?.dependency_fixture_contract : undefined;
    const declaredParameters: unknown[] = Array.isArray(context?.signature)
        ? context.signature.map((parameter: any) => parameter?.name)
        : Array.isArray(context?.args) ? context.args : [];
    const parameters = [...new Set(declaredParameters.filter((name): name is string => typeof name === 'string'
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name.normalize('NFKC'))))];
    const parameterSetup = parameters.length ? 'PARAMETER SETUP (source signature): ' + JSON.stringify(parameters)
        + '. Build input values in test scope and pass them to the target; parameter names alone do not authorize '
        + 'patching target_module.<parameter>. An independent source-proven global lookup may justify a module patch. '
        + 'Do not infer fixture shapes or expected outputs from parameter names.\n' : '';
    const parameterMethods = parameters.flatMap(parameter => {
        if (context?.class_name && context?.method_kind !== 'static' && parameter === declaredParameters[0]) { return []; }
        const methods = calls.filter(call => call.startsWith(parameter + '.'))
            .map(call => call.slice(parameter.length + 1)).filter(method => /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(method));
        return methods.length ? [`Input ${parameter} is used with methods ${[...new Set(methods)].join(', ')}; `
            + 'for those source paths pass a controlled protocol object, not a string/scalar. Configure the consumed method, not unrelated methods. '
            + 'If asserting call history, make that method a unittest.mock.Mock: a lambda/plain function has no .called or assert_called* history.'] : [];
    }).join('\n');
    const sourceCalls = sourceSetupCallGuidance(module, context);
    // Source-bound fixture consumption is necessary setup, including in the
    // first compact Writer prompt. Only the larger topology remains optional.
    const consumptionGuidance = formatFixtureConsumptionGuidance(module, context);
    const receiverGuidance = formatFixtureReceiverGuidance(module, context);
    if (!bindings.length && !calls.length && !allowedMockTargets?.length && !topology) {
        return parameterSetup + sourceCalls + receiverGuidance + consumptionGuidance;
    }
    // Conservative prompt relevance only; identifiers in source strings can
    // retain extra guidance but never authorize a patch or an assertion.
    const setupSource = [context?.code || '', JSON.stringify(context?.class_context || null),
        JSON.stringify(context?.referenced_globals || []), ...calls].join('\n').normalize('NFKC');
    const optionalGuidance = /\b(?:getattr|hasattr|__file__)\b/u.test(setupSource)
        ? OPTIONAL_ATTRIBUTE_MOCK_GUIDANCE + ' ' : '';
    const clockGuidance = immutableClockSetupGuidance(module, context, imports, context?.dependency_fixture_contract);
    const globalsGuidance = context?.referenced_globals?.length
        ? 'Source globals are not test globals: explicitly import the canonical target module and read its source-shown bindings. ' : '';
    const conversions = context?.referenced_globals?.length || /\bstr\s*\(/u.test(setupSource)
        ? 'For dependency call assertions, retain source-shown argument conversions and types: str(path) is not the Path object. ' : '';
    const observations = [...context?.traceResult?.examples || [], ...context?.traceResult?.errors || []];
    const diagnosticGuidance = observations.some(item => item.call_assertable === false || item.result_assertable === false
        || item.oracle_reason || item.result_type === 'non_assertable')
        ? 'Never use non_assertable diagnostic text or private tool classes as a return fixture or expected type. ' : '';
    const aliasGuidance = imports.length ? 'Use distinct mock/import names; as Path shadows imported Path. ' : '';
    return parameterSetup + (parameterMethods ? parameterMethods + '\n' : '') + sourceCalls + 'DEPENDENCY USE-SITE CONTRACT (source setup only, never an output oracle):\n'
        + JSON.stringify({ targetModule: module,
            imports: options.sourceImportsListed ? { same_complete_setup_as: 'SOURCE SETUP.imports' } : bindings, sourceCalls: calls,
            ...(topology ? { sourceConsumption: topology } : {}),
            ...(allowedMockTargets ? { suppliedUsePoints: allowedMockTargets } : {}) })
        + '\nPatch source-shown use points: from-import alias => target_module.alias; module alias => target_module.alias.member. '
        + 'Check scope/rebindings; locals and constructor-injected objects are not module patch targets. '
        + (allowedMockTargets ? 'Supplied use points are setup hints, not an exhaustive whitelist; verify every patch against the source binding. ' : 'No patch list was supplied; source imports alone do not prove a patch is allowed. ')
        + (topology ? TOPOLOGY_LEGEND + ' '
            : 'Configure only return objects and context-manager layers actually consumed in TARGET SOURCE. ')
        + consumptionGuidance
        + receiverGuidance
        + (calls.length ? MOCK_CALL_ASSERTION_GUIDANCE + '\n' : '')
        + globalsGuidance + conversions + diagnosticGuidance + aliasGuidance
        + optionalGuidance
        + clockGuidance
        + 'A configured mock alone is not an assertion: assert the real target result or the source-shown dependency call with controlled arguments.';
}

/** Call only after the containing source contract has been validated. */
function sourceLiteralHighlights(facts: any): Array<{ callee: string; text: string }> {
    const rows: Array<{ callee: string; text: string }> = [];
    for (const item of facts.literalCallArguments ?? []) {
        if (item.source.length <= 600) {
            const position = item.position === undefined ? `keyword ${item.keyword}` : `arg ${item.position}`;
            rows.push({ callee: item.callee, text: `Source literal at line ${item.line}, ${item.callee}, ${position}: ${item.source}` });
        }
    }
    for (const call of facts.literalCallArguments === undefined ? facts.calls : []) {
        for (const [index, item] of call.args.entries()) {
            if (item.scope === 'literal' && /\\[nrt]|[\r\n]/.test(item.source) && item.source.length <= 600) {
                rows.push({ callee: call.callee, text: `Source literal at line ${call.line}, ${call.callee}, arg ${index + 1}: ${item.source}` });
            }
        }
    }
    return rows;
}

/** Exact AST spellings reduce setup guesswork, not the execution or assertion gates. */
export function sourceSetupCallGuidance(module: string, context?: any): string {
    const facts = context?.source_setup_call_contract;
    const source = typeof context?.code === 'string' ? context.code.replace(/\r\n?/g, '\n') : '';
    const parameterMembers = facts?.parameterMembers ?? [];
    const literalCallArguments = facts?.literalCallArguments ?? [];
    if (!facts || facts.schemaVersion !== 'source-setup-call-contract-v1' || facts.status !== 'complete'
        || facts.sourceHashKind !== 'normalized-target-source' || facts.authority !== 'source-spelling-only'
        || facts.assertionOracle !== false || facts.patchAuthorization !== false || !source
        || facts.targetSourceHash !== createHash('sha256').update(source).digest('hex')
        || facts.target !== (context?.class_name ? `${context.class_name}.${context.name}` : context?.name)
        || !Array.isArray(facts.calls) || !Array.isArray(facts.optionalLookups) || !Array.isArray(facts.sourceLocations)
        || !Array.isArray(parameterMembers) || !Array.isArray(literalCallArguments)
        || facts.calls.length + facts.optionalLookups.length + parameterMembers.length + literalCallArguments.length > 64
        || Buffer.byteLength(JSON.stringify(facts), 'utf8') > 16384) { return ''; }
    const identifier = (value: unknown): value is string => typeof value === 'string'
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(value.normalize('NFKC'));
    const spelling = (value: unknown): value is string => typeof value === 'string' && !!value;
    const argument = (value: any): boolean => !!value && spelling(value.source)
        && ['module-global', 'parameter', 'literal', 'unknown'].includes(value.scope);
    const declaredParameters: unknown[] = Array.isArray(context?.signature)
        ? context.signature.map((parameter: any) => parameter?.name) : Array.isArray(context?.args) ? context.args : [];
    const instanceReceiver = context?.class_name && context?.method_kind !== 'static' ? declaredParameters[0] : undefined;
    if (facts.optionalLookups.some((item: any) => !item || !identifier(item.owner) || !identifier(item.attribute)
            || item.ownerScope !== 'module-global' || !spelling(item.defaultSource) || !spelling(item.source)
            || !Number.isSafeInteger(item.line) || item.line <= 0)
        || facts.calls.some((item: any) => !item || !spelling(item.callee) || !Array.isArray(item.args)
            || !Array.isArray(item.keywords) || !item.args.every(argument)
            || item.keywords.some((keyword: any) => !argument(keyword) || keyword.name !== null && !identifier(keyword.name))
            || !Number.isSafeInteger(item.line) || item.line <= 0)
        || facts.sourceLocations.some((name: unknown) => name !== '__file__')
        || literalCallArguments.some((item: any) => !item || !spelling(item.callee) || !spelling(item.source)
            || !Number.isSafeInteger(item.line) || item.line <= 0
            || !(Number.isSafeInteger(item.position) && item.position > 0 && item.keyword === undefined
                || item.position === undefined && identifier(item.keyword)))
        || parameterMembers.some((item: any) => !item || !identifier(item.parameter)
            || !declaredParameters.includes(item.parameter) || item.parameter === instanceReceiver
            || !Array.isArray(item.members) || !item.members.length || item.members.length > 8 || !item.members.every(identifier)
            || !['read', 'write', 'call'].includes(item.usage) || !Number.isSafeInteger(item.line) || item.line <= 0)) { return ''; }
    if (!facts.calls.length && !facts.optionalLookups.length && !facts.sourceLocations.length
        && !parameterMembers.length && !literalCallArguments.length) { return ''; }
    const lines = ['SOURCE CALL SETUP (AST-normalized spellings; read the complete source above; no output oracle or patch permission):', JSON.stringify(facts)];
    const literalHighlights = sourceLiteralHighlights(facts).map(item => item.text);
    // Optional navigation repeats whole spellings; the complete facts above are never cut.
    if (literalHighlights.length > 0 && literalHighlights.length <= 6
        && literalHighlights.join('\n').length <= 2400) {
        lines.push('SOURCE LITERAL SPELLINGS (retain escapes and whitespace; source argument facts, not target output expectations):',
            ...literalHighlights);
    }
    for (const lookup of facts.optionalLookups) {
        lines.push(`Optional source lookup ${lookup.source}: owner is ${module}.${lookup.owner}. `
            + `For its controlled attribute use patch.object(${module}.${lookup.owner}, ${JSON.stringify(lookup.attribute)}, controlled_value, create=True); `
            + 'an attribute may be absent. Preserve the source default case and restore attribute existence/value.');
    }
    if (facts.calls.some((call: any) => [...call.args, ...call.keywords].some((arg: any) => arg.scope === 'module-global'))) {
        lines.push('Dependency-call assertions must retain the recorded args/keywords, including conversions. '
            + `Read each module-global spelling from ${module}.<source spelling>; do not replace it with its upstream input or imported origin. `
            + 'Parameter/literal inputs are test-controlled; unknown expressions remain unknown. These call spellings do not choose expected target outputs.');
        for (const call of facts.calls) {
            const moduleArgument = (item: any): string | undefined => item.scope === 'module-global'
                && item.source.split('.').every(identifier) ? `${module}.${item.source}` : undefined;
            const bindings = [...call.args.map((item: any, index: number) => {
                const binding = moduleArgument(item); return binding ? `arg ${index + 1}: ${binding}` : undefined;
            }), ...call.keywords.map((item: any) => {
                const binding = moduleArgument(item); return binding && item.name ? `${item.name}: ${binding}` : undefined;
            })].filter(Boolean);
            if (bindings.length) { lines.push(`Call setup ${call.callee}: ${bindings.join('; ')}.`); }
        }
        lines.push('Keep these same source bindings; do not substitute an upstream variable or hard-coded path.');
    }
    if (parameterMembers.length) {
        lines.push('Parameter object shape: provide controlled objects with the listed exact attribute paths, callable methods and writable members; '
            + 'dictionary keys do not satisfy dot attribute access. Preserve the same nested object identity when configuring and checking a consumed method. '
            + 'The source spelling proves required access only, never an attribute value, concrete type or expected target result.');
    }
    for (const parameter of [...new Set<string>(parameterMembers.map((item: any) => item.parameter))]) {
        const paths = [...new Set<string>(parameterMembers.filter((item: any) => item.parameter === parameter)
            .map((item: any) => `${parameter}.${item.members.join('.')}${item.usage === 'call' ? '()' : ''} [${item.usage}]`))];
        lines.push(`Parameter object setup ${parameter}: ${paths.join('; ')}. `
            + `Pass this object to the target; do not patch ${module}.${parameter} merely because it is a parameter.`);
    }
    if (facts.sourceLocations.length) {
        lines.push(`The source __file__ is ${module}.__file__, never the generated test __file__. `
            + `If controlling it, patch ${JSON.stringify(module + '.__file__')} within the test. `
            + 'Use only source-shown operations and scoped dependency return objects; do not call test-side resolve() or invent os.path operations for expected values. '
            + 'A path-constructor argument is input, not the returned resolved parent. Preserve the consumed return object/member and assert its explicitly controlled value.');
    }
    return lines.join('\n') + '\n';
}

/** Repeat only verified source spellings at the end of a concrete argument repair. */
export function sourceLiteralRepairGuidance(output: string, module: string, context?: any): string {
    const multiple = /^AssertionError: Expected '([A-Za-z_]\w{0,79})' to (?:be called once|have been called once)\. Called ([2-9]|[1-9]\d{1,4}) times\.\r?$/m.exec(output);
    if (!multiple && !/^AssertionError: expected call not found\.\r?$/m.test(output)) { return ''; }
    if (!sourceSetupCallGuidance(module, context)) { return ''; }
    const rows = sourceLiteralHighlights(context.source_setup_call_contract);
    const literals = rows.filter(item => !multiple || item.callee.split('.').at(-1) === multiple[1]).map(item => item.text);
    if (!literals.length || literals.length > 6 || literals.join('\n').length > 2400) { return ''; }
    if (multiple) {
        return '\n\nSOURCE_CALL_COUNT_REPAIR_V1\n' + literals.join('\n')
            + '\nThe failing once-only assertion is not a preservation requirement. Compare its asserted arguments with these source calls; do not keep an unsupported call assumption. '
            + 'First distinguish setup history from calls made by the real target for the controlled inputs; static call sites do not determine runtime count. '
            + 'Repair only the failing assertion with source-supported exact arguments, order and total count. Exact call_args_list equality can check all three; assert_any_call alone would lose precision. '
            + 'Preserve passing cases and fixture control. These source spellings provide no target return-value oracle or patch permission. Return a substantive repair, not the unchanged method.\n';
    }
    return '\n\nSOURCE_LITERAL_REPAIR_V1\n' + literals.join('\n')
        + '\nRepair the failing call-argument assertion using the matching original source spelling. '
        + 'This invalid argument may be corrected; preserve valid assertions and the source-consumed receiver. '
        + 'Keep escapes inside Python string literals exactly; do not flatten their whitespace. '
        + 'These facts supply no target return-value oracle or patch permission. Return the repaired code, not the old unchanged method.\n';
}

/** Only existing lexical receiver facts select these setup examples. No source is
 * executed, and the controlled values are inputs, never inferred target outputs. */
function immutableClockSetupGuidance(module: string, context: any, imports: any[], topology: any): string {
    const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
    if (!module.split('.').every(part => identifier.test(part))
        || topology?.schemaVersion !== 'dependency-fixture-contract-v1'
        || !['complete', 'partial'].includes(topology.status) || !Array.isArray(topology.flows)) { return ''; }
    const guidance: string[] = [];
    for (const item of imports) {
        if (item.module !== 'datetime' || item.level > 0) { continue; }
        const binding = item.bound_name || item.alias || item.name || 'datetime';
        if (typeof binding !== 'string' || !identifier.test(binding)
            || binding === context?.name?.split('.')[0]) { continue; }
        const fromType = (item.kind === 'from' || typeof item.name === 'string')
            && ['datetime', 'date'].includes(item.name);
        const moduleImport = item.kind !== 'from' && typeof item.name !== 'string';
        if (!fromType && !moduleImport) { continue; }
        for (const flow of topology.flows) {
            if (flow.root?.kind !== 'use-point' || flow.root.name !== binding || !Array.isArray(flow.steps)
                || !['now', 'utcnow', 'today'].includes(flow.method)) { continue; }
            const prefix = moduleImport ? flow.steps[0]?.name : '';
            if (fromType && flow.steps.length !== 0 || moduleImport && (flow.steps.length !== 1
                || flow.steps[0]?.kind !== 'member' || !['datetime', 'date'].includes(prefix))) { continue; }
            if ((moduleImport ? prefix : item.name) === 'date' && flow.method !== 'today') { continue; }
            const clockMember = (prefix ? prefix + '.' : '') + flow.method;
            const returned = [...flow.steps, { kind: 'member', name: flow.method }, { kind: 'return_value' }];
            const formatsText = topology.flows.some((next: any) => next.root?.kind === 'use-point'
                && next.root.name === binding && next.method === 'strftime'
                && Array.isArray(next.steps) && next.steps.length === returned.length
                && next.steps.every((step: any, index: number) => step.kind === returned[index].kind
                    && step.name === (returned[index] as { name?: string }).name));
            const assignment = `clock_stub.${clockMember}.return_value = controlled_clock_value`;
            const realFormatter = formatsText ? ` Use a concrete real ${moduleImport ? prefix : item.name} fixture imported through a separate test-local alias as controlled_clock_value, leaving its real strftime to execute. `
                + 'Never mock strftime or configure its return_value from expected text: that hides changes to the target format argument.' : '';
            guidance.push(`For the recorded ${binding}.${clockMember} call, use with patch('${module}.${binding}') as clock_stub; ${assignment}.${realFormatter}`);
        }
    }
    if (!guidance.length) { return ''; }
    return 'IMMUTABLE CLOCK SETUP (recorded receiver shape only): ' + [...new Set(guidance)].join(' ')
        + ' Define controlled values in test scope. Replace only the target module dependency binding, leaving the original datetime/date type and selected target callable intact; never patch datetime.datetime.now or a built-in type member. '
        + 'Restore the binding after each case; do not add return_value/strftime layers absent from the recorded path. Execute the real target under this exact mock before relying on its result; this setup is not an observed assertion oracle. ';
}

/** This optional generation block is indivisible: identity, all flows/diagnostics and their legend travel together. */
export function formatDependencyTopology(context?: any): string {
    const topology = context?.dependency_fixture_contract;
    if (!topology) { return ''; }
    return 'SOURCE CONSUMPTION TOPOLOGY (source setup only, not an output oracle or patch permission):\n'
        + JSON.stringify({ sourceConsumption: topology })
        + '\n' + TOPOLOGY_LEGEND;
}

/** Source-bound shape instructions. They never supply values or approve an assertion. */
export function formatFixtureConsumptionGuidance(module: string, context?: any): string {
    const facts = context?.dependency_fixture_contract;
    const source = typeof context?.code === 'string' ? context.code.replace(/\r\n?/g, '\n') : '';
    if (!facts || facts.schemaVersion !== 'dependency-fixture-contract-v1'
        || !['complete', 'partial'].includes(facts.status) || facts.authority !== 'fixture-shape-only'
        || facts.assertionOracle !== false || facts.patchAuthorization !== false
        || facts.sourceHashKind !== 'normalized-target-source' || !source
        || facts.targetSourceHash !== createHash('sha256').update(source).digest('hex')
        || facts.target !== (context?.class_name ? `${context.class_name}.${context.name}` : context?.name)
        || !Array.isArray(facts.flows) || facts.flows.length > 128) { return ''; }
    const identifier = (value: unknown): value is string => typeof value === 'string'
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(value.normalize('NFKC'));
    const lines: string[] = [];
    for (const flow of facts.flows) {
        const consumption = flow?.resultConsumption;
        if (!consumption || consumption.kind !== 'iterable' || !Array.isArray(consumption.itemAccesses)
            || consumption.itemAccesses.length > 8 || consumption.itemAccesses.some((access: any) => !access
                || access.kind !== 'index' || !Number.isSafeInteger(access.index) || access.index < 0 || access.index >= 256)
            || !flow.root || !identifier(flow.root.name) || !['parameter', 'use-point'].includes(flow.root.kind)
            || flow.method !== null && !identifier(flow.method) || !Array.isArray(flow.steps)
            || flow.steps.length > 64 || flow.steps.some((step: any) => !step
                || !['return_value', 'member', 'context-enter'].includes(step.kind)
                || step.kind === 'member' && !identifier(step.name))) { continue; }
        if (flow.root.kind === 'use-point' && !module) { continue; }
        const receiver = (flow.root.kind === 'parameter' ? flow.root.name : module + '.' + flow.root.name)
            + flow.steps.map((step: any) => step.kind === 'member' ? '.' + step.name
                : step.kind === 'context-enter' ? '.__enter__.return_value' : '.return_value').join('')
            + (flow.method ? '.' + flow.method : '');
        const indexes = [...new Set<number>(consumption.itemAccesses.map((access: any) => access.index))];
        lines.push(`Fixture shape: ${receiver}.return_value is the exact result iterated by the target. `
            + `Configure ${receiver}.return_value as an explicit controlled iterable, not another method's return_value. `
            + (indexes.length ? `Each item must support ${indexes.map(index => '[' + index + ']').join(', ')}; `
                + `a tuple/list fixture needs at least ${Math.max(...indexes) + 1} entries per item (a compatible mapping/object may also satisfy the access). ` : '')
            + 'Choose fixture contents explicitly; this shape supplies no expected output or exception.');
    }
    return lines.length ? lines.join('\n') + '\n' : '';
}

/** Keep compact generation's necessary receiver setup even when optional topology does not fit. */
export function formatFixtureReceiverGuidance(module: string, context?: any): string {
    const facts = context?.dependency_fixture_contract;
    const source = typeof context?.code === 'string' ? context.code.replace(/\r\n?/g, '\n') : '';
    if (!facts || facts.schemaVersion !== 'dependency-fixture-contract-v1'
        || !['complete', 'partial'].includes(facts.status) || facts.authority !== 'fixture-shape-only'
        || facts.assertionOracle !== false || facts.patchAuthorization !== false
        || facts.sourceHashKind !== 'normalized-target-source' || !source
        || facts.targetSourceHash !== createHash('sha256').update(source).digest('hex')
        || facts.target !== (context?.class_name ? `${context.class_name}.${context.name}` : context?.name)
        || !Array.isArray(facts.flows) || facts.flows.length > 128) { return ''; }
    const identifier = (value: unknown): value is string => typeof value === 'string'
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(value.normalize('NFKC'));
    const receivers = new Set<string>();
    for (const flow of facts.flows) {
        if (!flow?.root || !identifier(flow.root.name) || !['parameter', 'use-point'].includes(flow.root.kind)
            || !Array.isArray(flow.steps) || !flow.steps.length || flow.steps.length > 64
            || flow.steps.some((step: any) => !step || !['return_value', 'member', 'context-enter'].includes(step.kind)
                || step.kind === 'member' && !identifier(step.name))
            || !flow.steps.some((step: any) => step.kind === 'return_value' || step.kind === 'context-enter')
            || flow.method !== null && !identifier(flow.method)) { continue; }
        if (flow.root.kind === 'use-point' && !module) { continue; }
        const receiver = (flow.root.kind === 'parameter' ? flow.root.name : module + '.' + flow.root.name)
            + flow.steps.map((step: any) => step.kind === 'member' ? '.' + step.name
                : step.kind === 'context-enter' ? '.__enter__.return_value' : '.return_value').join('');
        receivers.add(receiver);
    }
    // A deeper receiver already preserves each prefix. This is lossless path
    // sharing, not an omission of a distinct source use point or an oracle.
    const paths = [...receivers].filter(receiver => ![...receivers].some(other => other.startsWith(receiver + '.')));
    if (!paths.length) { return ''; }
    const projection = JSON.stringify(paths);
    if (Buffer.byteLength(projection, 'utf8') > 2048) {
        return 'Receiver setup projection omitted whole for size, not absence of dependencies. '
            + 'Read complete TARGET SOURCE for the consumed return objects; unknown stays unknown.\n';
    }
    return 'Source-consumed receiver objects: ' + projection
        + '. Keep these return objects and configure their source-shown methods; replacing an enclosing receiver with None/string/scalar breaks the setup. '
        + 'These are fixture paths only, not patch authorization or expected target values.\n';
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

/** Conditional repair hints for mock call-count and call-argument AssertionErrors. */
export function executionFailureRepairGuidance(output: string): string {
    const hints: string[] = [];
    if (/^TypeError: '(?:types\.)?SimpleNamespace' object is not subscriptable\r?$/m.test(output)) {
        hints.push('INPUT SHAPE REPAIR CHECK: ' + SOURCE_INPUT_SHAPE_GUIDANCE
            + ' Inspect the actual failing receiver in the supplied source; preserve the real target call, controlled values and assertion strength.');
    }
    const multiCall = [...output.matchAll(/^AssertionError: Expected '([A-Za-z_][A-Za-z_0-9]{0,79})' to be called once\. Called ([2-9]|\d{2,}) times\.\r?$/gm)].at(-1);
    if (multiCall) {
        hints.push(`MOCK CALL COUNT CHECK: "${multiCall[1]}" was called ${multiCall[2]} times in its recorded mock history. `
            + 'This count alone does not attribute calls to the target; inspect setup/arrange calls, call_args_list and the source-supported expected history. '
            + 'If setup history must be excluded, reset_mock() immediately before the target call while preserving configured return_value and side_effect. '
            + 'Retain justified exact counts, arguments and order; do not weaken a failed once assertion to assert_any_call merely to pass.');
    }
    const zeroCall = [...output.matchAll(/^AssertionError: Expected '([A-Za-z_][A-Za-z_0-9]{0,79})' to (?:be called once\. Called 0 times\.|have been called\.)\r?$/gm)].at(-1);
    if (zeroCall) {
        hints.push(`MOCK UNCALLED CHECK: "${zeroCall[1]}" was called 0 times. Verify that the patch targets the exact binding read by the target, `
            + 'that the assertion checks the consumed receiver chain (such as return_value / __enter__.return_value), and that the test inputs reach that branch.');
    }
    if (/^AssertionError: expected call not found\.\r?$/m.test(output)) {
        hints.push('MOCK CALL ARGUMENT CHECK: Compare Expected vs Actual call arguments against TARGET SOURCE and SOURCE CALL SETUP. '
            + 'Retain source-shown argument conversions (such as str(path) vs Path) and read module-global arguments from the canonical target module rather than an upstream variable. '
            + 'String call arguments include exact whitespace and newlines: use the original source literal, not a flattened paraphrase or the failing Expected value. '
            + 'Do not normalize either side merely to hide a mismatch.');
    }
    const immutablePatch = [...output.matchAll(/^TypeError: cannot set '([^'\r\n]+)' attribute of immutable type '([^'\r\n]+)'\r?$/gm)].at(-1);
    if (immutablePatch) {
        hints.push(`IMMUTABLE TYPE PATCH CHECK: Cannot patch "${immutablePatch[1]}" directly on immutable type "${immutablePatch[2]}". `
            + `Patch the owning dependency binding in the target module instead (for example, with patch("target_module.datetime") as clock_stub) and configure clock_stub.${immutablePatch[1]}.return_value.`);
    }
    return hints.join('\n');
}
