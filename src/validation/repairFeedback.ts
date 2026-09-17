/** Keep failure feedback useful even when runner stack traces are very long. */
export function summarizeRepairOutput(output: string, budget = 6000): string {
    if (output.length <= budget) { return output; }
    const blocks = output.split(/(?=^(?:FAIL|ERROR): )/m);
    if (blocks.length === 1) {
        const half = Math.floor((budget - 80) / 2);
        return `${output.slice(0, half)}\n... runner output omitted; full log retained ...\n${output.slice(-half)}`;
    }
    const failures = blocks.slice(1);
    const preamble = blocks[0].length > 800 ? blocks[0].slice(0, 800) + '\n... runner preamble omitted ...' : blocks[0];
    const perBlock = Math.max(160, Math.floor((budget - preamble.length - 200) / failures.length));
    return preamble + '\n' + failures.map(block => {
        if (block.length <= perBlock) { return block; }
        const header = block.split('\n')[0];
        return `${header}\n... stack frames omitted ...\n${block.slice(-Math.max(80, perBlock - header.length - 40))}`;
    }).join('\n') + '\nFull runner output is retained in the report.';
}

/** Runner timing and shifted stack line numbers do not make a failure new. */
export function repairFailureKey(output: string): string {
    return output.replace(/\r\n/g, '\n')
        .replace(/^(Ran \d+ tests? in )\d+(?:\.\d+)?s\s*$/gm, '$1<elapsed>')
        .replace(/^(\s*File "[^"]+", line )\d+(, in .*)$/gm, '$1<line>$2').trim();
}

/** Verbose unittest IDs include the class, so different suites cannot collide. */
export function passingTestIds(output: string): Set<string> {
    const passing = new Set<string>();
    let current: string | undefined;
    for (const line of output.split(/\r?\n/)) {
        const start = line.match(/^test\S* \(([^)\n]+)\)/);
        if (start) { current = start[1]; }
        // unittest puts a method docstring on a second line in verbose mode.
        if (current && / \.\.\. ok\s*$/.test(line)) { passing.add(current); current = undefined; }
        else if (/ \.\.\. (?:FAIL|ERROR|skipped|expected failure|unexpected success)/.test(line)) { current = undefined; }
    }
    return passing;
}

export class RepairFeedback {
    private readonly seen = new Set<string>();
    private passing: Set<string>;
    public output: string;

    constructor(code: string, output: string) {
        this.seen.add(code.trim());
        this.passing = passingTestIds(output);
        this.output = output;
    }

    /** Repeated candidates consume an attempt but never re-run unchanged tests. */
    consider(code: string, latestFailure = this.output): boolean {
        const normalized = code.trim();
        if (this.seen.has(normalized)) {
            this.output = `NO CHANGE: this candidate was already tried. Make a focused correction using the latest failure below.\n${latestFailure.replace(/^(?:NO CHANGE:[^\n]*\n)+/, '')}`;
            return false;
        }
        this.seen.add(normalized);
        return true;
    }

    reject(reason: string): void {
        this.output = `CANDIDATE REJECTED; the previous test file is retained.\n${reason}\n\nPrevious execution:\n${this.output}`;
    }

    record(output: string): { accepted: boolean; regressed: string[] } {
        const passing = passingTestIds(output);
        const regressed = [...this.passing].filter(id => !passing.has(id));
        if (regressed.length > 0) {
            this.reject(`Previously passing tests failed, disappeared, or were skipped: ${regressed.join(', ')}\nRejected candidate execution:\n${output}`);
            return { accepted: false, regressed };
        }
        this.passing = passing;
        this.output = output;
        return { accepted: true, regressed: [] };
    }
}
