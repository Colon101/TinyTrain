import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedOperationDatabase, QueryResult } from './runtime';

type RuntimeAuthSnapshot = {
	isLoading: boolean;
	user: { id: string; email: string; user_metadata: Record<string, unknown> } | null;
};

const runtimeMocks = vi.hoisted(() => ({
	backfillRecentRows: vi.fn(),
	reconcileSupabaseDatabase: vi.fn(),
	awaitInitialReplication: vi.fn(),
	awaitInSync: vi.fn(),
	getDatabase: vi.fn(),
	reopenDatabase: vi.fn(),
	stopReplication: vi.fn(),
	getSupabaseUser: vi.fn(),
	authSubscriber: null as ((snapshot: RuntimeAuthSnapshot) => void) | null,
	authUserId: 'user-1' as string | null,
	hydrationError: null as Error | null,
	database: {}
}));

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, resolve, reject };
}

vi.mock('$app/environment', () => ({ browser: false }));

vi.mock('../db-cloud-sync', () => ({
	dbCloudSync: {
		backfillRecentRows: runtimeMocks.backfillRecentRows,
		reconcileSupabaseDatabase: runtimeMocks.reconcileSupabaseDatabase
	}
}));

vi.mock('../rxdb-dexie-adapter', () => ({
	getRxDexieLikeDatabase: runtimeMocks.getDatabase,
	reopenRxDexieLikeDatabase: runtimeMocks.reopenDatabase,
	subscribeToRxDexieChanges: () => ({ unsubscribe: vi.fn() })
}));

vi.mock('../rxdb', () => ({
	awaitSupabaseInitialReplication: runtimeMocks.awaitInitialReplication,
	awaitSupabaseInSync: runtimeMocks.awaitInSync,
	stopSupabaseReplication: runtimeMocks.stopReplication
}));

vi.mock('../supabase', () => ({
	getSupabaseAuthSnapshot: () => ({
		isLoading: false,
		user: runtimeMocks.authUserId
			? {
					id: runtimeMocks.authUserId,
					email: 'user@example.com',
					user_metadata: {}
				}
			: null
	}),
	getSupabaseUser: runtimeMocks.getSupabaseUser,
	initializeSupabaseAuth: vi.fn(),
	loginWithSupabaseGoogle: vi.fn(),
	logoutFromSupabase: vi.fn(),
	subscribeToSupabaseAuth: vi.fn((subscriber: (snapshot: RuntimeAuthSnapshot) => void) => {
		runtimeMocks.authSubscriber = subscriber;
		return { unsubscribe: vi.fn() };
	}),
	supabase: {
		from(tableName: string) {
			return {
				select() {
					const result = {
						data: tableName === 'workout_sessions' ? null : [],
						error: runtimeMocks.hydrationError
					};
					const query = {
						eq() {
							return query;
						},
						in() {
							return query;
						},
						maybeSingle() {
							return Promise.resolve(result);
						},
						then(
							onFulfilled: (value: typeof result) => unknown,
							onRejected?: (reason: unknown) => unknown
						) {
							return Promise.resolve(result).then(onFulfilled, onRejected);
						}
					};

					return query;
				}
			};
		}
	}
}));

beforeEach(() => {
	vi.resetModules();
	runtimeMocks.backfillRecentRows.mockReset().mockResolvedValue(undefined);
	runtimeMocks.reconcileSupabaseDatabase.mockReset().mockResolvedValue({ tables: [] });
	runtimeMocks.awaitInitialReplication.mockReset().mockResolvedValue(undefined);
	runtimeMocks.awaitInSync.mockReset().mockResolvedValue(undefined);
	runtimeMocks.getDatabase.mockReset().mockResolvedValue(runtimeMocks.database);
	runtimeMocks.reopenDatabase.mockReset().mockResolvedValue(runtimeMocks.database);
	runtimeMocks.stopReplication.mockReset();
	runtimeMocks.getSupabaseUser.mockReset().mockResolvedValue({ id: 'user-1' });
	runtimeMocks.authSubscriber = null;
	runtimeMocks.authUserId = 'user-1';
	runtimeMocks.hydrationError = null;
});

