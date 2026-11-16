/** v2-only artifact names; v1 output naming remains owned by its existing layout. */
export const ROW_RUN_DIRECTORY = 'r';
export const CASE_TABLE_TEST_FILE = 't.py';
export const INVOCATION_SUFFIX = '.inv.json';
export const ISOLATION_SUFFIX = '.iso.jsonl';
export const RUNNER_RESULT_SUFFIX = '.res.json';

const round = (suffix: string): string => suffix === '_followup' ? 'f' : suffix;
export const rowTestModule = (id: string, attempt: number, suffix = ''): string => `${id.toLowerCase()}_${attempt}${round(suffix)}`;
export const candidateTestModule = (id: string, suffix = ''): string => `k_${id.toLowerCase()}${round(suffix)}`;
export const mergedTestModule = (suffix = ''): string => `t${round(suffix)}`;
export const coverageTestModule = (id: string): string => `g_${id}`;

// Target-level reports remain shorter than the longest v2 artifact used by preflight.
export const REQUIREMENTS_COVERAGE_JSON = 'req.json';
export const REQUIREMENTS_COVERAGE_MD = 'req.md';
export const DESIGN_FINDINGS_JSON = 'design.json';
export const DESIGN_FINDINGS_MD = 'design.md';
