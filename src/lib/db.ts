import { browser } from '$app/environment';
import type { StorageBackend } from './runtime-mode';
import {
	getSupabaseAuthSnapshot,
	getSupabaseUser,
	initializeSupabaseAuth,
	loginWithSupabaseGoogle as startSupabaseGoogleLogin,
	logoutFromSupabase,
	subscribeToSupabaseAuth,
	supabase
} from './supabase';
import type { RxDexieLikeDatabase } from './rxdb-dexie-adapter';
import {
	BASELINE_EXERCISE_BY_ID,
	BASELINE_EXERCISE_BY_NORMALIZED_NAME,
	BASELINE_EXERCISE_ROWS,
	createBaselineExerciseId as createSharedBaselineExerciseId
} from './exercises';
import {
	dbCloudSync,
	type DatabaseUploadMode,
	type DatabaseUploadSummary,
	type LocalDatabaseStats,
	type SupabaseSyncedRow,
	type SupabaseTableName,
	type SyncableRow,
	type SyncProgress
} from './db-cloud-sync';
import { SESSION_INACTIVITY_ABANDON_MS } from './session-inactivity';

export type {
	DatabaseTableUploadSummary,
	DatabaseUploadMode,
	DatabaseUploadSummary,
	LocalDatabaseStats,
	SyncProgress
} from './db-cloud-sync';

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';
export type ExerciseSource = 'baseline' | 'custom';
export type SessionSetSide = 'bilateral' | 'left' | 'right';
export type SessionInputField = 'weight' | 'reps' | 'rir';

export {
	SESSION_INACTIVITY_ABANDON_MS,
	SESSION_INACTIVITY_CHECK_INTERVAL_MS,
	SESSION_INACTIVITY_WARNING_MS
} from './session-inactivity';

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

type HistoricalSessionExerciseMatch = {
	session: WorkoutSession;
	sessionExercise: SessionExercise;
	sets: SessionSet[];
};
type SessionInputDraftFieldKey = `${SessionInputField}Input`;
type SessionInputDraftBaseKey = `${SessionInputDraftFieldKey}Base`;
type SessionInputDraftSet = Partial<
	Record<SessionInputDraftFieldKey | SessionInputDraftBaseKey, string>
> & { updatedAt?: number };
type SessionInputDraft = {
	sessionId: string;
	sets?: Record<string, SessionInputDraftSet>;
	updatedAt?: number;
};
const SESSION_INPUT_DRAFT_CHANGE_EVENT = 'tinytrain:session-input-draft-change';

const EXAMPLE_WORKOUT_NAME = 'Upper Builder Demo';
const EXAMPLE_EXERCISE_NAMES = ['Barbell Bench Press', 'Wide Grip Pull-up', 'Cable Lateral Raise'];

type SubscriptionLike = {
	unsubscribe(): void;
};

type SyncStateLike = {
	phase?: string;
	status?: string;
	progress?: number;
	error?: Error;
};
type DatabaseTableKey =
	| 'exercises'
	| 'workouts'
	| 'workoutExercises'
	| 'workoutSessions'
	| 'sessionExercises'
	| 'sessionSets'
	| 'exerciseResetEvents';
type DatabaseChangeSubscriber = (tables: DatabaseTableKey[]) => void;
type DatabaseChangeSubscribeOptions = {
	debounceMs?: number;
};
type WindowWithIdleCallback = Window & {
	requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

class ValueObservable<T> {
	private subscribers = new Set<(value: T) => void>();

	constructor(public value: T) {}

	subscribe(subscriber: (value: T) => void): SubscriptionLike {
		this.subscribers.add(subscriber);
		subscriber(this.value);

		return {
			unsubscribe: () => {
				this.subscribers.delete(subscriber);
			}
		};
	}

	set(value: T) {
		this.value = value;

		for (const subscriber of this.subscribers) {
			subscriber(value);
		}
	}
}

type QueryResult<T> = {
	toArray(): Promise<T[]>;
	first(): Promise<T | undefined>;
	sortBy(field: string): Promise<T[]>;
};

type WhereClause<T> = {
	equals(value: unknown): QueryResult<T>;
	anyOf(values: unknown[]): QueryResult<T>;
	between(
		lower: unknown,
		upper: unknown,
		includeLower?: boolean,
		includeUpper?: boolean
	): QueryResult<T>;
};

type DataTable<T extends { id: string }> = {
	toArray(): Promise<T[]>;
	get(id: string): Promise<T | undefined>;
	bulkGet(ids: string[]): Promise<(T | undefined)[]>;
	add(doc: T): Promise<string>;
	bulkAdd(docs: T[]): Promise<string[]>;
	put(doc: T): Promise<string>;
	bulkPut(docs: T[]): Promise<string[]>;
	update(id: string, patch: Partial<T>): Promise<number>;
	delete(id: string): Promise<void>;
	bulkDelete(ids: string[]): Promise<void>;
	where(field: string): WhereClause<T>;
};

const activeUser = new ValueObservable<{
	userId?: string;
	name?: string;
	email?: string;
	claims?: Record<string, unknown>;
	isLoggedIn?: boolean;
	isLoading?: boolean;
}>({ isLoading: true });
const activeSyncState = new ValueObservable<SyncStateLike>({
	phase: 'initial',
	status: 'not-started'
});
const supabaseHydratedPrefix = 'tinytrain:supabase-rxdb-hydrated:';
const progressiveBackfillPrefix = 'tinytrain:supabase-rxdb-backfilled:';
const recentBackfillDays = 90;

let activeBackend: StorageBackend = 'supabase-rxdb';
let rxDataDb: RxDexieLikeDatabase | null = null;
let activeSupabaseUserId: string | null = null;
let dbOpenPromise: Promise<typeof db> | null = null;
let authBridgeStarted = false;
let supabaseBackendActivationPromise: Promise<void> | null = null;
let closedDatabaseRecoveryPromise: Promise<boolean> | null = null;
let rxChangeSubscription: SubscriptionLike | null = null;
let rxRuntimePromise: Promise<{
	adapter: typeof import('./rxdb-dexie-adapter');
	rxdb: typeof import('./rxdb');
}> | null = null;
let lastStaleSessionCleanupKey: string | null = null;
let backgroundSyncUserId: string | null = null;
const databaseChangeSubscribers = new Set<{
	tables: Set<DatabaseTableKey>;
	callback: DatabaseChangeSubscriber;
	debounceMs: number;
	pendingTables: Set<DatabaseTableKey>;
	timeoutId: ReturnType<typeof setTimeout> | null;
}>();

function toSupabaseCloudUser() {
	const snapshot = getSupabaseAuthSnapshot();
	const user = snapshot.user;

	if (!user) {
		return {
			isLoading: snapshot.isLoading,
			isLoggedIn: false
		};
	}

	return {
		userId: user.id,
		name:
			typeof user.user_metadata?.name === 'string'
				? user.user_metadata.name
				: typeof user.user_metadata?.full_name === 'string'
					? user.user_metadata.full_name
					: user.email,
		email: user.email,
		claims: user.user_metadata as Record<string, unknown>,
		isLoggedIn: true,
		isLoading: false
	};
}

function hasHydratedSupabaseCache(userId: string) {
	return browser && localStorage.getItem(`${supabaseHydratedPrefix}${userId}`) === 'true';
}

function markSupabaseCacheHydrated(userId: string) {
	if (!browser) {
		return;
	}

	localStorage.setItem(`${supabaseHydratedPrefix}${userId}`, 'true');
}

export function getActiveStorageBackend(): StorageBackend {
	return activeBackend;
}

function getProgressiveBackfillKey(userId: string) {
	return `${progressiveBackfillPrefix}${userId}`;
}

function markRecentBackfillComplete(userId: string) {
	if (!browser) {
		return;
	}

	localStorage.setItem(getProgressiveBackfillKey(userId), 'true');
}

function emitDatabaseChange(tableName: DatabaseTableKey) {
	for (const subscriber of databaseChangeSubscribers) {
		if (!subscriber.tables.has(tableName)) {
			continue;
		}

		subscriber.pendingTables.add(tableName);

		if (subscriber.timeoutId) {
			continue;
		}

		subscriber.timeoutId = setTimeout(() => {
			subscriber.timeoutId = null;
			const changedTables = [...subscriber.pendingTables];
			subscriber.pendingTables.clear();
			subscriber.callback(changedTables);
		}, subscriber.debounceMs);
	}
}

export function subscribeToDatabaseChanges(
	tables: DatabaseTableKey[],
	callback: DatabaseChangeSubscriber,
	options: DatabaseChangeSubscribeOptions = {}
): SubscriptionLike {
	const subscriber = {
		tables: new Set(tables),
		callback,
		debounceMs: options.debounceMs ?? 150,
		pendingTables: new Set<DatabaseTableKey>(),
		timeoutId: null as ReturnType<typeof setTimeout> | null
	};

	databaseChangeSubscribers.add(subscriber);

	return {
		unsubscribe() {
			if (subscriber.timeoutId) {
				clearTimeout(subscriber.timeoutId);
			}
			databaseChangeSubscribers.delete(subscriber);
		}
	};
}

function startAuthBridge() {
	if (authBridgeStarted) {
		return;
	}

	authBridgeStarted = true;
	void initializeSupabaseAuth();
	subscribeToSupabaseAuth((snapshot) => {
		if (!snapshot.user) {
			if (!snapshot.isLoading) {
				clearSupabaseRuntimeState();
			}

			activeUser.set(toSupabaseCloudUser());
			return;
		}

		activeUser.set(toSupabaseCloudUser());

		if (activeBackend !== 'supabase-rxdb' || activeSupabaseUserId !== snapshot.user.id) {
			activeUser.set({ isLoading: true });
			dbOpenPromise = null;
			supabaseBackendActivationPromise ??= selectBackend()
				.catch((error) => {
					activeSyncState.set({
						phase: 'error',
						status: 'error',
						error: error instanceof Error ? error : new Error('Supabase sync failed.')
					});
					console.warn('Supabase backend activation failed.', error);
				})
				.finally(() => {
					supabaseBackendActivationPromise = null;
				});
		}
	});
}

function clearSupabaseRuntimeState() {
	const previousUserId = activeSupabaseUserId;

	lastStaleSessionCleanupKey = null;
	backgroundSyncUserId = null;
	activeBackend = 'supabase-rxdb';
	activeSupabaseUserId = null;
	rxDataDb = null;
	dbOpenPromise = null;
	activeSyncState.set({ phase: 'initial', status: 'not-started' });

	if (!previousUserId) {
		return;
	}

	void getRxRuntime()
		.then(({ rxdb }) => rxdb.stopSupabaseReplication(previousUserId))
		.catch((error) => {
			console.warn('Supabase replication shutdown failed.', error);
		});
}

async function getRxRuntime() {
	rxRuntimePromise ??= Promise.all([import('./rxdb-dexie-adapter'), import('./rxdb')]).then(
		([adapter, rxdb]) => ({ adapter, rxdb })
	);
	return rxRuntimePromise;
}

async function openSupabaseRuntime(userId: string) {
	const { adapter, rxdb } = await getRxRuntime();

	activeBackend = 'supabase-rxdb';
	activeSupabaseUserId = userId;
	activeSyncState.set({ phase: 'pulling', status: 'syncing' });
	rxDataDb = await adapter.getRxDexieLikeDatabase(userId);
	rxChangeSubscription ??= adapter.subscribeToRxDexieChanges((tableName) => {
		emitDatabaseChange(tableName as DatabaseTableKey);
	});
	activeUser.set(toSupabaseCloudUser());
	startProgressiveSync(userId);

	if (hasHydratedSupabaseCache(userId)) {
		void rxdb
			.awaitSupabaseInSync(userId, { timeoutMs: 15000 })
			.then(() => {
				markSupabaseCacheHydrated(userId);
				if (activeBackend === 'supabase-rxdb' && activeSupabaseUserId === userId) {
					activeSyncState.set({ phase: 'in-sync', status: 'synced' });
				}
			})
			.catch((error) => {
				console.warn('Background Supabase sync failed.', error);
				if (activeBackend === 'supabase-rxdb' && activeSupabaseUserId === userId) {
					activeSyncState.set({
						phase: 'error',
						status: 'error',
						error: error instanceof Error ? error : new Error('Supabase sync failed.')
					});
				}
			});
		return;
	}
}

async function selectBackend() {
	startAuthBridge();
	const user = await getSupabaseUser();

	if (!user) {
		clearSupabaseRuntimeState();
		activeUser.set(toSupabaseCloudUser());
		return;
	}

	await openSupabaseRuntime(user.id);
}

const cloudCompat = {
	currentUser: activeUser,
	syncState: activeSyncState,
	async sync() {
		await syncNow();
	}
};

type AppDatabase = {
	exercises: DataTable<Exercise>;
	workouts: DataTable<Workout>;
	workoutExercises: DataTable<WorkoutExercise>;
	workoutSessions: DataTable<WorkoutSession>;
	sessionExercises: DataTable<SessionExercise>;
	sessionSets: DataTable<SessionSet>;
	exerciseResetEvents: DataTable<ExerciseResetEvent>;
	cloud: typeof cloudCompat;
	open(): Promise<AppDatabase>;
	transaction<T>(mode: string, ...args: unknown[]): Promise<T>;
};

type RxDataTableKey = Exclude<keyof RxDexieLikeDatabase, 'transaction'>;

function getRxDataTable(tableName: RxDataTableKey) {
	if (!rxDataDb) {
		throw new Error('The local database is still loading.');
	}

	return rxDataDb[tableName];
}

async function runRecoveringDatabaseOperation<T>(
	operation: () => Promise<T>,
	retryOperation: () => Promise<T>
) {
	try {
		return await operation();
	} catch (error) {
		if (!isClosedDatabaseError(error) || !(await recoverClosedDatabase())) {
			throw error;
		}
	}

	return retryOperation();
}

function createRecoveringQueryResult<T>(
	queryResult: QueryResult<T>,
	rebuildQueryResult: () => QueryResult<T>
): QueryResult<T> {
	return new Proxy(queryResult, {
		get(target, prop) {
			const value = target[prop as keyof QueryResult<T>];

			if (typeof value !== 'function') {
				return value;
			}

			return (...args: unknown[]) =>
				runRecoveringDatabaseOperation(
					() => (value as (...methodArgs: unknown[]) => Promise<unknown>).apply(target, args),
					() => {
						const nextQueryResult = rebuildQueryResult();
						const nextValue = nextQueryResult[prop as keyof QueryResult<T>];

						return (nextValue as (...methodArgs: unknown[]) => Promise<unknown>).apply(
							nextQueryResult,
							args
						);
					}
				);
		}
	}) as QueryResult<T>;
}

function createRecoveringWhereClause<T>(
	whereClause: WhereClause<T>,
	rebuildWhereClause: () => WhereClause<T>
): WhereClause<T> {
	return new Proxy(whereClause, {
		get(target, prop) {
			const value = target[prop as keyof WhereClause<T>];

			if (typeof value !== 'function') {
				return value;
			}

			return (...args: unknown[]) => {
				const queryResult = (value as (...methodArgs: unknown[]) => QueryResult<T>).apply(
					target,
					args
				);

				return createRecoveringQueryResult(queryResult, () => {
					const nextWhereClause = rebuildWhereClause();
					const nextValue = nextWhereClause[prop as keyof WhereClause<T>];

					return (nextValue as (...methodArgs: unknown[]) => QueryResult<T>).apply(
						nextWhereClause,
						args
					);
				});
			};
		}
	}) as WhereClause<T>;
}

function createRecoveringDataTable<T extends { id: string }>(
	tableName: RxDataTableKey,
	table: DataTable<T>
): DataTable<T> {
	return new Proxy(table, {
		get(target, prop) {
			const value = target[prop as keyof DataTable<T>];

			if (prop === 'where' && typeof value === 'function') {
				return (field: string) => {
					const whereClause = target.where(field);

					return createRecoveringWhereClause(whereClause, () =>
						(getRxDataTable(tableName) as unknown as DataTable<T>).where(field)
					);
				};
			}

			if (typeof value !== 'function') {
				return value;
			}

			return (...args: unknown[]) =>
				runRecoveringDatabaseOperation(
					() => (value as (...methodArgs: unknown[]) => Promise<unknown>).apply(target, args),
					() => {
						const nextTable = getRxDataTable(tableName) as unknown as DataTable<T>;
						const nextValue = nextTable[prop as keyof DataTable<T>];

						return (nextValue as (...methodArgs: unknown[]) => Promise<unknown>).apply(
							nextTable,
							args
						);
					}
				);
		}
	}) as DataTable<T>;
}

export const db = new Proxy(
	{},
	{
		get(_target, prop) {
			if (prop === 'cloud') {
				return cloudCompat;
			}

			if (prop === 'transaction' && activeBackend === 'supabase-rxdb' && rxDataDb) {
				return rxDataDb.transaction.bind(rxDataDb);
			}

			if (
				activeBackend === 'supabase-rxdb' &&
				rxDataDb &&
				typeof prop === 'string' &&
				prop in rxDataDb
			) {
				return createRecoveringDataTable(
					prop as RxDataTableKey,
					rxDataDb[prop as RxDataTableKey] as unknown as DataTable<{ id: string }>
				);
			}

			if (prop === 'open') {
				return ensureDbOpen;
			}

			return undefined;
		}
	}
) as AppDatabase;

export type PersistentStorageStatus = 'persisted' | 'promptable' | 'denied' | 'unsupported';

export async function getPersistentStorageStatus(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted) {
		return 'unsupported';
	}

	return (await navigator.storage.persisted()) ? 'persisted' : 'promptable';
}

