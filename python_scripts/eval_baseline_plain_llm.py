"""Control group for the evaluation (architecture 6.3): the same model writes unittest in one request.

For each target the model receives exactly the architecture prompt
「以下是一個 Python 函式，請為它寫 unittest」 followed by the complete function
source. One request, no revision, no review, no AST facts or execution results.
Model settings (temperature 0, num_ctx, localThinkingMode) match the system and
are recorded. The generated test runs through the same guarded runner
(generated_test_runner.py), coverage (coverage_read.py) and mutation engine
(basic_mutation_runner.py / external_mutation_runner.py) as the system.
Model failures, syntax errors, missing test methods, failing tests and timeouts
all stay in the denominator.

The output folder looks like a batch (batch_manifest.json plus one folder per
target with function_knowledge.json and role_events.jsonl), so eval_aggregate.py
summarises it as a third group (method "plain-llm").

Usage:
  python python_scripts/eval_baseline_plain_llm.py --targets eval/eval_screening/targets.json \\
      --model gpt-oss:20b --output <new folder> [--ollama-url http://127.0.0.1:11434] [--num-ctx 8192] \\
      [--thinking provider-default|disabled] [--mutation-engine builtin|mutatest] [--python <interpreter>]
"""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import uuid

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
# Architecture 6.3, verbatim. Do not add instructions: the control group must stay a plain request.
PROMPT_HEADER = '以下是一個 Python 函式，請為它寫 unittest'
METHOD = 'plain-llm'
ROLE = 'plain-llm'
BUILTIN_OPERATOR_SET_VERSION = 'builtin-ast-v3'
FENCE = re.compile(r'```(?:python|py)?[^\n]*\n(.*?)```', re.S | re.I)


def build_prompt(function_source):
    return f'{PROMPT_HEADER}\n\n{function_source}'


def function_source(source, target):
    """Complete source of `func` or `Class.method` (decorators included)."""
    tree = ast.parse(source)
    body, node = tree.body, None
    parts = target.split('.')
    for index, name in enumerate(parts):
        last = index == len(parts) - 1
        kinds = (ast.FunctionDef, ast.AsyncFunctionDef) if last else (ast.ClassDef,)
        matches = [item for item in body if isinstance(item, kinds) and item.name == name]
        if not matches:
            raise ValueError(f'target-not-found: {target}')
        node = matches[-1]
        body = node.body
    lines = source.splitlines()
    start = min([node.lineno] + [decorator.lineno for decorator in node.decorator_list])
    return '\n'.join(lines[start - 1:node.end_lineno])


def ollama_request(prompt, settings):
    """One non-streaming Ollama request with the system's settings (temperature 0, num_ctx, think)."""
    body = {'model': settings['model'], 'prompt': prompt, 'stream': False,
            'options': {'temperature': 0, 'num_ctx': settings['numCtx']}}
    if settings['localThinkingMode'] == 'disabled':
        body['think'] = False
    request = urllib.request.Request(settings['ollamaUrl'].rstrip('/') + '/api/generate',
                                     data=json.dumps(body).encode('utf-8'), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=settings['requestTimeoutSeconds']) as response:
        payload = json.loads(response.read().decode('utf-8'))
    return {'response': payload.get('response', ''), 'promptEvalCount': payload.get('prompt_eval_count'),
            'evalCount': payload.get('eval_count'), 'completionReason': payload.get('done_reason')}


def extract_test_code(response):
    fenced = FENCE.findall(response or '')
    if fenced:
        return max(fenced, key=len).strip() + '\n'
    text = (response or '').strip()
    return text + '\n' if ('import unittest' in text or re.search(r'^\s*def test', text, re.M)) else None


def count_test_methods(tree):
    return sum(1 for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
               for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith('test'))


def _environment(import_paths):
    env = dict(os.environ)
    env.pop('PYTHONPATH', None)
    env['LLM_UNIT_TEST_IMPORT_PATHS'] = json.dumps(import_paths)
    env['PYTHONIOENCODING'] = 'utf-8'
    return env


def _python(python, script, args, cwd, import_paths, timeout):
    return subprocess.run([python, '-E', '-X', 'utf8', '-B', os.path.join(SCRIPTS, script), *args], cwd=cwd,
                          env=_environment(import_paths), capture_output=True, text=True, encoding='utf-8', timeout=timeout)


