import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompensationJournalStorage } from './compensation-journal';
import type { Exercise, SessionExercise, SessionSet, WorkoutSession } from './models';

class MemoryStorage implements CompensationJournalStorage {
	readonly values = new Map<string, string>();
	failWrites = false;

	get length() {
		return this.values.size;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		if (this.failWrites) throw new Error('storage write failed');
		this.values.set(key, value);
	}

	removeItem(key: string) {
		this.values.delete(key);
	}
}

const runtimeHarness = vi.hoisted(() => {
	type TableName = 'exercises' | 'sessionExercises' | 'sessionSets' | 'workoutSessions';
	type Row = Exercise | SessionExercise | SessionSet | WorkoutSession;
	type Failure = {
		table: TableName;
		method: string;
		message: string;
		onFail?: (database: TestDatabase) => void;
	};
	type Barrier = {
		table: TableName;
		field: string;
		value: unknown;
		entered: Promise<void>;
		release: () => void;
		markEntered: () => void;
		wait: Promise<void>;
	};
	type TestDatabase = ReturnType<typeof createDatabase>;

	function deferred() {
		let resolve = () => {};
		const promise = new Promise<void>((nextResolve) => {
			resolve = nextResolve;
		});
		return { promise, resolve };
	}

	function clone<T>(value: T): T {
		return structuredClone(value);
	}

	function createDatabase(name: string) {
		const rows = {
			exercises: new Map<string, Exercise>(),
			sessionExercises: new Map<string, SessionExercise>(),
			sessionSets: new Map<string, SessionSet>(),
			workoutSessions: new Map<string, WorkoutSession>()
		};
		const tombstones = {
			exercises: new Set<string>(),
			sessionExercises: new Set<string>(),
			sessionSets: new Set<string>(),
			workoutSessions: new Set<string>()
		};
		const failures: Failure[] = [];
		let barrier: Barrier | null = null;

		function maybeFail(table: TableName, method: string) {
			const index = failures.findIndex(
				(failure) => failure.table === table && failure.method === method
			);

			if (index === -1) {
				return;
			}

			const [failure] = failures.splice(index, 1);
			failure.onFail?.(database);
			throw new Error(failure.message);
		}

		function createTable<T extends Row>(tableName: TableName) {
			const tableRows = rows[tableName] as Map<string, T>;
			const tableTombstones = tombstones[tableName];

			return {
				toArray: vi.fn(async () => [...tableRows.values()].map(clone)),
				get: vi.fn(async (id: string) => {
					const row = tableRows.get(id);
					return row ? clone(row) : undefined;
				}),
				getSyncState: vi.fn(async (id: string) => {
					const row = tableRows.get(id);
					if (row) return { row: clone(row), deleted: false };
					return tableTombstones.has(id) ? { deleted: true } : undefined;
				}),
				bulkGet: vi.fn(async (ids: string[]) =>
					ids.map((id) => {
						const row = tableRows.get(id);
						return row ? clone(row) : undefined;
					})
				),
				add: vi.fn(async (row: T) => {
					if (tableRows.has(row.id) || tableTombstones.has(row.id)) {
						throw new Error(`${tableName}:${row.id} already exists`);
					}
					tableRows.set(row.id, clone(row));
					maybeFail(tableName, 'add');
					return row.id;
				}),
				bulkAdd: vi.fn(async (nextRows: T[]) => {
					for (const row of nextRows) {
						if (tableRows.has(row.id) || tableTombstones.has(row.id)) {
							throw new Error(`${tableName}:${row.id} already exists`);
						}
						tableRows.set(row.id, clone(row));
					}
					maybeFail(tableName, 'bulkAdd');
					return nextRows.map(({ id }) => id);
				}),
				put: vi.fn(async (row: T) => {
					tableRows.set(row.id, clone(row));
					tableTombstones.delete(row.id);
					maybeFail(tableName, 'put');
					return row.id;
				}),
				bulkPut: vi.fn(async (nextRows: T[]) => {
					for (const row of nextRows) {
						tableRows.set(row.id, clone(row));
						tableTombstones.delete(row.id);
					}
					maybeFail(tableName, 'bulkPut');
					return nextRows.map(({ id }) => id);
				}),
				update: vi.fn(async (id: string, patch: Partial<T>) => {
					const row = tableRows.get(id);
					if (!row) return 0;
					tableRows.set(id, { ...row, ...clone(patch) });
					maybeFail(tableName, 'update');
					return 1;
				}),
				delete: vi.fn(async (id: string) => {
					if (tableRows.has(id)) tableTombstones.add(id);
					tableRows.delete(id);
					maybeFail(tableName, 'delete');
				}),
				bulkDelete: vi.fn(async (ids: string[]) => {
					for (const id of ids) {
						if (tableRows.has(id)) tableTombstones.add(id);
						tableRows.delete(id);
					}
					maybeFail(tableName, 'bulkDelete');
				}),
				where: vi.fn((field: string) => ({
					equals: (value: unknown) => ({
						toArray: async () => {
							if (
								barrier &&
								barrier.table === tableName &&
								barrier.field === field &&
								barrier.value === value
							) {
								const activeBarrier = barrier;
								barrier = null;
								activeBarrier.markEntered();
								await activeBarrier.wait;
							}

							return [...tableRows.values()]
								.filter((row) => (row as unknown as Record<string, unknown>)[field] === value)
								.map(clone);
						}
					}),
					anyOf: (values: unknown[]) => ({
						toArray: async () =>
							[...tableRows.values()]
								.filter((row) =>
									values.includes((row as unknown as Record<string, unknown>)[field])
								)
								.map(clone)
					})
				}))
			};
		}

		const database = {
			name,
			rows,
			tombstones,
			exercises: createTable<Exercise>('exercises'),
			sessionExercises: createTable<SessionExercise>('sessionExercises'),
			sessionSets: createTable<SessionSet>('sessionSets'),
			workoutSessions: createTable<WorkoutSession>('workoutSessions'),
			transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
				const callback = args.at(-1);
				if (typeof callback !== 'function') throw new Error('Expected transaction callback.');
				return callback();
			}),
			failNext(table: TableName, method: string, message: string, onFail?: Failure['onFail']) {
				failures.push({ table, method, message, onFail });
			},
			pauseNextWhere(table: TableName, field: string, value: unknown) {
				const entered = deferred();
				const wait = deferred();
				barrier = {
					table,
					field,
					value,
					entered: entered.promise,
					markEntered: entered.resolve,
					wait: wait.promise,
					release: wait.resolve
				};
				return barrier;
			}
		};

		return database;
	}

	let ownerId = 'owner-1';
	let currentDatabase = createDatabase('initial');
	const globalDatabase = new Proxy(
		{},
		{
			get(_target, property) {
				return currentDatabase[property as keyof TestDatabase];
			}
		}
	);

	return {
		createDatabase,
		globalDatabase,
		get currentDatabase() {
			return currentDatabase;
		},
		setCurrent(nextOwnerId: string, database: TestDatabase) {
			ownerId = nextOwnerId;
			currentDatabase = database;
		},
		runAuthenticatedDatabaseOperation: vi.fn(
			async <T>(callback: (operation: unknown) => Promise<T> | T) => {
				const capturedOwnerId = ownerId;
				const capturedDatabase = currentDatabase;
				return callback({
					userId: capturedOwnerId,
					generation: 1,
					database: capturedDatabase
				});
			}
		)
	};
});

