export interface ScenarioIdentity { id: string; fingerprint: string; runtimeId?: string }

export function reconcileScenarios(current: ScenarioIdentity[], baseline: ScenarioIdentity[]): ScenarioIdentity[] {
    return current.map(scenario => {
        const previous = baseline.find(item => (item.runtimeId || item.id) === scenario.id)
            || baseline.find(item => item.fingerprint === scenario.fingerprint);
        return { ...scenario, runtimeId: scenario.id, id: previous?.id || scenario.id };
    });
}

/** Normalize the changing loop module; permit pure renames only with identical AST/setup. */
export function normalizeScenarioOutput(output: string, current: ScenarioIdentity[], baseline: ScenarioIdentity[]): string {
    const reconciled = reconcileScenarios(current, baseline);
    return output.replace(/^(test\S* \()([^)\n]+)(\))/gm, (full, prefix, id, suffix) => {
        const parts = id.split('.');
        const local = parts.slice(-2).join('.');
        const scenario = reconciled.find(item => item.runtimeId === local);
        return `${prefix}${scenario?.id || local}${suffix}`;
    });
}
