"""Summarize manifest-reported A/B outcomes; never manufacture quality evidence."""
import argparse
from datetime import datetime
import json
from pathlib import Path


def group(directories):
    runs, identities = [], set()
    for directory in directories:
        file = Path(directory) / 'batch_manifest.json'
        if file.is_symlink() or file.stat().st_size > 8 * 1024 * 1024:
            raise ValueError('invalid-batch-manifest')
        data = json.loads(file.read_text(encoding='utf-8-sig'))
        identity = data.get('batchId')
        if not isinstance(identity, str) or not identity or identity in identities:
            raise ValueError('missing-or-duplicate-batch-identity')
        identities.add(identity)
        counts = data.get('statusCounts')
        numbers = [data.get(key) for key in ('expectedTargets', 'attemptedTargets', 'finishedTargets')]
        if (not isinstance(counts, dict) or any(type(value) is not int or value < 0 for value in counts.values())
                or any(type(value) is not int or value < 0 for value in numbers)
                or sum(counts.values()) != numbers[0] or numbers[1] > numbers[0] or numbers[2] > numbers[0]):
            raise ValueError('inconsistent-batch-counts')
        elapsed = None
        if data.get('startedAt') and data.get('finishedAt'):
            elapsed = (datetime.fromisoformat(data['finishedAt'].replace('Z', '+00:00'))
                       - datetime.fromisoformat(data['startedAt'].replace('Z', '+00:00'))).total_seconds()
            if elapsed < 0:
                raise ValueError('invalid-batch-time')
        runs.append({'batchId': identity, 'model': data.get('model'), 'buildTimestamp': data.get('buildTimestamp'),
                     'validationMode': data.get('validationMode'), 'expectedTargets': numbers[0],
                     'attemptedTargets': numbers[1], 'finishedTargets': numbers[2], 'statusCounts': counts,
                     'elapsedSeconds': elapsed,
                     'selectedFiles': sorted(data.get('scope', {}).get('selectedFiles', []))})
    totals = {}
    for run in runs:
        for status, count in run['statusCounts'].items():
            totals[status] = totals.get(status, 0) + count
    return {'runs': runs, 'statusCounts': totals, 'attemptedTargets': sum(run['attemptedTargets'] for run in runs)}


def summarize(a, b):
    left, right = group(a), group(b)
    if {run['batchId'] for run in left['runs']} & {run['batchId'] for run in right['runs']}:
        raise ValueError('same-batch-in-both-groups')
    dimensions = ('model', 'validationMode', 'selectedFiles')
    return {'schemaVersion': 'skill-ab-summary-v1', 'evidenceBasis': 'manifest-reported-outcomes-only',
            'qualityEvidenceRevalidated': False,
            'comparisonFacts': {key: {json.dumps(run[key], sort_keys=True) for run in left['runs']}
                                == {json.dumps(run[key], sort_keys=True) for run in right['runs']}
                                for key in dimensions},
            'note': 'Pending targets are not failed tests. Matching dimensions do not prove equal prompts, sampling, budgets or semantic quality. Inspect original same-candidate evidence.',
            'A': left, 'B': right}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--a', action='append', required=True, help='Group A batch directory; repeat for multiple runs')
    parser.add_argument('--b', action='append', required=True, help='Group B batch directory; repeat for multiple runs')
    args = parser.parse_args()
    print(json.dumps(summarize(args.a, args.b), ensure_ascii=True, indent=2))
