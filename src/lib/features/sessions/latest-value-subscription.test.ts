import { describe, expect, it, vi } from 'vitest';
import { startLatestValueSubscription } from './latest-value-subscription';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

describe('latest value subscription', () => {
	it('subscribes before reading and keeps a change that lands during the first read', async () => {
		const initialRead = deferred<string>();
		const callOrder: string[] = [];
		const appliedValues: string[] = [];
		let notifyChange: () => void = () => undefined;
		let loadCount = 0;
		const controller = startLatestValueSubscription({
			subscribe(onChange) {
				callOrder.push('subscribe');
				notifyChange = onChange;
				return { unsubscribe: vi.fn() };
			},
			load() {
				callOrder.push('load');
				loadCount += 1;
				return loadCount === 1 ? initialRead.promise : Promise.resolve('after-change');
			},
			apply: (value) => appliedValues.push(value)
		});

		expect(callOrder).toEqual(['subscribe', 'load']);
		notifyChange();
		await vi.waitFor(() => expect(appliedValues).toEqual(['after-change']));
		initialRead.resolve('before-change');
		await Promise.resolve();
		expect(appliedValues).toEqual(['after-change']);
		controller.dispose();
	});

	it('does not publish an in-flight value after disposal', async () => {
		const pendingRead = deferred<string>();
		const apply = vi.fn();
		const unsubscribe = vi.fn();
		const controller = startLatestValueSubscription({
			subscribe: () => ({ unsubscribe }),
			load: () => pendingRead.promise,
			apply
		});

		controller.dispose();
		pendingRead.resolve('stale');
		await Promise.resolve();

		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(apply).not.toHaveBeenCalled();
	});
});
