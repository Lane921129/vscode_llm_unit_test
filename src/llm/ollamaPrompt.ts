/**
 * /generate templates may consume only .Prompt. Put the complete, already
 * contracted role instructions there once, with the same separator counted
 * by the final budget gate. Keep the model's own chat/completion template.
 */
export function buildOllamaPromptEnvelope(contractedSystemPrompt: string, userPrompt: string): {
    system: string; prompt: string;
} {
    return {
        // Omitted/empty system falls back to the Modelfile SYSTEM. A nonempty
        // blank overrides that fallback without duplicating role instructions.
        system: ' ',
        prompt: contractedSystemPrompt + '\n' + userPrompt
    };
}
