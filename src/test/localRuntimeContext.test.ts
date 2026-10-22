import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextInputBudget, promptFits, resolveLocalRuntimeContext, runtimeContextWindow } from '../prompts/promptBudget';
import { getOllamaModelConnectionMetadata } from '../llm/ollamaRuntime';
import { LOCAL_RUNTIME_QUALIFICATION_VERSION, ModelQualificationProfile, QUALIFICATION_VERSION,
    qualificationAppliesToRequest, qualificationForRequest } from '../llm/modelQualification';
import { qualifiedRole } from '../llm/roleQualification';
import { buildOllamaRoleQualificationProbe } from '../llm/ollamaCapability';

test('selected capacities have the same input budget across parameter sizes without an automatic size cap', () => {
    for (const paramSize of ['500M', '2B', '3B', '7B', '13B', '31B', 'unknown']) {
        for (const [contextLength, contextWindow, inputBudget] of [
            [2048, 2048, 1433], [4096, 4096, 2867], [4097, 4097, 2867],
            [8192, 8192, 5734], [16384, 16384, 11468], [32768, 32768, 22937],
            [131072, 131072, 91750]
        ]) {
            assert.equal(runtimeContextWindow(paramSize, contextLength), contextWindow);
            assert.equal(contextInputBudget(paramSize, contextLength), inputBudget);
        }
    }
});

test('known model limits allocate half in automatic mode independently of size and stale runtime records', () => {
    for (const paramSize of ['500M', '2B', '3B', '13B', '31B', 'unknown']) {
        for (const [contextLength, contextWindow, inputBudget] of [
            [1, 1, 0], [3, 1, 0], [2048, 1024, 716], [4097, 2048, 1433],
            [8192, 4096, 2867], [32768, 16384, 11468], [131072, 65536, 45875],
            [Number.MAX_SAFE_INTEGER, 4503599627370495, 3152519739159346]
        ]) {
            for (const runtimeContextTokens of [undefined, 0]) {
                const expected = { ok: true, configuredTokens: 0, mode: 'automatic', contextWindow, inputBudget };
                const base = { paramSize, contextLength, contextLengthKnown: true, runtimeContextTokens };
                assert.deepEqual(resolveLocalRuntimeContext(base), expected);
                assert.deepEqual(resolveLocalRuntimeContext({ ...base,
                    preferredRuntimeContextTokens: 5000, preferredRuntimeContextSource: 'captured-runtime',
                    qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8572 },
                    effectiveRuntimeContextTokens: 12288 }), expected,
                'saved captures, prior qualification and current allocation cannot pin known-limit automatic mode');
            }
        }
    }
});

test('explicit selection wins over saved preference, qualified runtime and the current API allocation', () => {
    const profile = { paramSize: '3B', contextLength: 32768, contextLengthKnown: true,
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8572 },
        effectiveRuntimeContextTokens: 16384, preferredRuntimeContextTokens: 8192,
        preferredRuntimeContextSource: 'user-choice' as const };
    assert.deepEqual(resolveLocalRuntimeContext(profile), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 8192, inputBudget: 5734
    });
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, runtimeContextTokens: 32768 }), {
        ok: true, configuredTokens: 32768, mode: 'explicit', contextWindow: 32768, inputBudget: 22937
    });
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, preferredRuntimeContextTokens: 0 }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 16384, inputBudget: 11468
    }, 'clearing a user preference restores half of the known limit, not an older qualified runtime');
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, preferredRuntimeContextTokens: undefined, qualificationRuntime: undefined }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 16384, inputBudget: 11468
    });
});

