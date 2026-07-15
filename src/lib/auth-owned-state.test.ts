import { describe, expect, it, vi } from 'vitest';

describe('auth-owned state identity', () => {
	it('publishes a new generation and clears volatile state synchronously', async () => {
		vi.resetModules();
		const authState = await import('./auth-owned-state');
		const observed: Array<ReturnType<typeof authState.getAuthOwnedStateIdentity>> = [];
		const unregister = authState.registerAuthOwnedVolatileInvalidator(() => {
			observed.push(authState.getAuthOwnedStateIdentity());
		});

		authState.setAuthOwnedStateIdentity('user-a', true);
		const firstGeneration = authState.getAuthOwnedStateIdentity().generation;
		authState.setAuthOwnedStateIdentity(null, false);

		expect(observed).toEqual([
			{ ownerId: 'user-a', generation: firstGeneration, isResolved: true },
			{ ownerId: null, generation: firstGeneration + 1, isResolved: false }
		]);
		unregister();
	});

	it('keeps the generation and volatile state stable for same-user token refreshes', async () => {
		vi.resetModules();
		const authState = await import('./auth-owned-state');
		const invalidate = vi.fn();
		authState.registerAuthOwnedVolatileInvalidator(invalidate);

		authState.setAuthOwnedStateIdentity('user-a', true);
		const establishedIdentity = authState.getAuthOwnedStateIdentity();
		invalidate.mockClear();

		authState.setAuthOwnedStateIdentity('user-a', true);

		expect(authState.getAuthOwnedStateIdentity()).toBe(establishedIdentity);
		expect(invalidate).not.toHaveBeenCalled();

		authState.setAuthOwnedStateIdentity(null, false);
		expect(authState.getAuthOwnedStateIdentity().generation).toBe(
			establishedIdentity.generation + 1
		);
		expect(invalidate).toHaveBeenCalledOnce();
	});
});
