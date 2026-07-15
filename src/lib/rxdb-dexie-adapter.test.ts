import type { RxCollection } from 'rxdb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rxdbMocks = vi.hoisted(() => ({
	getTinyTrainRxDatabase: vi.fn(),
	reopenTinyTrainRxDatabase: vi.fn(),
	startSupabaseReplication: vi.fn()
}));

vi.mock('./rxdb', () => rxdbMocks);

import {
	getRxDexieLikeDatabase,
	reopenRxDexieLikeDatabase,
	RxTableAdapter
} from './rxdb-dexie-adapter';
import { getAddedSessionExerciseId } from './db/sessions/schedule-identity';

type TestDoc = {
	id: string;
	user_id?: string;
	value: number | string;
};

function createCollection<T extends { id: string }>(rows: T[] = []) {
	return {
		$: {
			subscribe: vi.fn()
		},
		find: vi.fn(() => ({
			exec: async () => rows.map((row) => ({ toMutableJSON: () => ({ ...row }) }))
		}))
	} as unknown as RxCollection<T>;
}

function createDatabase() {
	return {
		exercises: createCollection(),
		workouts: createCollection(),
		workoutExercises: createCollection(),
		workoutSessions: createCollection(),
		sessionExercises: createCollection(),
		sessionSets: createCollection(),
		exerciseResetEvents: createCollection()
	};
}

function createTable(values: Array<number | string>) {
	const rows = values.map((value, index) => ({ id: `row-${index}`, value }));
	return new RxTableAdapter<TestDoc>(createCollection(rows), 'user-1', 'workouts');
}

