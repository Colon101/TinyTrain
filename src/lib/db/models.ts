export type {
	DatabaseTableUploadSummary,
	DatabaseUploadMode,
	DatabaseUploadSummary,
	SyncProgress
} from '../db-cloud-sync';

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';
export type ExerciseSource = 'baseline' | 'custom';
export type SessionSetSide = 'bilateral' | 'left' | 'right';
export type SessionInputField = 'weight' | 'reps' | 'rir';

export type HydrateVisibleScopeInput =
	| { type: 'session'; sessionId: string }
	| { type: 'week'; weekStartDayKey: string; weekEndDayKey: string }
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
	session: SessionSummary | null;
};

export type ExerciseListItem = {
	exercise: Exercise;
	historyCount: number;
	lastPerformedAt?: string;
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

export type SessionExerciseOverview = SessionExerciseDetail & {
	exercise: Exercise | null;
	sets: SessionSetOverview[];
};

export type SessionOverview = {
	summary: SessionSummary;
	previousSummary: SessionSummary | null;
	exercises: SessionExerciseOverview[];
};

export type ExerciseDetail = {
	exercise: Exercise;
	history: ExerciseHistoryEntry[];
};
