import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOllamaModelConnectionMetadata, getOllamaRuntimeContextMetadata } from '../llm/ollamaRuntime';
import { resolveLocalRuntimeContext } from '../prompts/promptBudget';

const show = { model_info: { 'general.architecture': 'neutral', 'neutral.context_length': 131072 },
    details: { parameter_size: '3B' }, parameters: 'temperature 0\nnum_ctx 8192\nstop "end"' };

test('running allocation remains a separate observed fact when automatic requests use half the known model limit', () => {
    const running = { models: [{ name: 'other:latest', context_length: 65536 },
        { name: 'neutral:latest', model: 'neutral:latest', context_length: 12288 }] };
    const runtime = getOllamaRuntimeContextMetadata(show, running, 'neutral');
    assert.deepEqual(runtime, { effectiveRuntimeContextTokens: 12288, runtimeContextSource: 'ollama-ps' });
    assert.equal(getOllamaModelConnectionMetadata(show).contextLength, 131072);
    assert.deepEqual(resolveLocalRuntimeContext({ ...getOllamaModelConnectionMetadata(show), ...runtime }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 65536, inputBudget: 45875
    });
});

test('an unloaded model can use its exact num_ctx setting and never another model allocation', () => {
    for (const running of [undefined, {}, { models: [{ name: 'other:latest', context_length: 65536 }] }]) {
        assert.deepEqual(getOllamaRuntimeContextMetadata(show, running, 'neutral'), {
            effectiveRuntimeContextTokens: 8192, runtimeContextSource: 'ollama-num-ctx'
        });
    }
    assert.deepEqual(getOllamaRuntimeContextMetadata({ parameters: { num_ctx: 32768 } }, {}, 'neutral'), {
        effectiveRuntimeContextTokens: 32768, runtimeContextSource: 'ollama-num-ctx'
    });
});

test('advertised limits, context-like settings and malformed defaults cannot become runtime capacity', () => {
    for (const parameters of [undefined, '', 'num_ctx 0', 'num_ctx -1', 'num_ctx 8192.5', 'num_ctx Infinity',
        'num_ctx 9007199254740992', 'num_ctx 8192\nnum_ctx 16384', 'num_ctx=8192',
        'stop "num_ctx 8192"', 'num_predict 8192', '# num_ctx 8192', { num_ctx: '8192' },
        Object.create({ num_ctx: 8192 })]) {
        assert.equal(getOllamaRuntimeContextMetadata({ ...show, parameters }, {}, 'neutral'), undefined);
    }
    assert.equal(getOllamaRuntimeContextMetadata(show, {}, ''), undefined);
});

test('ambiguous running identities do not choose the first allocation or fall back to an unrelated record', () => {
    for (const models of [
        [{ name: 'neutral:latest', context_length: 8192 }, { model: 'neutral', context_length: 16384 }],
        [{ name: 'neutral:latest', model: 'other:latest', context_length: 16384 }],
        [{ name: 'other:latest', model: 'neutral:latest', context_length: 16384 }]
    ]) {
        assert.equal(getOllamaRuntimeContextMetadata(show, { models }, 'neutral'), undefined);
    }
    assert.equal(getOllamaRuntimeContextMetadata({}, { models: [{ name: 'neutral:other', context_length: 65536 }] }, 'neutral'), undefined);
});

test('invalid running capacity cannot authorize a request but a valid show default remains distinct evidence', () => {
    for (const context_length of [undefined, 0, -1, 8192.5, NaN, Infinity, '8192', Number.MAX_SAFE_INTEGER + 1]) {
        const running = { models: [{ name: 'neutral:latest', context_length }] };
        assert.equal(getOllamaRuntimeContextMetadata({}, running, 'neutral'), undefined);
        assert.deepEqual(getOllamaRuntimeContextMetadata(show, running, 'neutral'), {
            effectiveRuntimeContextTokens: 8192, runtimeContextSource: 'ollama-num-ctx'
        });
    }
});

test('a known running allocation remains usable when model architecture metadata is unavailable', () => {
    const metadata = getOllamaModelConnectionMetadata({});
    const runtime = getOllamaRuntimeContextMetadata({}, { models: [{ model: 'neutral:latest', context_length: 24576 }] }, 'neutral');
    assert.equal(metadata.contextLengthKnown, false);
    assert.deepEqual(resolveLocalRuntimeContext({ ...metadata, ...runtime }), {
        ok: true, configuredTokens: 0, mode: 'automatic', contextWindow: 24576, inputBudget: 17203
    });
});
