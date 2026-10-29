/**
 * test_rule_library.ts
 * 測試生成規則庫 - Unittest Writer 可用的專項提示規則集合
 *
 * 運作原理：
 *   TestRuleDispatcher 在語意分析完成後，依原始碼與 AST 情境確定性選取規則。
 *   格式化函式只注入選中的規則卡，分析師負責情境規劃而不選規則 ID。
 */

import { loadTestSkills } from '../skills/catalog';
import { dependencyLibraryBindings } from '../skills/dependencyFacts';

export interface TestGenerationRuleCard {
    id: string;
    title: string;
    trigger_hint: string;
    rules: string[];
    version?: number;
}

export const TEST_RULE_LIBRARY: TestGenerationRuleCard[] = loadTestSkills();

export function getTestRuleCards(ruleIds: string[]): TestGenerationRuleCard[] {
    return ruleIds
        .map(id => TEST_RULE_LIBRARY.find(rule => rule.id === id))
        .filter((rule): rule is TestGenerationRuleCard => rule !== undefined);
}

type TimeRuleContext = { calls?: string[]; file_imports?: Array<{
    module?: string | null; name?: string | null; bound_name?: string | null; alias?: string | null;
}> };

/** AST call bindings distinguish a clock read from parsing an explicit value. */
function canonicalLibraryCall(call: string, context?: TimeRuleContext): string {
    const root = call.split('.')[0];
    const imported = context?.file_imports?.find(item => (item.bound_name || item.alias || item.name || item.module?.split('.')[0]) === root);
    if (!imported) { return call; }
    const canonical = imported.name && imported.name !== '*' ? `${imported.module}.${imported.name}` : imported.module || root;
    return canonical + call.slice(root.length);
}

export function currentClockCalls(source: string, context?: TimeRuleContext): string[] {
    // When AST calls are available they are authoritative, including an empty
    // set. The legacy syntax fallback strips comments/string literals first.
    const code = source.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\r\n]*)/g,
        match => match.replace(/[^\r\n]/g, ' '));
    const calls = context?.calls ?? [...code.matchAll(/\b((?:datetime\.)?(?:datetime|date)\.(?:now|utcnow|today)|time\.(?:time|time_ns|monotonic|monotonic_ns|perf_counter|perf_counter_ns|process_time|process_time_ns))\s*\(/g)].map(match => match[1]);
    return calls.filter(call => {
        if (context?.calls && context.file_imports && !context.file_imports.some(item =>
            (item.bound_name || item.alias || item.name || item.module?.split('.')[0]) === call.split('.')[0])) { return false; }
        return /^(?:datetime\.(?:datetime\.)?(?:now|utcnow|today)|datetime\.date\.today|date\.today|time\.(?:time|time_ns|monotonic|monotonic_ns|perf_counter|perf_counter_ns|process_time|process_time_ns))$/.test(canonicalLibraryCall(call, context));
    });
}

function deterministicTimeDependency(dependency: unknown, context?: TimeRuleContext): boolean {
    if (!dependency || typeof dependency !== 'object' || !('name' in dependency) || typeof dependency.name !== 'string') { return false; }
    const root = dependency.name.split('.')[0];
    const binding = context?.file_imports?.find(item => (item.bound_name || item.alias || item.name || item.module?.split('.')[0]) === root);
    if (binding?.module !== 'datetime') { return false; }
    const calls = (context?.calls || []).filter(call => call === root || call.startsWith(root + '.'));
    // Narrow operation-based exemption; unresolved methods still receive normal
    // dependency guidance. This does not certify outputs or suppress safety gates.
    return calls.length > 0 && calls.every(call => /^datetime\.(?:(?:datetime|date|time)\.)?(?:strptime|strftime|fromisoformat|isoformat)$/.test(canonicalLibraryCall(call, context)));
}

/**
 * A conservative, domain-neutral safety net for when the semantic model is
 * unavailable or omits an obvious language construct.  It only reacts to
 * Python syntax and standard-library usage, never names from an application.
 */