const syncNow = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./runtime', () => ({
	db: runtimeHarness.globalDatabase,
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: runtimeHarness.runAuthenticatedDatabaseOperation,
	syncNow
}));

vi.mock('./exercises', () => ({
	getExercise: vi.fn(
		async (exerciseId: string, database: typeof runtimeHarness.currentDatabase) => {
			return (await database.exercises.get(exerciseId)) ?? null;
		}
	),
	getPerformedSessionExerciseIdSet: vi.fn(async () => new Set<string>()),
	listExercises: vi.fn(async () => [])
}));

import {
	ExerciseMergeCompensationError,
	getMergedSessionExerciseId,
	getMergedSessionSetId,
	mergeExerciseHistory
} from './exercise-merge';

const originalAt = '2026-07-14T10:00:00.000Z';
const performedAt = '2026-07-15T10:00:00.000Z';

function seedMerge(database: ReturnType<typeof runtimeHarness.createDatabase>) {
	const mainExercise: Exercise = {
		id: 'main',
		name: 'Main',
		normalizedName: 'main',
		unilateral: false,
		source: 'custom',
		archived: false,
		createdAt: originalAt,
		updatedAt: originalAt
	};
	const secondaryExercise: Exercise = {
		...mainExercise,
		id: 'secondary',
		name: 'Secondary',
		normalizedName: 'secondary'
	};
	const session: WorkoutSession = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Workout',
		dayKey: '2026-07-15',
		status: 'completed',
		startedAt: performedAt,
		completedAt: performedAt,
		createdAt: originalAt,
		updatedAt: originalAt
	};
	const sourceExercise: SessionExercise = {
		id: 'secondary-history',
		sessionId: session.id,
		workoutId: session.workoutId,
		exerciseId: secondaryExercise.id,
		exerciseNameSnapshot: secondaryExercise.name,
		order: 1,
		performedAt,
		createdAt: originalAt,
		updatedAt: originalAt
	};
	const sourceSets: SessionSet[] = [1, 2].map((order) => ({
		id: `source-set-${order}`,
		sessionExerciseId: sourceExercise.id,
		exerciseId: secondaryExercise.id,
		logicalSetId: `logical-${order}`,
		order,
		side: 'bilateral',
		weight: 100,
		reps: 5 + order,
		createdAt: originalAt,
		updatedAt: originalAt
	}));

	database.rows.exercises.set(mainExercise.id, structuredClone(mainExercise));
	database.rows.exercises.set(secondaryExercise.id, structuredClone(secondaryExercise));
	database.rows.workoutSessions.set(session.id, structuredClone(session));
	database.rows.sessionExercises.set(sourceExercise.id, structuredClone(sourceExercise));
	for (const sourceSet of sourceSets) {
		database.rows.sessionSets.set(sourceSet.id, structuredClone(sourceSet));
	}

	return { mainExercise, secondaryExercise, session, sourceExercise, sourceSets };
}