export async function requestPersistentStorage(): Promise<PersistentStorageStatus> {
	if (!globalThis.navigator?.storage?.persisted || !globalThis.navigator.storage.persist) {
		return 'unsupported';
	}

	if (await navigator.storage.persisted()) {
		return 'persisted';
	}

	return (await navigator.storage.persist()) ? 'persisted' : 'denied';
}

export async function loginWithGoogle(redirectPath = '/') {
	await loginWithSupabaseGoogleForApp(redirectPath);
}

export async function loginWithSupabaseGoogleForApp(redirectPath = '/') {
	await startSupabaseGoogleLogin(redirectPath);
}

export async function ensureDbOpen() {
	if (!dbOpenPromise) {
		dbOpenPromise = selectBackend()
			.then(() => db)
			.catch((error) => {
				dbOpenPromise = null;
				throw error;
			});
	}

	return dbOpenPromise;
}

function isClosedDatabaseError(error: unknown) {
	if (!(error instanceof Error)) {
		return false;
	}

	return (
		error.name === 'DatabaseClosedError' ||
		error.name === 'DatabaseClosed' ||
		error.message.includes('Database has been closed') ||
		error.message.includes('db.open() was cancelled') ||
		error.message.includes('closed or removed')
	);
}

async function recoverClosedDatabase() {
	if (activeBackend !== 'supabase-rxdb' || !activeSupabaseUserId) {
		return false;
	}

	const userId = activeSupabaseUserId;

	closedDatabaseRecoveryPromise ??= (async () => {
		const { adapter } = await getRxRuntime();

		activeSyncState.set({ phase: 'pulling', status: 'syncing' });
		rxDataDb = await adapter.reopenRxDexieLikeDatabase(userId);

		if (activeSupabaseUserId !== userId || activeBackend !== 'supabase-rxdb') {
			return false;
		}

		dbOpenPromise = Promise.resolve(db);
		backgroundSyncUserId = null;
		activeUser.set(toSupabaseCloudUser());
		startProgressiveSync(userId);

		return true;
	})().finally(() => {
		closedDatabaseRecoveryPromise = null;
	});

	return closedDatabaseRecoveryPromise;
}

export async function runWithClosedDatabaseRetry<T>(operation: () => Promise<T>): Promise<T> {
	await ensureDbOpen();

	try {
		return await operation();
	} catch (error) {
		if (!isClosedDatabaseError(error) || !(await recoverClosedDatabase())) {
			throw error;
		}
	}

	return operation();
}

export async function logoutFromCloud() {
	await ensureDbOpen();
	await logoutFromSupabase();
	clearSupabaseRuntimeState();
	activeUser.set(toSupabaseCloudUser());
}

export async function syncNow(options: SyncNowOptions = {}) {
	await ensureDbOpen();

	if (!activeSupabaseUserId) {
		return;
	}

	activeSyncState.set({ phase: 'pushing', status: 'syncing' });

	try {
		const userId = activeSupabaseUserId;
		const summary = await reconcileSupabaseDatabase(userId, 'richest', {
			onProgress: options.onProgress
		});
		const { rxdb } = await getRxRuntime();

		void rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 }).catch((error) => {
			console.warn('Background Supabase sync confirmation failed.', error);
		});

		activeSyncState.set({ phase: 'in-sync', status: 'synced' });
		return summary;
	} catch (error) {
		activeSyncState.set({
			phase: 'error',
			status: 'error',
			error: error instanceof Error ? error : new Error('Cloud sync failed.')
		});
		throw error;
	}
}

type SyncNowOptions = {
	onProgress?: (progress: SyncProgress) => void;
};

function getCloudSyncDeps() {
	return {
		db,
		getActiveSupabaseUserId: () => activeSupabaseUserId,
		markSupabaseCacheHydrated,
		markRecentBackfillComplete,
		withExerciseDefaults,
		withSessionSetDefaults,
		hasInputValue
	};
}

function normalizeRemoteSessionSet(row: SessionSet): SessionSet {
	return dbCloudSync.normalizeRemoteSessionSet(getCloudSyncDeps(), row);
}

function shouldSyncExercise(exercise: Exercise) {
	return dbCloudSync.shouldSyncExercise(getCloudSyncDeps(), exercise);
}

function getRowTimestamp(row: SyncableRow) {
	return dbCloudSync.getRowTimestamp(row);
}

function stripSupabaseSyncFields<T extends { id: string }>(row: SupabaseSyncedRow): T {
	return dbCloudSync.stripSupabaseSyncFields<T>(row);
}

async function reconcileSupabaseDatabase(
	userId: string,
	mode: DatabaseUploadMode,
	options: SyncNowOptions = {}
): Promise<DatabaseUploadSummary> {
	return dbCloudSync.reconcileSupabaseDatabase(getCloudSyncDeps(), userId, mode, options);
}

async function putMergedRemoteRow<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	row: T,
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRow(getCloudSyncDeps(), tableName, table, row, normalize);
}

async function putMergedRemoteRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	rows: T[],
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRows(getCloudSyncDeps(), tableName, table, rows, normalize);
}

async function fetchSupabaseRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	buildQuery: (query: any) => PromiseLike<{ data: unknown; error: unknown }>,
	normalize: (row: T) => T = (row) => row
) {
	return dbCloudSync.fetchSupabaseRows(getCloudSyncDeps(), tableName, buildQuery, normalize);
}

async function backfillRecentRows(userId: string, days = recentBackfillDays) {
	if (activeBackend !== 'supabase-rxdb' || activeSupabaseUserId !== userId) {
		return;
	}

	await dbCloudSync.backfillRecentRows(getCloudSyncDeps(), userId, days);
}

function startProgressiveSync(userId: string) {
	if (backgroundSyncUserId === userId) {
		return;
	}

	backgroundSyncUserId = userId;

	void (async () => {
		try {
			const { rxdb } = await getRxRuntime();
			await waitForBackgroundSyncSlot();

			activeSyncState.set({ phase: 'pulling', status: 'syncing', progress: 0.25 });

			try {
				await backfillRecentRows(userId);
			} catch (error) {
				console.warn('Recent Supabase backfill failed.', error);
			}

			activeSyncState.set({ phase: 'pulling', status: 'syncing', progress: 0.75 });
			await rxdb.awaitSupabaseInitialReplication(userId);
			await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 });

			markSupabaseCacheHydrated(userId);
			activeSyncState.set({ phase: 'in-sync', status: 'synced' });
		} catch (error) {
			console.warn('Background Supabase sync failed.', error);

			if (activeSupabaseUserId === userId) {
				activeSyncState.set({
					phase: 'error',
					status: 'error',
					error: error instanceof Error ? error : new Error('Supabase sync failed.')
				});
			}
		}
	})();
}

function waitForBackgroundSyncSlot() {
	if (!browser) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve) => {
		const idleWindow = window as WindowWithIdleCallback;

		if (idleWindow.requestIdleCallback) {
			idleWindow.requestIdleCallback(() => resolve(), { timeout: 3000 });
			return;
		}

		setTimeout(resolve, 1500);
	});
}

export async function uploadLocalDatabaseToCloud() {
	await ensureDbOpen();

	if (!activeSupabaseUserId) {
		throw new Error('Sign in with Google to upload this device.');
	}

	activeSyncState.set({ phase: 'pushing', status: 'syncing' });

	try {
		const summary = await reconcileSupabaseDatabase(activeSupabaseUserId, 'local-preferred');
		activeSyncState.set({ phase: 'in-sync', status: 'synced' });
		return summary;
	} catch (error) {
		activeSyncState.set({
			phase: 'error',
			status: 'error',
			error: error instanceof Error ? error : new Error('Local upload failed.')
		});
		throw error;
	}
}

export async function getLocalDatabaseStats(): Promise<LocalDatabaseStats> {
	await ensureDbOpen();

	const [workouts, exercises, sessions, sessionExercises, sessionSets] = await Promise.all([
		db.workouts.toArray(),
		db.exercises.toArray(),
		db.workoutSessions.toArray(),
		db.sessionExercises.toArray(),
		db.sessionSets.toArray()
	]);
	const completedSessions = sessions.filter((session) => session.status === 'completed');
	const lastWorkout = [...completedSessions].sort(
		(first, second) => getRowTimestamp(second) - getRowTimestamp(first)
	)[0];

	return {
		workouts: workouts.length,
		customExercises: exercises.filter(shouldSyncExercise).length,
		previousWorkouts: completedSessions.length,
		sessionExercises: sessionExercises.length,
		sessionSets: sessionSets.length,
		filledSessionSets: sessionSets.filter(hasAnySetValue).length,
		lastWorkoutAt: lastWorkout?.completedAt ?? lastWorkout?.startedAt ?? lastWorkout?.createdAt
	};
}

async function hydrateSessionFromSupabase(sessionId: string) {
	if (activeBackend !== 'supabase-rxdb' || !activeSupabaseUserId) {
		return;
	}

	try {
		const [sessionResult, sessionExercisesResult] = await Promise.all([
			supabase
				.from('workout_sessions')
				.select('*')
				.eq('user_id', activeSupabaseUserId)
				.eq('id', sessionId)
				.eq('_deleted', false)
				.maybeSingle(),
			supabase
				.from('session_exercises')
				.select('*')
				.eq('user_id', activeSupabaseUserId)
				.eq('sessionId', sessionId)
				.eq('_deleted', false)
		]);

		if (sessionResult.error) {
			throw sessionResult.error;
		}

		if (sessionExercisesResult.error) {
			throw sessionExercisesResult.error;
		}

		const sessionRow = sessionResult.data as SupabaseSyncedRow | null;
		const sessionExerciseRows = (sessionExercisesResult.data ?? []) as SupabaseSyncedRow[];
		const sessionExerciseIds = sessionExerciseRows.map((row) => row.id);
		const exerciseIds = [...new Set(sessionExerciseRows.map((row) => String(row.exerciseId)))];
		const [sessionSetsResult, exercisesResult] = await Promise.all([
			sessionExerciseIds.length > 0
				? supabase
						.from('session_sets')
						.select('*')
						.eq('user_id', activeSupabaseUserId)
						.in('sessionExerciseId', sessionExerciseIds)
						.eq('_deleted', false)
				: Promise.resolve({ data: [], error: null }),
			exerciseIds.length > 0
				? supabase
						.from('exercises')
						.select('*')
						.eq('user_id', activeSupabaseUserId)
						.in('id', exerciseIds)
						.eq('_deleted', false)
				: Promise.resolve({ data: [], error: null })
		]);

		if (sessionSetsResult.error) {
			throw sessionSetsResult.error;
		}

		if (exercisesResult.error) {
			throw exercisesResult.error;
		}

		if (sessionRow) {
			await putMergedRemoteRow(
				'workout_sessions',
				db.workoutSessions,
				stripSupabaseSyncFields<WorkoutSession>(sessionRow)
			);
		}

		await putMergedRemoteRows(
			'session_exercises',
			db.sessionExercises,
			sessionExerciseRows.map((row) => stripSupabaseSyncFields<SessionExercise>(row))
		);
		await putMergedRemoteRows(
			'session_sets',
			db.sessionSets,
			((sessionSetsResult.data ?? []) as SupabaseSyncedRow[]).map((row) =>
				stripSupabaseSyncFields<SessionSet>(row)
			),
			normalizeRemoteSessionSet
		);
		await putMergedRemoteRows(
			'exercises',
			db.exercises,
			((exercisesResult.data ?? []) as SupabaseSyncedRow[]).map((row) =>
				stripSupabaseSyncFields<Exercise>(row)
			),
			withExerciseDefaults
		);
	} catch (error) {
		console.warn('Direct session hydration from Supabase failed.', error);
	}
}

export type HydrateVisibleScopeInput =
	| { type: 'session'; sessionId: string }
	| { type: 'week'; weekStartDayKey: string; weekEndDayKey: string }
	| { type: 'day'; dayKey: string }
	| { type: 'workouts' };

export async function hydrateVisibleScope(scope: HydrateVisibleScopeInput) {
	await ensureDbOpen();

	if (activeBackend !== 'supabase-rxdb' || !activeSupabaseUserId) {
		return;
	}

	if (scope.type === 'session') {
		await hydrateSessionFromSupabase(scope.sessionId);
		return;
	}

	if (scope.type === 'week') {
		const sessions = await fetchSupabaseRows<WorkoutSession>('workout_sessions', (query) =>
			query
				.gte('dayKey', scope.weekStartDayKey)
				.lte('dayKey', scope.weekEndDayKey)
				.order('_modified', { ascending: false })
		);
		await putMergedRemoteRows('workout_sessions', db.workoutSessions, sessions);
		return;
	}

	if (scope.type === 'day') {
		const sessions = await fetchSupabaseRows<WorkoutSession>('workout_sessions', (query) =>
			query.eq('dayKey', scope.dayKey).order('_modified', { ascending: false })
		);
		await putMergedRemoteRows('workout_sessions', db.workoutSessions, sessions);
		await Promise.all(sessions.map((session) => hydrateSessionFromSupabase(session.id)));
		return;
	}

	const workouts = await fetchSupabaseRows<Workout>('workouts', (query) =>
		query.order('_modified', { ascending: false }).limit(200)
	);
	const workoutExercises = await fetchSupabaseRows<WorkoutExercise>('workout_exercises', (query) =>
		query.order('_modified', { ascending: false }).limit(2000)
	);
	const exerciseIds = [...new Set(workoutExercises.map((row) => row.exerciseId))];
	const exercises =
		exerciseIds.length === 0
			? []
			: await fetchSupabaseRows<Exercise>(
					'exercises',
					(query) => query.in('id', exerciseIds),
					withExerciseDefaults
				);

	await Promise.all([
		putMergedRemoteRows('workouts', db.workouts, workouts),
		putMergedRemoteRows('workout_exercises', db.workoutExercises, workoutExercises),
		putMergedRemoteRows('exercises', db.exercises, exercises, withExerciseDefaults)
	]);
}