test('captured runtime survives an unknown-metadata restart without becoming a new explicit user choice', () => {
    const metadata = { paramSize: '3B', contextLength: 4096, contextLengthKnown: false };
    const first = resolveLocalRuntimeContext({ ...metadata, effectiveRuntimeContextTokens: 12288 });
    assert.deepEqual(first, { ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 12288, inputBudget: 8601 });
    const saved = JSON.parse(JSON.stringify({ preferredRuntimeContextTokens: 12288, preferredRuntimeContextSource: 'captured-runtime' }));
    assert.deepEqual(resolveLocalRuntimeContext({ ...metadata, ...saved }), first);
    assert.deepEqual(resolveLocalRuntimeContext({ ...metadata, ...saved, preferredRuntimeContextSource: 'user-choice' }), first);
    assert.deepEqual(resolveLocalRuntimeContext({ ...metadata, preferredRuntimeContextTokens: 12288 }), {
        ok: false, reasonCode: 'runtime-context-metadata-required'
    }, 'legacy preferences without origin cannot impersonate observed allocation');
});

test('unknown model limits retain captured, qualified and observed runtime fallback order', () => {
    const profile = { paramSize: '3B', contextLength: 32768, contextLengthKnown: false,
        qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 8572 },
        effectiveRuntimeContextTokens: 16384 };
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, preferredRuntimeContextTokens: 8192,
        preferredRuntimeContextSource: 'captured-runtime' }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 8192, inputBudget: 5734
    });
    assert.deepEqual(resolveLocalRuntimeContext(profile), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 8572, inputBudget: 6000
    });
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, qualificationRuntime: undefined }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 16384, inputBudget: 11468
    });
    assert.deepEqual(resolveLocalRuntimeContext({ ...profile, qualificationRuntime: undefined,
        effectiveRuntimeContextTokens: undefined }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 4096, inputBudget: 2867
    });
});

test('explicit choices may exceed metadata while malformed preferences cannot invent capacity', () => {
    const base = { paramSize: '3B', contextLength: 8192, contextLengthKnown: true };
    for (const fields of [
        { runtimeContextTokens: 16384 },
        { preferredRuntimeContextTokens: 16384, preferredRuntimeContextSource: 'user-choice' as const }
    ]) {
        const result = resolveLocalRuntimeContext({ ...base, ...fields });
        assert.equal(result.ok, true);
        if (result.ok) { assert.equal(result.contextWindow, 16384); }
    }
    assert.deepEqual(resolveLocalRuntimeContext({ ...base, preferredRuntimeContextTokens: 16384 }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 4096, inputBudget: 2867
    }, 'an origin-less legacy preference is not a confirmed user choice');
    for (const preferredRuntimeContextTokens of [-1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8192', null]) {
        assert.deepEqual(resolveLocalRuntimeContext({ ...base, preferredRuntimeContextTokens }), {
            ok: false, reasonCode: 'invalid-runtime-context'
        });
    }
    for (const effectiveRuntimeContextTokens of [-1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8192', null]) {
        assert.deepEqual(resolveLocalRuntimeContext({ ...base, effectiveRuntimeContextTokens }), {
            ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 4096, inputBudget: 2867
        });
    }
});

test('unknown or malformed automatic metadata stays at 4096 even when a remembered number is larger', () => {
    const expected = { ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 4096, inputBudget: 2867 };
    for (const paramSize of ['2B', '3B', '13B', 'unknown']) {
        for (const contextLength of [2048, 8192, 32768, 131072]) {
            for (const contextLengthKnown of [undefined, false]) {
                assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength, contextLengthKnown }), expected);
            }
        }
        for (const contextLength of [0, -1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength, contextLengthKnown: true }), expected);
            assert.equal(runtimeContextWindow(paramSize, contextLength), 4096);
            assert.equal(contextInputBudget(paramSize, contextLength), 2867);
        }
    }
});

test('explicit local runtime uses the advertised bound and reserves output capacity without a size cap', () => {
    for (const paramSize of ['1B', '3B', '31B', 'unknown']) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength: 32768, contextLengthKnown: true, runtimeContextTokens: 8192 }), {
            ok: true, configuredTokens: 8192, mode: 'explicit', contextWindow: 8192, inputBudget: 5734
        });
    }
    assert.equal(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 8192, contextLengthKnown: true, runtimeContextTokens: 8192 }).ok, true);
    assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 8192, contextLengthKnown: true, runtimeContextTokens: 8193 }), {
        ok: true, configuredTokens: 8193, mode: 'explicit', contextWindow: 8193, inputBudget: 5735
    });
    assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '2B', contextLength: 32768, contextLengthKnown: true, runtimeContextTokens: 32768 }), {
        ok: true, configuredTokens: 32768, mode: 'explicit', contextWindow: 32768, inputBudget: 22937
    }, 'the automatic allocation ceiling must not silently clamp an explicit supported capacity');
});

