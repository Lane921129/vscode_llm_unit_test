"""Validate and resolve the five-category laboratory fixture batch.

This module only reads versioned fixture metadata. It never calls a model,
imports a fixture, or treats a missing report as a pass.
"""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = ROOT / 'test' / 'fixtures' / 'python' / 'manifest.json'
DEFAULT_BATCH_MANIFEST = ROOT / 'test' / 'fixtures' / 'python' / 'lab_batch_manifest.json'
REQUIRED_CATEGORY_IDS = {
    'pure-function',
    'class-method',
    'database-mock',
    'async-boundary',
    'ui-dependent-boundary',
}


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def resolve_lab_batch(manifest_path=DEFAULT_MANIFEST, batch_manifest_path=DEFAULT_BATCH_MANIFEST):
    """Return the base fixture entries selected by the lab batch manifest."""
    manifest = load_json(manifest_path)
    batch = load_json(batch_manifest_path)
    categories = batch.get('categories')
    if not isinstance(categories, list) or len(categories) != 5:
        raise ValueError('lab batch must define exactly five categories')
    category_ids = [item.get('id') for item in categories]
    if set(category_ids) != REQUIRED_CATEGORY_IDS or len(set(category_ids)) != len(category_ids):
        raise ValueError(f'lab batch categories must be exactly {sorted(REQUIRED_CATEGORY_IDS)}')
    fixtures_by_id = {item.get('id'): item for item in manifest.get('fixtures', [])}
    fixture_ids = [item.get('fixture_id') for item in categories]
    if len(set(fixture_ids)) != len(fixture_ids):
        raise ValueError('lab batch fixture_id values must be unique')
    missing = [fixture_id for fixture_id in fixture_ids if fixture_id not in fixtures_by_id]
    if missing:
        raise ValueError(f'lab batch references unknown fixtures: {missing}')
    return {
        'schema_version': manifest['schema_version'],
        'batch_schema_version': batch['schema_version'],
        'batch_name': batch.get('name', 'unnamed'),
        'categories': categories,
        'fixtures': [fixtures_by_id[fixture_id] for fixture_id in fixture_ids],
    }


if __name__ == '__main__':
    resolved = resolve_lab_batch()
    print(json.dumps({
        'batch_name': resolved['batch_name'],
        'category_count': len(resolved['categories']),
        'fixture_ids': [fixture['id'] for fixture in resolved['fixtures']],
    }, ensure_ascii=False))
