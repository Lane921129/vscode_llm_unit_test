/** Reject template labels without mistaking source comparisons for angle-bracket placeholders. */
export function hasTemplatePlaceholder(text: string): boolean {
    return /<(?:\.{3}|[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff -]{0,80})>/.test(text)
        || /<\s*(?:excerpt|reason|action|placeholder|TODO|待填內容)\s*>/i.test(text);
}
