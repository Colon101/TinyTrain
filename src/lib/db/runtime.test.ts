import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
	backfillRecentRows: vi.fn(),
	awaitInitialReplication: vi.fn(),
	awaitInSync: vi.fn(),
	getDatabase: vi.fn(),
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
		backfillRecentRows: runtimeMocks.backfillRecentRows
	}
}));

vi.mock('../rxdb-dexie-adapter', () => ({
	getRxDexieLikeDatabase: runtimeMocks.getDatabase,
	reopenRxDexieLikeDatabase: runtimeMocks.getDatabase,
	subscribeToRxDexieChanges: () => ({ unsubscribe: vi.fn() })
}));

vi.mock('../rxdb', () => ({
	awaitSupabaseInitialReplication: runtimeMocks.awaitInitialReplication,
	awaitSupabaseInSync: runtimeMocks.awaitInSync,
	stopSupabaseReplication: vi.fn()
}));

vi.mock('../supabase', () => ({
	getSupabaseAuthSnapshot: () => ({
		isLoading: false,
		user: {
			id: 'user-1',
			email: 'user@example.com',
			user_metadata: {}
		}
	}),
	getSupabaseUser: async () => ({ id: 'user-1' }),
	initializeSupabaseAuth: vi.fn(),
	loginWithSupabaseGoogle: vi.fn(),
	logoutFromSupabase: vi.fn(),
	subscribeToSupabaseAuth: vi.fn(),
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
	runtimeMocks.awaitInitialReplication.mockReset().mockResolvedValue(undefined);
	runtimeMocks.awaitInSync.mockReset().mockResolvedValue(undefined);
	runtimeMocks.getDatabase.mockReset().mockResolvedValue(runtimeMocks.database);
	runtimeMocks.hydrationError = null;
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
