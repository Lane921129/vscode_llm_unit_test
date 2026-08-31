/**
 * Return a deterministic assertion for a trivially inspectable stub body.
 * Only Python literals are accepted, so generated smoke tests never execute
 * source expressions merely to manufacture an expected value.
 */
export function buildStubSmokeAssertion(sourceCode: string): string | null {
    const source = sourceCode.trim();
    if (/:\s*pass\s*$/.test(source) || /\breturn\s+None\s*$/.test(source)) {
        return 'self.assertIsNone(result)';
    }
    const literalReturn = source.match(/\breturn\s+(True|False|-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*$/m);
    return literalReturn ? `self.assertEqual(result, ${literalReturn[1]})` : null;
}
