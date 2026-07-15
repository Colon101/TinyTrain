import { describe, expect, it, vi } from 'vitest';

async function loadFreshCache() {
	vi.resetModules();
	const authState = await import('$lib/auth-owned-state');
	authState.setAuthOwnedStateIdentity('user-a', true);

	return { ...(await import('./exercise-picker-cache')), authState };
}

describe('exercise picker cache', () => {
	it('never exposes one account exercise data to another account', async () => {
		const { authState, readExercisePickerCache, writeExercisePickerCache } = await loadFreshCache();
		writeExercisePickerCache([], []);
		expect(readExercisePickerCache()).not.toBeNull();

		authState.setAuthOwnedStateIdentity('user-b', true);

		expect(readExercisePickerCache()).toBeNull();
	});

	it('keeps the cache for a same-user token refresh', async () => {
		const { authState, readExercisePickerCache, writeExercisePickerCache } = await loadFreshCache();
		writeExercisePickerCache([], []);

		authState.setAuthOwnedStateIdentity('user-a', true);

		expect(readExercisePickerCache()).not.toBeNull();
	});
});
