import { browser } from '$app/environment';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
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
import { dbCloudSync, type SupabaseSyncedRow, type SyncProgress } from '../db-cloud-sync';
import { toDayKey, withExerciseDefaults, withSessionSetDefaults } from './shared';
import type {
	DatabaseUploadSummary,
	Exercise,
	HydrateVisibleScopeInput,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from './models';

export type SubscriptionLike = {
	unsubscribe(): void;
};

export type DatabaseTableKey =
	| 'exercises'
	| 'workouts'
	| 'workoutExercises'
	| 'workoutSessions'
	| 'sessionExercises'
	| 'sessionSets';
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
	bulkGetVersioned(ids: string[]): Promise<(VersionedDocument<T> | undefined)[]>;
	add(doc: T): Promise<string>;
	bulkAdd(docs: T[]): Promise<string[]>;
	put(doc: T): Promise<string>;
	bulkPut(docs: T[]): Promise<string[]>;
	compareAndPut(expectedVersion: string | undefined, doc: T): Promise<boolean>;
	update(id: string, patch: Partial<T>): Promise<number>;
	delete(id: string): Promise<void>;
	bulkDelete(ids: string[]): Promise<void>;
	compareAndDelete(expectedVersion: string, id: string): Promise<boolean>;
	where(field: string): WhereClause<T>;
};

export type VersionedDocument<T> = {
	document: T;
	version: string;
};

export const currentUser = new ValueObservable<{
	userId?: string;
	name?: string;
	email?: string;
	isLoggedIn?: boolean;
	isLoading?: boolean;
}>({ isLoading: true });
const supabaseHydratedPrefix = 'tinytrain:supabase-rxdb-hydrated:';
const recentBackfillDays = 90;

let rxDataDb: RxDexieLikeDatabase | null = null;
let activeSupabaseUserId: string | null = null;
let requestedSupabaseUserId: string | null = null;
let runtimeGeneration = 0;
let dbOpenPromise: Promise<typeof db> | null = null;
let authBridgeStarted = false;
let supabaseBackendActivationAttempt: RuntimeActivationAttempt | null = null;
let closedDatabaseRecoveryAttempt: RuntimeRecoveryAttempt | null = null;
let rxChangeSubscription: SubscriptionLike | null = null;
let rxRuntimePromise: Promise<{
	adapter: typeof import('../rxdb-dexie-adapter');
	rxdb: typeof import('../rxdb');
}> | null = null;
let lastStaleSessionCleanupKey: string | null = null;
let backgroundSyncAttempt: RuntimeIdentity | null = null;
const databaseChangeSubscribers = new Set<{
	tables: Set<DatabaseTableKey>;
	callback: DatabaseChangeSubscriber;
	debounceMs: number;
	pendingTables: Set<DatabaseTableKey>;
	timeoutId: ReturnType<typeof setTimeout> | null;
}>();

type RuntimeIdentity = {
	userId: string;
	generation: number;
};

type ActiveRuntimeContext = RuntimeIdentity & {
	database: AppDatabase;
};

type RuntimeActivationAttempt = RuntimeIdentity & {
	promise: Promise<void>;
};

type RuntimeRecoveryAttempt = RuntimeIdentity & {
	promise: Promise<boolean>;
};

function isCurrentRuntimeRequest(identity: RuntimeIdentity) {
	return requestedSupabaseUserId === identity.userId && runtimeGeneration === identity.generation;
}

function isActiveRuntimeIdentity(identity: RuntimeIdentity) {
	return isCurrentRuntimeRequest(identity) && activeSupabaseUserId === identity.userId;
}

function getActiveRuntimeContext(): ActiveRuntimeContext | null {
	if (!activeSupabaseUserId || !rxDataDb) {
		return null;
	}

	const context = {
		userId: activeSupabaseUserId,
		generation: runtimeGeneration,
		database: rxDataDb as unknown as AppDatabase
	};

	return isCurrentRuntimeRequest(context) ? context : null;
}

function isActiveRuntimeContext(context: ActiveRuntimeContext) {
	return (
		isActiveRuntimeIdentity(context) &&
		rxDataDb === (context.database as unknown as RxDexieLikeDatabase)
	);
}

