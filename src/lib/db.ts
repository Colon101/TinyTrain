/**
 * TinyTrain's canonical database API.
 *
 * Feature code should import from this facade. Implementations live in focused
 * runtime and domain modules so the public API stays stable without a God implementation.
 */
export * from './db/models';
export {
	currentUser,
	db,
	ensureDbOpen,
	getSessionTimerSummary,
	hydrateVisibleScope,
	loginWithSupabaseGoogleForApp,
	logoutFromCloud,
	runWithClosedDatabaseRetry,
	subscribeToDatabaseChanges,
	syncNow,
	uploadLocalDatabaseToCloud
} from './db/runtime';
export {
	createCustomExercise,
	createExercise,
	getExerciseDetail,
	listExerciseItems,
	listExercises,
	listExerciseUsagePreferences,
	setExerciseUnilateral
} from './db/exercises';
export { listExerciseMergeOptions, mergeExerciseHistory } from './db/exercise-merge';
export {
	addExercisesToWorkout,
	createWorkout,
	listWorkoutExercises,
	listWorkoutSchedulingOptions,
	listWorkouts,
	removeWorkoutExercise,
	reorderWorkoutExercises
} from './db/workouts';
export * from './db/sessions';
export { normalizeName, toDayKey } from './db/shared';
