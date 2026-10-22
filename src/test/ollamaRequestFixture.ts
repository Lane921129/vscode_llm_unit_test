import * as assert from 'node:assert/strict';

/** Explicit metadata fixtures stay separate from generation replies and role counters. */
export function ollamaRuntimeMetadataFixture(url: string | URL | Request, options: RequestInit | undefined,
    identity: { modelName: string; contextLength?: number; observedContextTokens?: number; metadataAvailable?: boolean }): Response | undefined {
    const pathname = new URL(typeof url === 'string' || url instanceof URL ? url : url.url).pathname;
    if (!['/api/show', '/api/ps'].includes(pathname)) { return undefined; }
    if (identity.metadataAvailable === false) { return new Response('{}', { status: 503 }); }
    if (pathname === '/api/show') {
        assert.equal(options?.method, 'POST');
        assert.equal(JSON.parse(String(options?.body)).model, identity.modelName, 'runtime metadata belongs to the exact selected model');
        return new Response(JSON.stringify({ model_info: { 'general.architecture': 'fixture',
            'fixture.context_length': identity.contextLength ?? 32768 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ models: identity.observedContextTokens === undefined ? []
        : [{ name: identity.modelName, context_length: identity.observedContextTokens }] }), { status: 200 });
}

/** Model fixtures may use only the exact executed case supplied by the host. */
export function readObservedSeedCaseForModelFixture(prompt: string, target: string): {
    args: string[]; kwargs: Record<string, string>; observedResult?: string;
    observedOutcome: 'returned' | 'raised'; exception?: { module: string; qualname: string }
} | undefined {
    const row = /WRITER_SEED_CASE_FACTS_V1\n([^\n]+)/.exec(prompt)?.[1];
    if (!row) { return undefined; }
    const value = JSON.parse(row);
    assert.equal(value.target, target);
    assert.ok(value.caseId && /^[a-f0-9]{64}$/.test(value.sourceHash));
    assert.ok(Array.isArray(value.args) && value.args.every((item: unknown) => typeof item === 'string'));
    assert.ok(value.kwargs && Object.values(value.kwargs).every(item => typeof item === 'string'));
    assert.ok(['returned', 'raised'].includes(value.observedOutcome));
    if (value.observedOutcome === 'returned') { assert.equal(typeof value.observedResult, 'string'); }
    else { assert.ok(value.exception?.module === 'builtins' && typeof value.exception.qualname === 'string'); }
    return value;
}

/** A mocked Writer reads the current bound packet, not accumulated global Trace examples. */
export function readCurrentFocusCasesForModelFixture(prompt: string, target: string): Array<{ args: string[]; result: string }> {
    const packets = prompt.split('\n').flatMap(line => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { return []; }
        return Array.isArray(value) ? value.filter(item => item?.origin === 'controlled-focus-observations'
            && item.binding?.target === target) : [];
    });
    assert.equal(packets.length, 1, 'one source-bound current focus packet is required');
    return packets[0].observations.map((observation: any) => {
        assert.equal(observation.observedOutcome, 'returned');
        assert.ok(Array.isArray(observation.args) && observation.args.every((item: unknown) => typeof item === 'string'));
        assert.deepEqual(observation.kwargs, {});
        assert.equal(typeof observation.observedResult, 'string');
        return { args: observation.args, result: observation.observedResult };
    });
}

/** Decode the real wire prompt for fixture routing; never route on the ignored system field. */
export function readOllamaRoleRequest(wire: any): any & { roleInstructions: string; prompt: string; transmittedPrompt: string } {
    assert.equal(wire.system, wire.raw === true ? undefined : ' ',
        'raw completion omits system; normal transport suppresses the Modelfile fallback');
    assert.equal(typeof wire.prompt, 'string');
    const decodedPrompt = wire.raw === true ? wire.prompt.split('\n').map((line: string) =>
        line.startsWith('# ') ? line.slice(2) : line).join('\n') : wire.prompt;
    if (wire.raw === true) { assert.match(wire.prompt, /^# WRITER_SEED_V1 OUTPUT SCOPE\n/); }
    assert.match(decodedPrompt, /^(?:You are |EXECUTION_VERIFICATION_V1 Writer:|WRITER_SEED_V1 OUTPUT SCOPE\n)/,
        'role instructions must lead the actual transmitted prompt');
    // Known request envelopes start on their own line. Match their first
    // occurrence, before any target/test source can quote another role.
    const start = /^(?:=== ANALYSIS EVIDENCE V2 ===|REVIEW_REQUEST_V7|QUALITY_TASK_V[34]|BUG_FIX_REQUEST_V5|WRITER_REVISION_REQUEST_V2|EXECUTION_VERIFICATION_V1|compact-writer-v[12] \(metadata, never an import\)|Target function: [^\r\n]+)\r?$/m.exec(decodedPrompt);
    assert.ok(start && start.index > 0, 'fixture needs an explicit user-request boundary; do not guess from evidence text');
    const roleInstructions = decodedPrompt.slice(0, start.index - 1);
    const prompt = decodedPrompt.slice(start.index);
    assert.equal(roleInstructions + '\n' + prompt, decodedPrompt, 'the complete wire text must survive decoding');
    return { ...wire, roleInstructions, prompt, transmittedPrompt: wire.prompt };
}
