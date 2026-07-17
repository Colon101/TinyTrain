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
	it('admits only one destructive action until it settles', async () => {
		const releaseFirst = deferred();
		const runSingleFlight = createSessionMutationFence();
		const duplicateAction = vi.fn();
		const firstRun = runSingleFlight(() => releaseFirst.promise);
		const duplicateRun = runSingleFlight(async () => duplicateAction());

		await expect(duplicateRun).resolves.toBe(false);
		expect(duplicateAction).not.toHaveBeenCalled();

		releaseFirst.resolve();
		await expect(firstRun).resolves.toBe(true);
		await expect(runSingleFlight(async () => duplicateAction())).resolves.toBe(true);
		expect(duplicateAction).toHaveBeenCalledOnce();
	});
});
