import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { formatSourceLineContext } from '../pipeline/sourceLineContext';
import { buildCompactWriterContext } from '../prompts/compactWriterContext';

const source = 'def target(value):\n    try:\n        return value.read()\n    except ValueError:\n        return None';
const location = { version: 'python-source-location-v1', startLine: 250, endLine: 254,
    sourceHash: createHash('sha256').update(source).digest('hex') };

test('measured file-line IDs resolve to the complete snippet without treating source as an oracle', () => {
    const text = formatSourceLineContext(source, location, 'line:253');
    assert.match(text, /Snippet row 1 is file line 250/);
    assert.match(text, /"fileLine":253,"text":"    except ValueError:"/);
    assert.match(text, /not execution or assertion evidence/);
    const branch = formatSourceLineContext(source, location, 'branch:252->-250');
    assert.match(branch, /"fileLine":252/);
    assert.doesNotMatch(branch, /"fileLine":-/);
    assert.equal(formatSourceLineContext(source.replaceAll('\n', '\r\n'), location, 'line:253'), text);
});

test('missing, drifted, malformed or unrelated location evidence never invents file lines', () => {
    for (const invalid of [undefined, {}, { ...location, sourceHash: 'a'.repeat(64) },
        { ...location, endLine: 999 }, { ...location, startLine: 0 }, { ...location, startLine: 1.1 }]) {
        assert.equal(formatSourceLineContext(source, invalid, 'line:253'), '');
    }
    assert.equal(formatSourceLineContext(source + '\n# changed', location), '');
    assert.doesNotMatch(formatSourceLineContext(source, location, 'line:999999999999999999999'), /"fileLine"/);
    assert.doesNotMatch(formatSourceLineContext(source, location, 'untrusted text line:253'), /"fileLine"/);
    const evidence: any = { sourceHash: 'a'.repeat(64), ruleSelection: { ids: [], selectedRules: [] } };
    const context = buildCompactWriterContext({ module: 'sample', name: 'target', source, evidence,
        context: { source_location: location, writerGenerationPhase: 'seed' }, budgetTokens: 1 });
    assert.ok(context.includes(source), 'the complete source remains byte-for-byte available');
    assert.match(context, /SOURCE_FILE_LINES_V1/);
    assert.equal(context.split(source).length - 1, 1, 'do not duplicate a whole function to add line numbers');
});

test('large source rows are referenced whole rather than duplicated or clipped into the prompt', () => {
    const large = 'def target():\n    value = "' + 'large literal '.repeat(3000) + '"\n    return value';
    const metadata = { ...location, startLine: 100, endLine: 102,
        sourceHash: createHash('sha256').update(large).digest('hex') };
    const text = formatSourceLineContext(large, metadata, 'line:102');
    assert.match(text, /"fileLine":101,"sourceRow":2,"textInCompleteSource":true/);
    assert.doesNotMatch(text, /large literal/);
    assert.ok(text.length < 1000);
});
