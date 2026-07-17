import type { Exercise, ExerciseUsagePreference, SessionOverview } from '$lib/db';
import {
	getAuthOwnedStateIdentity,
	isAuthOwnedStateIdentityCurrent,
	registerAuthOwnedVolatileInvalidator,
	type AuthOwnedStateIdentity
} from '$lib/auth-owned-state';

type SessionDataCacheEntry = {
	sessionId: string;
	overview: SessionOverview | null;
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
	updatedAt: number;
	ownerId: string;
	authGeneration: number;
};

const SESSION_DATA_CACHE_MAX_ENTRIES = 10;
const sessionDataCache = new Map<string, SessionDataCacheEntry>();
registerAuthOwnedVolatileInvalidator(() => sessionDataCache.clear());

export function readSessionDataCache(sessionId: string) {
	const identity = getAuthOwnedStateIdentity();

	if (!identity.isResolved || !identity.ownerId) {
		return null;
	}

	const entry = sessionDataCache.get(sessionId);

	if (
		!entry ||
		entry.ownerId !== identity.ownerId ||
		entry.authGeneration !== identity.generation
	) {
		return null;
	}

	// Map insertion order gives us a small deterministic least-recently-used cache.
	sessionDataCache.delete(sessionId);
	sessionDataCache.set(sessionId, entry);
	return entry;
}

export function writeSessionDataCache(
	sessionId: string,
	entry: Omit<SessionDataCacheEntry, 'sessionId' | 'updatedAt' | 'ownerId' | 'authGeneration'>,
	ownerIdentity: AuthOwnedStateIdentity
) {
	const identity = getAuthOwnedStateIdentity();

	if (
		!isAuthOwnedStateIdentityCurrent(ownerIdentity) ||
		!identity.isResolved ||
		!identity.ownerId
	) {
		return false;
	}

	sessionDataCache.delete(sessionId);
	sessionDataCache.set(sessionId, {
		...entry,
		sessionId,
		ownerId: identity.ownerId,
		authGeneration: identity.generation,
		updatedAt: Date.now()
	});

	while (sessionDataCache.size > SESSION_DATA_CACHE_MAX_ENTRIES) {
		const leastRecentlyUsedSessionId = sessionDataCache.keys().next().value;

		if (leastRecentlyUsedSessionId === undefined) {
			break;
		}

		sessionDataCache.delete(leastRecentlyUsedSessionId);
	}

	return true;
}
