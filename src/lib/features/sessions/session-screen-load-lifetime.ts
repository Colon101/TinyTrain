export function createSessionScreenLoadLifetime() {
	let disposed = false;
	let generation = 0;

	return {
		beginLoad() {
			generation += 1;
			return generation;
		},
		getGeneration() {
			return generation;
		},
		isCurrent(candidateGeneration: number) {
			return !disposed && candidateGeneration === generation;
		},
		isDisposed() {
			return disposed;
		},
		dispose() {
			if (disposed) {
				return;
			}

			disposed = true;
			generation += 1;
		}
	};
}