export async function getSessionTimerSummary(sessionId: string) {
	await ensureDbOpen();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	return summarizeSession(
		session,
		await db.sessionExercises.where('sessionId').equals(sessionId).toArray(),
		[]
	);
}

export function toDayKey(input: Date | string) {
	const date = toValidDate(input);

	return [
		String(date.getFullYear()).padStart(4, '0'),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
}

function toValidDate(input: Date | string) {
	const date = input instanceof Date ? new Date(input) : new Date(input);

	if (Number.isNaN(date.getTime())) {
		return new Date();
	}

	return date;
}

function requireLoggedInUser() {
	if (activeBackend === 'supabase-rxdb') {
		if (!activeSupabaseUserId) {
			throw new Error('Sign in with Google to save workouts.');
		}

		return;
	}

	if (!activeUser.value?.isLoggedIn) {
		throw new Error('Sign in with Google to save workouts.');
	}
}

function timestamp(date = new Date()) {
	return date.toISOString();
}

function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== undefined && value !== null;
}

function createId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeName(name: string) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

function inferExerciseSource(nameOrNormalizedName: string, source?: ExerciseSource) {
	if (source) {
		return source;
	}

	return BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(normalizeName(nameOrNormalizedName))
		? 'baseline'
		: 'custom';
}

function withExerciseDefaults(exercise: Exercise): Exercise {
	return {
		...exercise,
		unilateral: Boolean(exercise.unilateral),
		source: inferExerciseSource(exercise.normalizedName || exercise.name, exercise.source)
	};
}

function compareExercises(first: Exercise, second: Exercise) {
	if (first.archived !== second.archived) {
		return Number(first.archived) - Number(second.archived);
	}

	if (BASELINE_EXERCISE_BY_ID.has(first.id) !== BASELINE_EXERCISE_BY_ID.has(second.id)) {
		return BASELINE_EXERCISE_BY_ID.has(first.id) ? -1 : 1;
	}

	if (first.source !== second.source) {
		return first.source === 'baseline' ? -1 : 1;
	}

	if (first.updatedAt !== second.updatedAt) {
		return second.updatedAt.localeCompare(first.updatedAt);
	}

	if (first.createdAt !== second.createdAt) {
		return first.createdAt.localeCompare(second.createdAt);
	}

	return first.id.localeCompare(second.id);
}

function pickPreferredExercise(exercises: Exercise[]) {
	return exercises.map(withExerciseDefaults).sort(compareExercises)[0] ?? null;
}

function dedupeExercises(exercises: Exercise[]) {
	const exerciseByNormalizedName = new Map<string, Exercise>();

	for (const exercise of exercises.map(withExerciseDefaults)) {
		const existingExercise = exerciseByNormalizedName.get(exercise.normalizedName);

		if (!existingExercise || compareExercises(exercise, existingExercise) < 0) {
			exerciseByNormalizedName.set(exercise.normalizedName, exercise);
		}
	}

	return [...exerciseByNormalizedName.values()];
}

function toOptionalNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStoredInputValue(rawValue?: string, numericValue?: number) {
	if (typeof rawValue === 'string') {
		return rawValue;
	}

	return typeof numericValue === 'number' && Number.isFinite(numericValue) ? `${numericValue}` : '';
}

function toParsedInputValue(rawValue: string, field?: SessionInputField) {
	if (!rawValue.trim()) {
		return undefined;
	}

	const cleanValue = toCleanSessionInputValue(rawValue, field);

	if (!cleanValue) {
		return undefined;
	}

	const nextValue = Number(cleanValue);

	return Number.isFinite(nextValue) ? nextValue : undefined;
}

function toCleanSessionInputValue(rawValue: string, field?: SessionInputField) {
	return field === 'reps' || field === 'rir' ? rawValue.trim().replace(/\D/g, '') : rawValue.trim();
}

function normalizeSessionSetSide(side: unknown): SessionSetSide {
	return side === 'left' || side === 'right' || side === 'bilateral' ? side : 'bilateral';
}

function hasInputValue(value?: string) {
	return typeof value === 'string' && value.trim().length > 0;
}

function hasAnySetValue(
	sessionSet: Pick<SessionSet, 'weight' | 'reps' | 'rir' | 'weightInput' | 'repsInput' | 'rirInput'>
) {
	return (
		hasInputValue(sessionSet.weightInput) ||
		hasInputValue(sessionSet.repsInput) ||
		hasInputValue(sessionSet.rirInput) ||
		(typeof sessionSet.weight === 'number' && Number.isFinite(sessionSet.weight)) ||
		(typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)) ||
		(typeof sessionSet.rir === 'number' && Number.isFinite(sessionSet.rir))
	);
}

function hasPerformedSetValues(
	sessionSets: Array<
		Pick<SessionSet, 'weight' | 'reps' | 'rir' | 'weightInput' | 'repsInput' | 'rirInput'>
	>
) {
	return sessionSets.some(hasAnySetValue);
}

function getSessionSortTime(session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>) {
	return toValidDate(session.startedAt ?? session.createdAt).getTime();
}

function getExerciseHistorySortTime(
	entry: Pick<ExerciseHistoryEntry, 'performedAt' | 'startedAt' | 'completedAt' | 'dayKey'>
) {
	return toValidDate(
		entry.performedAt ?? entry.startedAt ?? entry.completedAt ?? `${entry.dayKey}T12:00:00`
	).getTime();
}

function compareSessionRows(
	first: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>,
	second: Pick<WorkoutSession, 'id' | 'startedAt' | 'createdAt'>
) {
	return (
		getSessionSortTime(first) - getSessionSortTime(second) || first.id.localeCompare(second.id)
	);
}

function getWorkoutSessionRecencyTimestamp(session: WorkoutSession) {
	return session.completedAt ?? session.startedAt ?? session.createdAt;
}

function compareOptionalRecency(first?: string, second?: string) {
	if (first && second && first !== second) {
		return second.localeCompare(first);
	}

	if (first && !second) {
		return -1;
	}

	if (!first && second) {
		return 1;
	}

	return 0;
}

function getSessionExerciseSortTime(
	sessionExercise: Pick<SessionExercise, 'performedAt'>,
	session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>
) {
	return toValidDate(
		sessionExercise.performedAt || session.startedAt || session.createdAt
	).getTime();
}

function compareHistoricalSessionExerciseMatches(
	first: HistoricalSessionExerciseMatch,
	second: HistoricalSessionExerciseMatch
) {
	return (
		getSessionExerciseSortTime(first.sessionExercise, first.session) -
			getSessionExerciseSortTime(second.sessionExercise, second.session) ||
		first.sessionExercise.id.localeCompare(second.sessionExercise.id)
	);
}

