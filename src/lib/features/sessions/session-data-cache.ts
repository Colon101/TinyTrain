import type { Exercise, ExerciseUsagePreference, SessionOverview } from '$lib/db';

type SessionDataCacheEntry = {
	sessionId: string;
	overview: SessionOverview | null;
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
	updatedAt: number;
};

const sessionDataCache = new Map<string, SessionDataCacheEntry>();

export function readSessionDataCache(sessionId: string) {
	return sessionDataCache.get(sessionId) ?? null;
}

export function writeSessionDataCache(
	sessionId: string,
	entry: Omit<SessionDataCacheEntry, 'sessionId' | 'updatedAt'>
) {
	sessionDataCache.set(sessionId, {
		...entry,
		sessionId,
		updatedAt: Date.now()
	});
}

