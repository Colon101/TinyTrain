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
	filterSessionSetsForSessionExercises,
	hasAnySetValue,
	hasInputValue,
	projectUniqueSessionExercises,
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
import {
	projectSessionChildren,
	repairScheduledSessionDay,
	repairScheduledSessionDays
} from './sessions/schedule-integrity';

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
	getSyncState(id: string): Promise<{ row?: T; deleted: boolean } | undefined>;
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
// A requested identity changes immediately, while the published identity may remain available
// until an admitted transaction drains. Keep both generations so stale work cannot confuse them.
let activeRuntimeGeneration: number | null = null;
let requestedSupabaseUserId: string | null = null;
let runtimeGeneration = 0;
let dbOpenPromise: Promise<typeof db> | null = null;
let authBridgeStarted = false;
let supabaseBackendActivationAttempt: RuntimeActivationAttempt | null = null;
let closedDatabaseRecoveryAttempt: RuntimeRecoveryAttempt | null = null;
let authenticatedOperationRecoveryAttempt: AuthenticatedOperationRecoveryAttempt | null = null;
let rxChangeSubscription: SubscriptionLike | null = null;
let rxRuntimePromise: Promise<{
	adapter: typeof import('../rxdb-dexie-adapter');
	rxdb: typeof import('../rxdb');
}> | null = null;
let lastStaleSessionCleanupKey: string | null = null;
let backgroundSyncAttempt: RuntimeIdentity | null = null;
const activeRuntimeLeases = new Map<number, { count: number; drainWaiters: Set<() => void> }>();
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

type AuthenticatedOperationRecoveryAttempt = RuntimeIdentity & {
	promise: Promise<AppDatabase | null>;
};

function isCurrentRuntimeRequest(identity: RuntimeIdentity) {
	return requestedSupabaseUserId === identity.userId && runtimeGeneration === identity.generation;
}

function isActiveRuntimeIdentity(identity: RuntimeIdentity) {
	return (
		isCurrentRuntimeRequest(identity) &&
		activeSupabaseUserId === identity.userId &&
		activeRuntimeGeneration === identity.generation
	);
}

function getActiveRuntimeContext(): ActiveRuntimeContext | null {
	const context = getPublishedRuntimeContext();

	return context && isCurrentRuntimeRequest(context) ? context : null;
}

function getPublishedRuntimeContext(): ActiveRuntimeContext | null {
	if (!activeSupabaseUserId || activeRuntimeGeneration === null || !rxDataDb) {
		return null;
	}

	return {
		userId: activeSupabaseUserId,
		generation: activeRuntimeGeneration,
		database: rxDataDb as unknown as AppDatabase
	};
}

function isActiveRuntimeContext(context: ActiveRuntimeContext) {
	return (
		isActiveRuntimeIdentity(context) &&
		rxDataDb === (context.database as unknown as RxDexieLikeDatabase)
	);
}

function isPublishedRuntimeIdentity(identity: RuntimeIdentity) {
	return (
		activeSupabaseUserId === identity.userId && activeRuntimeGeneration === identity.generation
	);
}

function acquireRuntimeLease(identity: RuntimeIdentity) {
	const state = activeRuntimeLeases.get(identity.generation) ?? {
		count: 0,
		drainWaiters: new Set<() => void>()
	};

	state.count += 1;
	activeRuntimeLeases.set(identity.generation, state);

	return () => {
		const currentState = activeRuntimeLeases.get(identity.generation);

		if (!currentState) {
			return;
		}

		currentState.count -= 1;
		if (currentState.count > 0) {
			return;
		}

		activeRuntimeLeases.delete(identity.generation);
		for (const resolve of currentState.drainWaiters) {
			resolve();
		}
	};
}

function waitForRuntimeLeases(identity: RuntimeIdentity | null) {
	if (!identity) {
		return null;
	}

	const state = activeRuntimeLeases.get(identity.generation);
	if (!state || state.count === 0) {
		return null;
	}

	return new Promise<void>((resolve) => {
		state.drainWaiters.add(resolve);
	});
}

async function runWithRuntimeIdentityLease<T>(
	context: ActiveRuntimeContext,
	_tableName: RxDataTableKey,
	operation: () => Promise<T>
) {
	if (!isActiveRuntimeIdentity(context)) {
		throw new Error('The authenticated local database changed before the operation could start.');
	}

	const releaseLease = acquireRuntimeLease(context);

	try {
		return await operation();
	} finally {
		releaseLease();
	}
}