async function listEquivalentExerciseIds(exerciseId: string) {
	const exercise = await getExercise(exerciseId);

	if (!exercise) {
		return [exerciseId];
	}

	const normalizedName = normalizeName(exercise.normalizedName || exercise.name);

	if (!normalizedName) {
		return [exerciseId];
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.equals(normalizedName)
		.toArray();

	return [
		...new Set([exerciseId, ...matchingExercises.map((matchingExercise) => matchingExercise.id)])
	];
}

async function listHistoricalSessionExerciseMatches(
	exerciseId: string
): Promise<HistoricalSessionExerciseMatch[]> {
	const exercise = await getExercise(exerciseId);
	const equivalentExerciseIds = await listEquivalentExerciseIds(exerciseId);
	const normalizedName = exercise ? normalizeName(exercise.normalizedName || exercise.name) : '';
	const [idMatchedSessionExercises, nameMatchedSessionExercises] = await Promise.all([
		equivalentExerciseIds.length === 0
			? Promise.resolve([])
			: equivalentExerciseIds.length === 1
				? db.sessionExercises.where('exerciseId').equals(equivalentExerciseIds[0]).toArray()
				: db.sessionExercises.where('exerciseId').anyOf(equivalentExerciseIds).toArray(),
		normalizedName
			? db.sessionExercises
					.toArray()
					.then((rows) =>
						rows.filter(
							(sessionExercise) =>
								normalizeName(sessionExercise.exerciseNameSnapshot) === normalizedName
						)
					)
			: Promise.resolve([])
	]);
	const sessionExercises = [
		...new Map(
			[...idMatchedSessionExercises, ...nameMatchedSessionExercises].map((sessionExercise) => [
				sessionExercise.id,
				sessionExercise
			])
		).values()
	];

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const [sessions, sessionSets] = await Promise.all([
		db.workoutSessions.bulkGet(sessionIds),
		db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
			.toArray()
			.then((rows) => rows.map(withSessionSetDefaults))
	]);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises
		.flatMap((sessionExercise) => {
			const session = sessionById.get(sessionExercise.sessionId);
			const sets = (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(
				compareSessionSetRows
			);

			if (!session || session.status === 'planned' || !hasPerformedSetValues(sets)) {
				return [];
			}

			return [
				{
					session,
					sessionExercise,
					sets
				}
			];
		})
		.sort((first, second) => compareHistoricalSessionExerciseMatches(second, first));
}

async function getPreferredExerciseByNormalizedNames(normalizedNames: string[]) {
	const uniqueNormalizedNames = [...new Set(normalizedNames.filter(Boolean))];

	if (uniqueNormalizedNames.length === 0) {
		return new Map<string, Exercise>();
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(uniqueNormalizedNames)
		.toArray();
	const exercisesByNormalizedName = new Map<string, Exercise[]>();

	for (const exercise of matchingExercises) {
		const rows = exercisesByNormalizedName.get(exercise.normalizedName) ?? [];
		rows.push(exercise);
		exercisesByNormalizedName.set(exercise.normalizedName, rows);
	}

	return new Map(
		uniqueNormalizedNames.flatMap((normalizedName) => {
			const preferredExercise = pickPreferredExercise(
				exercisesByNormalizedName.get(normalizedName) ?? []
			);

			return preferredExercise ? ([[normalizedName, preferredExercise]] as const) : [];
		})
	);
}

function getSessionSetSideOrder(side: SessionSetSide) {
	switch (side) {
		case 'right':
			return 1;
		case 'left':
			return 2;
		default:
			return 0;
	}
}

function compareSessionSetRows(
	first: Pick<SessionSet, 'id' | 'order' | 'side'>,
	second: Pick<SessionSet, 'id' | 'order' | 'side'>
) {
	if (first.order !== second.order) {
		return first.order - second.order;
	}

	return (
		getSessionSetSideOrder(normalizeSessionSetSide(first.side)) -
			getSessionSetSideOrder(normalizeSessionSetSide(second.side)) ||
		first.id.localeCompare(second.id)
	);
}

function getSessionSetLabel(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	const side = normalizeSessionSetSide(sessionSet.side);

	if (side === 'bilateral') {
		return `Set ${String(sessionSet.order).padStart(2, '0')}`;
	}

	return `${side === 'right' ? 'R' : 'L'}${sessionSet.order}`;
}

function getSessionSetKey(sessionSet: Pick<SessionSet, 'order' | 'side'>) {
	return `${sessionSet.order}:${normalizeSessionSetSide(sessionSet.side)}`;
}

function withSessionSetDefaults(sessionSet: SessionSet): SessionSet {
	return {
		...sessionSet,
		side: normalizeSessionSetSide(sessionSet.side),
		weightInput: toStoredInputValue(sessionSet.weightInput, toOptionalNumber(sessionSet.weight)),
		repsInput: toStoredInputValue(sessionSet.repsInput, toOptionalNumber(sessionSet.reps)),
		rirInput: toStoredInputValue(sessionSet.rirInput, toOptionalNumber(sessionSet.rir)),
		weight: toOptionalNumber(sessionSet.weight),
		reps: toOptionalNumber(sessionSet.reps),
		rir: toOptionalNumber(sessionSet.rir)
	};
}

async function listSessionExerciseDetails(sessionId: string): Promise<SessionExerciseDetail[]> {
	const sessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.sortBy('order');
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises.map((sessionExercise) => ({
		...sessionExercise,
		sets: (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(compareSessionSetRows)
	}));
}

function formatSignedDelta(diff: number) {
	return `${diff > 0 ? '+' : ''}${Number(diff.toFixed(2))}`;
}

function createFieldDelta(current?: number, previous?: number): SessionFieldDelta {
	if (
		typeof current !== 'number' ||
		!Number.isFinite(current) ||
		typeof previous !== 'number' ||
		!Number.isFinite(previous)
	) {
		return {
			state: 'empty',
			label: ''
		};
	}

	const diff = Number((current - previous).toFixed(2));

	if (diff > 0) {
		return {
			state: 'improved',
			label: formatSignedDelta(diff)
		};
	}

	if (diff < 0) {
		return {
			state: 'regressed',
			label: formatSignedDelta(diff)
		};
	}

	return {
		state: 'matched',
		label: ''
	};
}

function toSessionSetReference(
	entry: ExerciseHistoryEntry,
	sessionSet: SessionSet
): SessionSetReference {
	return {
		sessionId: entry.sessionId,
		startedAt: entry.startedAt,
		completedAt: entry.completedAt,
		order: sessionSet.order,
		side: sessionSet.side,
		weight: sessionSet.weight,
		reps: sessionSet.reps,
		rir: sessionSet.rir
	};
}

function buildPreviousReferenceBySetKey(
	currentExercise: SessionExerciseDetail,
	previousPerformance: ExerciseHistoryEntry | null
) {
	const referenceBySetKey = new Map<string, SessionSetReference>();

	if (!previousPerformance) {
		return referenceBySetKey;
	}

	for (const currentSet of currentExercise.sets) {
		const setKey = getSessionSetKey(currentSet);

		if (referenceBySetKey.has(setKey)) {
			continue;
		}

		const previousSet = previousPerformance.sets.find(
			(candidate) => getSessionSetKey(candidate) === setKey && hasAnySetValue(candidate)
		);

		if (previousSet) {
			referenceBySetKey.set(setKey, toSessionSetReference(previousPerformance, previousSet));
		}
	}

	return referenceBySetKey;
}

function getSessionSetOrderCount(sessionSets: Array<Pick<SessionSet, 'order'>>) {
	return sessionSets.reduce((highestOrder, sessionSet) => {
		return Math.max(highestOrder, sessionSet.order);
	}, 0);
}

function findLatestHistoryEntryWithPerformedSets(history: ExerciseHistoryEntry[]) {
	return (
		history.find(
			(entry) => getSessionSetOrderCount(entry.sets) > 0 && hasPerformedSetValues(entry.sets)
		) ?? null
	);
}

function summarizeExerciseProgress(
	currentExercise: SessionExerciseDetail,
	previousReferenceBySetKey: Map<string, SessionSetReference>
) {
	if (previousReferenceBySetKey.size === 0) {
		return {
			progressStatus: 'new' as const,
			progressSummary: 'First logged performance for this exercise.'
		};
	}

	let improvedFieldCount = 0;
	let regressedFieldCount = 0;

	for (const currentSet of currentExercise.sets) {
		const previousReference = previousReferenceBySetKey.get(getSessionSetKey(currentSet));

		if (!previousReference) {
			continue;
		}

		for (const fieldDelta of [
			createFieldDelta(currentSet.weight, previousReference.weight),
			createFieldDelta(currentSet.reps, previousReference.reps),
			createFieldDelta(currentSet.rir, previousReference.rir)
		]) {
			if (fieldDelta.state === 'improved') {
				improvedFieldCount += 1;
				continue;
			}

			if (fieldDelta.state === 'regressed') {
				regressedFieldCount += 1;
			}
		}
	}

	const summaryParts: string[] = [];

	if (improvedFieldCount > 0) {
		summaryParts.push(`${improvedFieldCount} higher field${improvedFieldCount === 1 ? '' : 's'}`);
	}

	if (regressedFieldCount > 0) {
		summaryParts.push(`${regressedFieldCount} lower field${regressedFieldCount === 1 ? '' : 's'}`);
	}

	if (summaryParts.length === 0) {
		return {
			progressStatus: 'matched' as const,
			progressSummary: 'Matched the last workout.'
		};
	}

	if (improvedFieldCount > 0 && regressedFieldCount === 0) {
		return {
			progressStatus: 'improved' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	if (regressedFieldCount > 0 && improvedFieldCount === 0) {
		return {
			progressStatus: 'regressed' as const,
			progressSummary: summaryParts.join(', ')
		};
	}

	return {
		progressStatus: 'mixed' as const,
		progressSummary: summaryParts.join(', ')
	};
}

async function getLatestExerciseHistoryEntries(
	exerciseIds: string[],
	currentSessionId: string,
	beforeSessionAt: number
) {
	const uniqueExerciseIds = [...new Set(exerciseIds)];
	const previousEntries = await Promise.all(
		uniqueExerciseIds.map(async (exerciseId) => {
			const history = (await listExerciseHistory(exerciseId)).filter(
				(entry) =>
					entry.sessionId !== currentSessionId &&
					getExerciseHistorySortTime(entry) < beforeSessionAt
			);
			const previousEntry = findLatestHistoryEntryWithPerformedSets(history) ?? history[0] ?? null;

			return [exerciseId, previousEntry] as const;
		})
	);

	return new Map(
		previousEntries.filter(
			(entry): entry is readonly [string, ExerciseHistoryEntry] => entry[1] !== null
		)
	);
}

function createExerciseRow(
	name: string,
	unilateral = false,
	source: ExerciseSource = 'custom',
	now = timestamp(),
	id = createId()
): Exercise {
	const cleanName = displayName(name);

	return {
		id,
		name: cleanName,
		unilateral,
		source,
		normalizedName: normalizeName(cleanName),
		archived: false,
		createdAt: now,
		updatedAt: now
	};
}

function createBaselineExerciseId(normalizedName: string) {
	return createSharedBaselineExerciseId(normalizedName);
}

type SessionActivityTimestamp = { value: string; time: number };

function toSessionActivityTimestamp(value?: string): SessionActivityTimestamp | null {
	const time = value ? new Date(value).getTime() : NaN;
	return value && Number.isFinite(time) ? { value, time } : null;
}

function getLastSessionSetActivityAt(
	sessionSets: SessionSet[],
	notAfterMs = Number.POSITIVE_INFINITY,
	notBeforeMs = Number.NEGATIVE_INFINITY
) {
	let latestActivity: SessionActivityTimestamp | null = null;

	for (const sessionSet of sessionSets) {
		const createdAtMs = new Date(sessionSet.createdAt).getTime();
		const updatedAtMs = new Date(sessionSet.updatedAt).getTime();

		if (
			!Number.isFinite(createdAtMs) ||
			!Number.isFinite(updatedAtMs) ||
			updatedAtMs <= createdAtMs ||
			updatedAtMs > notAfterMs ||
			updatedAtMs < notBeforeMs ||
			(latestActivity && updatedAtMs <= latestActivity.time)
		) {
			continue;
		}

		latestActivity = {
			value: sessionSet.updatedAt,
			time: updatedAtMs
		};
	}

	return latestActivity;
}

function getSessionActivityAt(session: WorkoutSession, sessionSets: SessionSet[]) {
	const completedAtMs = session.completedAt ? new Date(session.completedAt).getTime() : NaN;
	const startedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const notAfterMs = Number.isFinite(completedAtMs) ? completedAtMs : Number.POSITIVE_INFINITY;
	const notBeforeMs = Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY;
	const candidates = [
		toSessionActivityTimestamp(session.startedAt),
		getLastSessionSetActivityAt(sessionSets, notAfterMs, notBeforeMs),
		session.status === 'in_progress' ? toSessionActivityTimestamp(session.updatedAt) : null
	].filter((candidate): candidate is SessionActivityTimestamp => candidate !== null);

	return candidates.sort((first, second) => second.time - first.time)[0] ?? null;
}

function summarizeSession(
	session: WorkoutSession,
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
): SessionSummary {
	const totalReps = sessionSets.reduce((total, sessionSet) => {
		return typeof sessionSet.reps === 'number' && Number.isFinite(sessionSet.reps)
			? total + sessionSet.reps
			: total;
	}, 0);
	const totalVolume = sessionSets.reduce((total, sessionSet) => {
		if (
			typeof sessionSet.weight !== 'number' ||
			!Number.isFinite(sessionSet.weight) ||
			typeof sessionSet.reps !== 'number' ||
			!Number.isFinite(sessionSet.reps)
		) {
			return total;
		}

		return total + sessionSet.weight * sessionSet.reps;
	}, 0);
	const completedAtMs = session.completedAt ? new Date(session.completedAt).getTime() : NaN;
	const startedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const setActivityCutoffMs = Number.isFinite(completedAtMs)
		? completedAtMs
		: Number.POSITIVE_INFINITY;
	const setActivityStartMs = Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY;

	return {
		...session,
		dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
		lastActivityAt: getSessionActivityAt(session, sessionSets)?.value,
		lastSetActivityAt: getLastSessionSetActivityAt(
			sessionSets,
			setActivityCutoffMs,
			setActivityStartMs
		)?.value,
		totalExercises: sessionExercises.length,
		totalSets: sessionSets.length,
		totalReps,
		totalVolume
	};
}

async function getSessionSummariesByIds(sessionIds: string[]) {
	if (sessionIds.length === 0) {
		return new Map<string, SessionSummary>();
	}

	const sessions = (await db.workoutSessions.bulkGet(sessionIds)).filter(isDefined);
	const sessionExercises = await db.sessionExercises.where('sessionId').anyOf(sessionIds).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const sessionExercisesBySessionId = new Map<string, SessionExercise[]>();
	const sessionSetsBySessionId = new Map<string, SessionSet[]>();
	const sessionExerciseById = new Map(
		sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
	);

	for (const sessionExercise of sessionExercises) {
		const rows = sessionExercisesBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionExercise);
		sessionExercisesBySessionId.set(sessionExercise.sessionId, rows);
	}

	for (const sessionSet of sessionSets) {
		const sessionExercise = sessionExerciseById.get(sessionSet.sessionExerciseId);

		if (!sessionExercise) {
			continue;
		}

		const rows = sessionSetsBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionSet);
		sessionSetsBySessionId.set(sessionExercise.sessionId, rows);
	}

	return new Map(
		sessions.map((session) => [
			session.id,
			summarizeSession(
				session,
				sessionExercisesBySessionId.get(session.id) ?? [],
				sessionSetsBySessionId.get(session.id) ?? []
			)
		])
	);
}

export async function ensureBaselineExercises() {
	requireLoggedInUser();

	if (activeBackend === 'supabase-rxdb') {
		return;
	}

	const normalizedNames = [...BASELINE_EXERCISE_BY_NORMALIZED_NAME.keys()];
	const existingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(normalizedNames)
		.toArray();
	const existingNames = new Set(existingExercises.map((exercise) => exercise.normalizedName));
	const now = timestamp();
	const missingExercisesByName = new Map<string, Exercise>();

	for (const exercise of BASELINE_EXERCISE_ROWS) {
		const normalizedName = exercise.normalizedName;

		if (existingNames.has(normalizedName) || missingExercisesByName.has(normalizedName)) {
			continue;
		}

		missingExercisesByName.set(
			normalizedName,
			createExerciseRow(
				exercise.name,
				exercise.unilateral,
				'baseline',
				now,
				createBaselineExerciseId(normalizedName)
			)
		);
	}

	const missingExercises = [...missingExercisesByName.values()];

	if (missingExercises.length > 0) {
		await db.exercises.bulkAdd(missingExercises);
	}
}

export async function listExercises() {
	const exercises = dedupeExercises([...BASELINE_EXERCISE_ROWS, ...(await db.exercises.toArray())]);

	return exercises
		.filter((exercise) => !exercise.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

async function getPerformedSessionExerciseIdSet(sessionExercises: SessionExercise[]) {
	if (sessionExercises.length === 0) {
		return new Set<string>();
	}

	const sessionSets = await db.sessionSets
		.where('sessionExerciseId')
		.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
		.toArray();
	const hasPerformedValuesBySessionExerciseId = new Set<string>();

	for (const sessionSet of sessionSets.map(withSessionSetDefaults)) {
		if (hasAnySetValue(sessionSet)) {
			hasPerformedValuesBySessionExerciseId.add(sessionSet.sessionExerciseId);
		}
	}

	return hasPerformedValuesBySessionExerciseId;
}

export async function listExerciseUsagePreferences(): Promise<ExerciseUsagePreference[]> {
	const sessionExercises = await db.sessionExercises.toArray();

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByNormalizedName = new Map<
		string,
		{
			exerciseIds: Set<string>;
			lastPerformedAt: string;
			sessionIds: Set<string>;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const normalizedName = normalizeName(sessionExercise.exerciseNameSnapshot);

		if (!normalizedName) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const currentUsage = usageByNormalizedName.get(normalizedName) ?? {
			exerciseIds: new Set<string>(),
			lastPerformedAt: performedAt,
			sessionIds: new Set<string>()
		};

		currentUsage.exerciseIds.add(sessionExercise.exerciseId);
		currentUsage.sessionIds.add(sessionExercise.sessionId);

		if (currentUsage.lastPerformedAt < performedAt) {
			currentUsage.lastPerformedAt = performedAt;
		}

		usageByNormalizedName.set(normalizedName, currentUsage);
	}

	return [...usageByNormalizedName.entries()]
		.map(([normalizedName, usage]) => ({
			normalizedName,
			exerciseIds: [...usage.exerciseIds],
			lastPerformedAt: usage.lastPerformedAt,
			sessionCount: usage.sessionIds.size
		}))
		.sort(
			(first, second) =>
				second.lastPerformedAt.localeCompare(first.lastPerformedAt) ||
				second.sessionCount - first.sessionCount ||
				first.normalizedName.localeCompare(second.normalizedName)
		);
}

export async function listCustomExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived && exercise.source === 'custom')
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExerciseItems(): Promise<ExerciseListItem[]> {
	const exercises = await listCustomExercises();
	const exerciseIds = exercises.map((exercise) => exercise.id);

	if (exerciseIds.length === 0) {
		return [];
	}

	const [sessionExercises, resetEvents] = await Promise.all([
		db.sessionExercises.where('exerciseId').anyOf(exerciseIds).toArray(),
		db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);

	const historyByExerciseId = new Map<string, Set<string>>();
	const lastPerformedAtByExerciseId = new Map<string, string>();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const historySessions =
			historyByExerciseId.get(sessionExercise.exerciseId) ?? new Set<string>();
		historySessions.add(sessionExercise.sessionId);
		historyByExerciseId.set(sessionExercise.exerciseId, historySessions);

		const currentValue = lastPerformedAtByExerciseId.get(sessionExercise.exerciseId);
		const performedAt = session.startedAt ?? sessionExercise.performedAt;

		if (!currentValue || currentValue < performedAt) {
			lastPerformedAtByExerciseId.set(sessionExercise.exerciseId, performedAt);
		}
	}

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return exercises.map((exercise) => ({
		exercise,
		historyCount: historyByExerciseId.get(exercise.id)?.size ?? 0,
		lastPerformedAt: lastPerformedAtByExerciseId.get(exercise.id),
		latestResetAt: latestResetAtByExerciseId.get(exercise.id)
	}));
}

export async function listExerciseItems(): Promise<ExerciseListItem[]> {
	const [customExercises, sessionExercises] = await Promise.all([
		listCustomExercises(),
		db.sessionExercises.toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByNormalizedName = new Map<
		string,
		{
			historySessionIds: Set<string>;
			lastPerformedAt?: string;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const normalizedName = normalizeName(sessionExercise.exerciseNameSnapshot);

		if (!normalizedName) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const usage = usageByNormalizedName.get(normalizedName) ?? {
			historySessionIds: new Set<string>(),
			lastPerformedAt: undefined
		};

		usage.historySessionIds.add(sessionExercise.sessionId);

		if (!usage.lastPerformedAt || usage.lastPerformedAt < performedAt) {
			usage.lastPerformedAt = performedAt;
		}

		usageByNormalizedName.set(normalizedName, usage);
	}

	const customByNormalizedName = new Map(
		customExercises.map((exercise) => [exercise.normalizedName, exercise])
	);
	const performedNormalizedNames = [...usageByNormalizedName.keys()];
	const preferredExercises = await getPreferredExerciseByNormalizedNames(performedNormalizedNames);
	const itemsByNormalizedName = new Map<string, ExerciseListItem>();

	for (const [normalizedName, usage] of usageByNormalizedName.entries()) {
		const exercise = [
			preferredExercises.get(normalizedName),
			BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(normalizedName),
			customByNormalizedName.get(normalizedName)
		]
			.filter(isDefined)
			.find((candidate) => !candidate.archived);

		if (!exercise) {
			continue;
		}

		itemsByNormalizedName.set(normalizedName, {
			exercise,
			historyCount: usage.historySessionIds.size,
			lastPerformedAt: usage.lastPerformedAt
		});
	}

	for (const exercise of customExercises) {
		if (itemsByNormalizedName.has(exercise.normalizedName)) {
			continue;
		}

		itemsByNormalizedName.set(exercise.normalizedName, {
			exercise,
			historyCount: 0
		});
	}

	const exerciseIds = [...itemsByNormalizedName.values()].map((item) => item.exercise.id);
	const resetEvents =
		exerciseIds.length === 0
			? []
			: await db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return [...itemsByNormalizedName.values()]
		.map((item) => ({
			...item,
			latestResetAt: latestResetAtByExerciseId.get(item.exercise.id)
		}))
		.sort(
			(first, second) =>
				compareOptionalRecency(first.lastPerformedAt, second.lastPerformedAt) ||
				second.historyCount - first.historyCount ||
				first.exercise.name.localeCompare(second.exercise.name)
		);
}

export async function listExerciseMergeOptions(): Promise<ExerciseMergeOption[]> {
	const [exercises, sessionExercises] = await Promise.all([
		listExercises(),
		db.sessionExercises.toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByExerciseId = new Map<
		string,
		{
			historySessionIds: Set<string>;
			lastPerformedAt?: string;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const usage = usageByExerciseId.get(sessionExercise.exerciseId) ?? {
			historySessionIds: new Set<string>(),
			lastPerformedAt: undefined
		};

		usage.historySessionIds.add(sessionExercise.sessionId);

		if (!usage.lastPerformedAt || usage.lastPerformedAt < performedAt) {
			usage.lastPerformedAt = performedAt;
		}

		usageByExerciseId.set(sessionExercise.exerciseId, usage);
	}

	return exercises
		.map((exercise) => {
			const usage = usageByExerciseId.get(exercise.id);

			return {
				exercise,
				historyCount: usage?.historySessionIds.size ?? 0,
				lastPerformedAt: usage?.lastPerformedAt,
				canRename: !BASELINE_EXERCISE_BY_ID.has(exercise.id) && exercise.source === 'custom'
			};
		})
		.sort(
			(first, second) =>
				compareOptionalRecency(first.lastPerformedAt, second.lastPerformedAt) ||
				second.historyCount - first.historyCount ||
				first.exercise.name.localeCompare(second.exercise.name)
		);
}

export async function getExercise(exerciseId: string) {
	const baselineExercise = BASELINE_EXERCISE_BY_ID.get(exerciseId);

	if (baselineExercise) {
		return baselineExercise;
	}

	const exercise = await db.exercises.get(exerciseId);

	return exercise ? withExerciseDefaults(exercise) : null;
}

function getMergedSessionExerciseId(mainExerciseId: string, secondarySessionExerciseId: string) {
	return `merge:${mainExerciseId}:${secondarySessionExerciseId}`;
}

function getMergedSessionSetId(mainSessionExerciseId: string, secondarySessionSetId: string) {
	return `${mainSessionExerciseId}:set:${secondarySessionSetId}`;
}

async function renameCustomExercise(
	exercise: Exercise,
	nextName: string,
	now = timestamp()
): Promise<{ exercise: Exercise; renamed: boolean }> {
	const cleanName = displayName(nextName);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	if (BASELINE_EXERCISE_BY_ID.has(exercise.id) || exercise.source !== 'custom') {
		return { exercise, renamed: false };
	}

	if (normalizedName === exercise.normalizedName && cleanName === exercise.name) {
		return { exercise, renamed: false };
	}

	const matchingExercises = (
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	)
		.map(withExerciseDefaults)
		.filter((candidate) => candidate.id !== exercise.id && !candidate.archived);

	if (
		matchingExercises.length > 0 ||
		(BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(normalizedName) &&
			BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(normalizedName)?.id !== exercise.id)
	) {
		throw new Error('That exercise name is already in use.');
	}

	const nextExercise = {
		...exercise,
		name: cleanName,
		normalizedName,
		updatedAt: now
	};

	await db.exercises.update(exercise.id, {
		name: cleanName,
		normalizedName,
		updatedAt: now
	});

	return { exercise: nextExercise, renamed: true };
}

export async function mergeExerciseHistory(
	input: ExerciseMergeInput
): Promise<ExerciseMergeResult> {
	requireLoggedInUser();

	if (input.mainExerciseId === input.secondaryExerciseId) {
		throw new Error('Choose two different exercises to merge.');
	}

	const [mainExercise, secondaryExercise] = await Promise.all([
		getExercise(input.mainExerciseId),
		getExercise(input.secondaryExerciseId)
	]);

	if (!mainExercise) {
		throw new Error('Main exercise not found.');
	}

	if (!secondaryExercise) {
		throw new Error('Secondary exercise not found.');
	}

	const now = timestamp();
	const secondarySessionExercises = await db.sessionExercises
		.where('exerciseId')
		.equals(secondaryExercise.id)
		.toArray();
	const secondarySessionExerciseIds = secondarySessionExercises.map(
		(sessionExercise) => sessionExercise.id
	);
	const [existingMainSessionExercises, existingCopiedSessionExercises, secondarySessionSets] =
		await Promise.all([
			db.sessionExercises.where('exerciseId').equals(mainExercise.id).toArray(),
			secondarySessionExerciseIds.length === 0
				? Promise.resolve([])
				: db.sessionExercises
						.bulkGet(
							secondarySessionExerciseIds.map((sessionExerciseId) =>
								getMergedSessionExerciseId(mainExercise.id, sessionExerciseId)
							)
						)
						.then((rows) => rows.filter(isDefined)),
			secondarySessionExerciseIds.length === 0
				? Promise.resolve([])
				: db.sessionSets.where('sessionExerciseId').anyOf(secondarySessionExerciseIds).toArray()
		]);
	const mainSessionIds = new Set(
		existingMainSessionExercises.map((sessionExercise) => sessionExercise.sessionId)
	);
	const existingCopiedIds = new Set(
		existingCopiedSessionExercises.map((sessionExercise) => sessionExercise.id)
	);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of secondarySessionSets.map(withSessionSetDefaults)) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	const sessionExercisesToAdd: SessionExercise[] = [];
	const sessionSetsToAdd: SessionSet[] = [];
	let skippedConflicts = 0;

	for (const secondarySessionExercise of secondarySessionExercises) {
		const copiedSessionExerciseId = getMergedSessionExerciseId(
			mainExercise.id,
			secondarySessionExercise.id
		);
		const sourceSets = setsBySessionExerciseId.get(secondarySessionExercise.id) ?? [];

		if (!hasPerformedSetValues(sourceSets)) {
			continue;
		}

		if (
			mainSessionIds.has(secondarySessionExercise.sessionId) ||
			existingCopiedIds.has(copiedSessionExerciseId)
		) {
			skippedConflicts += 1;
			continue;
		}

		const copiedSessionExercise: SessionExercise = {
			...secondarySessionExercise,
			id: copiedSessionExerciseId,
			exerciseId: mainExercise.id,
			exerciseNameSnapshot: mainExercise.name,
			createdAt: now,
			updatedAt: now
		};
		const copiedSessionSets = sourceSets.map((sessionSet) => ({
			...sessionSet,
			id: getMergedSessionSetId(copiedSessionExerciseId, sessionSet.id),
			sessionExerciseId: copiedSessionExerciseId,
			exerciseId: mainExercise.id,
			createdAt: now,
			updatedAt: now
		}));

		sessionExercisesToAdd.push(copiedSessionExercise);
		sessionSetsToAdd.push(...copiedSessionSets);
		mainSessionIds.add(secondarySessionExercise.sessionId);
	}

	let renamedMainExercise = mainExercise;
	let renamed = false;

	await db.transaction(
		'rw',
		db.exercises,
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		async () => {
			if (input.mainExerciseName !== undefined) {
				const renameResult = await renameCustomExercise(mainExercise, input.mainExerciseName, now);
				renamedMainExercise = renameResult.exercise;
				renamed = renameResult.renamed;
			}

			for (const sessionExercise of sessionExercisesToAdd) {
				sessionExercise.exerciseNameSnapshot = renamedMainExercise.name;
			}

			if (sessionExercisesToAdd.length > 0) {
				await db.sessionExercises.bulkAdd(sessionExercisesToAdd);
			}

			if (sessionSetsToAdd.length > 0) {
				await db.sessionSets.bulkAdd(sessionSetsToAdd);
			}

			const touchedSessionIds = [...new Set(sessionExercisesToAdd.map((row) => row.sessionId))];

			await Promise.all(
				touchedSessionIds.map((sessionId) =>
					db.workoutSessions.update(sessionId, { updatedAt: now })
				)
			);
		}
	);

	try {
		await syncNow();
		return {
			mainExercise: renamedMainExercise,
			secondaryExercise,
			copiedSessionExercises: sessionExercisesToAdd.length,
			copiedSessionSets: sessionSetsToAdd.length,
			skippedConflicts,
			renamed,
			syncStatus: 'synced'
		};
	} catch (error) {
		return {
			mainExercise: renamedMainExercise,
			secondaryExercise,
			copiedSessionExercises: sessionExercisesToAdd.length,
			copiedSessionSets: sessionSetsToAdd.length,
			skippedConflicts,
			renamed,
			syncStatus: 'failed',
			syncError: error instanceof Error ? error.message : 'Sync failed.'
		};
	}
}

export async function createExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const existingExercise = pickPreferredExercise(
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	);

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, inferExerciseSource(normalizedName));
	await db.exercises.add(exercise);

	return exercise;
}

export async function createCustomExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const matchingExercises = (
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	).map(withExerciseDefaults);
	const existingExercise = pickPreferredExercise(matchingExercises);

	if (matchingExercises.some((exercise) => exercise.source === 'baseline')) {
		throw new Error('That name already belongs to a built-in exercise.');
	}

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, 'custom');
	await db.exercises.add(exercise);

	return exercise;
}

export async function setExerciseUnilateral(exerciseId: string, unilateral: boolean) {
	requireLoggedInUser();

	if (BASELINE_EXERCISE_BY_ID.has(exerciseId)) {
		throw new Error('Built-in exercises are shared and cannot be edited.');
	}

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const updatedAt = timestamp();
	await db.exercises.update(exerciseId, { unilateral, updatedAt });

	return withExerciseDefaults({ ...exercise, unilateral, updatedAt });
}

export async function recordExerciseReset(exerciseId: string) {
	requireLoggedInUser();

	const exercise = await getExercise(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const resetEvent: ExerciseResetEvent = {
		id: createId(),
		exerciseId,
		resetAt: now,
		createdAt: now
	};

	await db.exerciseResetEvents.add(resetEvent);

	return resetEvent;
}

export async function listExerciseResetEvents(exerciseId: string) {
	const resetEvents = await db.exerciseResetEvents.where('exerciseId').equals(exerciseId).toArray();

	return resetEvents.sort((first, second) => second.resetAt.localeCompare(first.resetAt));
}

export async function listExerciseHistory(exerciseId: string): Promise<ExerciseHistoryEntry[]> {
	return (await listHistoricalSessionExerciseMatches(exerciseId)).map(
		({ session, sessionExercise, sets }) => ({
			sessionId: session.id,
			workoutId: session.workoutId,
			workoutNameSnapshot: session.workoutNameSnapshot,
			dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
			performedAt: sessionExercise.performedAt,
			startedAt: session.startedAt,
			completedAt: session.completedAt,
			status: session.status,
			sets
		})
	);
}

export async function getExerciseDetail(exerciseId: string): Promise<ExerciseDetail | null> {
	const [exercise, history, resetEvents] = await Promise.all([
		getExercise(exerciseId),
		listExerciseHistory(exerciseId),
		listExerciseResetEvents(exerciseId)
	]);

	if (!exercise) {
		return null;
	}

	return {
		exercise,
		history,
		resetEvents
	};
}

export async function listWorkouts() {
	const workouts = await db.workouts.toArray();

	return workouts
		.filter((workout) => !workout.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listWorkoutSchedulingOptions() {
	const [workouts, sessions] = await Promise.all([listWorkouts(), db.workoutSessions.toArray()]);
	const latestSessionAtByWorkoutId = new Map<string, string>();

	for (const session of sessions) {
		if (session.status === 'planned') {
			continue;
		}

		const sessionAt = getWorkoutSessionRecencyTimestamp(session);
		const currentValue = latestSessionAtByWorkoutId.get(session.workoutId);

		if (!currentValue || currentValue < sessionAt) {
			latestSessionAtByWorkoutId.set(session.workoutId, sessionAt);
		}
	}

	return workouts.sort(
		(first, second) =>
			compareOptionalRecency(
				latestSessionAtByWorkoutId.get(first.id),
				latestSessionAtByWorkoutId.get(second.id)
			) || first.name.localeCompare(second.name)
	);
}

export async function createWorkout(name: string) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Workout name is required.');
	}

	const existingWorkout = await db.workouts.where('normalizedName').equals(normalizedName).first();

	if (existingWorkout) {
		if (existingWorkout.archived) {
			const updatedAt = timestamp();
			await db.workouts.update(existingWorkout.id, { archived: false, updatedAt });

			return { ...existingWorkout, archived: false, updatedAt };
		}

		return existingWorkout;
	}

	const now = timestamp();
	const workout: Workout = {
		id: createId(),
		name: cleanName,
		normalizedName,
		archived: false,
		createdAt: now,
		updatedAt: now
	};

	await db.workouts.add(workout);

	return workout;
}

export async function listWorkoutExercises(workoutId: string) {
	const workoutExerciseRows = await db.workoutExercises
		.where('workoutId')
		.equals(workoutId)
		.sortBy('order');
	const exercises = await db.exercises.bulkGet(
		workoutExerciseRows.map((workoutExercise) => workoutExercise.exerciseId)
	);
	const exerciseById = new Map(
		exercises
			.filter(isDefined)
			.map((exercise) => withExerciseDefaults(exercise))
			.map((exercise) => [exercise.id, exercise])
	);

	return workoutExerciseRows
		.map<WorkoutExerciseWithExercise | null>((workoutExercise) => {
			const exercise = exerciseById.get(workoutExercise.exerciseId);

			if (!exercise || exercise.archived) {
				return null;
			}

			return { ...workoutExercise, exercise };
		})
		.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
			Boolean(workoutExercise)
		);
}

export async function addExerciseToWorkout(workoutId: string, exerciseId: string) {
	requireLoggedInUser();

	return db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const existingWorkoutExercise = await db.workoutExercises
			.where('[workoutId+exerciseId]')
			.equals([workoutId, exerciseId])
			.first();

		if (existingWorkoutExercise) {
			return existingWorkoutExercise;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const nextOrder =
			workoutExercises.reduce(
				(highestOrder, workoutExercise) => Math.max(highestOrder, workoutExercise.order),
				0
			) + 1;
		const now = timestamp();
		const workoutExercise: WorkoutExercise = {
			id: createId(),
			workoutId,
			exerciseId,
			order: nextOrder,
			createdAt: now,
			updatedAt: now
		};

		await db.workoutExercises.add(workoutExercise);
		await db.workouts.update(workoutId, { updatedAt: now });

		return workoutExercise;
	});
}

async function syncWorkoutExercisesFromSession(sessionId: string, now = timestamp()) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return;
	}

	const [sessionExercises, workoutExercises] = await Promise.all([
		db.sessionExercises.where('sessionId').equals(sessionId).sortBy('order'),
		db.workoutExercises.where('workoutId').equals(session.workoutId).toArray()
	]);
	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
	);
	const sessionExerciseIdSet = new Set(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
	);
	const workoutExerciseIdsToDelete = workoutExercises
		.filter((workoutExercise) => !sessionExerciseIdSet.has(workoutExercise.exerciseId))
		.map((workoutExercise) => workoutExercise.id);
	const nextWorkoutExercises = sessionExercises.map((sessionExercise, index) => {
		const existingWorkoutExercise = workoutExerciseByExerciseId.get(sessionExercise.exerciseId);

		return {
			id: existingWorkoutExercise?.id ?? createId(),
			workoutId: session.workoutId,
			exerciseId: sessionExercise.exerciseId,
			order: index + 1,
			createdAt: existingWorkoutExercise?.createdAt ?? now,
			updatedAt: now
		} satisfies WorkoutExercise;
	});

	if (workoutExerciseIdsToDelete.length > 0) {
		await db.workoutExercises.bulkDelete(workoutExerciseIdsToDelete);
	}

	if (nextWorkoutExercises.length > 0) {
		await db.workoutExercises.bulkPut(nextWorkoutExercises);
	}

	await db.workouts.update(session.workoutId, { updatedAt: now });
}

