import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSessionScreenLoadLifetime } from './session-screen-load-lifetime';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

describe('session screen load lifetime', () => {
	it('prevents an older response from overwriting a newer load', async () => {
		const lifetime = createSessionScreenLoadLifetime();
		const olderResponse = deferred<string>();
		const newerResponse = deferred<string>();
		const apply = vi.fn();
		const finishLoad = async (generation: number, response: Promise<string>) => {
			const value = await response;

			if (lifetime.isCurrent(generation)) {
				apply(value);
			}
		};

		const olderLoad = finishLoad(lifetime.beginLoad(), olderResponse.promise);
		const newerLoad = finishLoad(lifetime.beginLoad(), newerResponse.promise);
		newerResponse.resolve('newer');
		await newerLoad;
		olderResponse.resolve('older');
		await olderLoad;

		expect(apply).toHaveBeenCalledOnce();
		expect(apply).toHaveBeenCalledWith('newer');
	});

	it('invalidates cache and navigation side effects after disposal', async () => {
		const lifetime = createSessionScreenLoadLifetime();
		const response = deferred<'abandoned'>();
		const generation = lifetime.beginLoad();
		const redirect = vi.fn();
		const finishLoad = (async () => {
			const status = await response.promise;

			if (lifetime.isCurrent(generation) && status === 'abandoned') {
				redirect();
			}
		})();

		lifetime.dispose();
		response.resolve('abandoned');
		await finishLoad;

		expect(redirect).not.toHaveBeenCalled();
	});

	it('fences both session screens before publishing async data', () => {
		for (const fileName of ['SessionOverviewScreen.svelte', 'SessionExerciseScreen.svelte']) {
			const source = readFileSync(resolve(import.meta.dirname, fileName), 'utf8');
			const loadBlock = source.slice(
				source.indexOf('\n\tasync function loadData'),
				source.indexOf('\n\tasync function runMutation')
			);
			const cacheWriteIndex = loadBlock.indexOf('writeSessionDataCache(sessionId');
			const lifetimeGuardIndex = loadBlock.lastIndexOf(
				'loadLifetime.isCurrent(generation)',
				cacheWriteIndex
			);
			const ownerGuardIndex = loadBlock.lastIndexOf(
				'getAuthOwnedStateIdentity() !== ownerIdentity',
				cacheWriteIndex
			);

			expect(source).toContain('createSessionMutationFence()');
			expect(source).toContain('loadLifetime.dispose();');
			expect(cacheWriteIndex).toBeGreaterThan(-1);
			expect(lifetimeGuardIndex).toBeGreaterThan(-1);
			expect(ownerGuardIndex).toBeGreaterThan(-1);
		}
	});
});
