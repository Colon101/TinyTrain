export function createSessionMutationFence() {
	let isRunning = false;

	return async function runSingleFlight(action: () => Promise<void>): Promise<boolean> {
		if (isRunning) {
			return false;
		}

		isRunning = true;

		try {
			await action();
			return true;
		} finally {
			isRunning = false;
		}
	};
}
