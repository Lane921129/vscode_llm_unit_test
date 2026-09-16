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
        ...(owner ? ['Never import the method as a top-level function. Reuse the verified instance setup; do not invent constructor arguments.'] : [])
    ].join('\n');
}
