import type { Exercise, ExerciseUsagePreference } from '$lib/db';
import {
	getAuthOwnedStateIdentity,
	registerAuthOwnedVolatileInvalidator
} from '$lib/auth-owned-state';

type ExercisePickerCacheEntry = {
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
	updatedAt: number;
	ownerId: string;
	authGeneration: number;
};

let exercisePickerCache: ExercisePickerCacheEntry | null = null;
registerAuthOwnedVolatileInvalidator(() => (exercisePickerCache = null));

export function readExercisePickerCache() {
	const identity = getAuthOwnedStateIdentity();

	return exercisePickerCache?.ownerId === identity.ownerId &&
		exercisePickerCache?.authGeneration === identity.generation &&
		identity.isResolved &&
		identity.ownerId
		? exercisePickerCache
		: null;
}

export function writeExercisePickerCache(
	exercises: Exercise[],
	exerciseUsagePreferences: ExerciseUsagePreference[]
) {
	const identity = getAuthOwnedStateIdentity();

	if (!identity.isResolved || !identity.ownerId) {
		return;
	}

	exercisePickerCache = {
		exercises,
		exerciseUsagePreferences,
		ownerId: identity.ownerId,
		authGeneration: identity.generation,
		updatedAt: Date.now()
	};
}
