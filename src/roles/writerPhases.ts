/** Instructions are additive to the existing evidence and Python output contract. */
export function buildWriterSeedPrompt(evidencePrompt: string): string {
    return `${evidencePrompt}\n\nWRITER_SEED_V1\n`
        + 'One verified case, exactly one test method; imports/fixtures; real target call. '
        + 'Assert observed return/exception or explicitly controlled dependency behavior; do not invent an expected value or exception. '
        + 'No rule-name/speculative tests, copied source or target mocks. '
        + 'Host must execute this seed successfully before expansion; existing output contract.';
}

export function buildWriterExpansionPrompt(evidencePrompt: string, baselineCode: string, gap: string): string {
    const baseline = evidencePrompt.includes(baselineCode)
        ? 'The EXECUTED BASELINE is already supplied above; preserve its imports, fixtures, methods, inputs and assertions.\n'
        : `EXECUTED BASELINE (preserve these imports, fixtures, methods, inputs and assertions):\n\`\`\`python\n${baselineCode}\n\`\`\`\n`;
    // Keep the baseline as one complete unit. The orchestrator's shared prompt
    // budget must reject an oversized request, rather than slice Python here.
    return `${evidencePrompt}\n\nWRITER_EXPANSION_V2\n`
        + baseline
        + `ONE REQUESTED GAP (a hypothesis until verified):\n${gap}\n`
        + 'Return the complete unittest file, preserving the executed baseline unchanged and adding one focused test for this gap. '
        + 'You are responsible for writing the new test; tools provide observations and candidate inputs, never a preapproved test addition. '
        + 'Use only exact verified observations or explicit same-test dependency controls for expected values. '
        + 'For state observations, preserve the exact constructor and ordered target calls; assert only the observed return, exception arguments and state. '
        + 'A measured implementation behavior is not independent proof that the implementation meets its requirements. '
        + 'Keep the real target. Do not rename, delete, weaken, replace, or duplicate passing cases. '
        + 'If evidence cannot support an additional assertion, return the unchanged baseline. '
        + 'The host will validate and execute the addition, then obtain approval from a separate Reviewer before mutation; '
        + 'this request does not certify coverage or mutation quality. '
        + 'Use the existing Python output contract.';
}
