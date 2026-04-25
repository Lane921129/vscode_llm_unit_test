export function getSystemPrompt(loopCount: number, survivedMutants?: string): string {
    let prompt = "你是一個資深的 Python 測試工程師。請為提供的程式碼撰寫單元測試 (使用 unittest 或 pytest)。\n";
    prompt += "你必須考慮邊界條件，並確保突變測試 (Mutation Testing) 的分數能達到最高。\n";

    if (loopCount > 1 && survivedMutants) {
        prompt += `\n⚠️ 注意：上一輪測試後，以下突變體依然存活，請加強 Assert 邏輯來殺死它們：\n${survivedMutants}`;
    }
    return prompt;
}

export function getUserPrompt(fileName: string, funcName: string, code: string): string {
    const target = funcName ? `函式 \`${funcName}\`` : `整份檔案`;
    return `【目標檔案】: ${fileName}\n【目標範圍】: ${target}\n【原始程式碼】:\n\`\`\`python\n${code}\n\`\`\``;
}