export function getActiveCloudUser() {
	return currentUser.value;
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
	const context = getActiveRuntimeContext();

	if (!context || !browser || !navigator.onLine) {
		return false;
	}

	try {
		const { rxdb } = await getRxRuntime();
		await rxdb.awaitSupabaseInSync(context.userId, { timeoutMs: 5000 });

		if (!isActiveRuntimeContext(context)) {
			return false;
		}

		markSupabaseCacheHydrated(context.userId);
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
		setAuthOwnedStateIdentity(snapshot.user?.id ?? null, !snapshot.isLoading);

		if (!snapshot.user) {
			if (!snapshot.isLoading) {
				clearSupabaseRuntimeState();
			}

			currentUser.set(toSupabaseCloudUser());
			return;
		}

		currentUser.set(toSupabaseCloudUser());

		if (
			activeSupabaseUserId !== snapshot.user.id &&
			!(
				supabaseBackendActivationAttempt?.userId === snapshot.user.id &&
				isCurrentRuntimeRequest(supabaseBackendActivationAttempt)
			)
		) {
			currentUser.set({ isLoading: true });
			dbOpenPromise = null;
			void activateSupabaseBackend(snapshot.user.id).catch((error) => {
				console.warn('Supabase backend activation failed.', error);
			});
		}
	});
}

export function clearSupabaseRuntimeState() {
	const previousUserId = activeSupabaseUserId;

	runtimeGeneration += 1;
	requestedSupabaseUserId = null;
	lastStaleSessionCleanupKey = null;
	backgroundSyncAttempt = null;
	activeSupabaseUserId = null;
	rxDataDb = null;
	dbOpenPromise = null;

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
	await activateSupabaseBackend(userId);
}

async function openSupabaseRuntimeForRequest(identity: RuntimeIdentity) {
	const { adapter, rxdb } = await getRxRuntime();
	const database = await adapter.getRxDexieLikeDatabase(identity.userId);

	if (!isCurrentRuntimeRequest(identity)) {
		if (requestedSupabaseUserId !== identity.userId) {
			rxdb.stopSupabaseReplication(identity.userId);
		}
		return;
	}

	activeSupabaseUserId = identity.userId;
	rxDataDb = database;
	rxChangeSubscription ??= adapter.subscribeToRxDexieChanges((tableName) => {
		emitDatabaseChange(tableName as DatabaseTableKey);
	});
	currentUser.set(toSupabaseCloudUser());
	startProgressiveSync(identity.userId, identity.generation);

	if (hasHydratedSupabaseCache(identity.userId)) {
		void rxdb
			.awaitSupabaseInSync(identity.userId, { timeoutMs: 15000 })
			.then(() => {
				if (isActiveRuntimeIdentity(identity)) {
					markSupabaseCacheHydrated(identity.userId);
				}
			})
			.catch((error) => {
				console.warn('Background Supabase sync failed.', error);
			});
		return;
	}
}

async function activateSupabaseBackend(userId: string) {
	const currentAttempt = supabaseBackendActivationAttempt;

	if (currentAttempt?.userId === userId && isCurrentRuntimeRequest(currentAttempt)) {
		return currentAttempt.promise;
	}

	if (activeSupabaseUserId === userId && requestedSupabaseUserId === userId && rxDataDb) {
		return;
	}

	const previousUserId = activeSupabaseUserId;
	const identity = { userId, generation: runtimeGeneration + 1 };

	runtimeGeneration = identity.generation;
	requestedSupabaseUserId = userId;
	activeSupabaseUserId = null;
	rxDataDb = null;
	dbOpenPromise = null;
	backgroundSyncAttempt = null;

	if (previousUserId && previousUserId !== userId) {
		void getRxRuntime()
			.then(({ rxdb }) => rxdb.stopSupabaseReplication(previousUserId))
			.catch((error) => {
				console.warn('Supabase replication shutdown failed.', error);
			});
	}

	const promise = openSupabaseRuntimeForRequest(identity).finally(() => {
		if (supabaseBackendActivationAttempt?.generation === identity.generation) {
			supabaseBackendActivationAttempt = null;
		}
	});

	supabaseBackendActivationAttempt = { ...identity, promise };
	return promise;
}

export async function selectBackend() {
	startAuthBridge();
	const user = await getSupabaseUser();
	const currentAuthUser = getSupabaseAuthSnapshot().user;

	if (!currentAuthUser) {
		clearSupabaseRuntimeState();
		currentUser.set(toSupabaseCloudUser());
		return;
	}

	if (!user || user.id !== currentAuthUser.id) {
		return;
	}

	await activateSupabaseBackend(currentAuthUser.id);
}

export type AppDatabase = {
	exercises: DataTable<Exercise>;
	workouts: DataTable<Workout>;
	workoutExercises: DataTable<WorkoutExercise>;
	workoutSessions: DataTable<WorkoutSession>;
	sessionExercises: DataTable<SessionExercise>;
	sessionSets: DataTable<SessionSet>;
	transaction<T>(callback: () => Promise<T> | T): Promise<T>;
};

export type ActiveDatabaseLease = {
	userId: string;
	database: AppDatabase;
	assertActive(): void;
	syncNow(options?: SyncNowOptions): Promise<DatabaseUploadSummary | undefined>;
};

