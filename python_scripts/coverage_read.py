"""Read native coverage evidence for one exact source/target without importing it."""
import argparse
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import io
import json
from pathlib import Path

from coverage import Coverage
from target_invocation import canonical_path, target_scope, verified_invocation


SCHEMA_VERSION = 'coverage-evidence-v1'


def read_coverage(file, target, data_file='.coverage', invocation_evidence=None, expected_run_id=None, expected_test_hash=None):
    canonical = canonical_path(file)
    result = {'schemaVersion': SCHEMA_VERSION, 'canonicalFile': canonical, 'target': target,
              'available': False, 'scopeStatus': 'unresolved'}
    try:
        source_bytes = Path(file).read_bytes()
        result['sourceHash'] = hashlib.sha256(source_bytes).hexdigest()
        scope, ambiguous = target_scope(source_bytes.decode('utf-8-sig'), target)
        result['invocationRequired'] = ambiguous
        invocation = verified_invocation(invocation_evidence, file, target, result['sourceHash'], data_file,
                                         expected_run_id, expected_test_hash)
        if invocation_evidence and invocation is None:
            raise ValueError('invalid-invocation-evidence')
        if ambiguous and invocation is None:
            raise ValueError('target-scope-ambiguous')
        result['scopeStatus'] = 'verified'
        if invocation:
            result['invocation'] = invocation
        coverage = Coverage(data_file=data_file, config_file=False)
        coverage.load()
        measured = [name for name in coverage.get_data().measured_files() if canonical_path(name) == canonical]
        if len(measured) != 1:
            raise ValueError('target-not-measured')
        filename, statement_lines, excluded, missing, _ = coverage.analysis2(measured[0])
        if canonical_path(filename) != canonical:
            raise ValueError('source-identity-mismatch')
        statements = set(statement_lines) - set(excluded)
        missing = set(missing)
        if not missing <= statements:
            raise ValueError('invalid-statement-partition')
        result.update(available=True, statements=sorted(statements),
                      executedStatements=sorted(statements - missing), missingStatements=sorted(missing),
                      targetStatements=sorted(statements & scope), branchCoverageAvailable=False)
        # Coverage 4.x has analysis2 but no JSON branch reporter. Keep line
        # evidence usable and branch status explicitly unknown on such versions.
        if coverage.get_data().has_arcs() and hasattr(coverage, 'json_report'):
            stdout = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(io.StringIO()):
                coverage.json_report(morfs=measured, outfile='-')
            report = json.loads(stdout.getvalue())
            matching = [entry for name, entry in report.get('files', {}).items()
                        if canonical_path(name) == canonical]
            if len(matching) != 1 or report.get('meta', {}).get('branch_coverage') is not True:
                raise ValueError('invalid-branch-report')
            entry = matching[0]
            executed = entry.get('executed_branches')
            unexecuted = entry.get('missing_branches')
            summary = entry.get('summary', {})
            if not isinstance(executed, list) or not isinstance(unexecuted, list):
                raise ValueError('incomplete-branch-report')
            result.update(branchCoverageAvailable=True, executedBranches=executed, missingBranches=unexecuted,
                          branchCounts={'total': summary.get('num_branches'), 'executed': summary.get('covered_branches'),
                                        'missing': summary.get('missing_branches')})
        return result
    except Exception as error:
        # Do not expose source, database content, or arbitrary exception text.
        reason = str(error) if type(error) is ValueError and str(error) in {
            'target-scope-unresolved', 'target-scope-ambiguous', 'target-not-measured', 'source-identity-mismatch',
            'invalid-statement-partition', 'invalid-branch-report', 'incomplete-branch-report', 'invalid-invocation-evidence'
        } else 'coverage-read-failed'
        return {**result, 'available': False, 'reason': reason,
                'scopeStatus': 'ambiguous' if reason == 'target-scope-ambiguous' else result['scopeStatus']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file')
    parser.add_argument('target')
    parser.add_argument('data_file', nargs='?', default='.coverage')
    parser.add_argument('--invocation-evidence')
    parser.add_argument('--expected-run-id')
    parser.add_argument('--expected-test-hash')
    arguments = parser.parse_args()
    print(json.dumps(read_coverage(**vars(arguments)), ensure_ascii=False))
