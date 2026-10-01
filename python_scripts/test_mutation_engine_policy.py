import copy
import hashlib
import unittest

from quality_policy import read_stored_mutation_run


def evidence(engine='builtin', version='builtin-ast-v2'):
    identity = {'sourcePath': 'sample.py', 'sourceHash': 'a' * 64, 'testHash': 'b' * 64,
                'targetScope': {'kind': 'function', 'qualifiedName': 'combine'}}
    candidate_id = 'c' * 64
    run = {**copy.deepcopy(identity), 'schemaVersion': 1, 'engine': engine, 'operatorSetVersion': version,
           'scopeVersion': 'selected-function-body-v1', 'executionBackend': 'isolated-unittest-v1',
           'baselinePassed': True, 'baselineStatus': 'passed', 'status': 'complete', 'scoreAvailable': True,
           'candidateIds': [candidate_id], 'candidateSetId': hashlib.sha256(candidate_id.encode()).hexdigest(),
           'counts': {'available': 1, 'selected': 1, 'executed': 1, 'notRun': 0, 'killed': 1, 'survived': 0, 'timeout': 0, 'error': 0},
           'excluded': {'noop': 0, 'duplicate': 0, 'invalid': 0},
           'mutants': [{'id': candidate_id, 'kind': 'BinOp', 'line': 2, 'column': 11, 'position': 0,
                       'from': 'Add', 'to': 'Sub', 'status': 'KILLED', 'killedBy': ['test_sample.Cases.test_sum']}]}
    if engine == 'mutatest':
        run['engineVersion'] = '3.1.0'
    return run, identity


class MutationEnginePolicyTests(unittest.TestCase):
    def test_v1_compatibility_and_new_isolated_engines(self):
        historical, identity = evidence('builtin', 'builtin-ast-v1')
        del historical['executionBackend']
        del historical['mutants'][0]['killedBy']
        for run in [historical, evidence()[0], evidence('mutatest', 'mutatest-ast-3.1.0-v1')[0]]:
            with self.subTest(version=run['operatorSetVersion']):
                self.assertTrue(read_stored_mutation_run(run, identity)['ok'])

    def test_version_engine_and_execution_backend_cannot_be_forged(self):
        base, identity = evidence('mutatest', 'mutatest-ast-3.1.0-v1')
        for patch in [{'engine': 'unknown'}, {'engine': ['mutatest']}, {'engine': 'mutmut'},
                      {'engineVersion': '9.0.0'}, {'engineVersion': None},
                      {'operatorSetVersion': 'builtin-ast-v2'}, {'operatorSetVersion': 'mutatest-ast-3.2.0-v1'},
                      {'executionBackend': None}, {'executionBackend': 'native-unverified'}]:
            with self.subTest(patch=patch):
                self.assertFalse(read_stored_mutation_run({**base, **patch}, identity)['ok'])
        for backend in [None, 'native-unverified']:
            builtin, identity = evidence()
            builtin['executionBackend'] = backend
            self.assertFalse(read_stored_mutation_run(builtin, identity)['ok'])

    def test_v2_and_external_kills_require_nonempty_unique_real_test_ids(self):
        for engine, version in [('builtin', 'builtin-ast-v2'), ('mutatest', 'mutatest-ast-3.1.0-v1')]:
            for attribution in [None, [], ['x', 'x'], [''], ['x\ny'], ['x\0y'], ['x' * 1025], [1], 'test_sample.Cases.test_sum']:
                run, identity = evidence(engine, version)
                if attribution is None:
                    del run['mutants'][0]['killedBy']
                else:
                    run['mutants'][0]['killedBy'] = attribution
                with self.subTest(engine=engine, attribution=attribution):
                    self.assertFalse(read_stored_mutation_run(run, identity)['ok'])
            run, identity = evidence(engine, version)
            run['mutants'][0]['killedBy'] = ['x' * 1024]
            self.assertTrue(read_stored_mutation_run(run, identity)['ok'])
            run, identity = evidence(engine, version)
            run['counts'].update(killed=0, survived=1)
            run['mutants'][0]['status'] = 'SURVIVED'
            self.assertFalse(read_stored_mutation_run(run, identity)['ok'])


if __name__ == '__main__':
    unittest.main()