export async function reorderWorkoutExercises(
	workoutId: string,
	orderedWorkoutExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const workoutExerciseById = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
		);
		const orderedIds = orderedWorkoutExerciseIds.filter((id) => workoutExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = workoutExercises
			.filter((workoutExercise) => !orderedIdSet.has(workoutExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((workoutExercise) => workoutExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.workoutExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutId, { updatedAt: now });
	});
}

export async function moveWorkoutExercise(workoutExerciseId: string, direction: 'up' | 'down') {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');
		const currentIndex = workoutExercises.findIndex((row) => row.id === workoutExerciseId);
		const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= workoutExercises.length) {
			return;
		}

		const currentRow = workoutExercises[currentIndex];
		const targetRow = workoutExercises[targetIndex];
		const now = timestamp();

		await Promise.all([
			db.workoutExercises.update(currentRow.id, { order: targetRow.order, updatedAt: now }),
			db.workoutExercises.update(targetRow.id, { order: currentRow.order, updatedAt: now }),
			db.workouts.update(workoutExercise.workoutId, { updatedAt: now })
		]);
	});
}

export async function removeWorkoutExercise(workoutExerciseId: string) {
	requireLoggedInUser();

	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const now = timestamp();

		await db.workoutExercises.delete(workoutExerciseId);

		const remainingWorkoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');

		await Promise.all(
			remainingWorkoutExercises.map((remainingWorkoutExercise, index) =>
				db.workoutExercises.update(remainingWorkoutExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutExercise.workoutId, { updatedAt: now });
	});
}