function isActiveSupabaseUser(userId: string) {
	return (
		activeSupabaseUserId === userId &&
		requestedSupabaseUserId === userId &&
		activeRuntimeGeneration === runtimeGeneration
	);
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
		setSyncStateForUser(context.userId, { phase: 'in-sync', status: 'synced' });
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
		setAuthOwnedStateIdentity(snapshot.user?.id ?? null, !snapshot.isLoading);

		if (!snapshot.user) {
			if (!snapshot.isLoading) {
				void clearSupabaseRuntimeState();
			}

			activeUser.set(toSupabaseCloudUser());
			return;
		}

		activeUser.set(toSupabaseCloudUser());

		if (
			activeSupabaseUserId !== snapshot.user.id &&
			!(
				supabaseBackendActivationAttempt?.userId === snapshot.user.id &&
				isCurrentRuntimeRequest(supabaseBackendActivationAttempt)
			)
		) {
			activeUser.set({ isLoading: true });
			dbOpenPromise = null;
			void activateSupabaseBackend(snapshot.user.id).catch((error) => {
				if (requestedSupabaseUserId === snapshot.user?.id) {
					activeSyncState.set({
						phase: 'error',
						status: 'error',
						error: error instanceof Error ? error : new Error('Supabase sync failed.')
					});
				}
				console.warn('Supabase backend activation failed.', error);
			});
		}
	});
}

