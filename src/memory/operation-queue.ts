export class MemoryOperationQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => T | PromiseLike<T>): Promise<Awaited<T>> {
		const result = this.tail.then(operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}