async function getSeedSetOrderCount(exercise: Exercise, excludeSessionId?: string) {
	const latestHistoricalMatch = (await listHistoricalSessionExerciseMatches(exercise.id)).find(
		({ session, sets }) => session.id !== excludeSessionId && sets.length > 0
	);

	if (!latestHistoricalMatch) {
		return 0;
	}

	return getSessionSetOrderCount(latestHistoricalMatch.sets);
}

function createSessionSetRow(
	sessionExerciseId: string,
	exerciseId: string,
	order: number,
	side: SessionSetSide,
	now = timestamp()
): SessionSet {
	return {
		id: createId(),
		sessionExerciseId,
		exerciseId,
		order,
		side,
		weightInput: '',
		repsInput: '',
		rirInput: '',
		createdAt: now,
		updatedAt: now
	};
}

function buildSeedSessionSetRows(
	sessionExerciseId: string,
	exerciseId: string,
	orderCount: number,
	unilateral: boolean,
	now = timestamp()
) {
	const sessionSets: SessionSet[] = [];

	for (let order = 1; order <= orderCount; order += 1) {
		if (unilateral) {
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'right', now));
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'left', now));
			continue;
		}

		sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'bilateral', now));
	}

	return sessionSets;
}

async function buildSessionSeedSetRows(
	sessionExerciseId: string,
	exercise: Exercise,
	now = timestamp(),
	excludeSessionId?: string
) {
	const orderCount = await getSeedSetOrderCount(exercise, excludeSessionId);

	return buildSeedSessionSetRows(
		sessionExerciseId,
		exercise.id,
		orderCount,
		exercise.unilateral,
		now
	);
}

async function ensureEditableSessionSeedRows(
	session: WorkoutSession,
	sessionExercises: SessionExerciseDetail[]
) {
	if (session.status === 'completed' || session.status === 'abandoned') {
		return sessionExercises;
	}

	const missingSeedRows = sessionExercises.filter(
		(sessionExercise) => sessionExercise.sets.length === 0
	);

	if (missingSeedRows.length === 0) {
		return sessionExercises;
	}

	const exerciseById = new Map(
		(
			await db.exercises.bulkGet(
				missingSeedRows.map((sessionExercise) => sessionExercise.exerciseId)
			)
		)
			.filter(isDefined)
			.map((exercise) => {
				const nextExercise = withExerciseDefaults(exercise);
				return [nextExercise.id, nextExercise] as const;
			})
	);
	const now = timestamp();
	const seedRowsBySessionExerciseId = new Map(
		await Promise.all(
			missingSeedRows.map(async (sessionExercise) => {
				const exercise = exerciseById.get(sessionExercise.exerciseId);

				if (!exercise) {
					return [sessionExercise.id, [] as SessionSet[]] as const;
				}

				return [
					sessionExercise.id,
					await buildSessionSeedSetRows(sessionExercise.id, exercise, now, session.id)
				] as const;
			})
		)
	);
	const seededSessionExerciseIds = [...seedRowsBySessionExerciseId.entries()]
		.filter(([, sessionSets]) => sessionSets.length > 0)
		.map(([sessionExerciseId]) => sessionExerciseId);

	if (seededSessionExerciseIds.length === 0) {
		return sessionExercises;
	}

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		await db.sessionSets.bulkAdd(
			seededSessionExerciseIds.flatMap(
				(sessionExerciseId) => seedRowsBySessionExerciseId.get(sessionExerciseId) ?? []
			)
		);
		await Promise.all(
			seededSessionExerciseIds.map((sessionExerciseId) =>
				db.sessionExercises.update(sessionExerciseId, { updatedAt: now })
			)
		);
		await db.workoutSessions.update(session.id, { updatedAt: now });
	});

	return listSessionExerciseDetails(session.id);
}

async function deleteWorkoutSessionRows(sessionId: string) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const sessionExercises = await db.sessionExercises.where('sessionId').equals(sessionId).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();

	if (sessionSets.length > 0) {
		await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
	}

	if (sessionExerciseIds.length > 0) {
		await db.sessionExercises.bulkDelete(sessionExerciseIds);
	}

	await db.workoutSessions.delete(sessionId);

	return session;
}

async function updateSessionSetInputValues(
	sessionSetId: string,
	rawValues: Partial<Record<SessionInputField, string>>,
	requestedActivityMs?: number,
	baseValues: Partial<Record<SessionInputField, string>> = {}
) {
	let nextSet: SessionSet | null = null;
	const skippedFields: SessionInputField[] = [];

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const sessionSet = await db.sessionSets.get(sessionSetId);

		if (!sessionSet) {
			throw new Error('Set not found.');
		}

		const normalizedSet = withSessionSetDefaults(sessionSet);
		const patch: Partial<SessionSet> = {};
		const nowMs = Date.now();
		const hasValidRequestedActivity =
			typeof requestedActivityMs === 'number' && Number.isFinite(requestedActivityMs);
		const requestedMs = hasValidRequestedActivity ? requestedActivityMs : nowMs;
		const boundedActivityMs = Math.min(requestedMs, nowMs);
		const currentUpdatedAtMs = new Date(sessionSet.updatedAt).getTime();
		const storedRowIsNewer =
			requestedActivityMs !== undefined &&
			(!hasValidRequestedActivity ||
				(Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > boundedActivityMs));

		for (const field of ['weight', 'reps', 'rir'] as const) {
			if (!Object.hasOwn(rawValues, field)) {
				continue;
			}

			const inputKey = `${field}Input` as const;
			const cleanInputValue = toCleanSessionInputValue(rawValues[field] ?? '', field);
			const parsedValue = toParsedInputValue(cleanInputValue, field);

			if (normalizedSet[inputKey] === cleanInputValue && normalizedSet[field] === parsedValue) {
				continue;
			}

			if (storedRowIsNewer) {
				const baseValue = baseValues[field];

				if (baseValue === undefined) {
					skippedFields.push(field);
					continue;
				}

				const cleanBaseValue = toCleanSessionInputValue(baseValue, field);
				const parsedBaseValue = toParsedInputValue(cleanBaseValue, field);

				if (
					normalizedSet[inputKey] !== cleanBaseValue ||
					normalizedSet[field] !== parsedBaseValue
				) {
					skippedFields.push(field);
					continue;
				}
			}

			Object.assign(patch, {
				[inputKey]: cleanInputValue,
				[field]: parsedValue
			});
		}

		if (Object.keys(patch).length === 0) {
			nextSet = normalizedSet;
			return;
		}

		const createdAtMs = new Date(sessionSet.createdAt).getTime();
		const activityMs = Number.isFinite(createdAtMs)
			? Math.max(boundedActivityMs, createdAtMs)
			: boundedActivityMs;
		const storedActivityMs =
			Number.isFinite(currentUpdatedAtMs) && currentUpdatedAtMs > activityMs
				? currentUpdatedAtMs
				: activityMs;
		const updatedAt = timestamp(new Date(storedActivityMs));
		patch.updatedAt = updatedAt;

		await db.sessionSets.update(sessionSetId, patch);

		const sessionExercise = await db.sessionExercises.get(sessionSet.sessionExerciseId);
		const session = sessionExercise
			? await db.workoutSessions.get(sessionExercise.sessionId)
			: undefined;

		if (session?.status === 'in_progress') {
			const sessionUpdatedAtMs = new Date(session.updatedAt).getTime();
			await db.workoutSessions.update(session.id, {
				updatedAt:
					Number.isFinite(sessionUpdatedAtMs) && sessionUpdatedAtMs > storedActivityMs
						? session.updatedAt
						: updatedAt
			});
		} else if (session?.status === 'abandoned' && requestedActivityMs === undefined) {
			// A live edit that was already queued when the timeout fired wins the race.
			await db.workoutSessions.update(session.id, {
				status: 'in_progress',
				completedAt: undefined,
				updatedAt
			});
		}

		nextSet = withSessionSetDefaults({ ...sessionSet, ...patch });
	});

	if (!nextSet) {
		throw new Error('Set not found.');
	}

	return { sessionSet: nextSet, skippedFields };
}

async function updateSessionSetInputs(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	return (await updateSessionSetInputValues(sessionSetId, { [field]: rawValue })).sessionSet;
}
function getSessionInputDraftKey(sessionId: string) {
	return `tinytrain:session-input-draft:${sessionId}`;
}

function readSessionInputDraft(sessionId: string) {
	if (!browser) {
		return null;
	}

	try {
		const rawDraft = localStorage.getItem(getSessionInputDraftKey(sessionId));
		const draft = rawDraft ? (JSON.parse(rawDraft) as SessionInputDraft) : null;

		if (!draft || draft.sessionId !== sessionId || !draft.sets) {
			return null;
		}

		return draft;
	} catch {
		return null;
	}
}

function isSessionInputDraftSet(value: unknown): value is SessionInputDraftSet {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clearSessionInputDraft(sessionId: string) {
	if (!browser) {
		return;
	}

	try {
		localStorage.removeItem(getSessionInputDraftKey(sessionId));
		window.dispatchEvent(
			new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
		);
	} catch {
		// Draft cleanup should not block the underlying workout mutation.
	}
}

function writeSessionInputDraft(sessionId: string, draft: SessionInputDraft) {
	if (!browser) {
		return;
	}

	try {
		localStorage.setItem(getSessionInputDraftKey(sessionId), JSON.stringify(draft));
		window.dispatchEvent(
			new CustomEvent(SESSION_INPUT_DRAFT_CHANGE_EVENT, { detail: { sessionId } })
		);
	} catch {
		// Draft cleanup should not block the underlying workout mutation.
	}
}

function removeSessionInputDraftSets(sessionId: string, sessionSetIds: string[]) {
	if (sessionSetIds.length === 0) {
		return;
	}

	const draft = readSessionInputDraft(sessionId);

	if (!draft?.sets) {
		return;
	}

	const sessionSetIdSet = new Set(sessionSetIds);
	const nextSets = Object.fromEntries(
		Object.entries(draft.sets).filter(([sessionSetId]) => !sessionSetIdSet.has(sessionSetId))
	);

	if (Object.keys(nextSets).length === Object.keys(draft.sets).length) {
		return;
	}

	if (Object.keys(nextSets).length === 0) {
		clearSessionInputDraft(sessionId);
		return;
	}

	writeSessionInputDraft(sessionId, {
		...draft,
		sets: nextSets
	});
}

export async function flushSessionInputDraft(
	sessionId: string,
	options: { clearDraft?: boolean } = {}
) {
	requireLoggedInUser();

	const draft = readSessionInputDraft(sessionId);

	if (!draft?.sets) {
		return;
	}

	const rawDraftEntries = Object.entries(draft.sets);
	const draftEntries = rawDraftEntries.filter((entry): entry is [string, SessionInputDraftSet] =>
		isSessionInputDraftSet(entry[1])
	);
	const staleSetIds = new Set(
		rawDraftEntries
			.filter(([, draftSet]) => !isSessionInputDraftSet(draftSet))
			.map(([sessionSetId]) => sessionSetId)
	);
	const unresolvedDraftSets: Record<string, SessionInputDraftSet> = {};
	let discardedMissingSetDraft = false;

	if (draftEntries.length === 0) {
		if (options.clearDraft !== false) {
			clearSessionInputDraft(sessionId);
		}
		return;
	}

	const existingSets = await db.sessionSets.bulkGet(
		draftEntries.map(([sessionSetId]) => sessionSetId)
	);
	const existingSetIds = new Set(
		existingSets.flatMap((sessionSet) => (sessionSet ? [sessionSet.id] : []))
	);

	for (const [sessionSetId] of draftEntries) {
		if (!existingSetIds.has(sessionSetId)) {
			staleSetIds.add(sessionSetId);
		}
	}

	for (const [sessionSetId, draftSet] of draftEntries) {
		if (staleSetIds.has(sessionSetId)) {
			discardedMissingSetDraft = true;
			continue;
		}

		const rawValues: Partial<Record<SessionInputField, string>> = {};
		const baseValues: Partial<Record<SessionInputField, string>> = {};

		for (const field of ['weight', 'reps', 'rir'] as const) {
			const fieldKey = `${field}Input` as const;
			const baseKey = `${fieldKey}Base` as const;

			if (Object.hasOwn(draftSet, fieldKey)) {
				rawValues[field] = draftSet[fieldKey] ?? '';

				if (Object.hasOwn(draftSet, baseKey)) {
					baseValues[field] = draftSet[baseKey] ?? '';
				}
			}
		}

		try {
			const { skippedFields } = await updateSessionSetInputValues(
				sessionSetId,
				rawValues,
				draftSet.updatedAt ?? draft.updatedAt,
				baseValues
			);

			if (skippedFields.length > 0) {
				const unresolvedDraftSet: SessionInputDraftSet = {
					updatedAt: draftSet.updatedAt ?? draft.updatedAt
				};

				for (const field of skippedFields) {
					const fieldKey = `${field}Input` as const;
					const baseKey = `${fieldKey}Base` as const;
					unresolvedDraftSet[fieldKey] = draftSet[fieldKey] ?? '';

					if (Object.hasOwn(draftSet, baseKey)) {
						unresolvedDraftSet[baseKey] = draftSet[baseKey] ?? '';
					}
				}

				unresolvedDraftSets[sessionSetId] = unresolvedDraftSet;
			}
		} catch (error) {
			if (error instanceof Error && error.message === 'Set not found.') {
				discardedMissingSetDraft = true;
				continue;
			}

			throw error;
		}
	}

	if (options.clearDraft !== false) {
		if (Object.keys(unresolvedDraftSets).length > 0) {
			writeSessionInputDraft(sessionId, {
				...draft,
				sets: unresolvedDraftSets
			});
			throw new Error(
				discardedMissingSetDraft
					? 'Some workout inputs changed on another device, and a removed set could not be restored. Your remaining unsaved values were kept; review and edit them again.'
					: 'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
			);
		}

		clearSessionInputDraft(sessionId);

		if (discardedMissingSetDraft) {
			throw new Error(
				'A set was removed on another device, so its unsaved inputs could not be applied. The rest of your session is safe.'
			);
		}
	}
}

async function getStoredSessionActivityAt(session: WorkoutSession) {
	const sessionSets = (await listSessionExerciseDetails(session.id)).flatMap(
		(sessionExercise) => sessionExercise.sets
	);

	return getSessionActivityAt(session, sessionSets);
}

function isSessionInactive(
	session: WorkoutSession,
	activityAt: SessionActivityTimestamp | null,
	nowMs = Date.now()
) {
	return (
		session.status === 'in_progress' &&
		Boolean(activityAt && nowMs - activityAt.time >= SESSION_INACTIVITY_ABANDON_MS)
	);
}

function canAttemptSessionCleanup() {
	return activeBackend !== 'supabase-rxdb' || (browser && navigator.onLine);
}

async function confirmSessionCleanupIsFresh() {
	if (activeBackend !== 'supabase-rxdb') {
		return true;
	}

	const userId = activeSupabaseUserId;

	if (!userId || !browser || !navigator.onLine) {
		return false;
	}

	try {
		const { rxdb } = await getRxRuntime();
		await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 5000 });

		if (activeSupabaseUserId !== userId || activeBackend !== 'supabase-rxdb') {
			return false;
		}

		markSupabaseCacheHydrated(userId);
		activeSyncState.set({ phase: 'in-sync', status: 'synced' });
		return true;
	} catch (error) {
		console.warn('Skipping stale-session cleanup until cloud sync is current.', error);
		return false;
	}
}

