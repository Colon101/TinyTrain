import type { RxCollection } from 'rxdb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

beforeEach(() => {
	rxdbMocks.getTinyTrainRxDatabase.mockReset();
	rxdbMocks.reopenTinyTrainRxDatabase.mockReset();
	rxdbMocks.startSupabaseReplication.mockReset().mockResolvedValue(undefined);
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
