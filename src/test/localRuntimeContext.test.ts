import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextInputBudget, resolveLocalRuntimeContext, runtimeContextWindow } from '../prompts/promptBudget';
import { getOllamaModelConnectionMetadata } from '../llm/ollamaRuntime';

test('default local runtime keeps existing caps without requiring advertised metadata', () => {
    for (const paramSize of ['1B', '3B', '7B', '13B', '31B', 'unknown']) {
        for (const contextLength of [4096, 8192, 32768, NaN]) {
            const expected = { ok: true, configuredTokens: 0, mode: 'automatic',
                contextWindow: runtimeContextWindow(paramSize, contextLength), inputBudget: contextInputBudget(paramSize, contextLength) };
            assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength }), expected);
            assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength, runtimeContextTokens: 0, contextLengthKnown: false }), expected);
        }
    }
    assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 32768 }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 5000, inputBudget: 3500
    });
});

test('explicit local runtime uses the advertised bound and reserves output capacity without a size cap', () => {
    for (const paramSize of ['1B', '3B', '31B', 'unknown']) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize, contextLength: 32768, contextLengthKnown: true, runtimeContextTokens: 8192 }), {
            ok: true, configuredTokens: 8192, mode: 'explicit', contextWindow: 8192, inputBudget: 5734
        });
    }
    assert.equal(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 8192, contextLengthKnown: true, runtimeContextTokens: 8192 }).ok, true);
    assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 8192, contextLengthKnown: true, runtimeContextTokens: 8193 }), {
        ok: false, reasonCode: 'runtime-context-exceeds-model-limit'
    });
});

test('invalid runtime settings never become automatic defaults or silently clamped values', () => {
    for (const runtimeContextTokens of [-1, 0.5, 8192.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, '8192', '0', null, true, {}, []]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength: 32768, contextLengthKnown: true, runtimeContextTokens }), {
            ok: false, reasonCode: 'invalid-runtime-context'
        });
    }
});

test('a positive override requires known valid metadata, not a remembered fallback number', () => {
    for (const contextLength of [4096, 8192, 32768]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength, runtimeContextTokens: 2048 }), {
            ok: false, reasonCode: 'runtime-context-metadata-required'
        });
    }
    for (const contextLength of [0, -1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.deepEqual(resolveLocalRuntimeContext({ paramSize: '3B', contextLength, contextLengthKnown: true, runtimeContextTokens: 2048 }), {
            ok: false, reasonCode: 'runtime-context-metadata-required'
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