function createRemoveTable(removeResult: { success: unknown[]; error: unknown[] }) {
	const bulkRemove = vi
		.fn()
		.mockResolvedValueOnce(removeResult)
		.mockImplementation(async (ids: string[]) => ({
			success: ids.map((primary) => ({ primary })),
			error: []
		}));
	const collection = {
		$: {
			subscribe: vi.fn()
		},
		storageInstance: {
			findDocumentsById: vi.fn().mockResolvedValue([])
		},
		bulkRemove
	} as unknown as RxCollection<TestDoc>;

	return {
		bulkRemove,
		table: new RxTableAdapter<TestDoc>(collection, 'user-1', 'workouts')
	};
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

function createLockManagerHarness() {
	const queueTails = new Map<string, Promise<void>>();
	const requestedNames: string[] = [];
	const request = vi.fn(
		<T>(
			name: string,
			_options: LockOptions,
			callback: (lock: Lock | null) => Promise<T> | T
		): Promise<T> => {
			requestedNames.push(name);
			const previous = queueTails.get(name) ?? Promise.resolve();
			const result = previous.then(
				() => callback({ name, mode: 'exclusive' } as Lock),
				() => callback({ name, mode: 'exclusive' } as Lock)
			);
			const queueTail = result.then(
				() => undefined,
				() => undefined
			);

			queueTails.set(name, queueTail);
			return result;
		}
	);

	return { lockManager: { request }, requestedNames };
}

beforeEach(() => {
	vi.unstubAllGlobals();
	rxdbMocks.getTinyTrainRxDatabase.mockReset();
	rxdbMocks.reopenTinyTrainRxDatabase.mockReset();
	rxdbMocks.startSupabaseReplication.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('RxTableAdapter range queries', () => {
	it('compares numeric bounds numerically without coercing mixed field types', async () => {
		const table = createTable([8, 9, 10, 11, '10']);

		const result = await table.where('value').between(9, 10, true, true).toArray();

		expect(result.map((row) => row.value)).toEqual([9, 10]);
	});

	it('preserves lexicographic ranges for string date keys', async () => {
		const table = createTable(['2026-05-01', '2026-05-02', '2026-05-10', '2026-06-01']);

		const result = await table
			.where('value')
			.between('2026-05-02', '2026-05-10', true, true)
			.toArray();

		expect(result.map((row) => row.value)).toEqual(['2026-05-02', '2026-05-10']);
	});

	it.each([
		{ includeLower: true, includeUpper: true, expected: [9, 10, 11] },
		{ includeLower: true, includeUpper: false, expected: [9, 10] },
		{ includeLower: false, includeUpper: true, expected: [10, 11] },
		{ includeLower: false, includeUpper: false, expected: [10] }
	])(
		'honors includeLower=$includeLower and includeUpper=$includeUpper',
		async ({ includeLower, includeUpper, expected }) => {
			const table = createTable([8, 9, 10, 11, 12]);

			const result = await table
				.where('value')
				.between(9, 11, includeLower, includeUpper)
				.toArray();

			expect(result.map((row) => row.value)).toEqual(expected);
		}
	);
});

describe('RxTableAdapter sync state', () => {
	it('exposes a storage tombstone only through the sync lookup', async () => {
		const findDocumentsById = vi.fn().mockResolvedValue([
			{
				id: 'row-1',
				user_id: 'user-1',
				value: 42,
				_deleted: true,
				_attachments: {},
				_meta: { lwt: 1 },
				_rev: '1-deleted'
			}
		]);
		const collection = {
			$: { subscribe: vi.fn() },
			find: vi.fn(() => ({ exec: async () => [] })),
			findOne: vi.fn(() => ({ exec: async () => null })),
			storageInstance: { findDocumentsById }
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'workouts');

		await expect(table.get('row-1')).resolves.toBeUndefined();
		await expect(table.toArray()).resolves.toEqual([]);
		await expect(table.getSyncState('row-1')).resolves.toEqual({
			row: { id: 'row-1', user_id: 'user-1', value: 42 },
			deleted: true
		});
		expect(findDocumentsById).toHaveBeenCalledWith(['row-1'], true);
	});

	it('reports true absence when storage has no live row or tombstone', async () => {
		const findDocumentsById = vi.fn().mockResolvedValue([]);
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById }
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'workouts');

		await expect(table.getSyncState('missing-row')).resolves.toBeUndefined();
		expect(findDocumentsById).toHaveBeenCalledWith(['missing-row'], true);
	});

	it('resurrects a compensated same-base id but inserts a fresh post-removal id', async () => {
		const compensatedId = getAddedSessionExerciseId(
			'session-1',
			'exercise-1',
			'2026-07-15T10:00:00.000Z'
		);
		const readdedId = getAddedSessionExerciseId(
			'session-1',
			'exercise-1',
			'2026-07-15T10:01:00.000Z'
		);
		const tombstone = {
			id: compensatedId,
			user_id: 'user-1',
			value: 'compensated',
			_deleted: true,
			_attachments: {},
			_meta: { lwt: 1 },
			_rev: '1-deleted'
		};
		const findDocumentsById = vi.fn(async (ids: string[]) =>
			ids.includes(compensatedId) ? [tombstone] : []
		);
		const bulkUpsert = vi.fn(async (rows: Array<{ id: string }>) => ({
			success: rows.map(({ id }) => ({ primary: id })),
			error: []
		}));
		const bulkInsert = vi.fn(async (rows: Array<{ id: string }>) => ({
			success: rows.map(({ id }) => ({ primary: id })),
			error: []
		}));
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById },
			bulkUpsert,
			bulkInsert,
			bulkRemove: vi.fn()
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'sessionExercises');

		await expect(table.bulkPut([{ id: compensatedId, value: 'retry' }])).resolves.toEqual([
			compensatedId
		]);
		await expect(table.bulkAdd([{ id: readdedId, value: 're-added' }])).resolves.toEqual([
			readdedId
		]);

		expect(readdedId).not.toBe(compensatedId);
		expect(bulkUpsert).toHaveBeenCalledWith([
			{ id: compensatedId, user_id: 'user-1', value: 'retry' }
		]);
		expect(bulkInsert).toHaveBeenCalledWith([
			{ id: readdedId, user_id: 'user-1', value: 're-added' }
		]);
	});
});

