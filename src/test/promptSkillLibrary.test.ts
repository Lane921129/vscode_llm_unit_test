import * as assert from 'assert';
import { test } from 'node:test';
import { getSkillCards, inferSkillIdsFromCode, mergeEvidenceBoundSkillIds } from '../prompt_skill_library';

test('syntax-based skill inference selects advanced cards without application vocabulary', () => {
    const source = `
async def load_snapshot(path):
    current = datetime.now()
    with open(path, 'r') as handle:
        return await parse(handle.read(), current)
`;

    const skillIds = inferSkillIdsFromCode(source);

    assert.ok(skillIds.includes('import_module_name'));
    assert.ok(skillIds.includes('async_coroutine_testing'));
    assert.ok(skillIds.includes('file_io_mocking'));
    assert.ok(skillIds.includes('datetime_freezing'));
    assert.deepStrictEqual(
        getSkillCards(skillIds).filter(card => card.id !== 'import_module_name').map(card => card.id).sort(),
        ['async_coroutine_testing', 'datetime_freezing', 'file_io_mocking']
    );
});

test('syntax-based skill inference does not add division rules without division', () => {
    const skillIds = inferSkillIdsFromCode('def combine(left, right):\n    return left + right');

    assert.ok(!skillIds.includes('zero_division'));
    assert.ok(!skillIds.includes('async_coroutine_testing'));
});

test('syntax-based skill inference recognizes explicit tuple returns without mistaking function arguments', () => {
    const tupleIds = inferSkillIdsFromCode('def split(value):\n    return (value, 1)');
    const callIds = inferSkillIdsFromCode('async def load(value):\n    return await parse(value, 1)');

    assert.ok(tupleIds.includes('tuple_return'));
    assert.ok(!callIds.includes('tuple_return'));
});

test('syntax-based skill inference selects pattern matching only for match/case syntax', () => {
    const matchIds = inferSkillIdsFromCode('def route(kind):\n    match kind:\n        case "new":\n            return 1');
    const ordinaryIds = inferSkillIdsFromCode('def match_words(value):\n    return value');
    assert.ok(matchIds.includes('pattern_matching'));
    assert.ok(!ordinaryIds.includes('pattern_matching'));
});

test('evidence-bound skill cart rejects unrelated semantic cards', () => {
    const source = `
def render(value):
    if len(value) < 3:
        raise ValueError('short')
    return value[:2]
`;
    const ids = mergeEvidenceBoundSkillIds(source, [
        'string_length_boundary',
        'python_slicing',
        'async_coroutine_testing',
        'file_io_mocking',
        'datetime_freezing',
        'class_method_testing',
    ]);

    assert.ok(ids.includes('string_length_boundary'));
    assert.ok(ids.includes('python_slicing'));
    assert.ok(!ids.includes('async_coroutine_testing'));
    assert.ok(!ids.includes('file_io_mocking'));
    assert.ok(!ids.includes('datetime_freezing'));
    assert.ok(!ids.includes('class_method_testing'));
});

test('evidence-bound skill cart keeps dependency mocking only when dependencies exist', () => {
    const ids = mergeEvidenceBoundSkillIds(
        'def render(value):\n    return normalize(value)',
        ['mock_external_dependency'],
        { dependencies: [{ name: 'normalize' }] }
    );
    assert.ok(ids.includes('mock_external_dependency'));
});

test('database isolation skill uses driver evidence rather than application naming', () => {
    const ids = inferSkillIdsFromCode(
        'def add_record(value):\n    return value',
        { file_imports: [{ module: 'sqlite3', name: null }] }
    );
    const ordinary = inferSkillIdsFromCode('def database_label(value):\n    return value');

    assert.ok(ids.includes('database_state_isolation'));
    assert.ok(ids.includes('mock_external_dependency'));
    assert.ok(!ordinary.includes('database_state_isolation'));
    assert.ok(getSkillCards(ids).find(card => card.id === 'database_state_isolation')?.rules
        .some(rule => rule.includes('Never connect to the application default')));
});

test('class instance skill is not injected for static or class-bound methods', () => {
    const staticIds = mergeEvidenceBoundSkillIds(
        'def render(value):\n    return value',
        ['class_method_testing'],
        { class_name: 'Renderer', method_kind: 'static' }
    );
    const classIds = inferSkillIdsFromCode(
        'def render(cls, value):\n    return value',
        { class_name: 'Renderer', method_kind: 'class' }
    );
    const instanceIds = inferSkillIdsFromCode(
        'def render(self, value):\n    return value',
        { class_name: 'Renderer', method_kind: 'instance' }
    );

    assert.ok(!staticIds.includes('class_method_testing'));
    assert.ok(!classIds.includes('class_method_testing'));
    assert.ok(instanceIds.includes('class_method_testing'));
});