async function abandonStoredInactiveSession(sessionId: string, nowMs: number) {
	return db.transaction('rw', db.workoutSessions, db.sessionExercises, db.sessionSets, async () => {
		const session = await db.workoutSessions.get(sessionId);

		if (!session || session.status !== 'in_progress') {
			return false;
		}

		const activityAt = await getStoredSessionActivityAt(session);

		if (!activityAt || !isSessionInactive(session, activityAt, nowMs)) {
			return false;
		}

		await db.workoutSessions.update(session.id, {
			status: 'abandoned',
			completedAt: activityAt.value,
			updatedAt: timestamp()
		});
		clearSessionInputDraft(session.id);
		return true;
	});
}

export async function abandonInactiveWorkoutSession(sessionId: string, nowMs = Date.now()) {
	await ensureDbOpen();
	requireLoggedInUser();

	if (!canAttemptSessionCleanup()) {
		return false;
	}

	await flushSessionInputDraft(sessionId, { clearDraft: false });
	const currentSession = await db.workoutSessions.get(sessionId);
	const currentActivityAt = currentSession
		? await getStoredSessionActivityAt(currentSession)
		: null;

	if (!currentSession || !isSessionInactive(currentSession, currentActivityAt, nowMs)) {
		return false;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return false;
	}

	await flushSessionInputDraft(sessionId);
	const abandoned = await abandonStoredInactiveSession(sessionId, nowMs);

	if (!abandoned) {
		return false;
	}

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});

	return true;
}

export async function cleanupStaleSessions(todayDayKey = toDayKey(new Date())) {
	await ensureDbOpen();

	const userId = activeUser.value?.userId;

	if (!activeUser.value?.isLoggedIn || !userId) {
		return;
	}

	if (!canAttemptSessionCleanup()) {
		return;
	}

	const nowMs = Date.now();
	const cleanupKey = `${userId}:${todayDayKey}:${Math.floor(nowMs / 60_000)}`;

	if (lastStaleSessionCleanupKey === cleanupKey) {
		return;
	}

	let [plannedSessions, runningSessions] = await Promise.all([
		db.workoutSessions.where('status').equals('planned').toArray(),
		db.workoutSessions.where('status').equals('in_progress').toArray()
	]);

	for (const runningSession of runningSessions) {
		await flushSessionInputDraft(runningSession.id, { clearDraft: false });
	}

	let stalePlannedSessions = plannedSessions.filter((session) => session.dayKey < todayDayKey);
	const hasStaleRunningSession = (
		await Promise.all(
			runningSessions.map(async (session) => {
				const activityAt = await getStoredSessionActivityAt(session);
				return isSessionInactive(session, activityAt, nowMs);
			})
		)
	).some(Boolean);

	if (stalePlannedSessions.length === 0 && !hasStaleRunningSession) {
		lastStaleSessionCleanupKey = cleanupKey;
		return;
	}

	if (!(await confirmSessionCleanupIsFresh())) {
		return;
	}

	[plannedSessions, runningSessions] = await Promise.all([
		db.workoutSessions.where('status').equals('planned').toArray(),
		db.workoutSessions.where('status').equals('in_progress').toArray()
	]);

	for (const runningSession of runningSessions) {
		await flushSessionInputDraft(runningSession.id);
	}

	stalePlannedSessions = plannedSessions.filter((session) => session.dayKey < todayDayKey);

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, db.sessionSets, async () => {
		for (const stalePlannedSession of stalePlannedSessions) {
			const currentSession = await db.workoutSessions.get(stalePlannedSession.id);

			if (currentSession?.status !== 'planned' || currentSession.dayKey >= todayDayKey) {
				continue;
			}

			await deleteWorkoutSessionRows(currentSession.id);
		}
	});

	for (const runningSession of runningSessions) {
		await abandonStoredInactiveSession(runningSession.id, nowMs);
	}

	lastStaleSessionCleanupKey = cleanupKey;
}
export async function getCurrentInProgressSession() {
	const sessions = await db.workoutSessions.where('status').equals('in_progress').toArray();
	const latestSession = sessions.sort((first, second) => compareSessionRows(second, first)).at(0);

	if (!latestSession) {
		return null;
	}

	return (await getSessionSummariesByIds([latestSession.id])).get(latestSession.id) ?? null;
}

export async function listSessionSummariesForMonth(monthDate: Date) {
	const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
	const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return [...(await getSessionSummariesByIds(sessions.map((session) => session.id))).values()].sort(
		(first, second) => compareSessionRows(first, second)
	);
}

export async function listSessionCalendarRowsForWeek(weekDate: Date): Promise<SessionSummary[]> {
	const start = toValidDate(weekDate);
	const end = new Date(start);
	end.setDate(start.getDate() + 6);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return sessions
		.map((session) => summarizeSession(session, [], []))
		.sort((first, second) => compareSessionRows(first, second));
}

export async function getDayOverview(dayKey: string): Promise<DayOverview> {
	const sessions = await db.workoutSessions.where('dayKey').equals(dayKey).toArray();
	const latestSession = sessions.sort(compareSessionRows).at(-1) ?? null;

	if (!latestSession) {
		return {
			dayKey,
			session: null
		};
	}

	const summaries = await getSessionSummariesByIds([latestSession.id]);

	return {
		dayKey,
		session: summaries.get(latestSession.id) ?? null
	};
}

export async function scheduleWorkoutSession(workoutId: string, dayKey: string) {
	requireLoggedInUser();

	const todayDayKey = toDayKey(new Date());

	if (dayKey !== todayDayKey) {
		throw new Error('You can only schedule a workout for today.');
	}

	await cleanupStaleSessions(todayDayKey);

	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.status === 'planned' ||
			session.status === 'in_progress' ||
			session.status === 'completed' ||
			session.status === 'abandoned'
	);

	if (existingSession) {
		throw new Error('A session already exists for today.');
	}

	const workout = await db.workouts.get(workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workoutId);
	const createdAt = timestamp();
	const session: WorkoutSession = {
		id: createId(),
		workoutId,
		workoutNameSnapshot: workout.name,
		dayKey,
		status: 'planned',
		createdAt,
		updatedAt: createdAt
	};
	const sessionExercises: SessionExercise[] = workoutExercises.map((workoutExercise, index) => ({
		id: createId(),
		sessionId: session.id,
		workoutId,
		exerciseId: workoutExercise.exercise.id,
		exerciseNameSnapshot: workoutExercise.exercise.name,
		order: index + 1,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	}));
	const sessionSets = (
		await Promise.all(
			sessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(sessionExercise.id, workoutExercises[index].exercise, createdAt)
			)
		)
	).flat();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			await db.workoutSessions.add(session);

			if (sessionExercises.length > 0) {
				await db.sessionExercises.bulkAdd(sessionExercises);
			}

			if (sessionSets.length > 0) {
				await db.sessionSets.bulkAdd(sessionSets);
			}

			await db.workouts.update(workoutId, { updatedAt: createdAt });
		}
	);

	return summarizeSession(session, sessionExercises, sessionSets);
}

export async function startWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const now = timestamp();
	let didStart = false;

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, async () => {
		const currentSession = await db.workoutSessions.get(sessionId);

		if (!currentSession) {
			throw new Error('Session not found.');
		}

		if (currentSession.status !== 'planned' && currentSession.status !== 'abandoned') {
			return;
		}

		const isResuming = currentSession.status === 'abandoned';

		if (isResuming && currentSession.dayKey !== toDayKey(new Date())) {
			throw new Error("Only today's abandoned session can be resumed.");
		}

		const previousStartedAtMs = currentSession.startedAt
			? new Date(currentSession.startedAt).getTime()
			: NaN;
		const previousCompletedAtMs = currentSession.completedAt
			? new Date(currentSession.completedAt).getTime()
			: NaN;
		const previousActiveDurationMs =
			Number.isFinite(previousStartedAtMs) &&
			Number.isFinite(previousCompletedAtMs) &&
			previousCompletedAtMs >= previousStartedAtMs
				? previousCompletedAtMs - previousStartedAtMs
				: 0;
		const resumedStartedAt = timestamp(new Date(Date.now() - previousActiveDurationMs));
		const resumedStartedAtMs = new Date(resumedStartedAt).getTime();
		const resumedStartDeltaMs =
			isResuming && Number.isFinite(previousStartedAtMs) && Number.isFinite(resumedStartedAtMs)
				? resumedStartedAtMs - previousStartedAtMs
				: 0;
		await db.workoutSessions.update(sessionId, {
			status: 'in_progress',
			startedAt: isResuming ? resumedStartedAt : now,
			completedAt: undefined,
			updatedAt: now
		});
		didStart = true;

		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();

		if (sessionExercises.length > 0) {
			await Promise.all(
				sessionExercises.map((sessionExercise) => {
					const performedAtMs = new Date(sessionExercise.performedAt).getTime();
					const nextPerformedAt =
						isResuming && Number.isFinite(performedAtMs)
							? timestamp(new Date(performedAtMs + resumedStartDeltaMs))
							: now;

					return db.sessionExercises.update(sessionExercise.id, {
						performedAt: nextPerformedAt,
						updatedAt: now
					});
				})
			);
		}
	});

	const nextSession = await db.workoutSessions.get(sessionId);
	const nextSessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const nextSessionSets = (await listSessionExerciseDetails(sessionId)).flatMap(
		(sessionExercise) => sessionExercise.sets
	);

	if (!nextSession) {
		throw new Error('Session not found.');
	}

	if (didStart) {
		void syncNow().catch((error) => {
			console.warn('Background Supabase sync failed.', error);
		});
	}

	return summarizeSession(nextSession, nextSessionExercises, nextSessionSets);
}

export async function reorderSessionExercises(
	sessionId: string,
	orderedSessionExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction('rw', db.sessionExercises, db.workoutSessions, async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseById = new Map(
			sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
		);
		const orderedIds = orderedSessionExerciseIds.filter((id) => sessionExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = sessionExercises
			.filter((sessionExercise) => !orderedIdSet.has(sessionExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((sessionExercise) => sessionExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.sessionExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});
}

export async function replaceSessionExercise(sessionExerciseId: string, exerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const [session, exercise, sessionExercises] = await Promise.all([
		db.workoutSessions.get(sessionExercise.sessionId),
		getExercise(exerciseId),
		db.sessionExercises.where('sessionId').equals(sessionExercise.sessionId).toArray()
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	if (
		sessionExercises.some(
			(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
		)
	) {
		throw new Error('That exercise is already in this session.');
	}

	const now = timestamp();
	const seedSets = await buildSessionSeedSetRows(sessionExerciseId, exercise, now, session.id);

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.update(sessionExerciseId, {
			exerciseId: exercise.id,
			exerciseNameSnapshot: exercise.name,
			updatedAt: now
		});

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(session.id, { updatedAt: now });
	});
}

export async function removeSessionExercise(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		return;
	}

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.delete(sessionExerciseId);

		const remainingSessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionExercise.sessionId)
			.sortBy('order');
		const now = timestamp();

		await Promise.all(
			remainingSessionExercises.map((remainingSessionExercise, index) =>
				db.sessionExercises.update(remainingSessionExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});
}

export async function addExerciseToSession(sessionId: string, exerciseId: string) {
	requireLoggedInUser();

	const [session, exercise] = await Promise.all([
		db.workoutSessions.get(sessionId),
		getExercise(exerciseId)
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const existingSessionExercise = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray()
		.then((rows) => rows.find((row) => row.exerciseId === exerciseId));

	if (existingSessionExercise) {
		throw new Error('That exercise is already in this session.');
	}

	const existingSessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const nextOrder =
		existingSessionExercises.reduce(
			(highestOrder, currentSessionExercise) =>
				Math.max(highestOrder, currentSessionExercise.order),
			0
		) + 1;
	const now = timestamp();
	const sessionExercise: SessionExercise = {
		id: createId(),
		sessionId,
		workoutId: session.workoutId,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: nextOrder,
		performedAt: session.startedAt ?? now,
		createdAt: now,
		updatedAt: now
	};
	const seedSets = await buildSessionSeedSetRows(sessionExercise.id, exercise, now, session.id);

	await db.transaction('rw', db.sessionExercises, db.sessionSets, db.workoutSessions, async () => {
		await db.sessionExercises.add(sessionExercise);

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});

	return sessionExercise;
}

export async function addSessionSetRow(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const exercise = await getExercise(sessionExercise.exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const currentSets = await db.sessionSets
		.where('sessionExerciseId')
		.equals(sessionExerciseId)
		.toArray();
	const nextOrder =
		currentSets.reduce((highestOrder, currentSet) => Math.max(highestOrder, currentSet.order), 0) +
		1;
	const now = timestamp();
	const nextSets = buildSeedSessionSetRows(
		sessionExerciseId,
		sessionExercise.exerciseId,
		1,
		exercise.unilateral,
		now
	).map((sessionSet) => ({
		...sessionSet,
		order: nextOrder
	}));

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		await db.sessionSets.bulkAdd(nextSets);
		await db.sessionExercises.update(sessionExerciseId, { updatedAt: now });
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});

	return nextSets.map(withSessionSetDefaults).sort(compareSessionSetRows);
}

export async function removeSessionSetRow(sessionSetId: string) {
	requireLoggedInUser();

	const sessionSet = await db.sessionSets.get(sessionSetId);

	if (!sessionSet) {
		return;
	}

	const sessionExercise = await db.sessionExercises.get(sessionSet.sessionExerciseId);

	if (!sessionExercise) {
		await db.sessionSets.delete(sessionSetId);
		return;
	}

	let deletedSetIds: string[] = [];

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionSet.sessionExerciseId)
			.toArray();
		const deleteSetIds = currentSets
			.filter((currentSet) => currentSet.order === sessionSet.order)
			.map((currentSet) => currentSet.id);
		deletedSetIds = deleteSetIds;

		if (deleteSetIds.length > 0) {
			await db.sessionSets.bulkDelete(deleteSetIds);
		}

		const remainingSets = currentSets
			.filter((currentSet) => !deleteSetIds.includes(currentSet.id))
			.sort(compareSessionSetRows);
		const uniqueOrders = [...new Set(remainingSets.map((currentSet) => currentSet.order))].sort(
			(first, second) => first - second
		);
		const nextOrderByCurrentOrder = new Map(
			uniqueOrders.map((order, index) => [order, index + 1] as const)
		);
		const now = timestamp();

		await Promise.all(
			remainingSets.map((remainingSet) => {
				const nextOrder = nextOrderByCurrentOrder.get(remainingSet.order) ?? remainingSet.order;

				if (nextOrder === remainingSet.order) {
					return Promise.resolve(0);
				}

				return db.sessionSets.update(remainingSet.id, {
					order: nextOrder,
					updatedAt: now
				});
			})
		);
		await db.sessionExercises.update(sessionExercise.id, { updatedAt: now });
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});

	removeSessionInputDraftSets(sessionExercise.sessionId, deletedSetIds);
}

export async function updateSessionSetInput(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	requireLoggedInUser();

	return updateSessionSetInputs(sessionSetId, field, rawValue);
}

export async function resetSessionInputs(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const workoutExercises = await listWorkoutExercises(session.workoutId);
	const now = timestamp();
	const nextSessionExercises: SessionExercise[] = workoutExercises.map(
		(workoutExercise, index) => ({
			id: createId(),
			sessionId,
			workoutId: session.workoutId,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: session.startedAt ?? now,
			createdAt: now,
			updatedAt: now
		})
	);
	const nextSessionSets = (
		await Promise.all(
			nextSessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(
					sessionExercise.id,
					workoutExercises[index].exercise,
					now,
					sessionId
				)
			)
		)
	).flat();

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);

		if (sessionExerciseIds.length > 0) {
			const sessionSets = await db.sessionSets
				.where('sessionExerciseId')
				.anyOf(sessionExerciseIds)
				.toArray();

			if (sessionSets.length > 0) {
				await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
			}

			await db.sessionExercises.bulkDelete(sessionExerciseIds);
		}

		if (nextSessionExercises.length > 0) {
			await db.sessionExercises.bulkAdd(nextSessionExercises);
		}

		if (nextSessionSets.length > 0) {
			await db.sessionSets.bulkAdd(nextSessionSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});

	clearSessionInputDraft(sessionId);
}

