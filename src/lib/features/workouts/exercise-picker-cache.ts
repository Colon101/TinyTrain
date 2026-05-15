import type { Exercise, ExerciseUsagePreference } from '$lib/db';

type ExercisePickerCacheEntry = {
	exercises: Exercise[];
	exerciseUsagePreferences: ExerciseUsagePreference[];
	updatedAt: number;
};

let exercisePickerCache: ExercisePickerCacheEntry | null = null;

export function readExercisePickerCache() {
	return exercisePickerCache;
}

export function writeExercisePickerCache(
	exercises: Exercise[],
	exerciseUsagePreferences: ExerciseUsagePreference[]
) {
	exercisePickerCache = {
		exercises,
		exerciseUsagePreferences,
		updatedAt: Date.now()
	};
}