function createRuntimeDatabase(owner: string) {
	return {
		workouts: {
			get: vi.fn(async () => ({ id: 'workout-1', owner }))
		}
	};
}

function createTransactionalRuntimeDatabase(owner: string) {
	const writes: string[] = [];
	const workouts = {
		get: vi.fn(async () => ({ id: 'workout-1', name: owner })),
		update: vi.fn(async (id: string) => {
			writes.push(id);
			return 1;
		})
	};
	const database = {
		workouts,
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				return undefined;
			}

			return callback();
		})
	};

	return { database, workouts, writes };
}

function createExerciseRuntimeDatabase(
	owner: string,
	options: { beforeExerciseQuery?: () => Promise<void> } = {}
) {
	const exercises: Array<{
		id: string;
		name: string;
		normalizedName: string;
		unilateral: boolean;
		source: 'custom';
		archived: boolean;
		createdAt: string;
		updatedAt: string;
	}> = [];
	const exerciseTable = {
		where: vi.fn((field: string) => ({
			equals: (value: unknown) => ({
				toArray: async () => {
					await options.beforeExerciseQuery?.();
					return exercises.filter(
						(exercise) => exercise[field as keyof (typeof exercises)[number]] === value
					);
				}
			})
		})),
		get: vi.fn(async (id: string) => exercises.find((exercise) => exercise.id === id)),
		add: vi.fn(async (exercise: (typeof exercises)[number]) => {
			exercises.push({ ...exercise });
			return exercise.id;
		}),
		update: vi.fn(async (id: string, patch: Partial<(typeof exercises)[number]>) => {
			const index = exercises.findIndex((exercise) => exercise.id === id);

			if (index < 0) {
				return 0;
			}

			exercises[index] = { ...exercises[index], ...patch };
			return 1;
		})
	};
	const resetEvents: unknown[] = [];
	const database = {
		exercises: exerciseTable,
		exerciseResetEvents: {
			add: vi.fn(async (event: unknown) => {
				resetEvents.push(event);
				return 'reset-event';
			})
		},
		workouts: {
			get: vi.fn(async () => ({ id: 'workout-1', name: owner }))
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				return undefined;
			}

			return callback();
		})
	};

	return { database, exerciseTable, exercises, resetEvents };
}

function createSessionTimerRuntimeDatabase(
	owner: string,
	options: { beforeSessionRead?: () => Promise<void> } = {}
) {
	const createdAt = '2026-07-15T08:00:00.000Z';
	const session = {
		id: 'shared-session',
		workoutId: `workout-${owner}`,
		workoutNameSnapshot: `${owner} workout`,
		dayKey: '2026-07-15',
		status: 'in_progress' as const,
		startedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	};
	const sessionExercise = {
		id: 'shared-session-exercise',
		sessionId: session.id,
		workoutId: session.workoutId,
		exerciseId: `exercise-${owner}`,
		exerciseNameSnapshot: `${owner} exercise`,
		order: 1,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	};
	const sessionSet = {
		id: 'shared-session-set',
		sessionExerciseId: sessionExercise.id,
		exerciseId: sessionExercise.exerciseId,
		order: 1,
		side: 'bilateral' as const,
		weightInput: owner === 'user-a' ? '100' : '999',
		weight: owner === 'user-a' ? 100 : 999,
		repsInput: '5',
		reps: 5,
		rirInput: '',
		createdAt,
		updatedAt: createdAt
	};
	const database = {
		workoutSessions: {
			get: vi.fn(async (id: string) => {
				await options.beforeSessionRead?.();
				return id === session.id ? { ...session } : undefined;
			})
		},
		sessionExercises: {
			where: vi.fn(() => ({
				equals: () => ({
					toArray: async () => [{ ...sessionExercise }]
				})
			}))
		},
		sessionSets: {
			where: vi.fn(() => ({
				anyOf: () => ({
					toArray: async () => [{ ...sessionSet }]
				})
			}))
		}
	};

	return { database, session, sessionExercise, sessionSet };
}