test('capacity budgeting preserves the output reserve and the complete format-repair reservation', () => {
    const runtime = resolveLocalRuntimeContext({ paramSize: '2B', contextLength: 16384, contextLengthKnown: true, effectiveRuntimeContextTokens: 8192 });
    assert.equal(runtime.ok, true);
    if (!runtime.ok) { throw new Error('expected resolved neutral context'); }
    const reservedInputTokens = 100;
    const fittingPrompt = '中'.repeat(runtime.inputBudget - reservedInputTokens - 1);
    assert.equal(promptFits('', fittingPrompt, runtime.inputBudget, reservedInputTokens), true);
    assert.equal(promptFits('', fittingPrompt + '中', runtime.inputBudget, reservedInputTokens), false);
    assert.equal(runtime.contextWindow - runtime.inputBudget, 2458, 'output space remains outside the input budget');
});

test('all local roles require matching qualification after automatic half-limit capacity changes', () => {
    for (const [paramSize, oldNumCtx] of [['2B', 2572], ['3B', 5000], ['13B', 8572]] as const) {
        const qualificationRuntime = { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: oldNumCtx };
        const automatic = resolveLocalRuntimeContext({ paramSize, contextLength: 32768, contextLengthKnown: true, qualificationRuntime });
        assert.deepEqual(automatic, { ok: true, configuredTokens: 0, mode: 'automatic',
            contextWindow: 16384, inputBudget: 11468 });
        const runtime = automatic;
        assert.equal(runtime.ok, true);
        if (!runtime.ok) { throw new Error('expected resolved neutral context'); }
        const request = { envType: 'local' as const, modelName: 'neutral-model', runtimeContextTokens: runtime.contextWindow };
        for (const role of ['writer', 'reviewer', 'bugFixer'] as const) {
            const probe = buildOllamaRoleQualificationProbe('neutral-model', `Neutral ${role} contract`,
                role === 'reviewer' ? 'json' : 'text', runtime.contextWindow);
            assert.deepEqual(probe.options, { temperature: 0, num_ctx: runtime.contextWindow });
            const profile: ModelQualificationProfile = {
                envType: 'local', modelName: 'neutral-model', qualificationVersion: QUALIFICATION_VERSION,
                testGenerationReady: role === 'writer',
                qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: oldNumCtx },
                roleQualification: {
                    writer: { state: role === 'writer' ? 'verified' : 'unverified', reason: 'neutral probe' },
                    reviewer: { state: role === 'reviewer' ? 'verified' : 'unverified', reason: 'neutral probe' },
                    bugFixer: { state: role === 'bugFixer' ? 'verified' : 'unverified', reason: 'neutral probe' }
                }
            };
            assert.equal(qualificationAppliesToRequest(profile, request), false, `${paramSize}/${role} cannot reuse a smaller probe`);
            assert.equal(qualificationForRequest(profile, request), false);
            assert.equal(qualifiedRole(role, profile.roleQualification, qualificationAppliesToRequest(profile, request), profile.testGenerationReady), false);
            const reprobed: ModelQualificationProfile = { ...profile,
                qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: runtime.contextWindow } };
            assert.equal(qualificationAppliesToRequest(reprobed, request), true);
            assert.equal(qualifiedRole(role, reprobed.roleQualification, qualificationAppliesToRequest(reprobed, request), reprobed.testGenerationReady), true);
            assert.equal(qualificationForRequest(reprobed, request), role === 'writer', 'matching capacity must not invent Writer success');
        }
    }
    const unchangedRuntime = resolveLocalRuntimeContext({ paramSize: '13B', contextLength: 8192, contextLengthKnown: true });
    assert.equal(unchangedRuntime.ok, true);
    if (!unchangedRuntime.ok) { throw new Error('expected resolved neutral context'); }
    assert.equal(qualificationForRequest({ envType: 'local', modelName: 'neutral-model', qualificationVersion: QUALIFICATION_VERSION,
        testGenerationReady: true, qualificationRuntime: { version: LOCAL_RUNTIME_QUALIFICATION_VERSION, numCtx: 4096 } },
    { envType: 'local', modelName: 'neutral-model', runtimeContextTokens: unchangedRuntime.contextWindow }), true,
    'an already verified identical runtime remains valid; a contract version bump is unnecessary');
});