def _read_json(path):
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def run_test_file(python, workdir, module, code, file, target, import_paths, timeout, coverage=False):
    test_path = os.path.join(workdir, f'{module}.py')
    with open(test_path, 'w', encoding='utf-8') as handle:
        handle.write(code)
    evidence = os.path.join(workdir, f'{module}.invocation.json')
    result = os.path.join(workdir, f'{module}.runner.json')
    args = [module, '-v', '--target-file', file, '--target-name', target, '--target-test-file', test_path,
            '--target-evidence', evidence, '--target-run-id', str(uuid.uuid4()),
            '--violation-report', os.path.join(workdir, f'{module}.isolation.jsonl'), '--result-json', result]
    if coverage:
        args.append(f'--coverage-source={os.path.dirname(file)}')
    try:
        run = _python(python, 'generated_test_runner.py', args, workdir, import_paths, timeout)
    except subprocess.TimeoutExpired:
        return {'status': 'timeout', 'testPath': test_path}
    report, invocation = _read_json(result) or {}, _read_json(evidence) or {}
    observed = invocation.get('observed') is True and invocation.get('status') == 'passed'
    status = 'passed' if run.returncode == 0 and report.get('status') == 'passed' else (report.get('status') or 'runner-error')
    return {'status': status, 'targetObserved': observed, 'testsRun': report.get('testsRun', 0), 'testPath': test_path,
            'evidence': evidence, 'invocation': invocation, 'output': (run.stdout + run.stderr)[-3000:]}


def measure_coverage(python, workdir, code, file, target, import_paths, timeout):
    run = run_test_file(python, workdir, 'baseline_coverage_test', code, file, target, import_paths, timeout, coverage=True)
    if run['status'] != 'passed' or not run['targetObserved']:
        return {'available': False, 'reasonCode': 'coverage-run-failed'}
    invocation = run['invocation']
    try:
        read = _python(python, 'coverage_read.py', [file, target, '--invocation-evidence', run['evidence'],
                                                    '--expected-run-id', str(invocation.get('testRunId')),
                                                    '--expected-test-hash', str(invocation.get('testHash'))],
                       workdir, import_paths, 30)
        raw = json.loads(read.stdout)
    except (subprocess.TimeoutExpired, ValueError):
        return {'available': False, 'reasonCode': 'coverage-read-failed'}
    if not raw.get('available') or not isinstance(raw.get('targetStatements'), list):
        return {'available': False, 'reasonCode': str(raw.get('reason') or 'coverage-unavailable')}
    target_lines = raw['targetStatements']
    missing = sorted(set(target_lines) & set(raw.get('missingStatements') or []))
    return {'available': True, 'raw': raw,
            'assessment': {'executableTargetLines': target_lines, 'missingTargetLines': missing}}


def measure_mutation(python, workdir, test_path, file, target, import_paths, engine, stage_seconds, workers):
    parts = target.split('.')
    function_name, class_name = parts[-1], (parts[0] if len(parts) > 1 else '')
    common = [file, test_path, '0', str(min(5, stage_seconds)), function_name, class_name, str(stage_seconds), str(workers)]
    if engine == 'builtin':
        script = 'basic_mutation_runner.py'
        args = [*common, BUILTIN_OPERATOR_SET_VERSION] + ([] if class_name else ['--activate-functions'])
    else:
        script, args = 'external_mutation_runner.py', [engine, *common]
    try:
        run = _python(python, script, args, workdir, import_paths, stage_seconds + 30)
        result = json.loads(run.stdout)
    except (subprocess.TimeoutExpired, ValueError):
        return {'score': None, 'reasonCode': 'mutation-failed'}
    counts = result.get('counts') or {}
    if run.returncode != 0 or not result.get('scoreAvailable') or not counts.get('selected'):
        return {'score': None, 'reasonCode': 'mutation-unmeasured', 'counts': counts}
    return {'score': 100.0 * counts['killed'] / counts['selected'], 'counts': counts, 'engine': engine}


