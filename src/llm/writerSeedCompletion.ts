/** Code-completion recovery for an observed instruction echo, never a model-name
 * policy. The caller supplies a canonical, body-free wrapper from targetContract. */
export function writerSeedCompletionPrompt(system: string, prompt: string, prefix: string): string {
    // Prefixing each line is reversible; no required evidence is removed, sliced,
    // evaluated, or promoted to an expected value. The only live Python is packaging.
    return (system + '\n' + prompt).split('\n').map(line => '# ' + line).join('\n')
        + '\n# Continue ONLY the indented test body below. Use the exact evidence above.\n'
        + '# The file wrapper is supplied; write setup, the real call and assertion yourself.\n'
        + '# Do not repeat comments or the wrapper. End after this one test.\n' + prefix;
}

/** Called only after the normal receiver establishes a complete stop response.
 * Keep model bytes intact. A complete fenced file is already a whole artifact;
 * otherwise the response is the literal continuation of the declared wrapper. */
export function assembleWriterSeedCompletion(prefix: string, response: string): string {
    return /^\s*```(?:python|py)\s*\r?\n/.test(response) ? response : prefix + response;
}