describe('authenticated runtime ownership', () => {
	it('invalidates synchronously on auth transitions but not same-user token refreshes', async () => {
		const runtime = await import('./runtime');
		const authState = await import('$lib/auth-owned-state');
		const invalidate = vi.fn();
		authState.registerAuthOwnedVolatileInvalidator(invalidate);
		runtime.startAuthBridge();
		const emitAuth = runtimeMocks.authSubscriber;
		expect(emitAuth).not.toBeNull();
		const user = (id: string) => ({ id, email: `${id}@example.com`, user_metadata: {} });

		emitAuth!({ isLoading: false, user: user('user-1') });
		const userOneGeneration = authState.getAuthOwnedStateIdentity().generation;
		invalidate.mockClear();

		emitAuth!({ isLoading: false, user: user('user-1') });
		expect(authState.getAuthOwnedStateIdentity().generation).toBe(userOneGeneration);
		expect(invalidate).not.toHaveBeenCalled();

		emitAuth!({ isLoading: true, user: null });
		expect(authState.getAuthOwnedStateIdentity()).toMatchObject({
			ownerId: null,
			generation: userOneGeneration + 1,
			isResolved: false
		});
		expect(invalidate).toHaveBeenCalledOnce();

		emitAuth!({ isLoading: false, user: user('user-2') });
		expect(authState.getAuthOwnedStateIdentity()).toMatchObject({
			ownerId: 'user-2',
			generation: userOneGeneration + 2,
			isResolved: true
		});
		expect(invalidate).toHaveBeenCalledTimes(2);

		emitAuth!({ isLoading: false, user: null });
		expect(authState.getAuthOwnedStateIdentity()).toMatchObject({
			ownerId: null,
			generation: userOneGeneration + 3,
			isResolved: true
		});
		expect(invalidate).toHaveBeenCalledTimes(3);
	});

	it('does not activate a user returned by a stale auth lookup', async () => {
		const fetchedUser = deferred<{ id: string } | null>();
		runtimeMocks.getSupabaseUser.mockReturnValue(fetchedUser.promise);
		const runtime = await import('./runtime');
		const selection = runtime.selectBackend();

		runtimeMocks.authUserId = 'user-2';
		fetchedUser.resolve({ id: 'user-1' });
		await selection;

		expect(runtimeMocks.getDatabase).not.toHaveBeenCalled();
	});

	it('does not let an older user activation replace the current database', async () => {
		const userOneDatabase = deferred<object>();
		const userTwoDatabase = deferred<object>();
		runtimeMocks.getDatabase.mockImplementation((userId: string) =>
			userId === 'user-1' ? userOneDatabase.promise : userTwoDatabase.promise
		);
		const runtime = await import('./runtime');

		const openUserOne = runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => expect(runtimeMocks.getDatabase).toHaveBeenCalledWith('user-1'));
		const openUserTwo = runtime.openSupabaseRuntime('user-2');
		userTwoDatabase.resolve(createRuntimeDatabase('user-2'));
		await openUserTwo;
		userOneDatabase.resolve(createRuntimeDatabase('user-1'));
		await openUserOne;

		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'user-2'
		});
		expect(runtimeMocks.stopReplication).toHaveBeenCalledWith('user-1');
	});

	it('does not publish a reopened database after the active user changes', async () => {
		const reopenedUserOneDatabase = deferred<object>();
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			createRuntimeDatabase(userId)
		);
		runtimeMocks.reopenDatabase.mockReturnValue(reopenedUserOneDatabase.promise);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		const recovery = runtime.recoverClosedDatabase();
		await vi.waitFor(() => expect(runtimeMocks.reopenDatabase).toHaveBeenCalledWith('user-1'));
		await runtime.openSupabaseRuntime('user-2');
		reopenedUserOneDatabase.resolve(createRuntimeDatabase('user-1'));

		await expect(recovery).resolves.toBe(false);
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'user-2'
		});
	});

	it('binds an in-flight reconciliation to its original user and database', async () => {
		const reconciliation = deferred<void>();
		let capturedDependencies:
			| {
					db: { workouts: { get(id: string): Promise<unknown> } };
					getActiveSupabaseUserId(): string | null;
			  }
			| undefined;
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			createRuntimeDatabase(userId)
		);
		runtimeMocks.reconcileSupabaseDatabase.mockImplementation(async (dependencies) => {
			capturedDependencies = dependencies;
			await reconciliation.promise;
			return { tables: [] };
		});
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		const sync = runtime.syncNow();
		await vi.waitFor(() => expect(runtimeMocks.reconcileSupabaseDatabase).toHaveBeenCalledOnce());
		await runtime.openSupabaseRuntime('user-2');
		reconciliation.resolve();
		await sync;

		expect(capturedDependencies?.getActiveSupabaseUserId()).toBeNull();
		await expect(capturedDependencies?.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'user-1'
		});
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'user-2'
		});
	});

	it('invalidates old sync work when the same user signs in again', async () => {
		const reconciliation = deferred<void>();
		let capturedDependencies:
			| {
					db: { workouts: { get(id: string): Promise<unknown> } };
					getActiveSupabaseUserId(): string | null;
			  }
			| undefined;
		runtimeMocks.getDatabase
			.mockResolvedValueOnce(createRuntimeDatabase('first-login'))
			.mockResolvedValueOnce(createRuntimeDatabase('second-login'));
		runtimeMocks.reconcileSupabaseDatabase.mockImplementation(async (dependencies) => {
			capturedDependencies = dependencies;
			await reconciliation.promise;
			return { tables: [] };
		});
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		const sync = runtime.syncNow();
		await vi.waitFor(() => expect(runtimeMocks.reconcileSupabaseDatabase).toHaveBeenCalledOnce());
		runtime.clearSupabaseRuntimeState();
		await runtime.openSupabaseRuntime('user-1');
		reconciliation.resolve();
		await sync;

		expect(capturedDependencies?.getActiveSupabaseUserId()).toBeNull();
		await expect(capturedDependencies?.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'first-login'
		});
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({
			owner: 'second-login'
		});
	});
});