describe('RxTableAdapter partial batch compensation', () => {
	it('removes successful inserts before rethrowing a partial bulkAdd failure', async () => {
		const originalError = { status: 409, documentId: 'row-2', isError: true };
		const bulkInsert = vi.fn().mockResolvedValue({
			success: [{ primary: 'row-1' }],
			error: [originalError]
		});
		const bulkRemove = vi.fn().mockResolvedValue({
			success: [{ primary: 'row-1' }],
			error: []
		});
		const findDocumentsById = vi.fn().mockResolvedValue([]);
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById },
			bulkInsert,
			bulkRemove
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'sessionSets');

		await expect(
			table.bulkAdd([
				{ id: 'row-1', value: 1 },
				{ id: 'row-2', value: 2 }
			])
		).rejects.toBe(originalError);

		expect(findDocumentsById).toHaveBeenCalledWith(['row-1', 'row-2'], true);
		expect(bulkRemove).toHaveBeenCalledOnce();
		expect(bulkRemove).toHaveBeenCalledWith(['row-1']);
	});

	it('restores prior rows before rethrowing a partial bulkPut failure', async () => {
		const originalError = { status: 500, documentId: 'row-2', isError: true };
		const previousRows = [
			{ id: 'row-1', user_id: 'user-1', value: 'old-1', _deleted: false },
			{ id: 'row-2', user_id: 'user-1', value: 'old-2', _deleted: false }
		];
		const bulkUpsert = vi
			.fn()
			.mockResolvedValueOnce({ success: [{ primary: 'row-1' }], error: [originalError] })
			.mockResolvedValueOnce({ success: [{ primary: 'row-1' }], error: [] });
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById: vi.fn().mockResolvedValue(previousRows) },
			bulkUpsert,
			bulkRemove: vi.fn()
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'sessionSets');

		await expect(
			table.bulkPut([
				{ id: 'row-1', value: 'new-1' },
				{ id: 'row-2', value: 'new-2' }
			])
		).rejects.toBe(originalError);

		expect(bulkUpsert).toHaveBeenCalledTimes(2);
		expect(bulkUpsert).toHaveBeenNthCalledWith(2, [
			{ id: 'row-1', user_id: 'user-1', value: 'old-1' }
		]);
	});

	it('restores successfully removed rows before rethrowing a partial bulkDelete failure', async () => {
		const originalError = { status: 500, documentId: 'row-2', isError: true };
		const previousRows = [
			{ id: 'row-1', user_id: 'user-1', value: 'old-1', _deleted: false },
			{ id: 'row-2', user_id: 'user-1', value: 'old-2', _deleted: false }
		];
		const bulkRemove = vi.fn().mockResolvedValue({
			success: [{ primary: 'row-1' }],
			error: [originalError]
		});
		const bulkUpsert = vi.fn().mockResolvedValue({
			success: [{ primary: 'row-1' }],
			error: []
		});
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById: vi.fn().mockResolvedValue(previousRows) },
			bulkRemove,
			bulkUpsert
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'sessionSets');

		await expect(table.bulkDelete(['row-1', 'row-2'])).rejects.toBe(originalError);

		expect(bulkRemove).toHaveBeenCalledOnce();
		expect(bulkUpsert).toHaveBeenCalledOnce();
		expect(bulkUpsert).toHaveBeenCalledWith([{ id: 'row-1', user_id: 'user-1', value: 'old-1' }]);
	});

	it('retains the original error as the cause when compensation also fails', async () => {
		const originalError = { status: 409, documentId: 'row-2', isError: true };
		const compensationError = { status: 500, documentId: 'row-1', isError: true };
		const collection = {
			$: { subscribe: vi.fn() },
			storageInstance: { findDocumentsById: vi.fn().mockResolvedValue([]) },
			bulkInsert: vi.fn().mockResolvedValue({
				success: [{ primary: 'row-1' }],
				error: [originalError]
			}),
			bulkRemove: vi.fn().mockResolvedValue({ success: [], error: [compensationError] })
		} as unknown as RxCollection<TestDoc>;
		const table = new RxTableAdapter<TestDoc>(collection, 'user-1', 'sessionSets');

		await expect(
			table.bulkAdd([
				{ id: 'row-1', value: 1 },
				{ id: 'row-2', value: 2 }
			])
		).rejects.toMatchObject({
			name: 'BulkMutationCompensationError',
			message: 'Bulk insert failed and its partial-write compensation also failed.',
			cause: originalError,
			compensationError
		});
	});
});

