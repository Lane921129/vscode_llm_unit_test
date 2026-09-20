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
