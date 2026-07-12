import { browser } from '$app/environment';
import {
	getSupabaseAuthSnapshot,
	getSupabaseUser,
	initializeSupabaseAuth,
	loginWithSupabaseGoogle as startSupabaseGoogleLogin,
	logoutFromSupabase,
	subscribeToSupabaseAuth,
	supabase
} from '../supabase';
import type { RxDexieLikeDatabase } from '../rxdb-dexie-adapter';
import {
	dbCloudSync,
	type DatabaseUploadMode,
	type DatabaseUploadSummary,
	type LocalDatabaseStats,
	type SupabaseSyncedRow,
	type SupabaseTableName,
	type SyncableRow,
	type SyncProgress
} from '../db-cloud-sync';
import {
	hasAnySetValue,
	hasInputValue,
	summarizeSession,
	withExerciseDefaults,
	withSessionSetDefaults
} from './shared';
import type {
	Exercise,
	ExerciseResetEvent,
	HydrateVisibleScopeInput,
	PersistentStorageStatus,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from './models';

export {
	SESSION_INACTIVITY_ABANDON_MS,
	SESSION_INACTIVITY_CHECK_INTERVAL_MS,
	SESSION_INACTIVITY_WARNING_MS
} from '../session-inactivity';

export type SubscriptionLike = {
	unsubscribe(): void;
};

export type SyncStateLike = {
	phase?: string;
	status?: string;
	progress?: number;
	error?: Error;
};
export type DatabaseTableKey =
	| 'exercises'
	| 'workouts'
	| 'workoutExercises'
	| 'workoutSessions'
	| 'sessionExercises'
	| 'sessionSets'
	| 'exerciseResetEvents';
export type DatabaseChangeSubscriber = (tables: DatabaseTableKey[]) => void;
export type DatabaseChangeSubscribeOptions = {
	debounceMs?: number;
};
export type WindowWithIdleCallback = Window & {
	requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

export class ValueObservable<T> {
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

export type QueryResult<T> = {
	toArray(): Promise<T[]>;
	first(): Promise<T | undefined>;
	sortBy(field: string): Promise<T[]>;
};

export type WhereClause<T> = {
	equals(value: unknown): QueryResult<T>;
	anyOf(values: unknown[]): QueryResult<T>;
	between(
		lower: unknown,
		upper: unknown,
		includeLower?: boolean,
		includeUpper?: boolean
	): QueryResult<T>;
};

export type DataTable<T extends { id: string }> = {
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

let rxDataDb: RxDexieLikeDatabase | null = null;
let activeSupabaseUserId: string | null = null;
let dbOpenPromise: Promise<typeof db> | null = null;
let authBridgeStarted = false;
let supabaseBackendActivationPromise: Promise<void> | null = null;
let closedDatabaseRecoveryPromise: Promise<boolean> | null = null;
let rxChangeSubscription: SubscriptionLike | null = null;
let rxRuntimePromise: Promise<{
	adapter: typeof import('../rxdb-dexie-adapter');
	rxdb: typeof import('../rxdb');
}> | null = null;
let lastStaleSessionCleanupKey: string | null = null;
let backgroundSyncAttempt: { userId: string } | null = null;
const databaseChangeSubscribers = new Set<{
	tables: Set<DatabaseTableKey>;
	callback: DatabaseChangeSubscriber;
	debounceMs: number;
	pendingTables: Set<DatabaseTableKey>;
	timeoutId: ReturnType<typeof setTimeout> | null;
}>();

function isActiveSupabaseUser(userId: string) {
	return activeSupabaseUserId === userId;
}

function setSyncStateForUser(userId: string, state: SyncStateLike) {
	if (isActiveSupabaseUser(userId)) {
		activeSyncState.set(state);
	}
}

export function getActiveCloudUser() {
	return activeUser.value;
}

export function wasStaleSessionCleanupCompleted(cleanupKey: string) {
	return lastStaleSessionCleanupKey === cleanupKey;
}

export function markStaleSessionCleanupCompleted(cleanupKey: string) {
	lastStaleSessionCleanupKey = cleanupKey;
}

export function canAttemptSessionCleanup() {
	return browser && navigator.onLine;
}

export async function confirmSessionCleanupIsFresh() {
	const userId = activeSupabaseUserId;

	if (!userId || !browser || !navigator.onLine) {
		return false;
	}

	try {
		const { rxdb } = await getRxRuntime();
		await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 5000 });

		if (!isActiveSupabaseUser(userId)) {
			return false;
		}

		markSupabaseCacheHydrated(userId);
		setSyncStateForUser(userId, { phase: 'in-sync', status: 'synced' });
		return true;
	} catch (error) {
		console.warn('Skipping stale-session cleanup until cloud sync is current.', error);
		return false;
	}
}

export function toSupabaseCloudUser() {
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

export function hasHydratedSupabaseCache(userId: string) {
	return browser && localStorage.getItem(`${supabaseHydratedPrefix}${userId}`) === 'true';
}

export function markSupabaseCacheHydrated(userId: string) {
	if (!browser) {
		return;
	}

	localStorage.setItem(`${supabaseHydratedPrefix}${userId}`, 'true');
}

export function getProgressiveBackfillKey(userId: string) {
	return `${progressiveBackfillPrefix}${userId}`;
}

export function markRecentBackfillComplete(userId: string) {
	if (!browser) {
		return;
	}

	localStorage.setItem(getProgressiveBackfillKey(userId), 'true');
}

export function emitDatabaseChange(tableName: DatabaseTableKey) {
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

export function startAuthBridge() {
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

		if (activeSupabaseUserId !== snapshot.user.id) {
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

export function clearSupabaseRuntimeState() {
	const previousUserId = activeSupabaseUserId;

	lastStaleSessionCleanupKey = null;
	backgroundSyncAttempt = null;
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

export async function getRxRuntime() {
	rxRuntimePromise ??= Promise.all([import('../rxdb-dexie-adapter'), import('../rxdb')]).then(
		([adapter, rxdb]) => ({ adapter, rxdb })
	);
	return rxRuntimePromise;
}

export async function openSupabaseRuntime(userId: string) {
	const { adapter, rxdb } = await getRxRuntime();

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
				if (activeSupabaseUserId === userId) {
					activeSyncState.set({ phase: 'in-sync', status: 'synced' });
				}
			})
			.catch((error) => {
				console.warn('Background Supabase sync failed.', error);
				if (activeSupabaseUserId === userId) {
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

export async function selectBackend() {
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

export type AppDatabase = {
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

export type RxDataTableKey = Exclude<keyof RxDexieLikeDatabase, 'transaction'>;

export function getRxDataTable(tableName: RxDataTableKey) {
	if (!rxDataDb) {
		throw new Error('The local database is still loading.');
	}

	return rxDataDb[tableName];
}

export async function runRecoveringDatabaseOperation<T>(
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

export function createRecoveringQueryResult<T>(
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

export function createRecoveringWhereClause<T>(
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

export function createRecoveringDataTable<T extends { id: string }>(
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

			if (prop === 'transaction' && rxDataDb) {
				return rxDataDb.transaction.bind(rxDataDb);
			}

			if (rxDataDb && typeof prop === 'string' && prop in rxDataDb) {
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

export function isClosedDatabaseError(error: unknown) {
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

export async function recoverClosedDatabase() {
	if (!activeSupabaseUserId) {
		return false;
	}

	const userId = activeSupabaseUserId;

	closedDatabaseRecoveryPromise ??= (async () => {
		const { adapter } = await getRxRuntime();

		activeSyncState.set({ phase: 'pulling', status: 'syncing' });
		rxDataDb = await adapter.reopenRxDexieLikeDatabase(userId);

		if (activeSupabaseUserId !== userId) {
			return false;
		}

		dbOpenPromise = Promise.resolve(db);
		backgroundSyncAttempt = null;
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

	const userId = activeSupabaseUserId;

	if (!userId) {
		return;
	}

	setSyncStateForUser(userId, { phase: 'pushing', status: 'syncing' });

	try {
		const summary = await reconcileSupabaseDatabase(userId, 'richest', {
			onProgress: options.onProgress
		});
		const { rxdb } = await getRxRuntime();

		void rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 }).catch((error) => {
			console.warn('Background Supabase sync confirmation failed.', error);
		});

		setSyncStateForUser(userId, { phase: 'in-sync', status: 'synced' });
		return summary;
	} catch (error) {
		setSyncStateForUser(userId, {
			phase: 'error',
			status: 'error',
			error: error instanceof Error ? error : new Error('Cloud sync failed.')
		});
		throw error;
	}
}

export type SyncNowOptions = {
	onProgress?: (progress: SyncProgress) => void;
};

export function getCloudSyncDeps() {
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

export function normalizeRemoteSessionSet(row: SessionSet): SessionSet {
	return dbCloudSync.normalizeRemoteSessionSet(getCloudSyncDeps(), row);
}

export function shouldSyncExercise(exercise: Exercise) {
	return dbCloudSync.shouldSyncExercise(getCloudSyncDeps(), exercise);
}

export function getRowTimestamp(row: SyncableRow) {
	return dbCloudSync.getRowTimestamp(row);
}

export function stripSupabaseSyncFields<T extends { id: string }>(row: SupabaseSyncedRow): T {
	return dbCloudSync.stripSupabaseSyncFields<T>(row);
}

export async function reconcileSupabaseDatabase(
	userId: string,
	mode: DatabaseUploadMode,
	options: SyncNowOptions = {}
): Promise<DatabaseUploadSummary> {
	return dbCloudSync.reconcileSupabaseDatabase(getCloudSyncDeps(), userId, mode, options);
}

export async function putMergedRemoteRow<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	row: T,
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRow(getCloudSyncDeps(), tableName, table, row, normalize);
}

export async function putMergedRemoteRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	rows: T[],
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRows(getCloudSyncDeps(), tableName, table, rows, normalize);
}

export async function fetchSupabaseRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	buildQuery: (query: any) => PromiseLike<{ data: unknown; error: unknown }>,
	normalize: (row: T) => T = (row) => row
) {
	return dbCloudSync.fetchSupabaseRows(getCloudSyncDeps(), tableName, buildQuery, normalize);
}

export async function backfillRecentRows(userId: string, days = recentBackfillDays) {
	if (activeSupabaseUserId !== userId) {
		return;
	}

	await dbCloudSync.backfillRecentRows(getCloudSyncDeps(), userId, days);
}

export function startProgressiveSync(userId: string) {
	if (backgroundSyncAttempt?.userId === userId) {
		return;
	}

	const attempt = { userId };
	backgroundSyncAttempt = attempt;

	void (async () => {
		let shouldReleaseGuard = false;

		try {
			const { rxdb } = await getRxRuntime();
			await waitForBackgroundSyncSlot();

			if (!isActiveSupabaseUser(userId)) {
				shouldReleaseGuard = true;
				return;
			}

			setSyncStateForUser(userId, { phase: 'pulling', status: 'syncing', progress: 0.25 });

			try {
				await backfillRecentRows(userId);
			} catch (error) {
				shouldReleaseGuard = true;
				console.warn('Recent Supabase backfill failed.', error);
			}

			setSyncStateForUser(userId, { phase: 'pulling', status: 'syncing', progress: 0.75 });
			await rxdb.awaitSupabaseInitialReplication(userId);
			await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 });

			if (isActiveSupabaseUser(userId)) {
				markSupabaseCacheHydrated(userId);
				setSyncStateForUser(userId, { phase: 'in-sync', status: 'synced' });
			}
		} catch (error) {
			shouldReleaseGuard = true;
			console.warn('Background Supabase sync failed.', error);

			if (isActiveSupabaseUser(userId)) {
				setSyncStateForUser(userId, {
					phase: 'error',
					status: 'error',
					error: error instanceof Error ? error : new Error('Supabase sync failed.')
				});
			}
		} finally {
			if (shouldReleaseGuard && backgroundSyncAttempt === attempt) {
				backgroundSyncAttempt = null;
			}
		}
	})();
}

export function waitForBackgroundSyncSlot() {
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

	const userId = activeSupabaseUserId;

	if (!userId) {
		throw new Error('Sign in with Google to upload this device.');
	}

	setSyncStateForUser(userId, { phase: 'pushing', status: 'syncing' });

	try {
		const summary = await reconcileSupabaseDatabase(userId, 'local-preferred');
		setSyncStateForUser(userId, { phase: 'in-sync', status: 'synced' });
		return summary;
	} catch (error) {
		setSyncStateForUser(userId, {
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

export async function hydrateSessionFromSupabase(sessionId: string) {
	if (!activeSupabaseUserId) {
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
		throw error;
	}
}

export async function hydrateVisibleScope(scope: HydrateVisibleScopeInput) {
	await ensureDbOpen();

	if (!activeSupabaseUserId) {
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

export function requireLoggedInUser() {
	if (!activeSupabaseUserId) {
		throw new Error('Sign in with Google to save workouts.');
	}
}