function copiedIds(sourceSets: SessionSet[]) {
	const sessionExerciseId = getMergedSessionExerciseId('main', 'secondary-history');
	return {
		sessionExerciseId,
		setIds: sourceSets.map((sourceSet) => getMergedSessionSetId(sessionExerciseId, sourceSet.id))
	};
}

let testIndex = 0;
let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
	vi.stubGlobal('localStorage', storage);
	testIndex += 1;
	const database = runtimeHarness.createDatabase(`test-${testIndex}`);
	runtimeHarness.setCurrent(`owner-${testIndex}`, database);
	runtimeHarness.runAuthenticatedDatabaseOperation.mockClear();
	syncNow.mockClear();
});

describe('mergeExerciseHistory ownership and compensation', () => {
	it('keeps A history in A when authentication changes to B during source prefetch', async () => {
		const databaseA = runtimeHarness.createDatabase('A');
		const databaseB = runtimeHarness.createDatabase('B');
		const seededA = seedMerge(databaseA);
		seedMerge(databaseB);
		runtimeHarness.setCurrent('owner-A', databaseA);
		const barrier = databaseA.pauseNextWhere('sessionExercises', 'exerciseId', 'secondary');
		const merge = mergeExerciseHistory({
			mainExerciseId: 'main',
			secondaryExerciseId: 'secondary'
		});

		await barrier.entered;
		runtimeHarness.setCurrent('owner-B', databaseB);
		barrier.release();
		await merge;

		const { sessionExerciseId, setIds } = copiedIds(seededA.sourceSets);
		expect(databaseA.rows.sessionExercises.has(sessionExerciseId)).toBe(true);
		expect(setIds.every((id) => databaseA.rows.sessionSets.has(id))).toBe(true);
		expect(databaseB.rows.sessionExercises.has(sessionExerciseId)).toBe(false);
		expect(setIds.every((id) => !databaseB.rows.sessionSets.has(id))).toBe(true);
	});

	it.each([
		['sessionExercises', 'add', 'exercise insert failed'],
		['sessionSets', 'add', 'set insert failed'],
		['workoutSessions', 'update', 'metadata update failed']
	] as const)(
		'restores exact prior rows after %s.%s failure and retries the complete copy',
		async (table, method, message) => {
			const database = runtimeHarness.currentDatabase;
			const seeded = seedMerge(database);
			const beforeSession = structuredClone(seeded.session);
			const { sessionExerciseId, setIds } = copiedIds(seeded.sourceSets);
			database.failNext(table, method, message);

			await expect(
				mergeExerciseHistory({
					mainExerciseId: 'main',
					secondaryExerciseId: 'secondary',
					mainExerciseName: 'Renamed Main'
				})
			).rejects.toThrow(message);

			expect(database.rows.exercises.get('main')).toEqual(seeded.mainExercise);
			expect(database.rows.workoutSessions.get('session-1')).toEqual(beforeSession);
			expect(database.rows.sessionExercises.has(sessionExerciseId)).toBe(false);
			expect(setIds.every((id) => !database.rows.sessionSets.has(id))).toBe(true);

			const result = await mergeExerciseHistory({
				mainExerciseId: 'main',
				secondaryExerciseId: 'secondary',
				mainExerciseName: 'Renamed Main'
			});

			expect(result.copiedSessionExercises).toBe(1);
			expect(result.copiedSessionSets).toBe(2);
			expect(database.rows.sessionExercises.has(sessionExerciseId)).toBe(true);
			expect(setIds.every((id) => database.rows.sessionSets.has(id))).toBe(true);
			expect(database.rows.exercises.get('main')?.name).toBe('Renamed Main');
		}
	);

	it('fills every missing set when a partial prior attempt already left the copied exercise ID', async () => {
		const database = runtimeHarness.currentDatabase;
		const seeded = seedMerge(database);
		const { sessionExerciseId, setIds } = copiedIds(seeded.sourceSets);
		database.rows.sessionExercises.set(sessionExerciseId, {
			...seeded.sourceExercise,
			id: sessionExerciseId,
			exerciseId: 'main',
			exerciseNameSnapshot: 'Main'
		});

		const result = await mergeExerciseHistory({
			mainExerciseId: 'main',
			secondaryExerciseId: 'secondary'
		});

		expect(result.copiedSessionExercises).toBe(0);
		expect(result.copiedSessionSets).toBe(2);
		expect(setIds.every((id) => database.rows.sessionSets.has(id))).toBe(true);
	});

	it('retains cleanup failure as a user-scoped repairable error and repairs it on retry', async () => {
		const database = runtimeHarness.currentDatabase;
		const seeded = seedMerge(database);
		const { sessionExerciseId, setIds } = copiedIds(seeded.sourceSets);
		database.failNext('sessionSets', 'add', 'set write failed');
		database.failNext('sessionSets', 'delete', 'set cleanup failed');

		let compensationError: unknown;
		try {
			await mergeExerciseHistory({ mainExerciseId: 'main', secondaryExerciseId: 'secondary' });
		} catch (error) {
			compensationError = error;
		}

		expect(compensationError).toBeInstanceOf(ExerciseMergeCompensationError);
		if (!(compensationError instanceof ExerciseMergeCompensationError)) throw compensationError;
		expect(compensationError.attempt.userId).toBe(`owner-${testIndex}`);
		expect(compensationError.cleanupErrors).toHaveLength(1);

		const result = await mergeExerciseHistory({
			mainExerciseId: 'main',
			secondaryExerciseId: 'secondary'
		});

		expect(result.copiedSessionExercises).toBe(1);
		expect(result.copiedSessionSets).toBe(2);
		expect(database.rows.sessionExercises.has(sessionExerciseId)).toBe(true);
		expect(setIds.every((id) => database.rows.sessionSets.has(id))).toBe(true);
	});

	it('hydrates an interrupted merge repair after a module reload before retrying the merge', async () => {
		const database = runtimeHarness.currentDatabase;
		const seeded = seedMerge(database);
		const { sessionExerciseId, setIds } = copiedIds(seeded.sourceSets);
		database.failNext('sessionSets', 'add', 'set write failed');
		database.failNext('sessionSets', 'delete', 'set cleanup failed');

		let compensationError: unknown;
		try {
			await mergeExerciseHistory({ mainExerciseId: 'main', secondaryExerciseId: 'secondary' });
		} catch (error) {
			compensationError = error;
		}

		expect(compensationError).toBeInstanceOf(ExerciseMergeCompensationError);
		expect([...storage.values.values()].some((raw) => raw.includes('exercise-merge'))).toBe(true);

		vi.resetModules();
		const reloaded = await import('./exercise-merge');
		const result = await reloaded.mergeExerciseHistory({
			mainExerciseId: 'main',
			secondaryExerciseId: 'secondary'
		});

		expect(result.copiedSessionExercises).toBe(1);
		expect(result.copiedSessionSets).toBe(2);
		expect(database.rows.sessionExercises.has(sessionExerciseId)).toBe(true);
		expect(setIds.every((id) => database.rows.sessionSets.has(id))).toBe(true);
		expect([...storage.values.values()].some((raw) => raw.includes('exercise-merge'))).toBe(false);
	});

	it('warns explicitly when an incomplete merge repair cannot be persisted', async () => {
		const database = runtimeHarness.currentDatabase;
		seedMerge(database);
		database.failNext('sessionSets', 'add', 'set write failed');
		database.failNext('sessionSets', 'delete', 'set cleanup failed');
		storage.failWrites = true;

		let compensationError: unknown;
		try {
			await mergeExerciseHistory({ mainExerciseId: 'main', secondaryExerciseId: 'secondary' });
		} catch (error) {
			compensationError = error;
		}

		expect(compensationError).toBeInstanceOf(ExerciseMergeCompensationError);
		if (!(compensationError instanceof ExerciseMergeCompensationError)) throw compensationError;
		expect(compensationError.durabilityErrors).toHaveLength(1);
		expect(compensationError.message).toContain('Recovery could not be saved for reload safety.');
	});

	it('does not erase a concurrent winner that replaced an attempt-owned copied row', async () => {
		const database = runtimeHarness.currentDatabase;
		const seeded = seedMerge(database);
		const { sessionExerciseId, setIds } = copiedIds(seeded.sourceSets);
		database.failNext('sessionSets', 'add', 'set write failed', (activeDatabase) => {
			const attemptedRow = activeDatabase.rows.sessionExercises.get(sessionExerciseId)!;
			activeDatabase.rows.sessionExercises.set(sessionExerciseId, {
				...attemptedRow,
				exerciseId: 'concurrent-winner',
				updatedAt: 'winner-version'
			});
		});

		await expect(
			mergeExerciseHistory({ mainExerciseId: 'main', secondaryExerciseId: 'secondary' })
		).rejects.toThrow('set write failed');

		expect(database.rows.sessionExercises.get(sessionExerciseId)?.exerciseId).toBe(
			'concurrent-winner'
		);
		expect(setIds.every((id) => !database.rows.sessionSets.has(id))).toBe(true);
	});
});
