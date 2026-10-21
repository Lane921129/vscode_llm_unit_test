import { createHash } from 'node:crypto';
import { isolatedResourceSystemRule } from '../prompts/isolatedResourceContext';

/** Select packaging only. The model still authors the complete test body. */
export function selectWriterAdditionMethodName(baselineHash: string, focus: string,
    existingMethodIds: readonly string[]): string {
    const focusHash = createHash('sha256').update(focus).digest('hex').slice(0, 12);
    const prefix = `test_add_${baselineHash.slice(0, 12)}_${focusHash}`;
    const names = new Set(existingMethodIds.map(id => id.slice(id.lastIndexOf('.') + 1)));
    let name = prefix;
    for (let suffix = 2; names.has(name); suffix++) { name = `${prefix}_${suffix}`; }
    return name;
}

export function buildWriterAdditionMethodInstruction(methodName: string): string {
    return '\n\nWRITER_ADDITION_METHOD_V1\n'
        + 'Use this host-selected NEW method signature; its name is distinct from the AST inventory of the executed baseline. '
        + 'You must author its setup, target calls and assertions using the supplied evidence. '
        + 'A fresh name does not make a repeated scenario new or grant execution, review or mutation approval.\n'
        + `def ${methodName}(self):\n`;
}

/** A seed has its own small contract. Do not first ask for a comprehensive
 * suite and then ask a small model to override that instruction. The complete
 * target, setup and evidence are supplied separately, unchanged. */
export function buildWriterSeedSystemPrompt(systemPrompt: string, isAsync?: boolean): string {
    void systemPrompt; // Retain the existing call signature, not wider suite instructions.
    const invocation = isAsync === true
        ? 'The selected target is async: use unittest.IsolatedAsyncioTestCase, async def test_ and await its call. '
        : isAsync === false
            ? 'The selected target is synchronous: use unittest.TestCase and def test_; call it directly, never await it. '
            : 'Use unittest.TestCase for synchronous targets; only an async target needs IsolatedAsyncioTestCase, async def and await. ';
    return 'WRITER_SEED_V1 OUTPUT SCOPE\n'
        + 'Write a minimal runnable Python unittest file: exactly ONE test method and ONE target call. '
        + 'Return one python code fence, no prose or explanation. Include explicit unittest, target and helper imports; '
        + invocation + 'Use test_ methods and self.assert*. No pytest or top-level assert. '
        + 'Use the exact target module/class/property/constructor contract; never copy, redefine or mock the target or owner. '
        + 'When WRITER_SEED_CASE_FACTS_V1 is supplied, use ONLY that selected executed case and its exact input; copy targetCall when provided. '
        + 'Otherwise use one source-supported same-test controlled dependency case. Never guess outputs, exceptions, fixtures or imports; source expressions and diagnostics are not assertion oracles. '
        + 'Use exact observed results or explicit same-test controls; never call dependencies to calculate expected values. '
        + 'Use with self.assertRaises(ExactType) for an evidenced exception, no message second argument. '
        + 'Pure calculations need no mocks; control external/ambient boundaries only at their source use points with fresh per-test state. '
        + 'Never patch immutable built-in class members; replace the owning module binding. '
        + 'No direct test network, file I/O, shell, dynamic execution or shared SQLite; no skip, swallowed errors or tautologies. '
        + 'After this one test, close the code fence and stop. Expansion follows successful execution; independent Reviewer approval remains required.'
        + isolatedResourceSystemRule();
}

export function buildWriterAdditionSystemPrompt(systemPrompt: string): string {
    return `${systemPrompt}\n\nWRITER_ADDITION_V1 OUTPUT MODE\n`
        + 'For this request, replace the complete-file packaging requirement with one Python fence containing only the new test addition: '
        + 'needed imports plus a unittest class, or a complete top-level test method for the single baseline class. '
        + 'Replace comprehensive-suite and all-survivor scope with the current focus only: one NEW test method. '
        + 'That method may contain multiple target calls and must exercise EVERY supplied bound case exactly; '
        + 'do not add unrelated zero, negative or exception inputs. '
        + 'The host preserves and merges the executed baseline. Do not rewrite passing methods or fixtures. '
        + 'All target binding, evidence, assertion and isolation rules above still apply.';
}