export function inferTestRuleIdsFromCode(
    sourceCode: string,
    context?: {
        class_name?: string | null;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        is_generator?: boolean;
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null; alias?: string | null }>;
        condition_facts?: Array<{ kind?: string; parameter?: string; subject?: string; polarity?: string }>;
        name?: string;
        code?: string;
        dependency_skill_facts?: unknown;
    }
): string[] {
    const ids = new Set<string>(['import_module_name']);
    const source = sourceCode || '';
    const syntax = source.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\r\n]*)/g,
        match => match.replace(/[^\r\n]/g, ' '));
    const numericCallable = (!context?.method_kind || context.method_kind === 'module')
        && !context?.class_name && !context?.class_context && !context?.dependencies?.length
        && !(context?.calls || []).some(call => !['round', 'abs'].includes(call));
    if (numericCallable && /[\w)]\s*(?:\*\*|[+*/%\-])\s*[\w(]|\bround\s*\(/.test(source)) { ids.add('numeric_calculation'); }

    if (/\blen\s*\([^)]*\)\s*[<>]=?\s*\d+/.test(source)) { ids.add('string_length_boundary'); }
    if (/\w+\s*\[\s*-?\d*\s*:\s*-?\d*\s*\]/.test(source)) { ids.add('python_slicing'); }
    if (/\b(?:if|elif)\b[^\n]*[<>]=?\s*\d+/.test(source)) { ids.add('branch_threshold_coverage'); }
    if ((context?.condition_facts || []).some(fact => fact?.kind === 'truthiness')) { ids.add('boolean_truthiness_coverage'); }
    if (/^\s*match\s+[^\n]+\s*:/m.test(source)) { ids.add('pattern_matching'); }
    if (/\bround\s*\(|\bfloat\s*\(|\bmath\./.test(source)) { ids.add('float_precision'); }
    if (/\breturn\s*\{/.test(source)) { ids.add('dict_return'); }
    if (/\breturn\s*\(\s*[^()\n]+,\s*[^()\n]+\)|\breturn\s+(?![^#\n]*\()[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*/.test(source)) { ids.add('tuple_return'); }
    if (/\bNone\b|\bnot\s+\w+/.test(source)) { ids.add('none_input_handling'); }
    if (/\braise\s+[A-Za-z_]/.test(source)) { ids.add('assert_raises_syntax'); }
    if (/\btry\s*:[\s\S]*\bexcept\b[\s\S]*\breturn\b/.test(source)) { ids.add('try_except_returns_string'); }
    if (/(?:\b\w+\s*\/\s*(?:\w+|\d+)|\b\d+\s*\/\s*\w+)/.test(syntax)) { ids.add('zero_division'); }
    const needsInstance = context?.method_kind === 'instance' || context?.method_kind === 'property';
    const bindingUnknown = (context?.class_name || context?.class_context) && !context?.method_kind;
    if (needsInstance || bindingUnknown) { ids.add('class_method_testing'); }
    if ((context?.dependencies || []).some(dependency => !deterministicTimeDependency(dependency, context))) {
        ids.add('mock_external_dependency');
        ids.add('observation_mock_isolation');
        ids.add('caller_dependency_contract');
    }
    const importedModuleText = (context?.file_imports || []).filter(item => {
        const binding = item.bound_name || item.alias || item.name || item.module?.split('.')[0];
        return !binding || (context?.calls || []).some(call => call === binding || call.startsWith(binding + '.'));
    })
        .map(item => `${item.module || ''} ${item.name || ''}`)
        .join(' ');
    if (dependencyLibraryBindings('database', context).length
        || /\b(?:sqlite3|sqlalchemy|psycopg(?:2|3)?|pymysql|mysql\.connector|asyncpg)\b/i.test(`${source}\n${importedModuleText}`)) {
        ids.add('database_state_isolation');
        ids.add('mock_external_dependency');
    }
    if (/\basync\s+def\b|\bawait\b/.test(source)) { ids.add('async_coroutine_testing'); }
    if (context?.is_generator === true) { ids.add('generator_result_testing'); }
    if (/\bopen\s*\(|\.(?:read|write|read_text|write_text)\s*\(/.test(source)) { ids.add('file_io_mocking'); }
    if (currentClockCalls(source, context).length) { ids.add('datetime_freezing'); }
    if (/^\s*(?:async\s+)?with\s+.+:/m.test(source)) { ids.add('context_manager_testing'); }
    if (/^\s*async\s+with\s+.+:/m.test(source)) { ids.add('async_context_manager_testing'); }

    // Match a verified call binding instead of names in comments, strings, or
    // unrelated imports elsewhere in the module. HTTP library names are
    // technical dependency evidence, never application-domain vocabulary.
    const httpModules = /^(?:requests|httpx|aiohttp|urllib(?:\.request)?)$/;
    const httpBindings = new Set(
        (context?.file_imports || [])
            .filter(item => httpModules.test(item.module || ''))
            .map(item => item.bound_name || item.name || (item.module || '').split('.')[0])
            .filter((name): name is string => Boolean(name))
    );
    const httpCall = (context?.calls || []).some(call => {
        const root = call.split('.')[0];
        return httpBindings.has(root)
            || /^(?:requests|httpx|aiohttp)\.(?:get|post|put|patch|delete|request|stream)$/i.test(call)
            || /^urllib\.request\.urlopen$/i.test(call);
    });
    if (httpCall || dependencyLibraryBindings('http', context).length) {
        ids.add('http_client_mocking');
        ids.add('mock_external_dependency');
        const knownHttpRoots = new Set([...httpBindings, ...dependencyLibraryBindings('http', context).map(binding => binding.name)]);
        // A proven HTTP client's open/read is not file I/O. Retain ambiguous
        // receivers and any independent file calls; this changes guidance only.
        if (context?.calls && !context.calls.some(call => /(?:^|\.)(?:open|read|write|read_text|write_text)$/.test(call)
            && !knownHttpRoots.has(call.split('.')[0]))) { ids.delete('file_io_mocking'); }
    }

    return [...ids];
}

/**
 * Keep the semantic-plan rule selection evidence-bound. A model may prioritize
 * applicable rules, but it cannot inject unrelated rules which AST evidence
 * does not support. This prevents malformed or over-broad JSON from polluting
 * prompts across unrelated projects.
 */
export function mergeEvidenceBoundTestRuleIds(
    sourceCode: string,
    semanticRuleIds: unknown,
    context?: {
        class_name?: string | null;
        class_context?: unknown;
        method_kind?: 'module' | 'instance' | 'static' | 'class' | 'property';
        is_generator?: boolean;
        calls?: string[];
        dependencies?: unknown[];
        file_imports?: Array<{ module?: string | null; name?: string | null; bound_name?: string | null; alias?: string | null }>;
        condition_facts?: Array<{ kind?: string; parameter?: string; subject?: string; polarity?: string }>;
    }
): string[] {
    const baseline = inferTestRuleIdsFromCode(sourceCode, context);
    const allowed = new Set(baseline);
    const semantic = Array.isArray(semanticRuleIds)
        ? semanticRuleIds.filter((id): id is string => typeof id === 'string')
        : [];
    return [...new Set([...baseline, ...semantic.filter(id => allowed.has(id))])];
}

export function formatTestRuleCardsForPrompt(cards: TestGenerationRuleCard[]): string {
    if (cards.length === 0) {return '';}
    let out = '=== FUNCTION-SPECIFIC RULES (Selected for this function) ===\n';
    out += '(Derived from actual source code analysis — follow them precisely)\n\n';
    for (const card of cards) {
        out += `[${card.title}]\n`;
        for (const rule of card.rules) {
            out += `  ${rule}\n`;
        }
        out += '\n';
    }
    return out;
}
