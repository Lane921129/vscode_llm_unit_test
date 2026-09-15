import { createHash } from 'crypto';
import {
    inferTestRuleIdsFromCode,
    getTestRuleCards,
    formatTestRuleCardsForPrompt
} from '../prompts/testRuleLibrary';
import { RuleSelectionV2 } from './evidenceContracts';

/** Selection is deterministic and runs after the Analyst has planned scenarios. */
type TestRuleContext = Omit<NonNullable<Parameters<typeof inferTestRuleIdsFromCode>[1]>, 'class_name'> & {
    class_name?: string | null;
};

interface SemanticPlanForDispatch {
    test_strategy?: {
        input_hints?: Array<{ param_name?: string; strategy?: string }>;
    };
}

function sourceLineFact(source: string, pattern: RegExp): string | undefined {
    const lines = source.split(/\r?\n/);
    const index = lines.findIndex(line => pattern.test(line));
    return index >= 0 ? `source-line-${index + 1}: ${lines[index].trim().slice(0, 180)}` : undefined;
}

function dependencyNames(context?: TestRuleContext): string[] {
    return (context?.dependencies || []).map((dependency, index) => {
        if (dependency && typeof dependency === 'object' && 'name' in dependency) {
            const name = (dependency as { name?: unknown }).name;
            if (typeof name === 'string' && name.trim()) {return name.trim();}
        }
        return `dependency-${index + 1}`;
    });
}

function triggerFactsForRule(
    ruleId: string,
    source: string,
    context?: TestRuleContext
): string[] {
    const imports = (context?.file_imports || [])
        .map(item => item.module || item.name || item.bound_name)
        .filter((name): name is string => Boolean(name));
    const dependencies = dependencyNames(context);
    const firstSourceFact = (...patterns: RegExp[]) => patterns
        .map(pattern => sourceLineFact(source, pattern))
        .find((fact): fact is string => Boolean(fact));
    let fact: string | undefined;
    switch (ruleId) {
        case 'import_module_name': fact = 'runner-contract: canonical target module path is required'; break;
        case 'string_length_boundary': fact = firstSourceFact(/\blen\s*\([^)]*\)\s*[<>]=?\s*\d+/); break;
        case 'python_slicing': fact = firstSourceFact(/\w+\s*\[\s*-?\d*\s*:\s*-?\d*\s*\]/); break;
        case 'branch_threshold_coverage': fact = firstSourceFact(/\b(?:if|elif)\b[^\n]*[<>]=?\s*\d+/); break;
        case 'boolean_truthiness_coverage': {
            const truthy = (context?.condition_facts || []).find(item => item.kind === 'truthiness');
            fact = truthy ? `ast-condition: ${truthy.parameter || 'parameter'} is a ${truthy.polarity || 'truthy'} branch condition` : undefined;
            break;
        }
        case 'pattern_matching': fact = firstSourceFact(/^\s*match\s+[^\n]+\s*:/); break;
        case 'float_precision': fact = firstSourceFact(/\bround\s*\(|\bfloat\s*\(|\bmath\./); break;
        case 'dict_return': fact = firstSourceFact(/\breturn\s*\{/); break;
        case 'tuple_return': fact = firstSourceFact(/\breturn\s*\([^\n]*,[^\n]*\)|\breturn\s+[^#\n]*,[^#\n]*/); break;
        case 'none_input_handling': fact = firstSourceFact(/\bNone\b|\bnot\s+\w+/); break;
        case 'assert_raises_syntax': fact = firstSourceFact(/\braise\s+[A-Za-z_]/); break;
        case 'try_except_returns_string': fact = firstSourceFact(/^\s*except\b/); break;
        case 'zero_division': fact = firstSourceFact(/\//); break;
        case 'class_method_testing': fact = `ast-binding: ${context?.class_name || 'class'}.${context?.method_kind || 'member'}`; break;
        case 'mock_external_dependency': fact = dependencies.length
            ? `ast-dependencies: ${dependencies.join(', ')}`
            : `dependency-import: ${imports.join(', ')}`; break;
        case 'observation_mock_isolation': fact = `ast-dependencies: ${dependencies.join(', ')}`; break;
        case 'caller_dependency_contract': fact = `ast-dependencies: ${dependencies.join(', ')}`; break;
        case 'database_state_isolation': fact = `database-binding: ${imports.filter(name => /sqlite|sqlalchemy|psycopg|pymysql|mysql|asyncpg/i.test(name)).join(', ') || 'source call'}`; break;
        case 'async_coroutine_testing': fact = firstSourceFact(/\basync\s+def\b|\bawait\b/); break;
        case 'generator_result_testing': fact = context?.is_generator ? 'ast-callable: selected target is a generator' : undefined; break;
        case 'file_io_mocking': fact = firstSourceFact(/\bopen\s*\(|\.(?:read|write|read_text|write_text)\s*\(/); break;
        case 'datetime_freezing': fact = firstSourceFact(/\b(?:datetime|date|time|timezone)\b|\.(?:now|today)\s*\(/); break;
        case 'context_manager_testing': fact = firstSourceFact(/^\s*(?:async\s+)?with\s+.+:/); break;
        case 'async_context_manager_testing': fact = firstSourceFact(/^\s*async\s+with\s+.+:/); break;
        case 'http_client_mocking': fact = `http-binding: ${imports.filter(name => /requests|httpx|aiohttp|urllib/i.test(name)).join(', ') || (context?.calls || []).join(', ')}`; break;
    }
    return [fact || `deterministic-selector: ${ruleId}`];
}

function relatedAnalystHintsForRule(
    ruleId: string,
    semanticPlan?: SemanticPlanForDispatch
): string[] {
    const hintedParameters = (semanticPlan?.test_strategy?.input_hints || [])
        .map(hint => hint.param_name)
        .filter((name): name is string => Boolean(name));
    if (hintedParameters.length > 0 && (
        ruleId === 'string_length_boundary'
        || ruleId === 'branch_threshold_coverage'
        || ruleId === 'boolean_truthiness_coverage'
    )) {
        return [`analyst-scenario-parameters: ${[...new Set(hintedParameters)].join(', ')}`];
    }
    return [];
}

export function dispatchTestRules(
    source: string,
    context?: TestRuleContext,
    semanticPlan?: SemanticPlanForDispatch
): RuleSelectionV2 {
    const normalizedContext = context ? { ...context, class_name: context.class_name ?? undefined } : undefined;
    const ids = inferTestRuleIdsFromCode(source, normalizedContext);
    const cards = getTestRuleCards(ids);
    return {
        schemaVersion: 'rule-selection-v2',
        selectedRules: cards.map(card => ({
            ruleId: card.id,
            title: card.title,
            triggerFacts: triggerFactsForRule(card.id, source, context),
            relatedAnalystHints: relatedAnalystHintsForRule(card.id, semanticPlan),
            guidance: [...card.rules]
        })),
        ids,
        guidance: formatTestRuleCardsForPrompt(cards),
        provenance: 'deterministic',
        sourceHash: createHash('sha256').update(source).digest('hex'),
        dispatcherVersion: 'test-rule-dispatcher-v2'
    };
}