export function acquireActiveDatabaseLease(expectedUserId: string): ActiveDatabaseLease {
	const context = getActiveRuntimeContext();

	if (!context || context.userId !== expectedUserId) {
		throw new Error('The active database no longer belongs to the signed-in account.');
	}

	const assertActive = () => {
		if (
			!isActiveRuntimeContext(context) ||
			!currentUser.value.isLoggedIn ||
			currentUser.value.userId !== expectedUserId
		) {
			throw new Error('The signed-in account changed during the database operation.');
		}
	};

	return {
		userId: context.userId,
		database: context.database,
		assertActive,
		async syncNow(options = {}) {
			assertActive();
			const summary = await syncRuntimeContext(context, options);
			assertActive();
			return summary;
		}
	};
}

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
			if (prop === 'transaction' && rxDataDb) {
				return rxDataDb.transaction.bind(rxDataDb);
			}

			if (rxDataDb && typeof prop === 'string' && prop in rxDataDb) {
				return createRecoveringDataTable(
					prop as RxDataTableKey,
					rxDataDb[prop as RxDataTableKey] as unknown as DataTable<{ id: string }>
				);
			}

			return undefined;
		}
	}
) as AppDatabase;

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
	const context = getActiveRuntimeContext();

	if (!context) {
		return false;
	}

	if (closedDatabaseRecoveryAttempt && isActiveRuntimeIdentity(closedDatabaseRecoveryAttempt)) {
		return closedDatabaseRecoveryAttempt.promise;
	}

	const promise = (async () => {
		const { adapter } = await getRxRuntime();

		const database = await adapter.reopenRxDexieLikeDatabase(context.userId);

		if (!isActiveRuntimeContext(context)) {
			return false;
		}

		rxDataDb = database;
		dbOpenPromise = Promise.resolve(db);
		backgroundSyncAttempt = null;
		currentUser.set(toSupabaseCloudUser());
		startProgressiveSync(context.userId, context.generation);

		return true;
	})().finally(() => {
		if (closedDatabaseRecoveryAttempt?.generation === context.generation) {
			closedDatabaseRecoveryAttempt = null;
		}
	});

	closedDatabaseRecoveryAttempt = {
		userId: context.userId,
		generation: context.generation,
		promise
	};
	return promise;
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
	currentUser.set(toSupabaseCloudUser());
}

export async function syncNow(options: SyncNowOptions = {}) {
	await ensureDbOpen();

	const context = getActiveRuntimeContext();

	if (!context) {
		return;
	}

	return syncRuntimeContext(context, options);
}

async function syncRuntimeContext(context: ActiveRuntimeContext, options: SyncNowOptions) {
	const summary = await dbCloudSync.reconcileSupabaseDatabase(
		getCloudSyncDeps(context),
		context.userId,
		'richest',
		{ onProgress: options.onProgress }
	);
	const { rxdb } = await getRxRuntime();

	if (isActiveRuntimeContext(context)) {
		void rxdb.awaitSupabaseInSync(context.userId, { timeoutMs: 15000 }).catch((error) => {
			console.warn('Background Supabase sync confirmation failed.', error);
		});
	}

	return summary;
}

export type SyncNowOptions = {
	onProgress?: (progress: SyncProgress) => void;
};

function getCloudSyncDeps(context: ActiveRuntimeContext | null = null) {
	return {
		db: context?.database ?? db,
		getActiveSupabaseUserId: () =>
			context ? (isActiveRuntimeContext(context) ? context.userId : null) : activeSupabaseUserId,
		markSupabaseCacheHydrated,
		withExerciseDefaults,
		withSessionSetDefaults
	};
}

export function normalizeRemoteSessionSet(row: SessionSet): SessionSet {
	return dbCloudSync.normalizeRemoteSessionSet(getCloudSyncDeps(), row);
}

export function stripSupabaseSyncFields<T extends { id: string }>(row: SupabaseSyncedRow): T {
	return dbCloudSync.stripSupabaseSyncFields<T>(row);
}

export async function backfillRecentRows(userId: string, days = recentBackfillDays) {
	const context = getActiveRuntimeContext();

	if (!context || context.userId !== userId) {
		return;
	}

	await dbCloudSync.backfillRecentRows(getCloudSyncDeps(context), userId, days);
}

