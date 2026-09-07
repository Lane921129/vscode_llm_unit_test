/** Report the response that actually failed, even after a consumed first reply. */
export async function requireSuccessfulProbeResponse(
    response: Pick<Response, 'ok' | 'status' | 'text'>
): Promise<void> {
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} - ${await response.text()}`);
    }
}