export async function clearSupabaseRuntimeState() {
	const previousContext = getPublishedRuntimeContext();
	const clearGeneration = runtimeGeneration + 1;

	runtimeGeneration = clearGeneration;
	requestedSupabaseUserId = null;
	lastStaleSessionCleanupKey = null;
	backgroundSyncAttempt = null;
	dbOpenPromise = null;
	activeSyncState.set({ phase: 'initial', status: 'not-started' });

	const leaseDrain = waitForRuntimeLeases(previousContext);
	if (leaseDrain) {
		await leaseDrain;
	}

	if (runtimeGeneration !== clearGeneration || requestedSupabaseUserId !== null) {
		return;
	}

	activeSupabaseUserId = null;
	activeRuntimeGeneration = null;
	rxDataDb = null;

	if (!previousContext) {
		return;
	}

	void getRxRuntime()
		.then(({ rxdb }) => rxdb.stopSupabaseReplication(previousContext.userId))
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
	activeRuntimeGeneration = identity.generation;
	activeSyncState.set({ phase: 'pulling', status: 'syncing' });
	rxDataDb = database;
	rxChangeSubscription ??= adapter.subscribeToRxDexieChanges((tableName) => {
		emitDatabaseChange(tableName as DatabaseTableKey);
	});
	activeUser.set(toSupabaseCloudUser());
	startProgressiveSync(identity.userId, identity.generation);

	if (hasHydratedSupabaseCache(identity.userId)) {
		void rxdb
			.awaitSupabaseInSync(identity.userId, { timeoutMs: 15000 })
			.then(() => {
				if (isActiveRuntimeIdentity(identity)) {
					markSupabaseCacheHydrated(identity.userId);
					activeSyncState.set({ phase: 'in-sync', status: 'synced' });
				}
			})
			.catch((error) => {
				console.warn('Background Supabase sync failed.', error);
				if (isActiveRuntimeIdentity(identity)) {
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

async function activateSupabaseBackend(userId: string) {
	const currentAttempt = supabaseBackendActivationAttempt;

	if (currentAttempt?.userId === userId && isCurrentRuntimeRequest(currentAttempt)) {
		return currentAttempt.promise;
	}

	if (
		activeSupabaseUserId === userId &&
		requestedSupabaseUserId === userId &&
		activeRuntimeGeneration === runtimeGeneration &&
		rxDataDb
	) {
		return;
	}

	const previousContext = getPublishedRuntimeContext();
	const identity = { userId, generation: runtimeGeneration + 1 };

	runtimeGeneration = identity.generation;
	requestedSupabaseUserId = userId;
	dbOpenPromise = null;
	backgroundSyncAttempt = null;
	activeSyncState.set({ phase: 'initial', status: 'not-started' });

	const promise = (async () => {
		// Transactions are serialized by the adapter's user-scoped Web Lock. Direct calls and query
		// terminals take the same runtime-generation lease, so the published adapter cannot change
		// while any operation is queued or in flight.
		const leaseDrain = waitForRuntimeLeases(previousContext);
		if (leaseDrain) {
			await leaseDrain;
		}

		if (!isCurrentRuntimeRequest(identity)) {
			return;
		}

		activeSupabaseUserId = null;
		activeRuntimeGeneration = null;
		rxDataDb = null;

		if (previousContext && previousContext.userId !== userId) {
			void getRxRuntime()
				.then(({ rxdb }) => rxdb.stopSupabaseReplication(previousContext.userId))
				.catch((error) => {
					console.warn('Supabase replication shutdown failed.', error);
				});
		}

		await openSupabaseRuntimeForRequest(identity);
	})().finally(() => {
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
		await clearSupabaseRuntimeState();
		activeUser.set(toSupabaseCloudUser());
		return;
	}

	if (!user || user.id !== currentAuthUser.id) {
		return;
	}

	await activateSupabaseBackend(currentAuthUser.id);
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

export type AuthenticatedOperationDatabase = Pick<AppDatabase, RxDataTableKey | 'transaction'>;

export type AuthenticatedDatabaseOperation = Readonly<{
	userId: string;
	generation: number;
	database: AuthenticatedOperationDatabase;
}>;

type AuthenticatedDatabaseOperationState = RuntimeIdentity & {
	database: AppDatabase;
	active: boolean;
	tableFacades: Map<RxDataTableKey, DataTable<{ id: string }>>;
};

const rxDataTableKeys = new Set<RxDataTableKey>([
	'exercises',
	'workouts',
	'workoutExercises',
	'workoutSessions',
	'sessionExercises',
	'sessionSets',
	'exerciseResetEvents'
]);
const dataTableMethodKeys = new Set<keyof DataTable<{ id: string }>>([
	'toArray',
	'get',
	'getSyncState',
	'bulkGet',
	'add',
	'bulkAdd',
	'put',
	'bulkPut',
	'update',
	'delete',
	'bulkDelete',
	'where'
]);
const whereClauseMethodKeys = new Set<keyof WhereClause<{ id: string }>>([
	'equals',
	'anyOf',
	'between'
]);
const queryResultMethodKeys = new Set<keyof QueryResult<{ id: string }>>([
	'toArray',
	'first',
	'sortBy'
]);
const authenticatedOperationDataTableMetadata = new WeakMap<
	object,
	{ state: AuthenticatedDatabaseOperationState; tableName: RxDataTableKey }
>();

function assertAuthenticatedOperationActive(state: AuthenticatedDatabaseOperationState) {
	if (!state.active) {
		throw new Error('The authenticated database operation has already finished.');
	}
}

async function recoverAuthenticatedOperationDatabase(state: AuthenticatedDatabaseOperationState) {
	if (!isPublishedRuntimeIdentity(state)) {
		return false;
	}

	let attempt = authenticatedOperationRecoveryAttempt;

	if (!attempt || attempt.userId !== state.userId || attempt.generation !== state.generation) {
		const identity = { userId: state.userId, generation: state.generation };
		const promise = (async () => {
			const { adapter } = await getRxRuntime();
			const database = await adapter.reopenRxDexieLikeDatabase(identity.userId);

			if (!isPublishedRuntimeIdentity(identity)) {
				return null;
			}

			rxDataDb = database;

			if (isCurrentRuntimeRequest(identity)) {
				dbOpenPromise = Promise.resolve(db);
				backgroundSyncAttempt = null;
				activeUser.set(toSupabaseCloudUser());
				startProgressiveSync(identity.userId, identity.generation);
			}

			return database as unknown as AppDatabase;
		})().finally(() => {
			if (authenticatedOperationRecoveryAttempt?.generation === identity.generation) {
				authenticatedOperationRecoveryAttempt = null;
			}
		});

		attempt = { ...identity, promise };
		authenticatedOperationRecoveryAttempt = attempt;
	}

	const database = await attempt.promise;

	if (!database || !isPublishedRuntimeIdentity(state)) {
		return false;
	}

	state.database = database;
	return true;
}

async function runAuthenticatedOperationDatabaseCall<T>(
	state: AuthenticatedDatabaseOperationState,
	operation: (database: AppDatabase) => Promise<T>
) {
	assertAuthenticatedOperationActive(state);
	const releaseLease = acquireRuntimeLease(state);

	try {
		try {
			return await operation(state.database);
		} catch (error) {
			if (!isClosedDatabaseError(error) || !(await recoverAuthenticatedOperationDatabase(state))) {
				throw error;
			}
		}

		return operation(state.database);
	} finally {
		releaseLease();
	}
}

function createAuthenticatedOperationQueryResult<T>(
	state: AuthenticatedDatabaseOperationState,
	buildQueryResult: (database: AppDatabase) => QueryResult<T>
): QueryResult<T> {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (
					typeof prop !== 'string' ||
					!queryResultMethodKeys.has(prop as keyof QueryResult<{ id: string }>)
				) {
					return undefined;
				}

				return (...args: unknown[]) =>
					runAuthenticatedOperationDatabaseCall(state, async (database) => {
						const queryResult = buildQueryResult(database);
						const value = queryResult[prop as keyof QueryResult<T>];

						if (typeof value !== 'function') {
							throw new Error('Unsupported authenticated database query operation.');
						}

						return (value as (...methodArgs: unknown[]) => Promise<unknown>).apply(
							queryResult,
							args
						);
					});
			}
		}
	) as QueryResult<T>;
}

function createAuthenticatedOperationWhereClause<T extends { id: string }>(
	state: AuthenticatedDatabaseOperationState,
	tableName: RxDataTableKey,
	field: string
): WhereClause<T> {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (
					typeof prop !== 'string' ||
					!whereClauseMethodKeys.has(prop as keyof WhereClause<{ id: string }>)
				) {
					return undefined;
				}

				return (...args: unknown[]) => {
					assertAuthenticatedOperationActive(state);

					return createAuthenticatedOperationQueryResult(state, (database) => {
						const table = database[tableName] as unknown as DataTable<T>;
						const whereClause = table.where(field);
						const value = whereClause[prop as keyof WhereClause<T>];

						if (typeof value !== 'function') {
							throw new Error('Unsupported authenticated database where operation.');
						}

						return (value as (...methodArgs: unknown[]) => QueryResult<T>).apply(whereClause, args);
					});
				};
			}
		}
	) as WhereClause<T>;
}

function createAuthenticatedOperationDataTable<T extends { id: string }>(
	state: AuthenticatedDatabaseOperationState,
	tableName: RxDataTableKey
): DataTable<T> {
	const table = new Proxy(
		{},
		{
			get(_target, prop) {
				if (
					typeof prop !== 'string' ||
					!dataTableMethodKeys.has(prop as keyof DataTable<{ id: string }>)
				) {
					return undefined;
				}

				if (prop === 'where') {
					return (field: string) => {
						assertAuthenticatedOperationActive(state);
						return createAuthenticatedOperationWhereClause<T>(state, tableName, field);
					};
				}

				return (...args: unknown[]) =>
					runAuthenticatedOperationDatabaseCall(state, async (database) => {
						const currentTable = database[tableName] as unknown as DataTable<T>;
						const value = currentTable[prop as keyof DataTable<T>];

						if (typeof value !== 'function') {
							throw new Error('Unsupported authenticated database table operation.');
						}

						return (value as (...methodArgs: unknown[]) => Promise<unknown>).apply(
							currentTable,
							args
						);
					});
			}
		}
	) as DataTable<T>;

	authenticatedOperationDataTableMetadata.set(table, { state, tableName });
	return table;
}

function resolveAuthenticatedOperationTransactionArgument(
	state: AuthenticatedDatabaseOperationState,
	argument: unknown
): unknown {
	if (Array.isArray(argument)) {
		return argument.map((item) => resolveAuthenticatedOperationTransactionArgument(state, item));
	}

	if (argument && (typeof argument === 'object' || typeof argument === 'function')) {
		const metadata = authenticatedOperationDataTableMetadata.get(argument as object);

		if (!metadata || metadata.state !== state) {
			throw new Error('Authenticated transactions can only use tables from their operation.');
		}

		return state.database[metadata.tableName];
	}

	return argument;
}

async function runAuthenticatedOperationTransaction<T>(
	state: AuthenticatedDatabaseOperationState,
	mode: string,
	...args: unknown[]
) {
	assertAuthenticatedOperationActive(state);
	const callback = args.at(-1);

	if (typeof callback !== 'function') {
		return undefined as T;
	}

	const releaseLease = acquireRuntimeLease(state);

	try {
		const transactionArgs = args
			.slice(0, -1)
			.map((argument) => resolveAuthenticatedOperationTransactionArgument(state, argument));

		return await state.database.transaction<T>(mode, ...transactionArgs, () =>
			(callback as () => Promise<T> | T)()
		);
	} finally {
		releaseLease();
	}
}

function createAuthenticatedOperationDatabase(
	state: AuthenticatedDatabaseOperationState
): AuthenticatedOperationDatabase {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return undefined;
				}

				assertAuthenticatedOperationActive(state);

				if (prop === 'transaction') {
					return (mode: string, ...args: unknown[]) =>
						runAuthenticatedOperationTransaction(state, mode, ...args);
				}

				if (typeof prop !== 'string' || !rxDataTableKeys.has(prop as RxDataTableKey)) {
					return undefined;
				}

				const tableName = prop as RxDataTableKey;
				let table = state.tableFacades.get(tableName);

				if (!table) {
					table = createAuthenticatedOperationDataTable(state, tableName);
					state.tableFacades.set(tableName, table);
				}

				return table;
			}
		}
	) as AuthenticatedOperationDatabase;
}

