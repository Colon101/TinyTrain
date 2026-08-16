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
		sessionSets: createCollection()
	};
}

function createTable(values: Array<number | string>) {
	const rows = values.map((value, index) => ({ id: `row-${index}`, value }));
	return new RxTableAdapter<TestDoc>(createCollection(rows), 'user-1', 'workouts');
}

function createVersionedCollection(
	initial?: TestDoc & { user_id?: string },
	initialVersion = '1-initial'
) {
	let state = initial ? { ...initial } : undefined;
	let version = initialVersion;
	const controls = {
		insertConflict: false,
		modifyConflict: false,
		removeConflict: false,
		revisionChangesBeforeModifier: false,
		revisionless: false
	};
	const conflict = () => Object.assign(new Error('write conflict'), { code: 'CONFLICT' });
	const modify = vi.fn(async (modifier: (document: TestDoc) => TestDoc | Promise<TestDoc>) => {
		if (controls.modifyConflict) {
			throw conflict();
		}
		if (controls.revisionChangesBeforeModifier) {
			version = '2-concurrent';
		}

		state = { ...(await modifier({ ...state! })) };
		version = '2-modified';
		return getDocument();
	});
	const remove = vi.fn(async () => {
		if (controls.removeConflict) {
			throw conflict();
		}

		state = undefined;
	});
	const getDocument = () =>
		state
			? {
					get revision() {
						return controls.revisionless ? undefined : version;
					},
					toMutableJSON: () => ({
						...state,
						_rev: version,
						_meta: { lwt: 1 },
						_attachments: {},
						_deleted: false
					}),
					modify,
					remove
				}
			: undefined;
	const insert = vi.fn(async (document: TestDoc) => {
		if (state || controls.insertConflict) {
			throw conflict();
		}

		state = { ...document };
		version = '1-inserted';
		return getDocument();
	});
	const collection = {
		$: { subscribe: vi.fn() },
		findByIds: vi.fn((ids: string[]) => ({
			exec: async () =>
				new Map(ids.flatMap((id) => (state?.id === id ? [[id, getDocument()]] : [])))
		})),
		findOne: vi.fn((id: string) => ({
			exec: async () => (state?.id === id ? getDocument() : undefined)
		})),
		insert
	};

	return {
		collection: collection as unknown as RxCollection<TestDoc>,
		controls,
		getState: () => state,
		getVersion: () => version,
		insert,
		modify,
		remove
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

describe('RxTableAdapter conditional writes', () => {
	it('returns revision-bearing public rows without RxDB or tenant metadata', async () => {
		const fixture = createVersionedCollection({
			id: 'row-1',
			value: 1,
			user_id: 'user-1'
		});
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.bulkGetVersioned(['row-1'])).resolves.toEqual([
			{ document: { id: 'row-1', value: 1 }, version: '1-initial' }
		]);
	});

	it('inserts only when the expected state is absent and forces the lease tenant', async () => {
		const fixture = createVersionedCollection();
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(
			table.compareAndPut(undefined, { id: 'row-1', value: 2, user_id: 'attacker' })
		).resolves.toBe(true);
		expect(fixture.getState()).toEqual({ id: 'row-1', value: 2, user_id: 'user-1' });
		await expect(table.compareAndPut(undefined, { id: 'row-1', value: 3 })).resolves.toBe(false);
	});

	it('returns false when a concurrent insert wins after the absence check', async () => {
		const fixture = createVersionedCollection();
		fixture.controls.insertConflict = true;
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.compareAndPut(undefined, { id: 'row-1', value: 2 })).resolves.toBe(false);
		expect(fixture.getState()).toBeUndefined();
	});

	it('updates only the exact expected revision and surfaces concurrent conflicts as false', async () => {
		const fixture = createVersionedCollection({ id: 'row-1', value: 1, user_id: 'user-1' });
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.compareAndPut('stale', { id: 'row-1', value: 2 })).resolves.toBe(false);
		expect(fixture.modify).not.toHaveBeenCalled();

		fixture.controls.modifyConflict = true;
		await expect(table.compareAndPut('1-initial', { id: 'row-1', value: 2 })).resolves.toBe(false);
		expect(fixture.getState()?.value).toBe(1);

		fixture.controls.modifyConflict = false;
		await expect(table.compareAndPut('1-initial', { id: 'row-1', value: 2 })).resolves.toBe(true);
		expect(fixture.getState()).toEqual({ id: 'row-1', value: 2, user_id: 'user-1' });
	});

	it('rejects a revision change between the outer check and modify callback', async () => {
		const fixture = createVersionedCollection({ id: 'row-1', value: 1, user_id: 'user-1' });
		fixture.controls.revisionChangesBeforeModifier = true;
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.compareAndPut('1-initial', { id: 'row-1', value: 2 })).resolves.toBe(false);
		expect(fixture.getState()?.value).toBe(1);
	});

	it('deletes only the exact expected revision and preserves concurrent writes', async () => {
		const fixture = createVersionedCollection({ id: 'row-1', value: 1, user_id: 'user-1' });
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.compareAndDelete('stale', 'row-1')).resolves.toBe(false);
		expect(fixture.remove).not.toHaveBeenCalled();

		fixture.controls.removeConflict = true;
		await expect(table.compareAndDelete('1-initial', 'row-1')).resolves.toBe(false);
		expect(fixture.getState()?.value).toBe(1);

		fixture.controls.removeConflict = false;
		await expect(table.compareAndDelete('1-initial', 'row-1')).resolves.toBe(true);
		expect(fixture.getState()).toBeUndefined();
	});

	it('rejects a persisted document without an RxDB revision', async () => {
		const fixture = createVersionedCollection({ id: 'row-1', value: 1, user_id: 'user-1' });
		fixture.controls.revisionless = true;
		const table = new RxTableAdapter<TestDoc>(fixture.collection, 'user-1', 'workoutExercises');

		await expect(table.bulkGetVersioned(['row-1'])).rejects.toThrow(
			'RxDB returned a document without a revision.'
		);
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
