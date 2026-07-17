import { describe, expect, it, vi } from 'vitest';

describe('auth-owned state', () => {
	it('invalidates volatile state synchronously when ownership changes', async () => {
		vi.resetModules();
		const authState = await import('./auth-owned-state');
		const invalidate = vi.fn();
		authState.registerAuthOwnedVolatileInvalidator(invalidate);

		authState.setAuthOwnedStateIdentity('user-a', true);
		const userAIdentity = authState.getAuthOwnedStateIdentity();
		authState.setAuthOwnedStateIdentity('user-b', true);

		expect(userAIdentity).toMatchObject({ ownerId: 'user-a', isResolved: true });
		expect(authState.getAuthOwnedStateIdentity()).toMatchObject({
			ownerId: 'user-b',
			generation: userAIdentity.generation + 1,
			isResolved: true
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it('does not invalidate state for a same-user token refresh', async () => {
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
	});
});
