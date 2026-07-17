import { describe, expect, it, vi } from 'vitest';

async function loadFreshCache() {
	vi.resetModules();
	const authState = await import('$lib/auth-owned-state');
	authState.setAuthOwnedStateIdentity('user-a', true);

	return {
		...(await import('./exercise-picker-cache')),
		authState,
		ownerIdentity: authState.getAuthOwnedStateIdentity()
	};
}

describe('exercise picker cache', () => {
	it('never exposes one account exercise data to another account', async () => {
		const { authState, ownerIdentity, readExercisePickerCache, writeExercisePickerCache } =
			await loadFreshCache();
		writeExercisePickerCache([], [], ownerIdentity);
		expect(readExercisePickerCache()).not.toBeNull();

		authState.setAuthOwnedStateIdentity('user-b', true);

		expect(readExercisePickerCache()).toBeNull();
	});

	it('rejects a stale response instead of tagging it with the new owner', async () => {
		const { authState, ownerIdentity, readExercisePickerCache, writeExercisePickerCache } =
			await loadFreshCache();

		authState.setAuthOwnedStateIdentity('user-b', true);

		expect(writeExercisePickerCache([], [], ownerIdentity)).toBe(false);
		expect(readExercisePickerCache()).toBeNull();
	});

	it('keeps the cache for a same-user token refresh', async () => {
		const { authState, ownerIdentity, readExercisePickerCache, writeExercisePickerCache } =
			await loadFreshCache();
		writeExercisePickerCache([], [], ownerIdentity);

		authState.setAuthOwnedStateIdentity('user-a', true);

		expect(readExercisePickerCache()).not.toBeNull();
	});
});