describe('RxTableAdapter deletes', () => {
	it('completes a successful single delete', async () => {
		const { bulkRemove, table } = createRemoveTable({
			success: [{ primary: 'row-1' }],
			error: []
		});

		await expect(table.delete('row-1')).resolves.toBeUndefined();

		expect(bulkRemove).toHaveBeenCalledOnce();
		expect(bulkRemove).toHaveBeenCalledWith(['row-1']);
	});

	it('keeps deleting a missing row idempotent', async () => {
		const { bulkRemove, table } = createRemoveTable({ success: [], error: [] });

		await expect(table.delete('missing-row')).resolves.toBeUndefined();

		expect(bulkRemove).toHaveBeenCalledWith(['missing-row']);
	});

	it('rejects when a single remove reports a storage-write error', async () => {
		const removeError = { status: 409, documentId: 'row-1', isError: true };
		const { table } = createRemoveTable({ success: [], error: [removeError] });

		await expect(table.delete('row-1')).rejects.toBe(removeError);
	});

	it('completes a successful bulk delete', async () => {
		const { bulkRemove, table } = createRemoveTable({
			success: [{ primary: 'row-1' }, { primary: 'row-2' }],
			error: []
		});

		await expect(table.bulkDelete(['row-1', 'row-2'])).resolves.toBeUndefined();

		expect(bulkRemove).toHaveBeenCalledWith(['row-1', 'row-2']);
	});

	it('rejects a partially failed bulk delete instead of reporting success', async () => {
		const removeError = { status: 409, documentId: 'row-2', isError: true };
		const { bulkRemove, table } = createRemoveTable({
			success: [{ primary: 'row-1' }],
			error: [removeError]
		});

		await expect(table.bulkDelete(['row-1', 'row-2'])).rejects.toBe(removeError);

		expect(bulkRemove).toHaveBeenCalledWith(['row-1', 'row-2']);
	});

	it('does not call RxDB for an empty bulk delete', async () => {
		const { bulkRemove, table } = createRemoveTable({ success: [], error: [] });

		await expect(table.bulkDelete([])).resolves.toBeUndefined();

		expect(bulkRemove).not.toHaveBeenCalled();
	});
});

describe('RxDexieLikeDatabase initialization cache', () => {
	it('retries database initialization after opening the database fails', async () => {
		const openError = new Error('temporary IndexedDB failure');
		rxdbMocks.getTinyTrainRxDatabase
			.mockRejectedValueOnce(openError)
			.mockResolvedValueOnce(createDatabase());

		await expect(getRxDexieLikeDatabase('open-retry-user')).rejects.toBe(openError);
		const retried = await getRxDexieLikeDatabase('open-retry-user');
		const cached = await getRxDexieLikeDatabase('open-retry-user');

		expect(retried).toBe(cached);
		expect(rxdbMocks.getTinyTrainRxDatabase).toHaveBeenCalledTimes(2);
	});

	it('retries initialization after replication startup fails', async () => {
		const replicationError = new Error('temporary replication failure');
		rxdbMocks.getTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		rxdbMocks.startSupabaseReplication
			.mockRejectedValueOnce(replicationError)
			.mockResolvedValueOnce(undefined);

		await expect(getRxDexieLikeDatabase('replication-retry-user')).rejects.toBe(replicationError);
		await expect(getRxDexieLikeDatabase('replication-retry-user')).resolves.toBeDefined();

		expect(rxdbMocks.getTinyTrainRxDatabase).toHaveBeenCalledTimes(2);
		expect(rxdbMocks.startSupabaseReplication).toHaveBeenCalledTimes(2);
	});

	it('does not let an older failed initialization evict a newer reopened adapter', async () => {
		const staleOpen = createDeferred<ReturnType<typeof createDatabase>>();
		rxdbMocks.getTinyTrainRxDatabase
			.mockReturnValueOnce(staleOpen.promise)
			.mockResolvedValue(createDatabase());
		rxdbMocks.reopenTinyTrainRxDatabase.mockResolvedValue(createDatabase());

		const staleRequest = getRxDexieLikeDatabase('reopen-race-user');
		const staleRejection = expect(staleRequest).rejects.toThrow('stale open failed');
		const reopened = await reopenRxDexieLikeDatabase('reopen-race-user');

		staleOpen.reject(new Error('stale open failed'));
		await staleRejection;
		const cached = await getRxDexieLikeDatabase('reopen-race-user');

		expect(cached).toBe(reopened);
		expect(rxdbMocks.getTinyTrainRxDatabase).toHaveBeenCalledTimes(1);
	});

	it('retries a normal lookup after reopening fails', async () => {
		rxdbMocks.getTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		rxdbMocks.reopenTinyTrainRxDatabase.mockRejectedValue(new Error('reopen failed'));

		await expect(reopenRxDexieLikeDatabase('failed-reopen-user')).rejects.toThrow('reopen failed');
		await expect(getRxDexieLikeDatabase('failed-reopen-user')).resolves.toBeDefined();

		expect(rxdbMocks.getTinyTrainRxDatabase).toHaveBeenCalledTimes(1);
	});
});

