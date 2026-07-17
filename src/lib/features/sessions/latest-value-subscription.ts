type Subscription = {
	unsubscribe(): void;
};

type LatestValueSubscriptionOptions<T> = {
	subscribe: (onChange: () => void) => Subscription;
	load: () => Promise<T>;
	apply: (value: T) => void;
	onError?: (error: unknown) => void;
	isCurrent?: () => boolean;
};

export function startLatestValueSubscription<T>({
	subscribe,
	load,
	apply,
	onError,
	isCurrent = () => true
}: LatestValueSubscriptionOptions<T>) {
	let disposed = false;
	let loadGeneration = 0;

	async function refresh() {
		if (disposed || !isCurrent()) {
			return;
		}

		const generation = ++loadGeneration;

		try {
			const value = await load();

			if (!disposed && generation === loadGeneration && isCurrent()) {
				apply(value);
			}
		} catch (error) {
			if (!disposed && generation === loadGeneration && isCurrent()) {
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
