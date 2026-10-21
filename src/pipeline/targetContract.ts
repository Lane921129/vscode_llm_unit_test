/** One target binding shared by Writer, Reviewer and focused repair. */
export function formatTargetContract(module: string, name: string, args: string[], context?: any): string {
    const className = context?.class_name || context?.class_context?.name;
    const leaf = name.split('.').pop() || name;
    const owner = className || (name.includes('.') ? name.split('.')[0] : undefined);
    const kind = context?.method_kind || (owner ? 'instance' : 'module');
    const receiver = owner && ['instance', 'property'].includes(kind) ? 'instance' : owner;
    const callable = receiver ? `${receiver}.${leaf}` : leaf;
    const invocation = kind === 'property' ? callable : `${callable}(${args.join(', ')})`;
    return [
        `Target import: from ${module} import ${owner || leaf}`,
        `Target module: ${module}; prompt IDs and example_target are not target imports.`,
        `Target qualified name: ${owner ? owner + '.' : ''}${leaf}`,
        `Target binding: ${kind}${context?.is_async ? ' (await required)' : ''}`,
        `Target signature: ${invocation}`,
        `AST signature (input shape, not oracle): ${JSON.stringify(context?.signature || [])}`,
        ...(owner ? ['Never import the method as a top-level function.',
            ...(['static', 'class'].includes(kind)
                ? ['Call this method on the class. No instance setup or mock is required merely because it is a static/class method.']
                : ['Reuse the verified instance setup; do not invent constructor arguments.'])] : []),
        'Keep the selected target real. Mock only its dependencies; never patch the target itself or change its implementation/decorators.'
    ].join('\n');
}

/** Packaging only: no input, call, fixture value, expected value or assertion is
 * authored here. An incomplete prefix must never become an executable candidate. */
export function formatWriterSeedPackaging(module: string, name: string, context?: any): string {
    const identifier = (value: unknown): value is string => typeof value === 'string'
        && /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(value.normalize('NFKC'));
    const owner = context?.class_name || context?.class_context?.name || (name.includes('.') ? name.split('.')[0] : undefined);
    const imported = owner || name;
    if (!module.split('.').every(identifier) || !identifier(imported) || imported === 'unittest'
        || typeof context?.is_async !== 'boolean') { return ''; }
    const harness = imported === 'GeneratedSeedTests' ? 'GeneratedSeedCases' : 'GeneratedSeedTests';
    return 'WRITER_SEED_PACKAGING_V1 (incomplete prefix, not an executable test or assertion evidence)\n'
        + 'Start the returned test file with these imports and unittest wrapper; add any required helper imports. '
        + 'Then author the setup, ONE real target call and its evidence-supported assertion inside this method.\n'
        + '```python\nimport unittest\n' + `from ${module} import ${imported}\n\n`
        + `class ${harness}(unittest.${context.is_async ? 'IsolatedAsyncioTestCase' : 'TestCase'}):\n`
        + `    ${context.is_async ? 'async def' : 'def'} test_seed(self):\n` + '```\n'
        + 'Return the COMPLETE test file in one Python fence; do not return this empty prefix, source implementation, plans or explanations.';
}