describe('authenticated transaction identity fence', () => {
	it('keeps a same-id session timer wholly on user A while user B waits', async () => {
		const sessionReadStarted = deferred<void>();
		const releaseSessionRead = deferred<void>();
		const userA = createSessionTimerRuntimeDatabase('user-a', {
			beforeSessionRead: async () => {
				sessionReadStarted.resolve();
				await releaseSessionRead.promise;
			}
		});
		const userB = createSessionTimerRuntimeDatabase('user-b');
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		const runtime = await import('./runtime');

		runtimeMocks.authUserId = 'user-a';
		await runtime.openSupabaseRuntime('user-a');
		const timer = runtime.getSessionTimerSummary(userA.session.id);
		await sessionReadStarted.promise;

		runtimeMocks.authUserId = 'user-b';
		const switchUser = runtime.openSupabaseRuntime('user-b');
		await Promise.resolve();
		expect(runtimeMocks.getDatabase).not.toHaveBeenCalledWith('user-b');
		expect(userB.database.sessionExercises.where).not.toHaveBeenCalled();
		expect(userB.database.sessionSets.where).not.toHaveBeenCalled();

		releaseSessionRead.resolve();
		await expect(timer).resolves.toMatchObject({
			id: userA.session.id,
			workoutNameSnapshot: 'user-a workout',
			totalExercises: 1,
			totalSets: 1,
			totalReps: 5,
			totalVolume: 500
		});
		await switchUser;

		expect(userA.database.sessionExercises.where).toHaveBeenCalledOnce();
		expect(userA.database.sessionSets.where).toHaveBeenCalledOnce();
		expect(userB.database.workoutSessions.get).not.toHaveBeenCalled();
		expect(userB.database.sessionExercises.where).not.toHaveBeenCalled();
		expect(userB.database.sessionSets.where).not.toHaveBeenCalled();
	});

	it('pins user A from prefetch through a later transaction before publishing user B', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const userB = createTransactionalRuntimeDatabase('user-b');
		const transactionStarted = deferred<void>();
		const releaseTransaction = deferred<void>();
		const observedOwners: string[] = [];
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const transaction = runtime.runAuthenticatedDatabaseOperation(async (operation) => {
			observedOwners.push((await operation.database.workouts.get('workout-1'))?.name ?? 'missing');
			transactionStarted.resolve();
			await releaseTransaction.promise;

			await operation.database.transaction('rw', operation.database.workouts, async () => {
				await operation.database.workouts.update('workout-1', {});
				observedOwners.push(
					(await operation.database.workouts.get('workout-1'))?.name ?? 'missing'
				);
			});
		});
		await transactionStarted.promise;

		const switchUser = runtime.openSupabaseRuntime('user-b');
		await Promise.resolve();
		expect(runtimeMocks.getDatabase).not.toHaveBeenCalledWith('user-b');
		const staleTransactionCallback = vi.fn();
		await expect(runtime.db.transaction('rw', staleTransactionCallback)).rejects.toThrow(
			'authenticated local database changed'
		);
		const staleOperationCallback = vi.fn();
		await expect(runtime.runAuthenticatedDatabaseOperation(staleOperationCallback)).rejects.toThrow(
			'authenticated local database changed'
		);

		releaseTransaction.resolve();
		await transaction;
		await switchUser;

		expect(observedOwners).toEqual(['user-a', 'user-a']);
		expect(userA.writes).toEqual(['workout-1']);
		expect(userB.writes).toEqual([]);
		expect(staleTransactionCallback).not.toHaveBeenCalled();
		expect(staleOperationCallback).not.toHaveBeenCalled();
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({ name: 'user-b' });
	});

	it('lets an admitted operation finish on sign-out before detaching its database', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const transactionStarted = deferred<void>();
		const releaseTransaction = deferred<void>();
		runtimeMocks.getDatabase.mockResolvedValue(userA.database);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const transaction = runtime.runAuthenticatedDatabaseOperation(async (operation) => {
			await operation.database.transaction('rw', operation.database.workouts, async () => {
				transactionStarted.resolve();
				await releaseTransaction.promise;
				await operation.database.workouts.update('workout-1', {});
			});
		});
		await transactionStarted.promise;

		const signOut = runtime.clearSupabaseRuntimeState();
		await Promise.resolve();
		expect(userA.writes).toEqual([]);

		releaseTransaction.resolve();
		await transaction;
		await signOut;

		expect(userA.writes).toEqual(['workout-1']);
		expect(runtime.db.workouts).toBeUndefined();
	});

	it('recovers an admitted operation on user A before publishing user B', async () => {
		const closedError = new Error('Database has been closed');
		const userA = createTransactionalRuntimeDatabase('user-a');
		const reopenedUserA = createTransactionalRuntimeDatabase('user-a-reopened');
		const userB = createTransactionalRuntimeDatabase('user-b');
		const reopenedDatabase = deferred<object>();
		userA.workouts.get.mockRejectedValue(closedError);
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		runtimeMocks.reopenDatabase.mockReturnValue(reopenedDatabase.promise);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const transaction = runtime.runAuthenticatedDatabaseOperation(async (operation) => {
			await operation.database.transaction('rw', operation.database.workouts, async () => {
				await operation.database.workouts.get('workout-1');
				await operation.database.workouts.update('workout-1', {});
			});
		});
		await vi.waitFor(() => expect(runtimeMocks.reopenDatabase).toHaveBeenCalledWith('user-a'));

		const switchUser = runtime.openSupabaseRuntime('user-b');
		reopenedDatabase.resolve(reopenedUserA.database);

		await expect(transaction).resolves.toBeUndefined();
		await switchUser;

		expect(userA.writes).toEqual([]);
		expect(reopenedUserA.writes).toEqual(['workout-1']);
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({ name: 'user-b' });
	});

	it('invalidates captured operation facades when their callback finishes', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		runtimeMocks.getDatabase.mockResolvedValue(userA.database);
		const runtime = await import('./runtime');
		let capturedDatabase: AuthenticatedOperationDatabase | undefined;

		await runtime.openSupabaseRuntime('user-a');
		const capturedTable = await runtime.runAuthenticatedDatabaseOperation((operation) => {
			capturedDatabase = operation.database;
			return operation.database.workouts;
		});

		expect(() => capturedDatabase!.workouts).toThrow('operation has already finished');
		await expect(capturedTable!.get('workout-1')).rejects.toThrow('operation has already finished');
		expect(() => capturedDatabase!.transaction('rw', vi.fn())).toThrow(
			'operation has already finished'
		);
	});

	it('binds query builders to the operation and invalidates captured terminals', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const queryResult = {
			toArray: vi.fn(async () => [{ id: 'workout-1', name: 'user-a' }]),
			first: vi.fn(async () => ({ id: 'workout-1', name: 'user-a' })),
			sortBy: vi.fn(async () => [{ id: 'workout-1', name: 'user-a' }])
		};
		const database = {
			...userA.database,
			workouts: {
				...userA.workouts,
				where: vi.fn(() => ({
					equals: vi.fn(() => queryResult)
				}))
			}
		};
		runtimeMocks.getDatabase.mockResolvedValue(database);
		const runtime = await import('./runtime');
		let capturedQuery: QueryResult<{ id: string; name: string }> | undefined;

		await runtime.openSupabaseRuntime('user-a');
		const rows = await runtime.runAuthenticatedDatabaseOperation(async (operation) => {
			capturedQuery = operation.database.workouts.where('id').equals('workout-1');
			return capturedQuery.toArray();
		});

		expect(rows).toEqual([{ id: 'workout-1', name: 'user-a' }]);
		await expect(capturedQuery!.first()).rejects.toThrow('operation has already finished');
		expect(queryResult.first).not.toHaveBeenCalled();
	});
});

