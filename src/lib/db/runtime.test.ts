import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
	backfillRecentRows: vi.fn(),
	reconcileSupabaseDatabase: vi.fn(),
	awaitInitialReplication: vi.fn(),
	awaitInSync: vi.fn(),
	getDatabase: vi.fn(),
	reopenDatabase: vi.fn(),
	stopReplication: vi.fn(),
	getSupabaseUser: vi.fn(),
	authSubscriber: null as
		| null
		| ((snapshot: {
				user: { id: string; email: string; user_metadata: Record<string, unknown> } | null;
				isLoading: boolean;
		  }) => void),
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
	subscribeToSupabaseAuth: vi.fn((subscriber: NonNullable<typeof runtimeMocks.authSubscriber>) => {
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

describe('authenticated runtime ownership', () => {
	it('invalidates auth-owned state on account changes but not token refreshes', async () => {
		const runtime = await import('./runtime');
		const authState = await import('$lib/auth-owned-state');
		const invalidate = vi.fn();
		authState.registerAuthOwnedVolatileInvalidator(invalidate);
		runtime.startAuthBridge();
		const emitAuth = runtimeMocks.authSubscriber;
		const user = (id: string) => ({
			id,
			email: `${id}@example.com`,
			user_metadata: {}
		});

		expect(emitAuth).not.toBeNull();
		emitAuth!({ isLoading: false, user: user('user-1') });
		const userOneIdentity = authState.getAuthOwnedStateIdentity();
		invalidate.mockClear();
		emitAuth!({ isLoading: false, user: user('user-1') });

		expect(authState.getAuthOwnedStateIdentity()).toBe(userOneIdentity);
		expect(invalidate).not.toHaveBeenCalled();

		emitAuth!({ isLoading: false, user: user('user-2') });
		expect(authState.getAuthOwnedStateIdentity()).toMatchObject({
			ownerId: 'user-2',
			generation: userOneIdentity.generation + 1,
			isResolved: true
		});
		expect(invalidate).toHaveBeenCalledOnce();
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
			expect(warn).toHaveBeenCalledWith('Background Supabase sync failed.', replicationError);
		});

		runtime.startProgressiveSync('user-1');

		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledTimes(2);
			expect(runtimeMocks.awaitInSync).toHaveBeenCalledWith('user-1', { timeoutMs: 15000 });
		});
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
			expect(runtimeMocks.awaitInSync).toHaveBeenCalledWith('user-1', { timeoutMs: 15000 });
		});
		warn.mockRestore();
	});

	it('releases an attempt that becomes inactive before replication starts', async () => {
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');
		await vi.waitFor(() => {
			expect(runtimeMocks.awaitInitialReplication).toHaveBeenCalledWith('user-1');
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

describe('visible session hydration', () => {
	it('warns and rejects when Supabase hydration fails', async () => {
		const hydrationError = new Error('expired Supabase session');
		runtimeMocks.hydrationError = hydrationError;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const runtime = await import('./runtime');

		await runtime.openSupabaseRuntime('user-1');

		await expect(
			runtime.hydrateVisibleScope({ type: 'session', sessionId: 'session-1' })
		).rejects.toBe(hydrationError);
		expect(warn).toHaveBeenCalledWith(
			'Direct session hydration from Supabase failed.',
			hydrationError
		);
		warn.mockRestore();
	});
});
