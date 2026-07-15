export type LatestValueSubscription = {
	refresh: () => Promise<void>;
	dispose: () => void;
};

type Subscription = {
	unsubscribe(): void;
};

type LatestValueSubscriptionOptions<T> = {
	subscribe: (onChange: () => void) => Subscription;
	load: () => Promise<T>;
	apply: (value: T) => void;
	onError?: (error: unknown) => void;
};

/**
 * Registers the change listener before the first read, then lets only the newest read publish.
 * This closes both the read/subscribe gap and stale async response races.
 */
export function startLatestValueSubscription<T>({
	subscribe,
	load,
	apply,
	onError
}: LatestValueSubscriptionOptions<T>): LatestValueSubscription {
	let disposed = false;
	let loadGeneration = 0;

	async function refresh() {
		const generation = ++loadGeneration;

		try {
			const value = await load();

			if (!disposed && generation === loadGeneration) {
				apply(value);
			}
		} catch (error) {
			if (!disposed && generation === loadGeneration) {
				onError?.(error);
			}
		}
	}

	const subscription = subscribe(() => {
		void refresh();
	});

	void refresh();

	return {
		refresh,
		dispose() {
			if (disposed) {
				return;
			}

			disposed = true;
			loadGeneration += 1;
			subscription.unsubscribe();
		}
	};
}