describe('authenticated direct-operation identity fence', () => {
	it('waits for a captured user-A write and rejects a second captured write during user switch', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const userB = createTransactionalRuntimeDatabase('user-b');
		const writeStarted = deferred<void>();
		const releaseWrite = deferred<void>();
		userA.workouts.update.mockImplementationOnce(async (id: string) => {
			writeStarted.resolve();
			await releaseWrite.promise;
			userA.writes.push(id);
			return 1;
		});
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const capturedUserATable = runtime.db.workouts;
		const admittedWrite = capturedUserATable.update('admitted-write', {});
		await writeStarted.promise;

		const switchUser = runtime.openSupabaseRuntime('user-b');
		await Promise.resolve();
		expect(runtimeMocks.getDatabase).not.toHaveBeenCalledWith('user-b');
		expect(() => runtime.requireLoggedInUser()).toThrow('Sign in with Google');
		await expect(capturedUserATable.update('stale-write', {})).rejects.toThrow(
			'authenticated local database changed'
		);
		expect(userA.workouts.update).toHaveBeenCalledOnce();

		releaseWrite.resolve();
		await admittedWrite;
		await switchUser;

		expect(userA.writes).toEqual(['admitted-write']);
		expect(userB.writes).toEqual([]);
		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({ name: 'user-b' });
	});

	it('rejects a new direct write while sign-out drains an admitted write', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const writeStarted = deferred<void>();
		const releaseWrite = deferred<void>();
		userA.workouts.update.mockImplementationOnce(async (id: string) => {
			writeStarted.resolve();
			await releaseWrite.promise;
			userA.writes.push(id);
			return 1;
		});
		runtimeMocks.getDatabase.mockResolvedValue(userA.database);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const admittedWrite = runtime.db.workouts.update('admitted-write', {});
		await writeStarted.promise;

		const signOut = runtime.clearSupabaseRuntimeState();
		await expect(runtime.db.workouts.update('post-sign-out-write', {})).rejects.toThrow(
			'authenticated local database changed'
		);
		expect(() => runtime.requireLoggedInUser()).toThrow('Sign in with Google');
		expect(userA.workouts.update).toHaveBeenCalledOnce();

		releaseWrite.resolve();
		await admittedWrite;
		await signOut;

		expect(userA.writes).toEqual(['admitted-write']);
		expect(runtime.db.workouts).toBeUndefined();
	});

	it('leases a query terminal and rejects another terminal after the identity changes', async () => {
		const userA = createTransactionalRuntimeDatabase('user-a');
		const userB = createTransactionalRuntimeDatabase('user-b');
		const queryStarted = deferred<void>();
		const releaseQuery = deferred<void>();
		const queryResult = {
			toArray: vi.fn(async () => {
				queryStarted.resolve();
				await releaseQuery.promise;
				return [{ id: 'workout-1', name: 'user-a' }];
			}),
			first: vi.fn(async () => ({ id: 'workout-1', name: 'user-a' })),
			sortBy: vi.fn(async () => [{ id: 'workout-1', name: 'user-a' }])
		};
		const whereClause = {
			equals: vi.fn(() => queryResult),
			anyOf: vi.fn(() => queryResult),
			between: vi.fn(() => queryResult)
		};
		const userADatabase = {
			...userA.database,
			workouts: {
				...userA.workouts,
				where: vi.fn(() => whereClause)
			}
		};
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userADatabase : userB.database
		);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const capturedQuery = runtime.db.workouts.where('id').equals('workout-1');
		const admittedQuery = capturedQuery.toArray();
		await queryStarted.promise;

		const switchUser = runtime.openSupabaseRuntime('user-b');
		await expect(capturedQuery.first()).rejects.toThrow('authenticated local database changed');
		expect(queryResult.first).not.toHaveBeenCalled();

		releaseQuery.resolve();
		await expect(admittedQuery).resolves.toEqual([{ id: 'workout-1', name: 'user-a' }]);
		await switchUser;

		await expect(runtime.db.workouts.get('workout-1')).resolves.toMatchObject({ name: 'user-b' });
	});
});

