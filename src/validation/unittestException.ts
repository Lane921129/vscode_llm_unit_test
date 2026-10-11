export type WholeCandidateNameException = 'NameError' | 'UnboundLocalError';

/**
 * Runner text is only a conservative role-scheduling hint, never proof of the
 * missing binding's owner, an installation need, or permission to change source.
 * Ambiguous output (including chained tracebacks) keeps the existing route.
 */
export function wholeCandidateNameException(output: string): WholeCandidateNameException | undefined {
    if (output.length > 262144) { return undefined; }
    const lines = output.replace(/\r\n/g, '\n').split('\n');
    const headers = lines.flatMap((line, index) => /^(?:ERROR|FAIL): /.test(line) ? [index] : []);
    if (headers.length !== 1) { return undefined; }
    const start = headers[0];
    const header = lines[start].match(/^ERROR: (test_[A-Za-z0-9_]+) \(([A-Za-z_][A-Za-z0-9_.]*)\)$/);
    if (!header || !header[2].endsWith('.' + header[1])
        || lines[start - 1] !== '='.repeat(70) || lines[start + 1] !== '-'.repeat(70)) { return undefined; }
    const end = lines.findIndex((line, index) => index > start + 1 && line === '-'.repeat(70)
        && /^Ran [1-9]\d* tests? in \d+(?:\.\d+)?s$/.test(lines[index + 1] || ''));
    if (end < 0) { return undefined; }
    const summary = lines.slice(end + 2).find(line => line.trim());
    if (summary !== 'FAILED (errors=1)') { return undefined; }
    const traceback = lines.slice(start + 2, end);
    while (traceback[0] === '') { traceback.shift(); }
    if (traceback[0] !== 'Traceback (most recent call last):'
        || traceback.slice(1).some(line => line === 'Traceback (most recent call last):'
            || line === 'During handling of the above exception, another exception occurred:'
            || line === 'The above exception was the direct cause of the following exception:')) { return undefined; }
    let frames = 0;
    for (const line of traceback.slice(1)) {
        if (/^  File ".+", line [1-9]\d*, in .+$/.test(line)) { frames++; continue; }
        if (!line || /^\s/.test(line)) { continue; }
        // The first unindented line ends the frames. Everything after it can be
        // arbitrary multiline exception text, so never scan onward for a name.
        if (!frames) { return undefined; }
        const exception = line.match(/^(NameError|UnboundLocalError)(?::|$)/);
        return exception?.[1] as WholeCandidateNameException | undefined;
    }
    return undefined;
}
