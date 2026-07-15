/**
 * TinyTrain's canonical database API.
 *
 * Feature code should import from this facade. Implementations live in focused
 * runtime and domain modules so the public API stays stable without a God implementation.
 */
export * from './db/models';
export {
	db,
	ensureDbOpen,
	getLocalDatabaseStats,
	getPersistentStorageStatus,
	getSessionTimerSummary,
	hydrateVisibleScope,
	loginWithGoogle,
	loginWithSupabaseGoogleForApp,
	logoutFromCloud,
	requestPersistentStorage,
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
	listCustomExerciseItems,
	listCustomExercises,
	listExerciseHistory,
	listExerciseItems,
	listExerciseResetEvents,
	listExercises,
	listExerciseUsagePreferences,
	recordExerciseReset,
	setExerciseUnilateral
} from './db/exercises';
export {
	ExerciseMergeCompensationError,
	listExerciseMergeOptions,
	mergeExerciseHistory,
	repairExerciseMergeCompensation
} from './db/exercise-merge';
export {
	addExerciseToWorkout,
	addExercisesToWorkout,
	createWorkout,
	listWorkoutExercises,
	listWorkoutSchedulingOptions,
	listWorkouts,
	moveWorkoutExercise,
	removeWorkoutExercise,
	reorderWorkoutExercises
} from './db/workouts';
export * from './db/sessions';
export { normalizeName, toDayKey } from './db/shared';
