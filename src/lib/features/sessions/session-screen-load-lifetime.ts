export type SessionScreenLoadLifetime = {
	beginLoad: () => number;
	getGeneration: () => number;
	isCurrent: (generation: number) => boolean;
	isDisposed: () => boolean;
	dispose: () => void;
};

/** A per-component generation fence for async reads and their cache/navigation side effects. */
export function createSessionScreenLoadLifetime(): SessionScreenLoadLifetime {
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
		isCurrent(candidateGeneration) {
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
