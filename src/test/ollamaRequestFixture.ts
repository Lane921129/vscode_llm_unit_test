import * as assert from 'node:assert/strict';

/** Decode the real wire prompt for fixture routing; never route on the ignored system field. */
export function readOllamaRoleRequest(wire: any): any & { roleInstructions: string; prompt: string; transmittedPrompt: string } {
    assert.equal(wire.system, ' ', 'local transport suppresses Modelfile system fallback without carrying the role twice');
    assert.equal(typeof wire.prompt, 'string');
    assert.match(wire.prompt, /^(?:You are |EXECUTION_VERIFICATION_V1 Writer:)/,
        'role instructions must lead the actual transmitted prompt');
    // Known request envelopes start on their own line. Match their first
    // occurrence, before any target/test source can quote another role.
    const start = /^(?:=== ANALYSIS EVIDENCE V2 ===|REVIEW_REQUEST_V7|QUALITY_TASK_V3|BUG_FIX_REQUEST_V5|WRITER_REVISION_REQUEST_V2|EXECUTION_VERIFICATION_V1|compact-writer-v1 \(metadata, never an import\)|Target function: [^\r\n]+)\r?$/m.exec(wire.prompt);
    assert.ok(start && start.index > 0, 'fixture needs an explicit user-request boundary; do not guess from evidence text');
    const roleInstructions = wire.prompt.slice(0, start.index - 1);
    const prompt = wire.prompt.slice(start.index);
    assert.equal(roleInstructions + '\n' + prompt, wire.prompt, 'the complete wire text must survive decoding');
    return { ...wire, roleInstructions, prompt, transmittedPrompt: wire.prompt };
}
