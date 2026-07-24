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
	uploadLocalDatabaseToCloud,
	SESSION_INACTIVITY_ABANDON_MS,
	SESSION_INACTIVITY_CHECK_INTERVAL_MS,
	SESSION_INACTIVITY_WARNING_MS
} from './db/runtime';
export {
	createCustomExercise,
	createExercise,
	getExercise,
	getExerciseDetail,
	listCustomExercises,
	listExerciseHistory,
	listExerciseItems,
	listExerciseResetEvents,
	listExercises,
	listExerciseUsagePreferences,
	recordExerciseReset,
	setExerciseUnilateral
} from './db/exercises';
export { listExerciseMergeOptions, mergeExerciseHistory } from './db/exercise-merge';
export {
	addExerciseToWorkout,
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
