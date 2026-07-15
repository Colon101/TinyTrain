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
	it('subscribes before the initial read and preserves a change that lands during that read', async () => {
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
				return loadCount === 1 ? initialRead.promise : Promise.resolve('after-mutation');
			},
			apply(value) {
				appliedValues.push(value);
			}
		});

		expect(callOrder).toEqual(['subscribe', 'load']);

		notifyChange();
		await vi.waitFor(() => expect(appliedValues).toEqual(['after-mutation']));

		initialRead.resolve('before-mutation');
		await Promise.resolve();
		expect(appliedValues).toEqual(['after-mutation']);

		controller.dispose();
	});

	it('does not let an older deferred refresh overwrite a newer response', async () => {
		const olderRead = deferred<string>();
		const newerRead = deferred<string>();
		const appliedValues: string[] = [];
		let loadCount = 0;

		const controller = startLatestValueSubscription({
			subscribe: () => ({ unsubscribe: vi.fn() }),
			load() {
				loadCount += 1;
				return loadCount === 1 ? olderRead.promise : newerRead.promise;
			},
			apply(value) {
				appliedValues.push(value);
			}
		});

		const newerRefresh = controller.refresh();
		newerRead.resolve('newer');
		await newerRefresh;

		olderRead.resolve('older');
		await Promise.resolve();

		expect(appliedValues).toEqual(['newer']);
		controller.dispose();
	});

	it('invalidates an in-flight read when disposed', async () => {
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
