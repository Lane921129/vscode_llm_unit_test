import { inferSkillIdsFromCode, getSkillCards, formatSkillCardsForPrompt } from '../prompts/promptSkillLibrary';

/** Selection is deterministic; the Analyst plans scenarios instead of selecting IDs. */
type SkillContext = Omit<NonNullable<Parameters<typeof inferSkillIdsFromCode>[1]>, 'class_name'> & { class_name?: string | null };
export function dispatchSkills(source: string, context?: SkillContext) {
    const ids = inferSkillIdsFromCode(source, context ? { ...context, class_name: context.class_name ?? undefined } : undefined);
    return { ids, guidance: formatSkillCardsForPrompt(getSkillCards(ids)), provenance: 'source-derived' as const };
}
