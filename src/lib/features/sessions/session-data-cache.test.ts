import { describe, expect, it, vi } from 'vitest';

const emptyEntry = {
	overview: null,
	exercises: [],
	exerciseUsagePreferences: []
};

async function loadFreshCache() {
	vi.resetModules();
	return import('./session-data-cache');
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
});
