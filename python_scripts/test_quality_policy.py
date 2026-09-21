import copy
import json
from pathlib import Path
import unittest

from quality_policy import (create_fixture_quality_policy, create_strict_quality_policy,
                            evaluate_quality, quality_policy_hash, validate_quality_policy)

VECTORS = json.loads((Path(__file__).resolve().parent.parent / 'contracts' / 'quality-policy-cases-v1.json').read_text(encoding='utf-8'))


class QualityPolicyTests(unittest.TestCase):
    def test_policy_construction_and_hash_match_portable_snapshots(self):
        self.assertEqual(create_strict_quality_policy(), VECTORS['policies']['strict100'])
        self.assertEqual(create_fixture_quality_policy(fixtureId='neutral-fixture', manifestHash='f' * 64,
                                                       minLineCoverage=100, minMutationScore=85), VECTORS['policies']['fixture85'])
        with self.assertRaises(ValueError):
            create_fixture_quality_policy(fixtureId='neutral-fixture', manifestHash='f' * 64,
                                          minLineCoverage=100, minMutationScore=85.5)
        policy = create_strict_quality_policy()
        self.assertEqual(quality_policy_hash(policy), policy['policyHash'])
        policy['mode'] = ['strict100']
        policy['policyHash'] = quality_policy_hash(policy)
        self.assertFalse(validate_quality_policy(policy)['ok'])

    def test_shared_conformance_cases(self):
        for item in VECTORS['cases']:
            with self.subTest(case=item['name']):
                evidence = copy.deepcopy(item['evidence'])
                result = evaluate_quality(item.get('policy', VECTORS['policies'][item['policyKey']]), evidence)
                for key, value in item['expected'].items():
                    self.assertEqual(result[key], value, key)
                self.assertEqual(evidence, item['evidence'])

    def test_termination_does_not_change_saved_candidate_quality(self):
        evidence = copy.deepcopy(VECTORS['cases'][0]['evidence'])
        baseline = evaluate_quality(VECTORS['policies']['strict100'], evidence)
        for reason in ('cancelled', 'round-limit', 'budget-exhausted', 'retained-after-failure'):
            self.assertEqual(evaluate_quality(VECTORS['policies']['strict100'], {**evidence, 'terminationReason': reason}), baseline)


if __name__ == '__main__':
    unittest.main()