export function buildWriterSeedPrompt(evidencePrompt: string): string {
    return `${evidencePrompt}\n\nWRITER_SEED_V1\n`
        + 'One test method and one real target call; explicit imports/fixtures. '
        + 'Use WRITER_SEED_CASE_FACTS_V1 if supplied; else one source-supported, same-test controlled dependency case. '
        + 'Diagnostics never supply fixture values/types/imports. '
        + 'No guesses, speculative tests, copied source or target mocks. '
        + 'Pass execution before expansion; existing output contract.';
}

/** A prefix inside a larger unapproved draft is not a complete baseline unit. */
function completePythonCodeAlreadySupplied(prompt: string, code: string): boolean {
    return [...prompt.matchAll(/^```(?:python|py)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gm)]
        .some(match => match[1] === code);
}

export function buildWriterExpansionPrompt(evidencePrompt: string, baselineCode: string, gap: string): string {
    const baseline = completePythonCodeAlreadySupplied(evidencePrompt, baselineCode)
        ? 'The EXECUTED BASELINE is already supplied above; the host preserves its imports, fixtures, methods, inputs and assertions.\n'
        : `EXECUTED BASELINE (the host preserves these imports, fixtures, methods, inputs and assertions):\n\`\`\`python\n${baselineCode}\n\`\`\`\n`;
    // Keep the baseline as one complete unit. The orchestrator's shared prompt
    // budget must reject an oversized request, rather than slice Python here.
    return `${evidencePrompt}\n\nWRITER_ADDITION_V1\n`
        + baseline
        + `ONE REQUESTED GAP (a hypothesis until verified):\n${gap}\n`
        + 'Return only the Python addition for one focused test for this gap: imports if needed, followed by a unittest class containing the new test, or a complete top-level def test_...(self) method when the baseline has exactly one TestCase class. '
        + 'Use the baseline class name to inherit its existing fixtures; use a unique class name only when the addition needs its own fixtures. '
        + 'Do not return or rewrite passing tests. The host merges the addition while preserving the executed baseline unchanged; conflicting imports, fixtures and existing method changes are rejected. '
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

/** The original executed bytes stay with the host. This projection supplies
 * only AST-proven imports/class setup, never old test inputs or assertions. */
export function buildWriterCaseAdditionPrompt(evidencePrompt: string, contextCode: string,
    baselineHash: string, methodIds: readonly string[], gap: string): string {
    return `${evidencePrompt}\n\nWRITER_CASE_ADDITION_V1\n`
        + 'BASELINE SETUP CONTEXT (AST projection only; existing test bodies remain unchanged with the host):\n'
        + `\`\`\`python\n${contextCode}\n\`\`\`\n`
        + JSON.stringify({ baselineHash, existingMethodIds: methodIds }) + '\n'
        + `CURRENT CASE: ${gap}\n`
        + 'Write only one NEW test method with the required signature and the exact current observed call/result. '
        + 'The setup context is not an executable test candidate: do not copy its pass or create guessed cases. '
        + 'The host merges your addition into the original complete executed baseline, preserves its bytes and then '
        + 'validates the full family, executes, obtains independent Reviewer approval and measures mutation. '
        + 'A projected setup or an observed result alone certifies none of those stages.';
}

/** A repair replaces the unaccepted addition, never the immutable baseline. */
export function buildWriterAdditionRevisionPrompt(evidencePrompt: string, baselineCode: string,
    currentCode: string, feedback = ''): string {
    const prompt = buildWriterExpansionPrompt(evidencePrompt, baselineCode, feedback || 'Repair the unaccepted addition using the supplied execution/review evidence.');
    const draft = completePythonCodeAlreadySupplied(evidencePrompt, currentCode) ? 'The current unaccepted candidate is already supplied above.\n'
        : `CURRENT UNACCEPTED CANDIDATE (reference only):\n\`\`\`python\n${currentCode}\n\`\`\`\n`;
    return `${prompt}\n\nWRITER_ADDITION_REVISION_V1\n${draft}`
        + 'Return the replacement addition only. You may correct methods that belong to the unaccepted addition; '
        + 'do not copy or edit the EXECUTED BASELINE. The host merges with that original baseline, not with this failed draft. '
        + 'Existing preservation, structure, execution and same-candidate Reviewer approval still apply.';
}
