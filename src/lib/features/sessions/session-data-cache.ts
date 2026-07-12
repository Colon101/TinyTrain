import type { Exercise, ExerciseUsagePreference, SessionOverview } from '$lib/db';

type SessionDataCacheEntry = {
	sessionId: string;
	overview: SessionOverview | null;
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
	updatedAt: number;
};

const SESSION_DATA_CACHE_MAX_ENTRIES = 10;
const sessionDataCache = new Map<string, SessionDataCacheEntry>();

export function readSessionDataCache(sessionId: string) {
	const entry = sessionDataCache.get(sessionId);

	if (!entry) {
		return null;
	}

	// Map insertion order gives us a small deterministic least-recently-used cache.
	sessionDataCache.delete(sessionId);
	sessionDataCache.set(sessionId, entry);
	return entry;
}

export function writeSessionDataCache(
	sessionId: string,
	entry: Omit<SessionDataCacheEntry, 'sessionId' | 'updatedAt'>
) {
	sessionDataCache.delete(sessionId);
	sessionDataCache.set(sessionId, {
		...entry,
		sessionId,
		updatedAt: Date.now()
	});

	while (sessionDataCache.size > SESSION_DATA_CACHE_MAX_ENTRIES) {
		const leastRecentlyUsedSessionId = sessionDataCache.keys().next().value;

		if (leastRecentlyUsedSessionId === undefined) {
			break;
		}

		sessionDataCache.delete(leastRecentlyUsedSessionId);
	}
}
