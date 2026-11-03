import { createHash } from 'node:crypto';
import { AnalysisStageError } from '../utils/executionFailureCategory';

/** Pure builtin reference calculation; never imports or evaluates application code. */
export function digestReferenceHypotheses(value: any): { basis: 'hashlib-reference-v1'; limitation: string;
    corrections: Array<Record<string, unknown>> } | undefined {
    if (value?.basis !== 'hashlib-reference-v1') { return undefined; }
    const invalid = (): never => { throw new AnalysisStageError('validation', 'source-expectation-reference',
        'Invalid bounded digest reference descriptor.'); };
    const algorithms: Record<string, string> = { md5: 'md5', sha1: 'sha1', sha224: 'sha224', sha256: 'sha256',
        sha384: 'sha384', sha512: 'sha512', sha3_224: 'sha3-224', sha3_256: 'sha3-256',
        sha3_384: 'sha3-384', sha3_512: 'sha3-512' };
    if (value.changed !== false || !Array.isArray(value.referenceOperations)
        || !value.referenceOperations.length || value.referenceOperations.length > 32) { return invalid(); }
    const corrections: Array<Record<string, unknown>> = [];
    for (const operation of value.referenceOperations) {
        if (!operation || operation.version !== 'hashlib-reference-v1'
            || typeof operation.algorithm !== 'string' || !Object.hasOwn(algorithms, operation.algorithm)
            || !['utf-8', 'utf8', 'ascii', 'latin-1', 'latin1'].includes(operation.encoding)
            || typeof operation.inputBytesHex !== 'string' || operation.inputBytesHex.length > 2048
            || !/^(?:[a-f0-9]{2})*$/.test(operation.inputBytesHex)
            || typeof operation.method !== 'string'
            || !/^[_\p{ID_Start}][_\p{ID_Continue}]*\.test_[_\p{ID_Continue}]+$/u.test(operation.method)
            || !Number.isSafeInteger(operation.line) || operation.line < 1 || operation.line > 1000000
            || typeof operation.previous !== 'string' || operation.previous.length > 256) { return invalid(); }
        const data = Buffer.from(operation.inputBytesHex, 'hex');
        let calculated: string;
        try { calculated = createHash(algorithms[operation.algorithm]).update(data).digest('hex'); }
        catch { return undefined; } // A local crypto policy may disable an otherwise known algorithm.
        if (calculated !== operation.previous) {
            corrections.push({ method: operation.method, line: operation.line, previous: operation.previous, calculated,
                basis: { operation: 'stdlib-digest-reference', algorithm: operation.algorithm, encoding: operation.encoding,
                    inputHash: createHash('sha256').update(data).digest('hex'), assertionOracle: false } });
        }
    }
    return corrections.length ? { basis: 'hashlib-reference-v1',
        limitation: 'Unverified source-supported standard-library reference. AI revision and isolated execution are required.', corrections } : undefined;
}
