/** Convert a dynamic-trace value into a Python assertion literal without double-quoting strings. */
export function toPythonAssertionLiteral(result: string | undefined, resultType?: string): string {
    const value = result ?? 'None';
    if (resultType === 'NoneType') {
        return 'None';
    }
    if (resultType === 'bool') {
        return value === 'True' ? 'True' : 'False';
    }
    if (resultType === 'int' || resultType === 'float') {
        return value;
    }

    // dynamic_tracer uses Python repr(), so quoted strings, lists, dicts, tuples,
    // and None are already valid Python literals. Re-serializing a quoted string
    // would turn 'answer' into "'answer'" and make the assertion fail.
    if (/^(?:['\"].*['\"]|\[.*\]|\{.*\}|\(.*\)|None|True|False|-?\d+(?:\.\d+)?)$/s.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}
