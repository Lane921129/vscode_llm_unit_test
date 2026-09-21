"""Portable policy snapshots and pure, fail-closed saved-candidate assessment.

This does not change a run's termination reason or reclassify legacy reports.
The caller supplies independently established candidate identity and verifies
fixture thresholds against the manifest fixed before execution.
"""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re

DEFINITION = json.loads((Path(__file__).resolve().parent.parent / 'contracts' / 'quality-policy-v1.json').read_text(encoding='utf-8'))
MAX_SAFE_INTEGER = 9007199254740991


def _integer(value):
    if type(value) is int:
        return 0 <= value <= MAX_SAFE_INTEGER
    return type(value) is float and math.isfinite(value) and 0 <= value <= MAX_SAFE_INTEGER and value.is_integer()


def _positive_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def _digest(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def canonical_quality_json(value):
    def check(item):
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise ValueError('Unsupported canonical quality value')
            return {key: check(child) for key, child in item.items()}
        elif type(item) is list:
            return [check(child) for child in item]
        elif item is not None and type(item) not in (str, bool) and not _integer(item):
            raise ValueError('Unsupported canonical quality value')
        return int(item) if _integer(item) else item
    return json.dumps(check(value), sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def quality_policy_hash(value):
    snapshot = {key: item for key, item in value.items() if key != 'policyHash'}
    return hashlib.sha256(canonical_quality_json(snapshot).encode('utf-8')).hexdigest()


def _ratio(value):
    return type(value) is dict and set(value) == {'numerator', 'denominator'} \
        and _integer(value['numerator']) and _integer(value['denominator']) \
        and value['denominator'] > 0 and value['numerator'] <= value['denominator']


def validate_quality_policy(raw):
    failure = {'ok': False, 'reason': 'invalid-quality-policy'}
    if type(raw) is not dict or raw.get('mode') not in ('strict100', 'fixture') \
            or not _digest(raw.get('policyHash')) or raw.get('schemaVersion') != DEFINITION['schemaVersion'] \
            or raw.get('policyId') != DEFINITION['policyIds'][raw['mode']] \
            or not _ratio(raw.get('lineThreshold')) or not _ratio(raw.get('mutationThreshold')):
        return failure
    keys = {'schemaVersion', 'policyId', 'mode', 'policyHash', 'lineThreshold', 'mutationThreshold', *DEFINITION['fixed']}
    if any(raw.get(key) != value for key, value in DEFINITION['fixed'].items()):
        return failure
    if raw['mode'] == 'fixture':
        keys.add('fixture')
        fixture = raw.get('fixture')
        if type(fixture) is not dict or set(fixture) != {'fixtureId', 'manifestHash'} \
                or type(fixture.get('fixtureId')) is not str \
                or re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}', fixture['fixtureId']) is None \
                or not _digest(fixture.get('manifestHash')):
            return failure
    elif {key: raw[key] for key in ('lineThreshold', 'mutationThreshold')} != DEFINITION['strictThresholds']:
        return failure
    if set(raw) != keys or quality_policy_hash(raw) != raw['policyHash']:
        return failure
    return {'ok': True, 'policy': copy.deepcopy(raw)}


def _create_policy(mode, thresholds, fixture=None):
    value = {'schemaVersion': DEFINITION['schemaVersion'], 'policyId': DEFINITION['policyIds'][mode],
             'mode': mode, **DEFINITION['fixed'], **copy.deepcopy(thresholds)}
    if fixture is not None:
        value['fixture'] = fixture
    value['policyHash'] = quality_policy_hash(value)
    result = validate_quality_policy(value)
    if not result['ok']:
        raise ValueError(result['reason'])
    return result['policy']


def create_strict_quality_policy():
    return _create_policy('strict100', DEFINITION['strictThresholds'])


def create_fixture_quality_policy(*, fixtureId, manifestHash, minLineCoverage, minMutationScore):
    if not all(_integer(value) and value <= 100 for value in (minLineCoverage, minMutationScore)):
        raise ValueError('Fixture thresholds must be integer percentages between 0 and 100')
    return _create_policy('fixture', {'lineThreshold': {'numerator': minLineCoverage, 'denominator': 100},
                                     'mutationThreshold': {'numerator': minMutationScore, 'denominator': 100}},
                          {'fixtureId': fixtureId, 'manifestHash': manifestHash})


def _valid_scope(value):
    return type(value) is dict and value.get('kind') == 'function' \
        and type(value.get('qualifiedName')) is str and bool(value['qualifiedName'].strip()) \
        and all(key not in value or (_integer(value[key]) and value[key] > 0) for key in ('startLine', 'endLine')) \
        and not ('startLine' in value and 'endLine' in value and value['startLine'] > value['endLine'])


def _same_scope(value, expected):
    return _valid_scope(value) and all(value.get(key) == expected.get(key)
                                     for key in ('kind', 'qualifiedName', 'startLine', 'endLine'))


def read_stored_mutation_run(raw, context):
    """Read the persisted camelCase builtin contract, never a rounded summary."""
    failure = {'ok': False, 'reason': 'invalid-mutation-evidence'}
    if type(raw) is str:
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return failure
    if type(raw) is not dict or not _integer(raw.get('schemaVersion')) or raw.get('schemaVersion') != 1 or raw.get('engine') != 'builtin' \
            or type(raw.get('baselinePassed')) is not bool \
            or any(raw.get(key) != value for key, value in DEFINITION['mutationVersions'].items()):
        return failure
    if any(not _digest(raw.get(key)) or raw[key] != context.get(key) for key in ('sourceHash', 'testHash')) \
            or type(raw.get('sourcePath')) is not str or type(context.get('sourcePath')) is not str \
            or os.path.normcase(os.path.abspath(raw['sourcePath'])) != os.path.normcase(os.path.abspath(context['sourcePath'])):
        return failure
    scope, expected_scope = raw.get('targetScope'), context.get('targetScope')
    if not _valid_scope(scope) or not _valid_scope(expected_scope) \
            or any(scope.get(key) != expected_scope[key] for key in expected_scope if key in ('kind', 'qualifiedName', 'startLine', 'endLine')):
        return failure
    if raw.get('baselineStatus') not in ('passed', 'failed', 'timeout', 'error', 'not-run') \
            or raw['baselinePassed'] != (raw['baselineStatus'] == 'passed'):
        return failure
    counts = raw.get('counts')
    fields = ('available', 'selected', 'executed', 'notRun', 'killed', 'survived', 'timeout', 'error')
    if type(counts) is not dict or any(key not in counts or not (key == 'available' and counts[key] is None)
                                     and not _integer(counts[key]) for key in fields):
        return failure
    if (counts['available'] is not None and counts['selected'] > counts['available']) \
            or counts['executed'] + counts['notRun'] != counts['selected'] \
            or sum(counts[key] for key in ('killed', 'survived', 'timeout', 'error')) != counts['executed'] \
            or (not raw['baselinePassed'] and counts['executed'] > 0):
        return failure
    ids = raw.get('candidateIds')
    if type(ids) is not list or not all(_digest(item) for item in ids) or len(set(ids)) != len(ids):
        return failure
    if counts['available'] is None:
        if 'candidateSetId' not in raw or raw['candidateSetId'] is not None or ids or counts['selected'] or raw['baselinePassed']:
            return failure
    elif len(ids) != counts['available'] or not _digest(raw.get('candidateSetId')) \
            or raw['candidateSetId'] != hashlib.sha256('\n'.join(sorted(ids)).encode('utf-8')).hexdigest():
        return failure
    mutants = raw.get('mutants')
    if type(mutants) is not list or len(mutants) != (counts['selected'] if raw['baselinePassed'] else 0):
        return failure
    outcomes = {'KILLED': 'killed', 'SURVIVED': 'survived', 'TIMEOUT': 'timeout', 'ERROR': 'error', 'NOT_RUN': 'notRun'}
    observed = dict.fromkeys(outcomes, 0)
    for index, item in enumerate(mutants):
        if type(item) is not dict or item.get('id') != ids[index] or type(item.get('kind')) is not str or not item['kind'] \
                or not _integer(item.get('line')) or item['line'] < 1 \
                or not _integer(item.get('column')) or not _integer(item.get('position')) \
                or type(item.get('from')) is not str or type(item.get('to')) is not str \
                or type(item.get('status')) is not str or item['status'] not in outcomes \
                or ('output' in item and type(item['output']) is not str):
            return failure
        observed[item['status']] += 1
    if raw['baselinePassed'] and any(observed[outcome] != counts[key] for outcome, key in outcomes.items()):
        return failure
    available = raw['baselinePassed'] and counts['selected'] > 0 and counts['notRun'] == counts['error'] == counts['timeout'] == 0
    status = 'failed' if not raw['baselinePassed'] or counts['error'] else 'no-candidates' if counts['available'] == 0 \
        else 'complete' if available and counts['available'] == counts['selected'] else 'partial'
    if raw.get('status') != status or type(raw.get('scoreAvailable')) is not bool or raw['scoreAvailable'] != available \
            or ('stageTimeoutSeconds' in context and raw.get('stageTimeoutSeconds') != context['stageTimeoutSeconds']):
        return failure
    excluded = raw.get('excluded')
    if type(excluded) is not dict or not all(_integer(excluded.get(key)) for key in ('noop', 'duplicate', 'invalid')):
        return failure
    return {'ok': True, 'run': copy.deepcopy(raw)}


def _line_set(value):
    return type(value) is list and all(_integer(line) and line > 0 for line in value) and len(set(value)) == len(value)


def _meets(executed, total, threshold):
    return total > 0 and int(executed) * int(threshold['denominator']) >= int(total) * int(threshold['numerator'])


def _valid_branch(value, lines):
    if type(value) is not str or re.fullmatch(r'\d+->-?\d+', value, re.ASCII) is None:
        return False
    origin, destination = map(int, value.split('->'))
    return _integer(origin) and origin in lines and abs(destination) <= MAX_SAFE_INTEGER and destination != 0


def evaluate_quality(policy_raw, evidence):
    validated = validate_quality_policy(policy_raw)
    if type(evidence) is not dict:
        evidence = {}
    result = {'schemaVersion': DEFINITION['assessmentVersion'],
              'policyHash': validated['policy']['policyHash'] if validated['ok'] else None, 'evidenceIdentity': None,
              'measurementStatus': 'unavailable', 'policyStatus': 'unassessable',
              'reviewStatus': evidence.get('reviewStatus') if type(evidence.get('reviewStatus')) is str else 'unknown',
              'toolsSatisfied': False, 'fullyPassed': False, 'reasons': [], 'counts': {'lines': None, 'mutation': None}}

    def fail(reason):
        result['reasons'].append(reason)
        return result

    if not validated['ok']:
        return fail(validated['reason'])
    policy, identity = validated['policy'], evidence.get('identity')
    if type(identity) is not dict or type(identity.get('sourcePath')) is not str or not identity['sourcePath'] \
            or not _digest(identity.get('sourceHash')) or not _digest(identity.get('testHash')) \
            or not _valid_scope(identity.get('targetScope')) or identity.get('policyHash') != policy['policyHash'] \
            or ('stageTimeoutSeconds' in identity and not _positive_number(identity['stageTimeoutSeconds'])):
        return fail('quality-identity-mismatch')
    result['evidenceIdentity'] = copy.deepcopy(identity)
    if evidence.get('executionPassed') is not True:
        return fail('execution-not-passed')
    gaps = evidence.get('qualityGaps')
    if type(gaps) is not list or not all(type(item) is str for item in gaps):
        return fail('invalid-quality-gaps')
    coverage = evidence.get('coverage')
    if type(coverage) is not dict or coverage.get('sourceHash') != identity['sourceHash'] \
            or coverage.get('testHash') != identity['testHash'] or not _same_scope(coverage.get('targetScope'), identity['targetScope']) \
            or type(coverage.get('assessment')) is not dict:
        return fail('coverage-identity-mismatch')
    measured, invocation = coverage['assessment'], coverage['assessment'].get('invocationEvidence')
    lines, missing, branches = measured.get('executableTargetLines'), measured.get('missingTargetLines'), measured.get('missingTargetBranches')
    if measured.get('available') is not True or measured.get('evidenceVersion') != DEFINITION['coverageVersion'] \
            or measured.get('scopeStatus') != 'verified' or type(invocation) is not dict \
            or invocation.get('testHash') != identity['testHash'] or type(invocation.get('testRunId')) is not str or not invocation['testRunId'] \
            or type(invocation.get('observed')) is not bool or type(measured.get('targetExecuted')) is not bool \
            or measured['targetExecuted'] != invocation['observed'] \
            or not _line_set(lines) or not lines or not _line_set(missing) or not set(missing).issubset(lines) \
            or type(measured.get('targetFullyCovered')) is not bool \
            or measured['targetFullyCovered'] != (measured['targetExecuted'] is True and not missing) \
            or type(measured.get('targetBranchesCovered')) is not bool or type(branches) is not list \
            or not all(_valid_branch(item, lines) for item in branches) \
            or len(set(branches)) != len(branches) or measured['targetBranchesCovered'] != (not branches):
        return fail('invalid-coverage-evidence')
    result['counts']['lines'] = {'total': len(lines), 'executed': len(lines) - len(missing) if measured['targetExecuted'] else 0}
    parsed = read_stored_mutation_run(evidence.get('mutation'), identity)
    if not parsed['ok']:
        return fail('invalid-mutation-evidence')
    run = parsed['run']
    result['counts']['mutation'] = {'killed': run['counts']['killed'], 'total': run['counts']['selected'], 'available': run['counts']['available']}
    if run['status'] == 'no-candidates':
        result['measurementStatus'] = 'not-applicable'
        return fail('no-mutation-candidates')
    if run['status'] == 'partial':
        result['measurementStatus'] = 'partial'
        return fail('mutation-incomplete')
    if run['status'] != 'complete' or not run['scoreAvailable'] or not run['baselinePassed']:
        return fail('mutation-unavailable')
    result['measurementStatus'] = 'complete'
    reasons = result['reasons']
    if not measured['targetExecuted']:
        reasons.append('target-not-executed')
    if not _meets(result['counts']['lines']['executed'], result['counts']['lines']['total'], policy['lineThreshold']):
        reasons.append('line-threshold-not-met')
    if not measured['targetBranchesCovered']:
        reasons.append('branches-not-covered')
    if not _meets(run['counts']['killed'], run['counts']['selected'], policy['mutationThreshold']):
        reasons.append('mutation-threshold-not-met')
    if gaps:
        reasons.append('additional-quality-gaps')
    result['toolsSatisfied'] = not reasons
    result['policyStatus'] = 'met' if result['toolsSatisfied'] else 'below-threshold'
    review_complete = evidence.get('reviewStatus') == 'completed' or (evidence.get('reviewStatus') == 'not-required'
                                                                                    and evidence.get('generationMode') == 'deterministic-fallback')
    if not review_complete:
        reasons.append('review-incomplete' if evidence.get('reviewStatus') == 'incomplete' else 'review-provenance-missing')
    result['fullyPassed'] = result['toolsSatisfied'] and review_complete
    return result
