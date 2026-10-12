/** Learned output needs live only inside one target. Truncated responses are
 * never reused as code; only the exact cap reported by the transport is used. */
export class WriterOutputBudget {
    private floor = 0;
    get minimumTokens(): number { return this.floor; }

    grow(exhaustedCap: unknown, modelLimit: unknown): number | undefined {
        if (!Number.isSafeInteger(exhaustedCap) || (exhaustedCap as number) <= 0
            || !Number.isSafeInteger(modelLimit) || (modelLimit as number) <= 128) { return undefined; }
        const needed = Math.max((exhaustedCap as number) + 1024, Math.ceil((exhaustedCap as number) * 1.5));
        const next = Math.min(needed, (modelLimit as number) - 128);
        if (!Number.isSafeInteger(next) || next <= (exhaustedCap as number) || next <= this.floor) { return undefined; }
        this.floor = next;
        return next;
    }
}
