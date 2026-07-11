export type {
	DatabaseTableUploadSummary,
	DatabaseUploadMode,
	DatabaseUploadSummary,
	LocalDatabaseStats,
	SyncProgress
} from '../db-cloud-sync';

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';
export type ExerciseSource = 'baseline' | 'custom';
export type SessionSetSide = 'bilateral' | 'left' | 'right';
export type SessionInputField = 'weight' | 'reps' | 'rir';
export type PersistentStorageStatus = 'persisted' | 'promptable' | 'denied' | 'unsupported';

export type HydrateVisibleScopeInput =
	| { type: 'session'; sessionId: string }
	| { type: 'week'; weekStartDayKey: string; weekEndDayKey: string }
	| { type: 'day'; dayKey: string }
	| { type: 'workouts' };

export interface Exercise {
	id: string;
	name: string;
	normalizedName: string;
	unilateral: boolean;
	source: ExerciseSource;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Workout {
	id: string;
	name: string;
	normalizedName: string;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutExercise {
	id: string;
	workoutId: string;
	exerciseId: string;
	order: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutSession {
	id: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	startedAt?: string;
	completedAt?: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
}

export interface SessionExercise {
	id: string;
	sessionId: string;
	workoutId: string;
	exerciseId: string;
	exerciseNameSnapshot: string;
	order: number;
	performedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionSet {
	id: string;
	sessionExerciseId: string;
	exerciseId: string;
	order: number;
	side: SessionSetSide;
	weightInput?: string;
	repsInput?: string;
	rirInput?: string;
	weight?: number;
	reps?: number;
	rir?: number;
	createdAt: string;
	updatedAt: string;
}

export interface ExerciseResetEvent {
	id: string;
	exerciseId: string;
	resetAt: string;
	createdAt: string;
}

export type WorkoutExerciseWithExercise = WorkoutExercise & {
	exercise: Exercise;
};

export type SessionSummary = WorkoutSession & {
	lastActivityAt?: string;
	lastSetActivityAt?: string;
	totalExercises: number;
	totalSets: number;
	totalReps: number;
	totalVolume: number;
};

export type DayOverview = {
	dayKey: string;
	session: SessionSummary | null;
};

export type ExerciseListItem = {
	exercise: Exercise;
	historyCount: number;
	lastPerformedAt?: string;
	latestResetAt?: string;
};

export type ExerciseMergeOption = {
	exercise: Exercise;
	historyCount: number;
	lastPerformedAt?: string;
	canRename: boolean;
};

export type ExerciseMergeInput = {
	mainExerciseId: string;
	secondaryExerciseId: string;
	mainExerciseName?: string;
};

export type ExerciseMergeResult = {
	mainExercise: Exercise;
	secondaryExercise: Exercise;
	copiedSessionExercises: number;
	copiedSessionSets: number;
	skippedConflicts: number;
	renamed: boolean;
	syncStatus: 'synced' | 'failed';
	syncError?: string;
};

export type ExerciseUsagePreference = {
	normalizedName: string;
	exerciseIds: string[];
	lastPerformedAt: string;
	sessionCount: number;
};

export type ExerciseHistoryEntry = {
	sessionId: string;
	workoutId: string;
	workoutNameSnapshot: string;
	dayKey: string;
	performedAt?: string;
	startedAt?: string;
	completedAt?: string;
	status: SessionStatus;
	sets: SessionSet[];
};

export type SessionExerciseDetail = SessionExercise & {
	sets: SessionSet[];
};

export type SessionFieldDeltaState = 'improved' | 'regressed' | 'matched' | 'empty';

export type SessionFieldDelta = {
	state: SessionFieldDeltaState;
	label: string;
};

export type SessionSetReference = {
	sessionId: string;
	startedAt?: string;
	completedAt?: string;
	order: number;
	side: SessionSetSide;
	weight?: number;
	reps?: number;
	rir?: number;
};

export type SessionSetOverview = SessionSet & {
	label: string;
	previousReference: SessionSetReference | null;
	weightDelta: SessionFieldDelta;
	repsDelta: SessionFieldDelta;
	rirDelta: SessionFieldDelta;
};

export type SessionExerciseProgressStatus = 'new' | 'matched' | 'improved' | 'regressed' | 'mixed';

export type SessionExerciseOverview = SessionExerciseDetail & {
	exercise: Exercise | null;
	previousPerformance: ExerciseHistoryEntry | null;
	progressStatus: SessionExerciseProgressStatus;
	progressSummary: string;
	sets: SessionSetOverview[];
};

export type SessionProgressSummary = {
	improvedExercises: number;
	matchedExercises: number;
	regressedExercises: number;
	mixedExercises: number;
	newExercises: number;
};

export type SessionOverview = {
	summary: SessionSummary;
	previousSummary: SessionSummary | null;
	progress: SessionProgressSummary | null;
	exercises: SessionExerciseOverview[];
};

export type ExerciseDetail = {
	exercise: Exercise;
	history: ExerciseHistoryEntry[];
	resetEvents: ExerciseResetEvent[];
};

export type BackfillSeedResult = {
	workoutId: string;
	sessionId: string;
	created: boolean;
};

export type BackfillSessionSetInput = {
	order?: number;
	side?: SessionSetSide;
	weightInput?: string;
	repsInput?: string;
	rirInput?: string;
};

export type BackfillSessionExerciseInput = {
	exerciseId: string;
	sets: BackfillSessionSetInput[];
};

export type BackfillWorkoutSessionInput = {
	workoutId: string;
	dayKey: string;
	startTime: string;
	durationMinutes: number;
	exercises: BackfillSessionExerciseInput[];
};
