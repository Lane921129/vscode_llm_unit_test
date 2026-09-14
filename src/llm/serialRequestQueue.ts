/**
 * 讓本機小模型一次只接收一個請求，前一個請求失敗也不會卡住後續工作。
 * Serializes local-model work and keeps the queue moving after a rejected task.
 */
export class SerialRequestQueue {
    private tail: Promise<void> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const current = this.tail.then(task, task);
        this.tail = current.then(() => undefined, () => undefined);
        return current;
    }
}