export function startProgressiveSync(userId: string, generation = runtimeGeneration) {
	const attempt = { userId, generation };

	if (backgroundSyncAttempt?.userId === userId && backgroundSyncAttempt.generation === generation) {
		return;
	}

	backgroundSyncAttempt = attempt;

	void (async () => {
		let shouldReleaseGuard = false;

		try {
			const { rxdb } = await getRxRuntime();
			await waitForBackgroundSyncSlot();

			if (!isActiveRuntimeIdentity(attempt)) {
				shouldReleaseGuard = true;
				return;
			}

			try {
				await backfillRecentRows(userId);
			} catch (error) {
				shouldReleaseGuard = true;
				console.warn('Recent Supabase backfill failed.', error);
			}

			if (!isActiveRuntimeIdentity(attempt)) {
				shouldReleaseGuard = true;
				return;
			}

			await rxdb.awaitSupabaseInitialReplication(userId);
			await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 });

			if (isActiveRuntimeIdentity(attempt)) {
				markSupabaseCacheHydrated(userId);
			}
		} catch (error) {
			shouldReleaseGuard = true;
			console.warn('Background Supabase sync failed.', error);
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

	const context = getActiveRuntimeContext();

	if (!context) {
		throw new Error('Sign in with Google to upload this device.');
	}

	return dbCloudSync.reconcileSupabaseDatabase(
		getCloudSyncDeps(context),
		context.userId,
		'local-preferred'
	);
}

async function hydrateSessionForContext(sessionId: string, context: ActiveRuntimeContext) {
	const syncDeps = getCloudSyncDeps(context);

	try {
		const [sessionResult, sessionExercisesResult] = await Promise.all([
			supabase
				.from('workout_sessions')
				.select('*')
				.eq('user_id', context.userId)
				.eq('id', sessionId)
				.eq('_deleted', false)
				.maybeSingle(),
			supabase
				.from('session_exercises')
				.select('*')
				.eq('user_id', context.userId)
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

		if (!isActiveRuntimeContext(context)) {
			return;
		}

		const [sessionSetsResult, exercisesResult] = await Promise.all([
			sessionExerciseIds.length > 0
				? supabase
						.from('session_sets')
						.select('*')
						.eq('user_id', context.userId)
						.in('sessionExerciseId', sessionExerciseIds)
						.eq('_deleted', false)
				: Promise.resolve({ data: [], error: null }),
			exerciseIds.length > 0
				? supabase
						.from('exercises')
						.select('*')
						.eq('user_id', context.userId)
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

		if (!isActiveRuntimeContext(context)) {
			return;
		}

		if (sessionRow) {
			await dbCloudSync.putMergedRemoteRow(
				syncDeps,
				'workout_sessions',
				context.database.workoutSessions,
				stripSupabaseSyncFields<WorkoutSession>(sessionRow)
			);
		}

		await dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'session_exercises',
			context.database.sessionExercises,
			sessionExerciseRows.map((row) => stripSupabaseSyncFields<SessionExercise>(row))
		);
		await dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'session_sets',
			context.database.sessionSets,
			((sessionSetsResult.data ?? []) as SupabaseSyncedRow[]).map((row) =>
				stripSupabaseSyncFields<SessionSet>(row)
			),
			normalizeRemoteSessionSet
		);
		await dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'exercises',
			context.database.exercises,
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

	const context = getActiveRuntimeContext();

	if (!context) {
		return;
	}

	const syncDeps = getCloudSyncDeps(context);

	if (scope.type === 'session') {
		await hydrateSessionForContext(scope.sessionId, context);
		return;
	}

	if (scope.type === 'week') {
		const sessions = await dbCloudSync.fetchSupabaseRows<WorkoutSession>(
			syncDeps,
			'workout_sessions',
			(query) =>
				query
					.gte('dayKey', scope.weekStartDayKey)
					.lte('dayKey', scope.weekEndDayKey)
					.order('_modified', { ascending: false })
		);
		await dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'workout_sessions',
			context.database.workoutSessions,
			sessions
		);
		return;
	}

	const workouts = await dbCloudSync.fetchSupabaseRows<Workout>(syncDeps, 'workouts', (query) =>
		query.order('_modified', { ascending: false }).limit(200)
	);
	const workoutExercises = await dbCloudSync.fetchSupabaseRows<WorkoutExercise>(
		syncDeps,
		'workout_exercises',
		(query) => query.order('_modified', { ascending: false }).limit(2000)
	);
	const exerciseIds = [...new Set(workoutExercises.map((row) => row.exerciseId))];
	const exercises =
		exerciseIds.length === 0
			? []
			: await dbCloudSync.fetchSupabaseRows<Exercise>(
					syncDeps,
					'exercises',
					(query) => query.in('id', exerciseIds),
					withExerciseDefaults
				);

	await Promise.all([
		dbCloudSync.putMergedRemoteRows(syncDeps, 'workouts', context.database.workouts, workouts),
		dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'workout_exercises',
			context.database.workoutExercises,
			workoutExercises
		),
		dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'exercises',
			context.database.exercises,
			exercises,
			withExerciseDefaults
		)
	]);
}

export async function getSessionTimerSummary(sessionId: string) {
	await ensureDbOpen();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	return {
		...session,
		dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt)
	};
}

export function requireLoggedInUser() {
	if (!activeSupabaseUserId) {
		throw new Error('Sign in with Google to save workouts.');
	}
}
