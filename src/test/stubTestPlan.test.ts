import * as assert from 'assert';
import { test } from 'node:test';
import { buildStubTestPlan } from '../tier/stubTestPlan';

test('builds a module stub smoke-test plan with placeholder method arguments', () => {
    assert.deepStrictEqual(buildStubTestPlan('sample', 'pending', ['value']), {
        importLine: 'from sample import pending',
        setupBlock: '',
        callLine: 'result = pending(None)'
    });
});

test('calls static and class stubs without constructing an instance', () => {
    const plan = buildStubTestPlan('sample', 'label', ['value'], 'Service', 'static');
    assert.strictEqual(plan?.setupBlock, '');
    assert.strictEqual(plan?.callLine, 'result = Service.label(None)');
});

test('reuses verified constructor literals for an instance stub smoke-test', () => {
    const plan = buildStubTestPlan('sample', 'pending', [], 'Service', 'instance', ['prefix'], [{
        trace_constructor_args: ['prefix:'],
        trace_constructor_kwargs: {},
        constructor_args: ["'prefix:'"],
        constructor_kwargs: {}
    }]);
    assert.strictEqual(plan?.setupBlock, "    def setUp(self):\n        self._instance = Service('prefix:')");
    assert.strictEqual(plan?.callLine, 'result = self._instance.pending()');
});

test('does not generate an invalid instance stub test without required constructor facts', () => {
    assert.strictEqual(buildStubTestPlan('sample', 'pending', [], 'Service', 'instance', ['dependency']), null);
});

test('reads a property stub without calling the descriptor as a method', () => {
    const plan = buildStubTestPlan('sample', 'enabled', [], 'Feature', 'property');
    assert.strictEqual(plan?.callLine, 'result = self._instance.enabled');
});

test('filters out self and cls parameter when building placeholder argument list', () => {
    const instancePlan = buildStubTestPlan('sample', 'do_action', ['self', 'arg1', 'arg2'], 'Worker', 'instance');
    assert.strictEqual(instancePlan?.callLine, 'result = self._instance.do_action(None, None)');

    const classPlan = buildStubTestPlan('sample', 'create_instance', ['cls', 'config'], 'Worker', 'class');
    assert.strictEqual(classPlan?.callLine, 'result = Worker.create_instance(None)');
});