test('invalid runtime settings never become automatic defaults or silently clamped values', () => {
    for (const runtimeContextTokens of [-1, 0.5, 8192.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '8192', '0', null, true, {}, []]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 32768, contextLengthKnown: true, runtimeContextTokens }), {
            ok: false, reasonCode: 'invalid-runtime-context'
        });
    }
});

test('a positive direct override remains usable without valid architecture metadata', () => {
    for (const contextLength of [4096, 8192, 32768]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength, runtimeContextTokens: 2048 }), {
            ok: true, configuredTokens: 2048, mode: 'explicit', contextWindow: 2048, inputBudget: 1433
        });
    }
    for (const contextLength of [0, -1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength, contextLengthKnown: true, runtimeContextTokens: 2048 }), {
            ok: true, configuredTokens: 2048, mode: 'explicit', contextWindow: 2048, inputBudget: 1433
        });
    }
});

test('local metadata uses architecture-bound context before unrelated context fields and runtime defaults', () => {
    assert.deepEqual(getOllamaModelConnectionMetadata({ details: { parameter_size: ' 3.1B ' }, parameters: 'num_ctx 65536', context_length: 131072,
        model_info: { 'other.context_length': 999999, 'neutral.context_length': 32768, 'general.architecture': 'neutral' } }), {
        paramSize: '3.1B', contextLength: 32768, contextLengthKnown: true, contextSource: 'neutral.context_length'
    });
});

test('ambiguous or mismatched metadata never certifies an arbitrary context length', () => {
    for (const model_info of [
        { 'first.context_length': 32768, 'second.context_length': 65536 },
        { 'general.architecture': 'missing', 'first.context_length': 32768 },
        { 'general.architecture': '', 'first.context_length': 32768 },
        { 'general.architecture': 42, 'first.context_length': 32768 },
        { 'neutral.audio.context_length': 32768 },
        { 'general.architecture': 'neutral', 'neutral.context_length': '32768' },
        { 'general.architecture': 'neutral', 'neutral.context_length': 0 },
        { 'general.architecture': 'neutral', 'neutral.context_length': NaN },
        { 'general.architecture': 'neutral', 'neutral.context_length': Infinity },
        { 'general.architecture': 'neutral', 'neutral.context_length': 8192.5 }
    ]) {
        assert.deepEqual(getOllamaModelConnectionMetadata({ model_info }), {
            paramSize: 'unknown', contextLength: 4096, contextLengthKnown: false
        });
    }
});

test('old metadata can use a unique direct context key but never inherited or empty metadata', () => {
    assert.deepEqual(getOllamaModelConnectionMetadata({ model_info: { 'neutral.context_length': 8192 } }), {
        paramSize: 'unknown', contextLength: 8192, contextLengthKnown: true, contextSource: 'neutral.context_length'
    });
    for (const value of [undefined, null, '8192', [], {}, { model_info: Object.create({ 'neutral.context_length': 8192 }) },
        { parameters: 'num_ctx 8192', details: { family: 'neutral' } }]) {
        assert.deepEqual(getOllamaModelConnectionMetadata(value), { paramSize: 'unknown', contextLength: 4096, contextLengthKnown: false });
    }
});
