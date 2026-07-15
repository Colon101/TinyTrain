import { describe, expect, it, vi } from 'vitest';

const emptyEntry = {
	overview: null,
	exercises: [],
	exerciseUsagePreferences: []
};

async function loadFreshCache() {
	vi.resetModules();
	const [cache, authState] = await Promise.all([
		import('./session-data-cache'),
		import('$lib/auth-owned-state')
	]);
	authState.setAuthOwnedStateIdentity('user-1', true);
	return { ...cache, authState };
}

describe('session data cache', () => {
	it('evicts the oldest entry after inserting eleven sessions', async () => {
		const { readSessionDataCache, writeSessionDataCache } = await loadFreshCache();

		for (let index = 0; index < 11; index += 1) {
			writeSessionDataCache(`session-${index}`, emptyEntry);
		}

		expect(readSessionDataCache('session-0')).toBeNull();
		expect(readSessionDataCache('session-10')).not.toBeNull();
	});

	it('retains a recently read entry when the next write evicts an older one', async () => {
		const { readSessionDataCache, writeSessionDataCache } = await loadFreshCache();

		writeSessionDataCache('session-a', emptyEntry);
		for (let index = 0; index < 9; index += 1) {
			writeSessionDataCache(`session-${index}`, emptyEntry);
		}

		expect(readSessionDataCache('session-a')).not.toBeNull();
		writeSessionDataCache('session-9', emptyEntry);

		expect(readSessionDataCache('session-a')).not.toBeNull();
		expect(readSessionDataCache('session-0')).toBeNull();
	});

	it('does not expose cached first paint before auth resolves or across A to B to A', async () => {
		const { readSessionDataCache, writeSessionDataCache, authState } = await loadFreshCache();

		writeSessionDataCache('shared-session', emptyEntry);
		expect(readSessionDataCache('shared-session')).not.toBeNull();

		authState.setAuthOwnedStateIdentity(null, false);
		expect(readSessionDataCache('shared-session')).toBeNull();
		authState.setAuthOwnedStateIdentity('user-2', true);
		expect(readSessionDataCache('shared-session')).toBeNull();
		writeSessionDataCache('shared-session', emptyEntry);
		expect(readSessionDataCache('shared-session')).not.toBeNull();

		authState.setAuthOwnedStateIdentity('user-1', true);
		expect(readSessionDataCache('shared-session')).toBeNull();
	});

	it('retains the same-user first-paint cache across a token refresh callback', async () => {
		const { readSessionDataCache, writeSessionDataCache, authState } = await loadFreshCache();
		writeSessionDataCache('session-a', emptyEntry);
		const cachedBeforeRefresh = readSessionDataCache('session-a');
		const generationBeforeRefresh = authState.getAuthOwnedStateIdentity().generation;

		authState.setAuthOwnedStateIdentity('user-1', true);

		expect(authState.getAuthOwnedStateIdentity().generation).toBe(generationBeforeRefresh);
		expect(readSessionDataCache('session-a')).toBe(cachedBeforeRefresh);
	});
});