def evaluate_target(settings, file, target, workdir, request_fn):
    """Return (record, role_events) for one target; every outcome is a counted result."""
    os.makedirs(workdir, exist_ok=True)
    with open(file, encoding='utf-8') as handle:
        source = handle.read()
    prompt = build_prompt(function_source(source, target))
    with open(os.path.join(workdir, 'prompt.txt'), 'w', encoding='utf-8') as handle:
        handle.write(prompt)
    events = [{'stage': 'model-request', 'status': 'requested', 'detail': {'role': ROLE, 'pipeline': METHOD}}]
    started = time.monotonic()
    record = {'terminalStatus': 'failed', 'reasonCode': None, 'mutationScore': None, 'coverage': None}
    try:
        reply = request_fn(prompt, settings)
    except Exception as failure:  # transport or provider failure is a counted outcome, never a skip
        events.append({'stage': 'model-request', 'status': 'error', 'detail': {
            'role': ROLE, 'elapsedMs': int((time.monotonic() - started) * 1000), 'reasonCode': type(failure).__name__}})
        record['reasonCode'] = 'model-call-failed'
        return record, events
    events.append({'stage': 'model-request', 'status': 'timing', 'detail': {
        'role': ROLE, 'version': 'model-request-timing-v1', 'kind': 'transport', 'outcome': 'completed',
        'ollama': {'promptEvalCount': reply.get('promptEvalCount'), 'evalCount': reply.get('evalCount'),
                   'completionReason': reply.get('completionReason')}}})
    events.append({'stage': 'model-request', 'status': 'completed',
                   'detail': {'role': ROLE, 'elapsedMs': int((time.monotonic() - started) * 1000)}})
    with open(os.path.join(workdir, 'response.txt'), 'w', encoding='utf-8') as handle:
        handle.write(reply.get('response') or '')
    code = extract_test_code(reply.get('response'))
    if code is None:
        record['reasonCode'] = 'no-test-code'
        return record, events
    try:
        tree = ast.parse(code)
    except SyntaxError:
        record['reasonCode'] = 'syntax-error'
        return record, events
    if count_test_methods(tree) == 0:
        record['reasonCode'] = 'no-test-methods'
        return record, events
    import_paths = settings['importPaths'](file)
    run = run_test_file(settings['python'], workdir, 'baseline_test', code, file, target, import_paths, settings['testTimeoutSeconds'])
    if run['status'] == 'timeout':
        record['reasonCode'] = 'test-timeout'
        return record, events
    if run['status'] != 'passed':
        record['reasonCode'] = 'tests-failed' if run['status'] == 'failed' else 'test-runner-error'
        return record, events
    if not run['targetObserved']:
        record['reasonCode'] = 'target-not-called'
        return record, events
    record['coverage'] = measure_coverage(settings['python'], workdir, code, file, target, import_paths,
                                          settings['testTimeoutSeconds'])
    mutation = measure_mutation(settings['python'], workdir, run['testPath'], file, target, import_paths,
                                settings['mutationEngine'], settings['mutationStageSeconds'], settings['mutationWorkers'])
    record['mutation'] = mutation
    record['mutationScore'] = mutation['score']
    # Same tier rule as v2 usable: passing tests that call the target; mutation is reported separately.
    record['terminalStatus'], record['reasonCode'] = 'usable', 'usable'
    return record, events


def load_targets(path):
    with open(path, encoding='utf-8') as handle:
        data = json.load(handle)
    base = os.path.dirname(os.path.abspath(path))
    targets = data.get('targets') if isinstance(data, dict) else None
    if not isinstance(targets, dict):
        raise ValueError('targets file must map file names to target lists')
    return base, [(file, target) for file, names in targets.items() for target in names]


def _safe(name):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', name)[:60]