describe('RxDexieLikeDatabase transaction serialization', () => {
	it('does not overlap transactions from independent adapters for the same user', async () => {
		const lockHarness = createLockManagerHarness();
		vi.stubGlobal('navigator', { locks: lockHarness.lockManager });
		rxdbMocks.getTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		rxdbMocks.reopenTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		const firstAdapter = await getRxDexieLikeDatabase('shared-lock-user');
		const secondAdapter = await reopenRxDexieLikeDatabase('shared-lock-user');
		const releaseFirst = createDeferred<void>();
		const order: string[] = [];
		let activeCallbacks = 0;
		let maximumActiveCallbacks = 0;

		const firstTransaction = firstAdapter.transaction('rw', async () => {
			order.push('first:start');
			activeCallbacks += 1;
			maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
			await releaseFirst.promise;
			activeCallbacks -= 1;
			order.push('first:end');
		});
		const secondTransaction = secondAdapter.transaction('rw', async () => {
			order.push('second:start');
			activeCallbacks += 1;
			maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
			activeCallbacks -= 1;
			order.push('second:end');
		});

		await vi.waitFor(() => expect(order).toEqual(['first:start']));
		releaseFirst.resolve();
		await Promise.all([firstTransaction, secondTransaction]);

		expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
		expect(maximumActiveCallbacks).toBe(1);
		expect(lockHarness.requestedNames).toEqual([
			'tinytrain:rxdb-transaction:shared-lock-user',
			'tinytrain:rxdb-transaction:shared-lock-user'
		]);
	});

	it('uses separate locks so one authenticated user cannot block another', async () => {
		const lockHarness = createLockManagerHarness();
		vi.stubGlobal('navigator', { locks: lockHarness.lockManager });
		rxdbMocks.getTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		const firstAdapter = await getRxDexieLikeDatabase('lock-user-a');
		const secondAdapter = await getRxDexieLikeDatabase('lock-user-b');
		const releaseFirst = createDeferred<void>();
		const firstStarted = createDeferred<void>();
		let secondCompleted = false;

		const firstTransaction = firstAdapter.transaction('rw', async () => {
			firstStarted.resolve();
			await releaseFirst.promise;
		});
		await firstStarted.promise;

		await secondAdapter.transaction('rw', () => {
			secondCompleted = true;
		});

		expect(secondCompleted).toBe(true);
		expect(lockHarness.requestedNames).toEqual([
			'tinytrain:rxdb-transaction:lock-user-a',
			'tinytrain:rxdb-transaction:lock-user-b'
		]);
		releaseFirst.resolve();
		await firstTransaction;
	});

	it('keeps same-tab transaction ordering when Web Locks are unavailable', async () => {
		vi.stubGlobal('navigator', undefined);
		rxdbMocks.getTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		rxdbMocks.reopenTinyTrainRxDatabase.mockResolvedValue(createDatabase());
		const firstAdapter = await getRxDexieLikeDatabase('fallback-queue-user');
		const secondAdapter = await reopenRxDexieLikeDatabase('fallback-queue-user');
		const releaseFirst = createDeferred<void>();
		const order: string[] = [];

		const firstTransaction = firstAdapter.transaction('rw', async () => {
			order.push('first:start');
			await releaseFirst.promise;
			order.push('first:end');
		});
		const secondTransaction = secondAdapter.transaction('rw', () => {
			order.push('second');
		});

		await vi.waitFor(() => expect(order).toEqual(['first:start']));
		releaseFirst.resolve();
		await Promise.all([firstTransaction, secondTransaction]);

		expect(order).toEqual(['first:start', 'first:end', 'second']);
	});
});