describe('generation-bound exercise mutations', () => {
	it('fails an ambient exercise mutation closed when identity changes before its write', async () => {
		const queryStarted = deferred<void>();
		const releaseQuery = deferred<void>();
		const userA = createExerciseRuntimeDatabase('user-a', {
			beforeExerciseQuery: async () => {
				queryStarted.resolve();
				await releaseQuery.promise;
			}
		});
		const userB = createExerciseRuntimeDatabase('user-b');
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		const runtime = await import('./runtime');
		const { createCustomExercise } = await import('./exercises');

		await runtime.openSupabaseRuntime('user-a');
		const createExercise = createCustomExercise('Cable Fly');
		await queryStarted.promise;

		const switchUser = runtime.openSupabaseRuntime('user-b');
		await Promise.resolve();
		expect(runtimeMocks.getDatabase).not.toHaveBeenCalledWith('user-b');

		releaseQuery.resolve();
		await expect(createExercise).rejects.toThrow('authenticated local database changed');
		await switchUser;

		expect(userA.exercises).toEqual([]);
		expect(userA.exerciseTable.add).not.toHaveBeenCalled();
		expect(userB.exercises).toEqual([]);
		expect(userB.exerciseTable.add).not.toHaveBeenCalled();
	});

	it('does not let an unrelated old-generation transaction admit a same-table write', async () => {
		const userA = createExerciseRuntimeDatabase('user-a');
		const userB = createExerciseRuntimeDatabase('user-b');
		const transactionStarted = deferred<void>();
		const releaseTransaction = deferred<void>();
		runtimeMocks.getDatabase.mockImplementation(async (userId: string) =>
			userId === 'user-a' ? userA.database : userB.database
		);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-a');
		const oldTransaction = runtime.db.transaction('rw', runtime.db.exercises, async () => {
			transactionStarted.resolve();
			await releaseTransaction.promise;
		});
		await transactionStarted.promise;

		const switchUser = runtime.openSupabaseRuntime('user-b');
		const staleExercise = {
			id: 'stale-exercise',
			name: 'Stale exercise',
			normalizedName: 'stale exercise',
			unilateral: false,
			source: 'custom' as const,
			archived: false,
			createdAt: '2026-07-15T12:00:00.000Z',
			updatedAt: '2026-07-15T12:00:00.000Z'
		};
		await expect(runtime.db.exercises.add(staleExercise)).rejects.toThrow(
			'authenticated local database changed'
		);
		expect(userA.exerciseTable.add).not.toHaveBeenCalled();

		releaseTransaction.resolve();
		await oldTransaction;
		await switchUser;

		expect(userA.exercises).toEqual([]);
		expect(userB.exercises).toEqual([]);
	});
});

