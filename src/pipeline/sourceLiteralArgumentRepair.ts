import { runSpawn } from '../utils/processRunner';
import { pythonToolPath } from './pythonTools';
import { evidenceHash } from './analysisJournal';
import { AnalysisStageError } from '../utils/executionFailureCategory';

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export interface LiteralArgumentRepairOptions {
    source: string; code: string; failure: string; target: string; python: string; module?: string;
    moduleSource?: string; moduleSourceHash?: string;
    checkCurrent(): void;
    request(system: string, prompt: string): Promise<string>;
    event?(status: string, detail: Record<string, unknown>): void;
}

/** An AI edit directive selects an immutable source slice, never a new expected output. */
export async function repairSourceLiteralArgument(options: LiteralArgumentRepairOptions): Promise<string | undefined> {
    return repairSourceSpelling(options, 'literal-argument');
}

export async function repairSourceMockReceiver(options: LiteralArgumentRepairOptions): Promise<string | undefined> {
    return repairSourceSpelling(options, 'mock-receiver');
}

export async function repairSourceTestBinding(options: LiteralArgumentRepairOptions): Promise<string | undefined> {
    return repairSourceSpelling(options, 'test-binding');
}

async function repairSourceSpelling(options: LiteralArgumentRepairOptions,
    kind: 'literal-argument' | 'mock-receiver' | 'test-binding'): Promise<string | undefined> {
    const { source, code, failure, target, python } = options;
    const literal = kind === 'literal-argument';
    const binding = kind === 'test-binding';
    const receiverModule = !literal && !binding && options.moduleSource !== undefined;
    if (binding ? !/Writer binding repair: [_\p{ID_Start}][_\p{ID_Continue}]* is undefined or read before its local binding in [_\p{ID_Start}][_\p{ID_Continue}]*\./u.test(failure)
        : literal ? !/^AssertionError: expected call not found\.\r?$/m.test(failure)
        : !/^AssertionError: Expected '[^'\r\n]+' to (?:be called once|have been called once)\. Called 0 times\.\r?$/m.test(failure)
            && !/^AttributeError: '[^'\r\n]+' object has no attribute '[A-Za-z_]\w{0,79}'\r?$/m.test(failure)
            && !failure.startsWith('Mock assertion is not proven to observe an explicit target use-point patch or a mock passed to the target.')) { return undefined; }
    const version = binding ? 'source-test-binding-repair-v1' : literal ? 'source-literal-argument-repair-v1' : 'source-mock-receiver-repair-v1';
    const slot = binding ? 'import-1' : literal ? 'argument-1' : 'receiver-1';
    const prefix = binding ? 'binding-selection' : literal ? 'literal-selection' : 'receiver-selection';
    if (binding && (!options.moduleSource || !hash(options.moduleSourceHash))) { return undefined; }
    if ((binding || receiverModule) && evidenceHash(options.moduleSource!) !== options.moduleSourceHash) {
        throw new AnalysisStageError('validation', 'source-changed', 'Source module changed before binding repair.');
    }
    const payload = { source, code, failure, target, ...(!literal ? { module: options.module } : {}),
        ...(binding || receiverModule ? { moduleSource: options.moduleSource, moduleSourceHash: options.moduleSourceHash } : {}) };
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > (binding ? 1536 : 256) * 1024) { return undefined; }
    const invalid = (): never => { throw new AnalysisStageError('validation', 'source-spelling-tool',
        'Source spelling repair evidence is invalid; no edit was adopted.'); };
    const call = async (extra: Record<string, unknown>) => {
        options.checkCurrent();
        const result = await runSpawn(python, ['-I', '-B', pythonToolPath(binding ? 'sourceTestBindingRepair' : literal ? 'sourceLiteralRepair' : 'sourceMockReceiverRepair')], {
            input: JSON.stringify({ ...payload, ...extra }), timeout: 5000
        });
        options.checkCurrent();
        if (result.code !== 0) { return invalid(); }
        try { return JSON.parse(result.stdout); } catch { return invalid(); }
    };
    const plan = await call({ operation: 'plan' });
    if (plan?.version !== version) { return invalid(); }
    if (plan.status === 'unsupported') { return undefined; }
    const bytes = Buffer.from(code, 'utf8');
    if (plan.status !== 'eligible' || plan.target !== target || plan.targetSourceHash !== evidenceHash(source)
        || plan.testHash !== evidenceHash(code) || !hash(plan.planHash)
        || (binding ? plan.importId : literal ? plan.argumentId : plan.receiverId) !== slot
        || binding && (plan.editKind !== 'insert-import' || plan.moduleSourceHash !== options.moduleSourceHash)
        || receiverModule && plan.moduleSourceHash !== options.moduleSourceHash
        || binding && (typeof plan.missingName !== 'string' || !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(plan.missingName))
        || plan.assertionOracle !== false || plan.patchAuthorization !== false
        || !literal && !binding && !['native-failure', 'static-binding'].includes(plan.failureBasis)
        || typeof plan.method !== 'string' || typeof plan.methodSource !== 'string'
        || !plan.methodSource || !code.includes(plan.methodSource)
        || !Number.isSafeInteger(plan.startByte) || !Number.isSafeInteger(plan.endByte)
        || plan.startByte < 0 || (binding ? plan.endByte !== plan.startByte : plan.endByte <= plan.startByte) || plan.endByte > bytes.length
        || (binding ? plan.oldImportHash : literal ? plan.oldLiteralHash : plan.oldReceiverHash) !== evidenceHash(bytes.subarray(plan.startByte, plan.endByte).toString('utf8'))
        || !Array.isArray(plan.choices) || !plan.choices.length || plan.choices.length > 4
        || plan.choices.some((choice: any, index: number) => choice?.id !== `source-${index + 1}`
            || typeof choice.source !== 'string' || !choice.source || choice.source.length > 16384
            || !(binding && choice.bindingOrigin === 'stdlib-test-helper' && choice.sourceLine === null
                || Number.isSafeInteger(choice.sourceLine) && choice.sourceLine >= 1)
            || binding && !['target-module', 'stdlib-test-helper'].includes(choice.bindingOrigin)
            || !hash(choice.valueHash))) { return invalid(); }
    options.event?.(prefix + '-planned', { version, planHash: plan.planHash,
        previousTestHash: plan.testHash, targetSourceHash: plan.targetSourceHash,
        method: plan.method, choices: plan.choices.length, otherCodeLocked: true,
        ...(binding ? { moduleSourceHash: plan.moduleSourceHash, missingName: plan.missingName }
            : literal ? {} : { failureBasis: plan.failureBasis }) });
    const directiveFor = (id: string) => binding ? `INSERT ${slot} FROM ${id}` : `REPLACE ${slot} WITH ${id}`;
    const system = (binding ? 'Repair only an AST-proven unresolved test name with one explicit method-local import from a supplied binding. '
        : literal ? 'Repair only whitespace in one failed dependency-call argument. '
        : 'Repair only the receiver of one source-bound Mock assertion using source-proven consumption paths from its existing patch. ')
        + 'Select a supplied source spelling without retyping it. '
        + `Return exactly ${directiveFor('source-N')} using a supplied ID, or ABSTAIN. No code, fence, explanation or JSON. `
        + 'All other code, inputs, setup and assertions are locked by the host. '
        + (!literal ? 'Keep the same assertion method, call count and arguments; never weaken an assertion or patch the target. ' : '')
        + (binding ? 'Do not install packages or call source helpers for expected values. Binding names prove no values or types. ' : '')
        + 'Source spellings are not target return-value oracles or execution approval.';
    const prompt = (binding ? 'SOURCE_TEST_BINDING_SELECTION_V1' : literal ? 'SOURCE_LITERAL_SELECTION_V1' : 'SOURCE_MOCK_RECEIVER_SELECTION_V1') + '\nCOMPLETE TARGET SOURCE\n' + source
        + `\nCOMPLETE FAILING METHOD (all but ${slot} are locked)\n` + plan.methodSource
        + '\nSOURCE SPELLING CHOICES\n' + JSON.stringify(plan.choices)
        + (binding ? `\nThe static binding checker reports missing name ${plan.missingName}; only an import may be inserted. `
            : literal ? '\nargument-1 differs from these source arguments only in whitespace. '
            : plan.failureBasis === 'static-binding' ? '\nThe static checker cannot prove this assertion receiver observes the target dependency. No runtime call failure is claimed. Choices follow the same existing patch and object identity. '
                : '\nreceiver-1 failed to resolve or observe the expected call. Choices follow the source receiver through the same existing patch. ')
        + 'Select its source-preserving replacement, or abstain.';
    const raw = await options.request(system, prompt);
    options.checkCurrent();
    const directive = raw.trim();
    const choice = plan.choices.find((item: any) => directive === directiveFor(item.id));
    if (!choice) {
        options.event?.(prefix + '-rejected', { version, planHash: plan.planHash,
            reasonCode: directive === 'ABSTAIN' ? 'model-abstained' : 'invalid-directive', responseHash: evidenceHash(raw) });
        throw new AnalysisStageError('model-format', binding ? 'test-binding-repair-response' : literal ? 'literal-repair-response' : 'mock-receiver-repair-response',
            binding ? 'The model did not return an applicable test import directive; no edit was applied.'
                : literal ? 'The model did not return an applicable source literal edit directive; no edit was applied.'
                : 'The model did not return an applicable source receiver edit directive; no edit was applied.');
    }
    const applied = await call({ operation: 'apply', planHash: plan.planHash, directive });
    const expected = Buffer.concat([bytes.subarray(0, plan.startByte), Buffer.from(choice.source),
        bytes.subarray(plan.endByte)]).toString('utf8');
    if (applied?.version !== version || applied.status !== 'applied' || applied.planHash !== plan.planHash
        || applied.previousTestHash !== plan.testHash || applied.targetSourceHash !== plan.targetSourceHash
        || applied.choiceId !== choice.id || applied.code !== expected || applied.code === code
        || applied.candidateHash !== evidenceHash(expected)) { return invalid(); }
    options.event?.(prefix + '-applied', { version, planHash: plan.planHash,
        previousTestHash: plan.testHash, candidateHash: applied.candidateHash,
        choiceId: choice.id, ...(binding ? { sourceImportHash: choice.valueHash }
            : literal ? { sourceValueHash: choice.valueHash } : { sourceExpressionHash: choice.valueHash }), responseHash: evidenceHash(raw),
        executionApproved: false });
    return applied.code;
}