export async function runAuthenticatedDatabaseOperation<T>(
	callback: (operation: AuthenticatedDatabaseOperation) => Promise<T> | T
): Promise<T> {
	const context = getActiveRuntimeContext();

	if (!context) {
		throw new Error('The authenticated local database changed before the operation could start.');
	}

	const state: AuthenticatedDatabaseOperationState = {
		userId: context.userId,
		generation: context.generation,
		database: context.database,
		active: true,
		tableFacades: new Map()
	};
	const releaseLease = acquireRuntimeLease(context);
	const operation = Object.freeze({
		userId: context.userId,
		generation: context.generation,
		database: createAuthenticatedOperationDatabase(state)
	});

	try {
		return await callback(operation);
	} finally {
		state.active = false;
		releaseLease();
	}
}

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
	context: ActiveRuntimeContext,
	tableName: RxDataTableKey,
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
				runWithRuntimeIdentityLease(context, tableName, () =>
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
					)
				);
		}
	}) as QueryResult<T>;
}

export function createRecoveringWhereClause<T>(
	context: ActiveRuntimeContext,
	tableName: RxDataTableKey,
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

				return createRecoveringQueryResult(context, tableName, queryResult, () => {
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
	context: ActiveRuntimeContext,
	tableName: RxDataTableKey,
	table: DataTable<T>
): DataTable<T> {
	const recoveringTable = new Proxy(table, {
		get(target, prop) {
			const value = target[prop as keyof DataTable<T>];

			if (prop === 'where' && typeof value === 'function') {
				return (field: string) => {
					const whereClause = target.where(field);

					return createRecoveringWhereClause(context, tableName, whereClause, () =>
						(getRxDataTable(tableName) as unknown as DataTable<T>).where(field)
					);
				};
			}

			if (typeof value !== 'function') {
				return value;
			}

			return (...args: unknown[]) =>
				runWithRuntimeIdentityLease(context, tableName, () =>
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
					)
				);
		}
	}) as DataTable<T>;
	return recoveringTable;
}

async function runRuntimeTransaction<T>(mode: string, ...args: unknown[]): Promise<T> {
	const context = getActiveRuntimeContext();

	if (!context) {
		throw new Error('The authenticated local database changed before the transaction could start.');
	}

	const callback = args.at(-1);
	if (typeof callback !== 'function') {
		return undefined as T;
	}

	const releaseLease = acquireRuntimeLease(context);
	// Acquire the identity lease before entering the adapter queue. A backend switch requested
	// while this callback is waiting on the user-scoped Web Lock must wait for it too.
	const transactionArgs = [...args.slice(0, -1), () => (callback as () => Promise<T> | T)()];

	try {
		return await (context.database as unknown as RxDexieLikeDatabase).transaction<T>(
			mode,
			...transactionArgs
		);
	} finally {
		releaseLease();
	}
}

export const db = new Proxy(
	{},
	{
		get(_target, prop) {
			if (prop === 'cloud') {
				return cloudCompat;
			}

			if (prop === 'transaction') {
				return runRuntimeTransaction;
			}

			const context = getPublishedRuntimeContext();

			if (context && typeof prop === 'string' && prop in context.database) {
				return createRecoveringDataTable(
					context,
					prop as RxDataTableKey,
					context.database[prop as RxDataTableKey] as unknown as DataTable<{ id: string }>
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
	const context = getActiveRuntimeContext();

	if (!context) {
		return false;
	}

	if (closedDatabaseRecoveryAttempt && isActiveRuntimeIdentity(closedDatabaseRecoveryAttempt)) {
		return closedDatabaseRecoveryAttempt.promise;
	}

	const promise = (async () => {
		const { adapter } = await getRxRuntime();

		activeSyncState.set({ phase: 'pulling', status: 'syncing' });
		const database = await adapter.reopenRxDexieLikeDatabase(context.userId);

		if (!isActiveRuntimeContext(context)) {
			return false;
		}

		rxDataDb = database;
		dbOpenPromise = Promise.resolve(db);
		backgroundSyncAttempt = null;
		activeUser.set(toSupabaseCloudUser());
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
	await clearSupabaseRuntimeState();
	activeUser.set(toSupabaseCloudUser());
}

export async function syncNow(options: SyncNowOptions = {}) {
	await ensureDbOpen();

	const context = getActiveRuntimeContext();

	if (!context) {
		return;
	}

	setSyncStateForUser(context.userId, { phase: 'pushing', status: 'syncing' });

	try {
		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			getCloudSyncDeps(context),
			context.userId,
			'richest',
			{ onProgress: options.onProgress }
		);
		await repairScheduledSessionDays(context.database, context.userId);
		const { rxdb } = await getRxRuntime();

		if (isActiveRuntimeContext(context)) {
			void rxdb.awaitSupabaseInSync(context.userId, { timeoutMs: 15000 }).catch((error) => {
				console.warn('Background Supabase sync confirmation failed.', error);
			});
		}

		if (isActiveRuntimeContext(context)) {
			setSyncStateForUser(context.userId, { phase: 'in-sync', status: 'synced' });
		}
		return summary;
	} catch (error) {
		if (isActiveRuntimeContext(context)) {
			setSyncStateForUser(context.userId, {
				phase: 'error',
				status: 'error',
				error: error instanceof Error ? error : new Error('Cloud sync failed.')
			});
		}
		throw error;
	}
}

export type SyncNowOptions = {
	onProgress?: (progress: SyncProgress) => void;
};

function getCloudSyncDeps(context: ActiveRuntimeContext | null = null) {
	return {
		db: context?.database ?? db,
		getActiveSupabaseUserId: () =>
			context
				? isActiveRuntimeContext(context)
					? context.userId
					: null
				: (getActiveRuntimeContext()?.userId ?? null),
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
	const context = getActiveRuntimeContext();
	const summary = await dbCloudSync.reconcileSupabaseDatabase(
		getCloudSyncDeps(getActiveRuntimeContext()),
		userId,
		mode,
		options
	);

	if (context?.userId === userId && isActiveRuntimeContext(context)) {
		await repairScheduledSessionDays(context.database, context.userId);
	}

	return summary;
}

export async function putMergedRemoteRow<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	row: T,
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRow(
		getCloudSyncDeps(getActiveRuntimeContext()),
		tableName,
		table,
		row,
		normalize
	);
}

export async function putMergedRemoteRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	table: DataTable<T>,
	rows: T[],
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	return dbCloudSync.putMergedRemoteRows(
		getCloudSyncDeps(getActiveRuntimeContext()),
		tableName,
		table,
		rows,
		normalize
	);
}

export async function fetchSupabaseRows<T extends SyncableRow>(
	tableName: SupabaseTableName,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	buildQuery: (query: any) => PromiseLike<{ data: unknown; error: unknown }>,
	normalize: (row: T) => T = (row) => row
) {
	return dbCloudSync.fetchSupabaseRows(
		getCloudSyncDeps(getActiveRuntimeContext()),
		tableName,
		buildQuery,
		normalize
	);
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

			setSyncStateForUser(userId, { phase: 'pulling', status: 'syncing', progress: 0.25 });

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

			setSyncStateForUser(userId, { phase: 'pulling', status: 'syncing', progress: 0.75 });
			await rxdb.awaitSupabaseInitialReplication(userId);
			await rxdb.awaitSupabaseInSync(userId, { timeoutMs: 15000 });

			if (isActiveRuntimeIdentity(attempt)) {
				const context = getActiveRuntimeContext();

				if (context) {
					await repairScheduledSessionDays(context.database, context.userId);
				}

				markSupabaseCacheHydrated(userId);
				setSyncStateForUser(userId, { phase: 'in-sync', status: 'synced' });
			}
		} catch (error) {
			shouldReleaseGuard = true;
			console.warn('Background Supabase sync failed.', error);

			if (isActiveRuntimeIdentity(attempt)) {
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

	const context = getActiveRuntimeContext();

	if (!context) {
		throw new Error('Sign in with Google to upload this device.');
	}

	setSyncStateForUser(context.userId, { phase: 'pushing', status: 'syncing' });

	try {
		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			getCloudSyncDeps(context),
			context.userId,
			'local-preferred'
		);
		await repairScheduledSessionDays(context.database, context.userId);
		if (isActiveRuntimeContext(context)) {
			setSyncStateForUser(context.userId, { phase: 'in-sync', status: 'synced' });
		}
		return summary;
	} catch (error) {
		if (isActiveRuntimeContext(context)) {
			setSyncStateForUser(context.userId, {
				phase: 'error',
				status: 'error',
				error: error instanceof Error ? error : new Error('Local upload failed.')
			});
		}
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
	const visibleSessionExercises = projectUniqueSessionExercises(sessionExercises);
	const matchingSessionSets = filterSessionSetsForSessionExercises(
		sessionSets,
		visibleSessionExercises
	);
	const completedSessions = sessions.filter((session) => session.status === 'completed');
	const lastWorkout = [...completedSessions].sort(
		(first, second) => getRowTimestamp(second) - getRowTimestamp(first)
	)[0];

	return {
		workouts: workouts.length,
		customExercises: exercises.filter(shouldSyncExercise).length,
		previousWorkouts: completedSessions.length,
		sessionExercises: visibleSessionExercises.length,
		sessionSets: matchingSessionSets.length,
		filledSessionSets: matchingSessionSets.filter(hasAnySetValue).length,
		lastWorkoutAt: lastWorkout?.completedAt ?? lastWorkout?.startedAt ?? lastWorkout?.createdAt
	};
}

export async function hydrateSessionFromSupabase(sessionId: string) {
	const context = getActiveRuntimeContext();

	if (!context) {
		return;
	}

	await hydrateSessionForContext(sessionId, context);
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
		const session = await context.database.workoutSessions.get(scope.sessionId);

		if (session) {
			await repairScheduledSessionDay(context.database, context.userId, session.dayKey);
		}
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

		for (const dayKey of [...new Set(sessions.map((session) => session.dayKey))]) {
			const daySessions = await context.database.workoutSessions
				.where('dayKey')
				.equals(dayKey)
				.toArray();

			if (daySessions.length > 1) {
				await Promise.all(
					daySessions.map((session) => hydrateSessionForContext(session.id, context))
				);
			}

			await repairScheduledSessionDay(context.database, context.userId, dayKey);
		}
		return;
	}

	if (scope.type === 'day') {
		const sessions = await dbCloudSync.fetchSupabaseRows<WorkoutSession>(
			syncDeps,
			'workout_sessions',
			(query) => query.eq('dayKey', scope.dayKey).order('_modified', { ascending: false })
		);
		await dbCloudSync.putMergedRemoteRows(
			syncDeps,
			'workout_sessions',
			context.database.workoutSessions,
			sessions
		);
		await Promise.all(sessions.map((session) => hydrateSessionForContext(session.id, context)));
		await repairScheduledSessionDay(context.database, context.userId, scope.dayKey);
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
	const expectedUserId = getActiveCloudUser().userId;
	await ensureDbOpen();
	return runAuthenticatedDatabaseOperation(async (operation) => {
		if (!expectedUserId || operation.userId !== expectedUserId) {
			throw new Error('The signed-in user changed before the session timer could be loaded.');
		}

		const session = await operation.database.workoutSessions.get(sessionId);

		if (!session) {
			return null;
		}

		const storedSessionExercises = await operation.database.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseIds = storedSessionExercises.map(({ id }) => id);
		const storedSessionSets =
			sessionExerciseIds.length === 0
				? []
				: await operation.database.sessionSets
						.where('sessionExerciseId')
						.anyOf(sessionExerciseIds)
						.toArray();
		const projection = projectSessionChildren({
			session,
			sessionExercises: storedSessionExercises,
			sessionSets: storedSessionSets
		});

		return summarizeSession(
			session,
			projection.visibleSessionExercises,
			projection.visibleSessionSets
		);
	});
}

export function requireLoggedInUser() {
	if (!getActiveRuntimeContext()) {
		throw new Error('Sign in with Google to save workouts.');
	}
}