describe('progressive cloud sync', () => {
	it('allows a retry after replication fails', async () => {
		const replicationError = new Error('temporary replication failure');
		runtimeMocks.awaitInitialReplication
			.mockRejectedValueOnce(replicationError)
			.mockResolvedValue(undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => {
			expect(runtime.db.cloud.syncState.value.status).toBe('error');
		});

		runtime.startProgressiveSync('user-1');

		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledTimes(2);
			expect(runtime.db.cloud.syncState.value.status).toBe('synced');
		});
		expect(warn).toHaveBeenCalledWith('Background Supabase sync failed.', replicationError);
		warn.mockRestore();
	});

	it('does not let an old same-user attempt release a newer login attempt guard', async () => {
		const oldReplication = deferred<void>();
		const currentReplication = deferred<void>();
		const oldError = new Error('old login replication failed');
		runtimeMocks.awaitInitialReplication
			.mockImplementationOnce(() => oldReplication.promise)
			.mockImplementationOnce(() => currentReplication.promise)
			.mockResolvedValue(undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledTimes(1);
		});

		runtime.clearSupabaseRuntimeState();
		await runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledTimes(2);
		});

		oldReplication.reject(oldError);
		await vi.waitFor(() => {
			expect(warn).toHaveBeenCalledWith('Background Supabase sync failed.', oldError);
		});

		runtime.startProgressiveSync('user-1');
		await Promise.resolve();
		await Promise.resolve();
		expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledTimes(2);

		currentReplication.resolve();
		await vi.waitFor(() => {
			expect(runtime.db.cloud.syncState.value.status).toBe('synced');
		});
		warn.mockRestore();
	});

	it('releases an attempt that becomes inactive before replication starts', async () => {
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => {
			expect(runtime.db.cloud.syncState.value.status).toBe('synced');
		});

		runtime.startProgressiveSync('user-2');
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		await runtime.openSupabaseRuntime('user-2');

		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledWith('user-2');
		});
	});
});

describe('direct session hydration', () => {
	it('warns and rejects when Supabase hydration fails', async () => {
		const hydrationError = new Error('expired Supabase session');
		runtimeMocks.hydrationError = hydrationError;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');

		await expect(runtime.hydrateSessionFromSupabase('session-1')).rejects.toBe(hydrationError);
		expect(warn).toHaveBeenCalledWith(
			'Direct session hydration from Supabase failed.',
			hydrationError
		);
		warn.mockRestore();
	});
});
