import * as assert from 'assert';
import { test } from 'node:test';
import { getSkillCards, inferSkillIdsFromCode, mergeEvidenceBoundSkillIds } from '../prompts/promptSkillLibrary';

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
        ['async_coroutine_testing', 'context_manager_testing', 'datetime_freezing', 'file_io_mocking']
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

test('truthiness skill requires an AST direct-branch fact rather than a source-name guess', () => {
    const source = 'def choose(enabled: bool):\n    if enabled:\n        return "yes"\n    return "no"';
    const withFact = inferSkillIdsFromCode(source, {
        condition_facts: [{ kind: 'truthiness', parameter: 'enabled', subject: 'value', polarity: 'truthy' }],
    });
    const withoutFact = inferSkillIdsFromCode(source);

    assert.ok(withFact.includes('boolean_truthiness_coverage'));
    assert.ok(!withoutFact.includes('boolean_truthiness_coverage'));
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

test('context-manager skill requires a real with statement rather than a word match', () => {
    const contextManager = inferSkillIdsFromCode(
        'def load(factory):\n    with factory() as resource:\n        return resource.read()'
    );
    const ordinary = inferSkillIdsFromCode(
        'def combine_with(value):\n    return "with " + value'
    );

    assert.ok(contextManager.includes('context_manager_testing'));
    assert.ok(!ordinary.includes('context_manager_testing'));
    assert.ok(getSkillCards(contextManager).find(card => card.id === 'context_manager_testing')?.rules
        .some(rule => rule.includes('__enter__')));
});

test('async-context skill requires real async with syntax and uses the async protocol', () => {
    const asyncContext = inferSkillIdsFromCode(
        'async def load(session):\n    async with session.get() as response:\n        return await response.text()'
    );
    const ordinaryContext = inferSkillIdsFromCode(
        'def load(factory):\n    with factory() as resource:\n        return resource.read()'
    );
    const textOnly = inferSkillIdsFromCode(
        'async def label(value):\n    return "async with " + value'
    );

    assert.ok(asyncContext.includes('async_context_manager_testing'));
    assert.ok(!ordinaryContext.includes('async_context_manager_testing'));
    assert.ok(!textOnly.includes('async_context_manager_testing'));
    const card = getSkillCards(asyncContext).find(candidate => candidate.id === 'async_context_manager_testing');
    assert.ok(card?.rules.some(rule => rule.includes('__aenter__')));
    assert.ok(card?.rules.some(rule => rule.includes('bare AsyncMock call returns a coroutine')));
});

test('HTTP mocking skill requires a target call tied to an imported client binding', () => {
    const ids = inferSkillIdsFromCode(
        'def fetch(path):\n    return transport.get(path)',
        {
            calls: ['transport.get'],
            file_imports: [{ module: 'httpx', name: null, bound_name: 'transport' }],
        }
    );
    const importedButUnused = inferSkillIdsFromCode(
        'def label(value):\n    return value',
        {
            calls: [],
            file_imports: [{ module: 'requests', name: null, bound_name: 'requests' }],
        }
    );
    const unrelatedClient = inferSkillIdsFromCode(
        'def fetch(client, path):\n    return client.get(path)',
        { calls: ['client.get'], file_imports: [] }
    );

    assert.ok(ids.includes('http_client_mocking'));
    assert.ok(!importedButUnused.includes('http_client_mocking'));
    assert.ok(!unrelatedClient.includes('http_client_mocking'));
    assert.ok(getSkillCards(ids).find(card => card.id === 'http_client_mocking')?.rules
        .some(rule => rule.includes('Never make a real network request')));
});

test('generator skill requires selected-callable AST evidence and prevents repr assertions', () => {
    const generatorIds = inferSkillIdsFromCode(
        'def every_second(values):\n    for value in values:\n        yield value',
        { is_generator: true }
    );
    const ordinaryIds = inferSkillIdsFromCode(
        'def label(value):\n    return "yield " + value',
        { is_generator: false }
    );

    assert.ok(generatorIds.includes('generator_result_testing'));
    assert.ok(!ordinaryIds.includes('generator_result_testing'));
    assert.ok(getSkillCards(generatorIds).find(card => card.id === 'generator_result_testing')?.rules
        .some(rule => rule.includes('never assert a generator repr')));
});

test('boundary and constructor cards do not invent behavior absent from source evidence', () => {
    const cards = getSkillCards(['string_length_boundary', 'zero_division', 'class_method_testing']);
    const rules = cards.flatMap(card => card.rules).join('\n');

    assert.match(rules, /do NOT infer that either side raises/i);
    assert.match(rules, /explicit source raise or exact verified trace error/i);
    assert.match(rules, /do not guess required constructor dependencies/i);
    assert.doesNotMatch(rules, /N-1 \(should raise\)|self\.obj = ClassName\(\)/i);
});
