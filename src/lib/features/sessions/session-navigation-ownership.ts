export type SessionNavigationOwnershipSnapshot = {
	routeEpoch: number;
	isStructuralBusy: boolean;
	isReplayBusy: boolean;
	shouldBlockUnload: boolean;
};

export type SessionStructuralMutationLease = {
	routeEpoch: number;
	canRedirect: () => boolean;
	release: () => boolean;
};

export type SessionNavigationReplayResult<T> =
	| { status: 'navigated'; target: T }
	| { status: 'blocked' }
	| { status: 'stale' };

type ReplayWork<T> = {
	prepare: () => Promise<void>;
	navigate: (target: T) => Promise<void>;
};

type ActiveReplay<T> = {
	id: number;
	routeEpoch: number;
	phase: 'preparing' | 'navigating';
	target: T;
	promise: Promise<SessionNavigationReplayResult<T>>;
};

export type SessionNavigationOwnershipCoordinator<T> = {
	beginStructuralMutation: () => SessionStructuralMutationLease | null;
	requestReplay: (target: T, work: ReplayWork<T>) => Promise<SessionNavigationReplayResult<T>>;
	markRouteChanged: () => number;
	getSnapshot: () => SessionNavigationOwnershipSnapshot;
	shouldBlockUnload: () => boolean;
	subscribe: (listener: (snapshot: SessionNavigationOwnershipSnapshot) => void) => () => void;
	dispose: () => void;
};

/**
 * Coordinates async work owned by one mounted session route. Route changes invalidate redirects,
 * duplicate navigation replays share one preparation pass, and token-checked releases cannot clear
 * newer work.
 */
export function createSessionNavigationOwnershipCoordinator<
	T
>(): SessionNavigationOwnershipCoordinator<T> {
	let disposed = false;
	let routeEpoch = 0;
	let nextOwnershipId = 0;
	let activeStructuralMutation: { id: number; routeEpoch: number } | null = null;
	let activeReplay: ActiveReplay<T> | null = null;
	const listeners = new Set<(snapshot: SessionNavigationOwnershipSnapshot) => void>();

	function getSnapshot(): SessionNavigationOwnershipSnapshot {
		const isStructuralBusy = activeStructuralMutation !== null;
		const isReplayBusy = activeReplay !== null;

		return {
			routeEpoch,
			isStructuralBusy,
			isReplayBusy,
			shouldBlockUnload: isStructuralBusy || isReplayBusy
		};
	}

	function notify() {
		const snapshot = getSnapshot();
		listeners.forEach((listener) => listener(snapshot));
	}

	function beginStructuralMutation(): SessionStructuralMutationLease | null {
		if (disposed || activeStructuralMutation || activeReplay) {
			return null;
		}

		const ownership = {
			id: ++nextOwnershipId,
			routeEpoch
		};
		let released = false;
		activeStructuralMutation = ownership;
		notify();

		return {
			routeEpoch: ownership.routeEpoch,
			canRedirect() {
				return Boolean(
					!disposed &&
					!released &&
					activeStructuralMutation?.id === ownership.id &&
					routeEpoch === ownership.routeEpoch
				);
			},
			release() {
				if (released) {
					return false;
				}

				released = true;

				if (activeStructuralMutation?.id !== ownership.id) {
					return false;
				}

				activeStructuralMutation = null;
				notify();
				return true;
			}
		};
	}

	function requestReplay(target: T, work: ReplayWork<T>) {
		if (disposed) {
			return Promise.resolve<SessionNavigationReplayResult<T>>({ status: 'stale' });
		}

		if (activeStructuralMutation) {
			return Promise.resolve<SessionNavigationReplayResult<T>>({ status: 'blocked' });
		}

		if (activeReplay) {
			if (activeReplay.phase === 'preparing') {
				activeReplay.target = target;
			}

			return activeReplay.promise;
		}

		const replay: ActiveReplay<T> = {
			id: ++nextOwnershipId,
			routeEpoch,
			phase: 'preparing',
			target,
			promise: Promise.resolve({ status: 'stale' })
		};
		activeReplay = replay;
		notify();

		async function runReplay(): Promise<SessionNavigationReplayResult<T>> {
			try {
				await work.prepare();

				if (disposed || activeReplay?.id !== replay.id || routeEpoch !== replay.routeEpoch) {
					return { status: 'stale' };
				}

				replay.phase = 'navigating';
				const replayTarget = replay.target;
				await work.navigate(replayTarget);

				return { status: 'navigated', target: replayTarget };
			} finally {
				if (activeReplay?.id === replay.id) {
					activeReplay = null;
					notify();
				}
			}
		}

		let resolveReplay!: (result: SessionNavigationReplayResult<T>) => void;
		let rejectReplay!: (error: unknown) => void;
		replay.promise = new Promise<SessionNavigationReplayResult<T>>((resolve, reject) => {
			resolveReplay = resolve;
			rejectReplay = reject;
		});
		void runReplay().then(resolveReplay, rejectReplay);

		return replay.promise;
	}

	function markRouteChanged() {
		if (disposed) {
			return routeEpoch;
		}

		routeEpoch += 1;
		notify();
		return routeEpoch;
	}

	function subscribe(listener: (snapshot: SessionNavigationOwnershipSnapshot) => void) {
		listeners.add(listener);
		listener(getSnapshot());

		return () => {
			listeners.delete(listener);
		};
	}

	function shouldBlockUnload() {
		return getSnapshot().shouldBlockUnload;
	}

	function dispose() {
		if (disposed) {
			return;
		}

		disposed = true;
		routeEpoch += 1;
		activeStructuralMutation = null;
		activeReplay = null;
		notify();
		listeners.clear();
	}

	return {
		beginStructuralMutation,
		requestReplay,
		markRouteChanged,
		getSnapshot,
		shouldBlockUnload,
		subscribe,
		dispose
	};
}