def run_baseline(settings, targets_path, output, request_fn=ollama_request):
    if os.path.exists(output) and os.listdir(output):
        raise ValueError('output folder must be new or empty')
    os.makedirs(output, exist_ok=True)
    base, targets = load_targets(targets_path)
    settings = {**settings, 'importPaths': lambda file: list(dict.fromkeys([os.path.dirname(file), base]))}
    started_at = datetime.now(timezone.utc).isoformat()
    manifest_targets, model_requests, output_tokens, length_stops = [], 0, 0, 0
    for file_name, target in targets:
        file = os.path.join(base, file_name)
        folder = f'{_safe(os.path.splitext(file_name)[0])}/{_safe(target)}'
        workdir = os.path.join(output, *folder.split('/'))
        try:
            record, events = evaluate_target(settings, file, target, workdir, request_fn)
        except (OSError, ValueError, SyntaxError) as failure:
            os.makedirs(workdir, exist_ok=True)
            record, events = {'terminalStatus': 'failed', 'reasonCode': 'target-unreadable', 'detail': str(failure)[:200],
                              'mutationScore': None, 'coverage': None}, []
        source_hash = None
        if os.path.isfile(file):
            with open(file, 'rb') as handle:
                source_hash = hashlib.sha256(handle.read()).hexdigest()
        run_id = str(uuid.uuid4())
        knowledge = {'schemaVersion': 2, 'runId': run_id, 'sourceHash': source_hash, 'target': target, 'method': METHOD, **record}
        with open(os.path.join(workdir, 'function_knowledge.json'), 'w', encoding='utf-8') as handle:
            json.dump(knowledge, handle, ensure_ascii=False, indent=2)
        with open(os.path.join(workdir, 'role_events.jsonl'), 'w', encoding='utf-8') as handle:
            for index, event in enumerate(events, 1):
                handle.write(json.dumps({'sequence': index, 'runId': run_id, 'sourceHash': source_hash, 'loop': 1, **event},
                                        ensure_ascii=False) + '\n')
        requests = sum(1 for event in events if event['status'] == 'requested')
        model_requests += requests
        for event in events:
            ollama = event['detail'].get('ollama') if event['status'] == 'timing' else None
            if isinstance(ollama, dict):
                output_tokens += ollama.get('evalCount') or 0
                length_stops += 1 if ollama.get('completionReason') == 'length' else 0
        manifest_targets.append({'file': file_name, 'target': target, 'state': 'finished', 'terminalStatus': record['terminalStatus'],
                                 'reasonCode': record['reasonCode'], 'reportDirectory': folder, 'modelRequests': requests})
    counts = {}
    for item in manifest_targets:
        counts[item['terminalStatus']] = counts.get(item['terminalStatus'], 0) + 1
    manifest = {'schemaVersion': 'baseline-batch-v1', 'batchId': str(uuid.uuid4()), 'method': METHOD,
                'model': f"{settings['model']} ({METHOD})", 'status': 'complete', 'startedAt': started_at,
                'finishedAt': datetime.now(timezone.utc).isoformat(), 'expectedTargets': len(manifest_targets),
                'finishedTargets': len(manifest_targets), 'attemptedTargets': len(manifest_targets), 'statusCounts': counts,
                'targets': manifest_targets, 'cost': {'modelRequests': model_requests, 'outputTokens': output_tokens},
                'modelCapabilitySummary': {'lengthStoppedTransports': length_stops},
                'settings': {'model': settings['model'], 'temperature': 0, 'numCtx': settings['numCtx'],
                             'localThinkingMode': settings['localThinkingMode'], 'mutationEngine': settings['mutationEngine'],
                             'prompt': PROMPT_HEADER + ' + complete function source'}}
    with open(os.path.join(output, 'batch_manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description='Plain single-request LLM baseline (architecture 6.3).')
    parser.add_argument('--targets', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--ollama-url', default='http://127.0.0.1:11434')
    parser.add_argument('--num-ctx', type=int, default=8192)
    parser.add_argument('--thinking', choices=['provider-default', 'disabled'], default='provider-default')
    parser.add_argument('--mutation-engine', choices=['builtin', 'mutatest'], default='builtin')
    parser.add_argument('--mutation-seconds', type=int, default=120)
    parser.add_argument('--mutation-workers', type=int, default=2)
    parser.add_argument('--request-timeout', type=int, default=300)
    parser.add_argument('--test-timeout', type=int, default=60)
    parser.add_argument('--python', default=sys.executable)
    args = parser.parse_args(argv)
    settings = {'model': args.model, 'ollamaUrl': args.ollama_url, 'numCtx': args.num_ctx, 'localThinkingMode': args.thinking,
                'mutationEngine': args.mutation_engine, 'mutationStageSeconds': args.mutation_seconds,
                'mutationWorkers': args.mutation_workers, 'requestTimeoutSeconds': args.request_timeout,
                'testTimeoutSeconds': args.test_timeout, 'python': args.python}
    manifest = run_baseline(settings, args.targets, args.output)
    print(json.dumps({'output': args.output, 'statusCounts': manifest['statusCounts'],
                      'modelRequests': manifest['cost']['modelRequests']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