export async function completeWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (session.status === 'completed' || session.status === 'abandoned') {
		return;
	}

	await flushSessionInputDraft(sessionId);

	const now = timestamp();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.workoutExercises,
		db.workouts,
		async () => {
			await syncWorkoutExercisesFromSession(sessionId, now);
			await db.workoutSessions.update(sessionId, {
				status: 'completed',
				startedAt: session.startedAt ?? now,
				completedAt: now,
				updatedAt: now
			});
		}
	);

	clearSessionInputDraft(sessionId);

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});
}

export async function updateWorkoutSessionTiming(
	sessionId: string,
	nextStartedAt: string,
	nextCompletedAt?: string
) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const startedAtDate = new Date(nextStartedAt);
	const completedAtDate = nextCompletedAt ? new Date(nextCompletedAt) : null;

	if (Number.isNaN(startedAtDate.getTime())) {
		throw new Error('Start time is invalid.');
	}

	if (completedAtDate && Number.isNaN(completedAtDate.getTime())) {
		throw new Error('End time is invalid.');
	}

	if (completedAtDate && completedAtDate.getTime() < startedAtDate.getTime()) {
		throw new Error('End time must be after the start time.');
	}

	if (session.status === 'planned') {
		throw new Error('Start the session before editing its time.');
	}

	const currentStartedAtMs = session.startedAt ? new Date(session.startedAt).getTime() : NaN;
	const startedAtDeltaMs = Number.isNaN(currentStartedAtMs)
		? 0
		: startedAtDate.getTime() - currentStartedAtMs;
	const now = timestamp();

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, async () => {
		await db.workoutSessions.update(sessionId, {
			startedAt: timestamp(startedAtDate),
			completedAt: completedAtDate ? timestamp(completedAtDate) : undefined,
			dayKey: toDayKey(startedAtDate),
			updatedAt: now
		});

		if (startedAtDeltaMs === 0) {
			return;
		}

		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();

		await Promise.all(
			sessionExercises.map((sessionExercise) => {
				const performedAtMs = new Date(sessionExercise.performedAt).getTime();
				const nextPerformedAt = Number.isNaN(performedAtMs)
					? startedAtDate
					: new Date(performedAtMs + startedAtDeltaMs);

				return db.sessionExercises.update(sessionExercise.id, {
					performedAt: timestamp(nextPerformedAt),
					updatedAt: now
				});
			})
		);
	});

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview | null> {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const currentSessionAt = getSessionSortTime(session);
	const [sessionExercises, previousSession, exercises] = await Promise.all([
		listSessionExerciseDetails(sessionId),
		db.workoutSessions
			.where('workoutId')
			.equals(session.workoutId)
			.toArray()
			.then(
				(sessions) =>
					sessions
						.filter(
							(candidate) =>
								candidate.id !== session.id &&
								candidate.status !== 'planned' &&
								getSessionSortTime(candidate) < currentSessionAt
						)
						.sort(compareSessionRows)
						.at(-1) ?? null
			),
		db.exercises.bulkGet(
			(await db.sessionExercises.where('sessionId').equals(sessionId).toArray()).map(
				(sessionExercise) => sessionExercise.exerciseId
			)
		)
	]);
	const sessionSets = sessionExercises.flatMap((sessionExercise) => sessionExercise.sets);
	const previousExercises = previousSession
		? await listSessionExerciseDetails(previousSession.id)
		: [];
	const previousSummary = previousSession
		? summarizeSession(
				previousSession,
				previousExercises,
				previousExercises.flatMap((sessionExercise) => sessionExercise.sets)
			)
		: null;
	const exerciseById = new Map(
		exercises.filter(isDefined).map((exercise) => {
			const nextExercise = withExerciseDefaults(exercise);
			return [nextExercise.id, nextExercise] as const;
		})
	);
	const previousPerformanceByExerciseId = await getLatestExerciseHistoryEntries(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId),
		session.id,
		currentSessionAt
	);
	const progress =
		sessionExercises.length === 0
			? null
			: {
					improvedExercises: 0,
					matchedExercises: 0,
					regressedExercises: 0,
					mixedExercises: 0,
					newExercises: 0
				};
	const nextExercises = sessionExercises.map((sessionExercise) => {
		const previousPerformance =
			previousPerformanceByExerciseId.get(sessionExercise.exerciseId) ?? null;
		const previousReferenceBySetKey = buildPreviousReferenceBySetKey(
			sessionExercise,
			previousPerformance
		);
		const { progressStatus, progressSummary } = summarizeExerciseProgress(
			sessionExercise,
			previousReferenceBySetKey
		);
		const sets = sessionExercise.sets.map((sessionSet) => {
			const previousReference = previousReferenceBySetKey.get(getSessionSetKey(sessionSet)) ?? null;

			return {
				...sessionSet,
				label: getSessionSetLabel(sessionSet),
				previousReference,
				weightDelta: createFieldDelta(sessionSet.weight, previousReference?.weight),
				repsDelta: createFieldDelta(sessionSet.reps, previousReference?.reps),
				rirDelta: createFieldDelta(sessionSet.rir, previousReference?.rir)
			};
		});

		if (progress) {
			switch (progressStatus) {
				case 'improved':
					progress.improvedExercises += 1;
					break;
				case 'regressed':
					progress.regressedExercises += 1;
					break;
				case 'mixed':
					progress.mixedExercises += 1;
					break;
				case 'new':
					progress.newExercises += 1;
					break;
				default:
					progress.matchedExercises += 1;
			}
		}

		return {
			...sessionExercise,
			exercise: exerciseById.get(sessionExercise.exerciseId) ?? null,
			previousPerformance,
			progressStatus,
			progressSummary,
			sets
		};
	});

	return {
		summary: summarizeSession(session, sessionExercises, sessionSets),
		previousSummary,
		progress,
		exercises: nextExercises
	};
}

export async function getEditableSession(sessionId: string) {
	await ensureDbOpen();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	await ensureEditableSessionSeedRows(session, await listSessionExerciseDetails(sessionId));

	return getSessionOverview(sessionId);
}

export async function deleteWorkoutSession(sessionId: string) {
	requireLoggedInUser();

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			const session = await deleteWorkoutSessionRows(sessionId);

			if (!session) {
				return;
			}

			await db.workouts.update(session.workoutId, { updatedAt: timestamp() });
		}
	);
}

function toBackfillSessionDate(dayKey: string, timeValue: string) {
	const cleanDayKey = dayKey.trim();
	const cleanTimeValue = timeValue.trim() || '12:00';
	const date = new Date(`${cleanDayKey}T${cleanTimeValue}`);

	if (!cleanDayKey || Number.isNaN(date.getTime())) {
		throw new Error('Choose a valid backfill date.');
	}

	return date;
}

export async function createBackfillWorkoutSession(input: BackfillWorkoutSessionInput) {
	requireLoggedInUser();

	const workout = await db.workouts.get(input.workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workout.id);

	if (workoutExercises.length === 0) {
		throw new Error('Add exercises to this workout before backfilling it.');
	}

	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exercise.id, workoutExercise])
	);
	const includedExercises = input.exercises
		.map((entry) => ({
			...entry,
			workoutExercise: workoutExerciseByExerciseId.get(entry.exerciseId) ?? null,
			sets: entry.sets.filter(
				(set) => set.weightInput?.trim() || set.repsInput?.trim() || set.rirInput?.trim()
			)
		}))
		.filter((entry) => entry.workoutExercise && entry.sets.length > 0);

	if (includedExercises.length === 0) {
		throw new Error('Log at least one set before saving.');
	}

	const startedAtDate = toBackfillSessionDate(input.dayKey, input.startTime);
	const durationMinutes =
		Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
			? input.durationMinutes
			: 60;
	const completedAtDate = new Date(startedAtDate.getTime() + durationMinutes * 60 * 1000);
	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey: toDayKey(startedAtDate),
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};
	const sessionExercises: SessionExercise[] = includedExercises.map((entry, index) => {
		const workoutExercise = entry.workoutExercise as WorkoutExerciseWithExercise;

		return {
			id: createId(),
			sessionId,
			workoutId: workout.id,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: timestamp(new Date(startedAtDate.getTime() + index * 8 * 60 * 1000)),
			createdAt: startedAt,
			updatedAt: completedAt
		};
	});
	const sessionSets: SessionSet[] = sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
		includedExercises[exerciseIndex].sets.map((set, setIndex) => {
			const weightInput = toCleanSessionInputValue(set.weightInput ?? '', 'weight');
			const repsInput = toCleanSessionInputValue(set.repsInput ?? '', 'reps');
			const rirInput = toCleanSessionInputValue(set.rirInput ?? '', 'rir');

			return {
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order:
					typeof set.order === 'number' && Number.isFinite(set.order) && set.order > 0
						? set.order
						: setIndex + 1,
				side: normalizeSessionSetSide(set.side),
				weightInput,
				repsInput,
				rirInput,
				weight: toParsedInputValue(weightInput, 'weight'),
				reps: toParsedInputValue(repsInput, 'reps'),
				rir: toParsedInputValue(rirInput, 'rir'),
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 8 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			};
		})
	);

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			await db.workoutSessions.add(session);
			await db.sessionExercises.bulkAdd(sessionExercises);
			await db.sessionSets.bulkAdd(sessionSets);
			await db.workouts.update(workout.id, { updatedAt: completedAt });
		}
	);

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});

	return summarizeSession(session, sessionExercises, sessionSets);
}

function createExampleStartedAt(daysAgo: number, hours: number, minutes: number) {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hours, minutes, 0, 0);

	return date;
}

type ExampleSetSeed = Pick<SessionSet, 'weight' | 'reps' | 'rir'>;

type ExampleSessionSeed = {
	daysAgo: number;
	startedAt: {
		hours: number;
		minutes: number;
	};
	completedAt: {
		hours: number;
		minutes: number;
	};
	setsByExercise: ExampleSetSeed[][];
};

const EXAMPLE_BASELINE_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 60, reps: 8, rir: 2 },
		{ weight: 65, reps: 8, rir: 1 },
		{ weight: 67.5, reps: 6, rir: 1 }
	],
	[
		{ reps: 10, rir: 2 },
		{ reps: 9, rir: 1 },
		{ reps: 8, rir: 1 }
	],
	[
		{ weight: 10, reps: 15, rir: 2 },
		{ weight: 12.5, reps: 12, rir: 1 },
		{ weight: 12.5, reps: 12, rir: 1 }
	]
];

const EXAMPLE_IMPROVEMENT_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 62.5, reps: 8, rir: 2 },
		{ weight: 67.5, reps: 8, rir: 1 },
		{ weight: 70, reps: 6, rir: 1 }
	],
	[
		{ reps: 11, rir: 2 },
		{ reps: 10, rir: 1 },
		{ weight: 2.5, reps: 8, rir: 1 }
	],
	[
		{ weight: 12.5, reps: 15, rir: 2 },
		{ weight: 15, reps: 12, rir: 1 },
		{ weight: 15, reps: 12, rir: 1 }
	]
];

async function listExampleBaselineExercises() {
	const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
		EXAMPLE_EXERCISE_NAMES.map((name) => normalizeName(name))
	);

	return EXAMPLE_EXERCISE_NAMES.map((name) =>
		preferredExerciseByNormalizedName.get(normalizeName(name))
	).filter(isDefined);
}

async function normalizeExampleSessionExerciseIds(sessionId: string) {
	const sessionExercises = await db.sessionExercises.where('sessionId').equals(sessionId).toArray();
	const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
		sessionExercises.map((sessionExercise) => normalizeName(sessionExercise.exerciseNameSnapshot))
	);
	const exerciseIdsBySessionExerciseId = new Map(
		sessionExercises.flatMap((sessionExercise) => {
			const preferredExercise = preferredExerciseByNormalizedName.get(
				normalizeName(sessionExercise.exerciseNameSnapshot)
			);

			return preferredExercise ? ([[sessionExercise.id, preferredExercise.id]] as const) : [];
		})
	);
	const now = timestamp();

	await db.transaction('rw', db.sessionExercises, db.sessionSets, async () => {
		for (const sessionExercise of sessionExercises) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionExercise.id);

			if (!nextExerciseId || sessionExercise.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionExercises.update(sessionExercise.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}

		if (sessionExercises.length === 0) {
			return;
		}

		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
		const sessionSets = await db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExerciseIds)
			.toArray();

		for (const sessionSet of sessionSets) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionSet.sessionExerciseId);

			if (!nextExerciseId || sessionSet.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionSets.update(sessionSet.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}
	});
}

async function ensureExampleWorkoutSetup() {
	requireLoggedInUser();

	await ensureBaselineExercises();

	const workout = await createWorkout(EXAMPLE_WORKOUT_NAME);
	const exercises = await listExampleBaselineExercises();

	for (const exercise of exercises) {
		await addExerciseToWorkout(workout.id, exercise.id);
	}

	return {
		workout,
		exercises
	};
}

async function seedExampleSession(seed: ExampleSessionSeed): Promise<BackfillSeedResult> {
	const { workout, exercises } = await ensureExampleWorkoutSetup();
	const startedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.startedAt.hours,
		seed.startedAt.minutes
	);
	const completedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.completedAt.hours,
		seed.completedAt.minutes
	);
	const dayKey = toDayKey(startedAtDate);
	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) =>
			session.workoutId === workout.id && session.workoutNameSnapshot === EXAMPLE_WORKOUT_NAME
	);

	if (existingSession) {
		await normalizeExampleSessionExerciseIds(existingSession.id);

		return {
			workoutId: workout.id,
			sessionId: existingSession.id,
			created: false
		};
	}

	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey,
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};

	await db.workoutSessions.add(session);

	const sessionExercises: SessionExercise[] = exercises.map((exercise, index) => ({
		id: createId(),
		sessionId,
		workoutId: workout.id,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: index + 1,
		performedAt: timestamp(new Date(startedAtDate.getTime() + index * 12 * 60 * 1000)),
		createdAt: startedAt,
		updatedAt: completedAt
	}));

	await db.sessionExercises.bulkAdd(sessionExercises);

	await db.sessionSets.bulkAdd(
		sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
			(seed.setsByExercise[exerciseIndex] ?? []).map((set, setIndex) => ({
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order: setIndex + 1,
				side: 'bilateral' as const,
				weightInput: toStoredInputValue(undefined, set.weight),
				repsInput: toStoredInputValue(undefined, set.reps),
				rirInput: toStoredInputValue(undefined, set.rir),
				weight: set.weight,
				reps: set.reps,
				rir: set.rir,
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 12 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			}))
		)
	);

	return {
		workoutId: workout.id,
		sessionId,
		created: true
	};
}

export async function seedExampleBackfill(): Promise<BackfillSeedResult> {
	return seedExampleSession({
		daysAgo: 2,
		startedAt: {
			hours: 18,
			minutes: 10
		},
		completedAt: {
			hours: 18,
			minutes: 58
		},
		setsByExercise: EXAMPLE_BASELINE_SETS
	});
}

export async function seedImprovedBackfill(): Promise<BackfillSeedResult> {
	await seedExampleBackfill();

	return seedExampleSession({
		daysAgo: 1,
		startedAt: {
			hours: 18,
			minutes: 12
		},
		completedAt: {
			hours: 19,
			minutes: 1
		},
		setsByExercise: EXAMPLE_IMPROVEMENT_SETS
	});
}
