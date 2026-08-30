import * as assert from 'assert';
import { test } from 'node:test';
import { getSkillCards, inferSkillIdsFromCode } from '../prompt_skill_library';

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
