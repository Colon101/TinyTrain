import { describe, expect, it, vi } from 'vitest';

async function loadFreshCache() {
	vi.resetModules();
	const [cache, authState] = await Promise.all([
		import('./exercise-picker-cache'),
		import('$lib/auth-owned-state')
	]);

	return { ...cache, authState };
}

describe('exercise picker cache ownership', () => {
	it('never paints unresolved or previous-owner exercise data', async () => {
		const { readExercisePickerCache, writeExercisePickerCache, authState } = await loadFreshCache();

		writeExercisePickerCache([], []);
		expect(readExercisePickerCache()).toBeNull();

		authState.setAuthOwnedStateIdentity('user-1', true);
		writeExercisePickerCache([], []);
		expect(readExercisePickerCache()).not.toBeNull();

		authState.setAuthOwnedStateIdentity('user-2', true);
		expect(readExercisePickerCache()).toBeNull();
		writeExercisePickerCache([], []);
		expect(readExercisePickerCache()).not.toBeNull();

		authState.setAuthOwnedStateIdentity('user-1', true);
		expect(readExercisePickerCache()).toBeNull();
	});

	it('retains the picker cache for a same-user token refresh', async () => {
		const { readExercisePickerCache, writeExercisePickerCache, authState } = await loadFreshCache();
		authState.setAuthOwnedStateIdentity('user-1', true);
		writeExercisePickerCache([], []);
		const cachedBeforeRefresh = readExercisePickerCache();
		const generationBeforeRefresh = authState.getAuthOwnedStateIdentity().generation;

		authState.setAuthOwnedStateIdentity('user-1', true);

		expect(authState.getAuthOwnedStateIdentity().generation).toBe(generationBeforeRefresh);
		expect(readExercisePickerCache()).toBe(cachedBeforeRefresh);
	});
});
