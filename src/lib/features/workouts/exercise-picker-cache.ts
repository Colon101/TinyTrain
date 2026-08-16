import type { Exercise, ExerciseUsagePreference } from '$lib/db';
import {
	getAuthOwnedStateIdentity,
	isAuthOwnedStateIdentityCurrent,
	registerAuthOwnedVolatileInvalidator,
	type AuthOwnedStateIdentity
} from '$lib/auth-owned-state';

type ExercisePickerCacheEntry = {
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
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
	exerciseUsagePreferences: ExerciseUsagePreference[],
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

	exercisePickerCache = {
		exercises,
		exerciseUsagePreferences,
		ownerId: identity.ownerId,
		authGeneration: identity.generation
	};

	return true;
}
