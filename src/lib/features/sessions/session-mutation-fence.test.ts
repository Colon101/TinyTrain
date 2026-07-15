import { describe, expect, it, vi } from 'vitest';
import { createSessionMutationFence } from './session-mutation-fence';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

describe('session mutation fence', () => {
	it('does not enter a second action before the admitted action settles', async () => {
		const releaseFirst = deferred();
		const runSingleFlight = createSessionMutationFence();
		const secondAction = vi.fn();
		let actionEntries = 0;

		const firstRun = runSingleFlight(async () => {
			actionEntries += 1;
			await releaseFirst.promise;
		});
		const secondRun = runSingleFlight(async () => {
			actionEntries += 1;
			secondAction();
		});

		expect(actionEntries).toBe(1);
		await expect(secondRun).resolves.toBe(false);
		expect(secondAction).not.toHaveBeenCalled();

		releaseFirst.resolve();
		await expect(firstRun).resolves.toBe(true);
		await expect(
			runSingleFlight(async () => {
				actionEntries += 1;
				secondAction();
			})
		).resolves.toBe(true);

		expect(actionEntries).toBe(2);
		expect(secondAction).toHaveBeenCalledOnce();
	});
});
