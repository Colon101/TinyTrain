import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbCloudSync, type DatabaseCloudSyncDependencies, type SyncableRow } from './db-cloud-sync';
import type { DataTable } from './db/runtime';
import type { SessionExercise, SessionSet, WorkoutSession } from './db/models';
import { hasInputValue, withExerciseDefaults, withSessionSetDefaults } from './db/shared';
import { sessionSetConflictHandler } from './rxdb-conflicts';

type SupabaseMockRow = SyncableRow &
	Record<string, unknown> & {
		user_id: string;
		_deleted?: boolean;
		_modified?: string;
	};

const supabaseMock = vi.hoisted(() => ({
	remoteRows: new Map<string, SupabaseMockRow[]>(),
	uploadedRows: new Map<string, SyncableRow[]>(),
	afterRange: null as (() => void) | null,
	beforeWrite: null as
		| ((write: { tableName: string; operation: 'insert' | 'update'; row: SyncableRow }) => void)
		| null,
	writeCalls: [] as Array<{
		tableName: string;
		operation: 'insert' | 'update';
		row: SyncableRow;
	}>,
	writeRevision: 0,
	queryCalls: [] as Array<{
		tableName: string;
		filters: Array<{ operator: 'eq' | 'gte'; field: string; value: unknown }>;
		orders: Array<{ field: string; ascending: boolean }>;
		from: number;
		to: number;
	}>
}));

vi.mock('./supabase', () => ({
	supabase: {
		from(tableName: string) {
			const recordSuccessfulWrite = (row: SyncableRow) => {
				supabaseMock.uploadedRows.set(tableName, [
					...(supabaseMock.uploadedRows.get(tableName) ?? []),
					row
				]);
			};
			const nextModified = () => {
				supabaseMock.writeRevision += 1;
				return `2026-02-01T00:00:${String(supabaseMock.writeRevision).padStart(2, '0')}.000Z`;
			};

			return {
				select: () => {
					const filters: Array<{
						operator: 'eq' | 'gte';
						field: string;
						value: unknown;
					}> = [];
					const orders: Array<{ field: string; ascending: boolean }> = [];
					const query = {
						eq(field: string, value: unknown) {
							filters.push({ operator: 'eq' as const, field, value });
							return this;
						},
						gte(field: string, value: unknown) {
							filters.push({ operator: 'gte' as const, field, value });
							return this;
						},
						order(field: string, options: { ascending?: boolean } = {}) {
							orders.push({ field, ascending: options.ascending ?? true });
							return this;
						},
						async range(from: number, to: number) {
							supabaseMock.queryCalls.push({
								tableName,
								filters: [...filters],
								orders: [...orders],
								from,
								to
							});

							const data = [...(supabaseMock.remoteRows.get(tableName) ?? [])]
								.filter((row) =>
									filters.every(({ operator, field, value }) => {
										const rowValue = (row as Record<string, unknown>)[field];

										return operator === 'eq'
											? rowValue === value
											: String(rowValue ?? '') >= String(value ?? '');
									})
								)
								.sort((first, second) => {
									for (const { field, ascending } of orders) {
										const comparison = String(
											(first as Record<string, unknown>)[field] ?? ''
										).localeCompare(String((second as Record<string, unknown>)[field] ?? ''));

										if (comparison !== 0) {
											return ascending ? comparison : -comparison;
										}
									}

									return 0;
								})
								.slice(from, to + 1);
							supabaseMock.afterRange?.();

							return { data, error: null };
						}
					};

					return query;
				},
				insert: (row: SyncableRow) => ({
					async select() {
						supabaseMock.writeCalls.push({ tableName, operation: 'insert', row });
						supabaseMock.beforeWrite?.({ tableName, operation: 'insert', row });
						const currentRows = supabaseMock.remoteRows.get(tableName) ?? [];

						if (currentRows.some((currentRow) => currentRow.id === row.id)) {
							return { data: null, error: { code: '23505', message: 'duplicate key' } };
						}

						const storedRow = { ...row, _modified: nextModified() } as SupabaseMockRow;
						supabaseMock.remoteRows.set(tableName, [...currentRows, storedRow]);
						recordSuccessfulWrite(row);
						return { data: [{ id: row.id }], error: null };
					}
				}),
				update: (row: SyncableRow) => {
					const filters: Array<{
						operator: 'eq' | 'is';
						field: string;
						value: unknown;
					}> = [];
					const update = {
						eq(field: string, value: unknown) {
							filters.push({ operator: 'eq' as const, field, value });
							return this;
						},
						is(field: string, value: unknown) {
							filters.push({ operator: 'is' as const, field, value });
							return this;
						},
						async select() {
							supabaseMock.writeCalls.push({ tableName, operation: 'update', row });
							supabaseMock.beforeWrite?.({ tableName, operation: 'update', row });
							const currentRows = supabaseMock.remoteRows.get(tableName) ?? [];
							const matchingIndexes = currentRows.flatMap((currentRow, index) => {
								const matches = filters.every(({ operator, field, value }) => {
									const rowValue = (currentRow as Record<string, unknown>)[field];

									return operator === 'eq' ? rowValue === value : (rowValue ?? null) === value;
								});

								return matches ? [index] : [];
							});

							if (matchingIndexes.length === 0) {
								return { data: [], error: null };
							}

							const nextRows = [...currentRows];
							for (const index of matchingIndexes) {
								nextRows[index] = {
									...nextRows[index],
									...row,
									_modified: nextModified()
								} as SupabaseMockRow;
							}

							supabaseMock.remoteRows.set(tableName, nextRows);
							recordSuccessfulWrite(row);
							return {
								data: matchingIndexes.map((index) => ({ id: nextRows[index].id })),
								error: null
							};
						}
					};

					return update;
				}
			};
		}
	}
}));

beforeEach(() => {
	supabaseMock.remoteRows.clear();
	supabaseMock.uploadedRows.clear();
	supabaseMock.queryCalls.length = 0;
	supabaseMock.afterRange = null;
	supabaseMock.beforeWrite = null;
	supabaseMock.writeCalls.length = 0;
	supabaseMock.writeRevision = 0;
});

const older = '2026-01-01T00:00:00.000Z';
const newer = '2026-01-02T00:00:00.000Z';
const newest = '2026-01-03T00:00:00.000Z';
const latest = '2026-01-04T00:00:00.000Z';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

async function immediateTransaction<T>(_mode: string, ...args: unknown[]): Promise<T> {
	const callback = args.at(-1);

	if (typeof callback !== 'function') {
		throw new Error('Missing transaction callback.');
	}

	return (callback as () => Promise<T>)();
}

function pauseSecondTransactionForTable(
	dependencies: DatabaseCloudSyncDependencies,
	targetTable: DataTable<SyncableRow>
) {
	const requested = deferred<void>();
	const release = deferred<void>();
	let matchingTransactions = 0;

	dependencies.db.transaction = async <T>(_mode: string, ...args: unknown[]): Promise<T> => {
		const table = args[0];
		const callback = args.at(-1);

		if (typeof callback !== 'function') {
			throw new Error('Missing transaction callback.');
		}

		if (table === targetTable) {
			matchingTransactions += 1;

			if (matchingTransactions === 2) {
				requested.resolve();
				await release.promise;
			}
		}

		return (callback as () => Promise<T>)();
	};

	return { requested: requested.promise, release: release.resolve };
}

const dependencies: DatabaseCloudSyncDependencies = {
	db: { transaction: immediateTransaction } as DatabaseCloudSyncDependencies['db'],
	getActiveSupabaseUserId: () => 'user-1',
	markSupabaseCacheHydrated: () => undefined,
	markRecentBackfillComplete: () => undefined,
	withExerciseDefaults,
	withSessionSetDefaults,
	hasInputValue
};

function createLocalTable<T extends SyncableRow>(initialRow?: T) {
	const rows = new Map(initialRow ? [[initialRow.id, initialRow]] : []);
	const deletedRows = new Map<string, T>();
	const put = vi.fn(async (row: T) => {
		rows.set(row.id, row);
		deletedRows.delete(row.id);
		return row.id;
	});
	const mergeOperations = {
		get: async (id: string) => rows.get(id),
		getSyncState: async (id: string) => {
			const row = rows.get(id);

			if (row) {
				return { row, deleted: false };
			}

			const deletedRow = deletedRows.get(id);
			return deletedRow ? { row: deletedRow, deleted: true } : undefined;
		},
		put
	};

	return {
		deletedRows,
		rows,
		table: mergeOperations as unknown as DataTable<T>,
		put
	};
}

function createReconcileTable<T extends SyncableRow>(initialRows: T[] = []) {
	const rows = new Map(initialRows.map((row) => [row.id, row]));
	const deletedRows = new Map<string, T>();
	const put = vi.fn(async (row: T) => {
		rows.set(row.id, row);
		deletedRows.delete(row.id);
		return row.id;
	});
	const deleteRow = vi.fn(async (id: string) => {
		const row = rows.get(id);

		if (row) {
			deletedRows.set(id, row);
		}

		rows.delete(id);
	});

	return {
		deletedRows,
		deleteRow,
		put,
		rows,
		table: {
			toArray: async () => [...rows.values()],
			get: async (id: string) => rows.get(id),
			getSyncState: async (id: string) => {
				const row = rows.get(id);

				if (row) {
					return { row, deleted: false };
				}

				const deletedRow = deletedRows.get(id);
				return deletedRow ? { row: deletedRow, deleted: true } : undefined;
			},
			put,
			delete: deleteRow
		} as unknown as DataTable<T>
	};
}

function createReconcileDependencies(workout: SyncableRow) {
	const exercises = createReconcileTable();
	const workouts = createReconcileTable([workout]);
	const workoutExercises = createReconcileTable();
	const workoutSessions = createReconcileTable();
	const sessionExercises = createReconcileTable();
	const sessionSets = createReconcileTable();
	const exerciseResetEvents = createReconcileTable();

	return {
		workoutSessions,
		sessionExercises,
		workouts,
		sessionSets,
		dependencies: {
			...dependencies,
			db: {
				transaction: immediateTransaction,
				exercises: exercises.table,
				workouts: workouts.table,
				workoutExercises: workoutExercises.table,
				workoutSessions: workoutSessions.table,
				sessionExercises: sessionExercises.table,
				sessionSets: sessionSets.table,
				exerciseResetEvents: exerciseResetEvents.table
			} as DatabaseCloudSyncDependencies['db']
		}
	};
}

function createSessionSet(overrides: Partial<SessionSet> = {}): SessionSet {
	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		createdAt: older,
		updatedAt: older,
		...overrides
	};
}

function createWorkoutSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
	return {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Push',
		dayKey: '2026-01-01',
		startedAt: older,
		status: 'in_progress',
		createdAt: older,
		updatedAt: older,
		...overrides
	};
}

function createSessionExercise(overrides: Partial<SessionExercise> = {}): SessionExercise {
	return {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'exercise-old',
		exerciseNameSnapshot: 'Old exercise',
		order: 0,
		performedAt: older,
		createdAt: older,
		updatedAt: older,
		...overrides
	};
}

describe('database cloud conflict reconciliation', () => {
	it('aborts a pending remote merge before writing after the user changes', async () => {
		let activeUserId: string | null = 'user-1';
		const pendingRead = deferred<{ row?: SyncableRow; deleted: boolean } | undefined>();
		const put = vi.fn(async (row: SyncableRow) => row.id);
		const table = {
			getSyncState: () => pendingRead.promise,
			put
		} as unknown as DataTable<SyncableRow>;
		const merge = dbCloudSync.putMergedRemoteRow(
			{ ...dependencies, getActiveSupabaseUserId: () => activeUserId },
			'workouts',
			table,
			{ id: 'workout-1', updatedAt: newer }
		);

		activeUserId = 'user-2';
		pendingRead.resolve(undefined);

		await expect(merge).rejects.toThrow('signed-in user changed');
		expect(put).not.toHaveBeenCalled();
	});

	it('stores a remote row when no local row exists', async () => {
		const { rows, table } = createLocalTable<SyncableRow>();
		const remoteRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: older };

		await dbCloudSync.putMergedRemoteRow(dependencies, 'workouts', table, remoteRow);

		expect(rows.get(remoteRow.id)).toEqual(remoteRow);
	});

	it('still hydrates a remote set when it is truly absent locally', async () => {
		const { rows, table, put } = createLocalTable<SessionSet>();
		const remoteRow = createSessionSet({
			updatedAt: newer,
			weightInput: '100',
			weight: 100
		});

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.get(remoteRow.id)).toEqual(remoteRow);
		expect(put).toHaveBeenCalledOnce();
	});

	it('does not hydrate a live remote set over a local tombstone', async () => {
		const deletedLocalRow = createSessionSet({
			updatedAt: newer,
			weightInput: '80',
			weight: 80
		});
		const remoteRow = createSessionSet({
			updatedAt: newest,
			weightInput: '100',
			weight: 100
		});
		const { deletedRows, rows, table, put } = createLocalTable<SessionSet>();
		deletedRows.set(deletedLocalRow.id, deletedLocalRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.has(remoteRow.id)).toBe(false);
		expect(put).not.toHaveBeenCalled();
	});

	it('defers explicit session hydration instead of reopening a completed local session', async () => {
		const localCompleted = createWorkoutSession({
			status: 'completed',
			completedAt: newer,
			updatedAt: newer
		});
		const staleRemoteActivity = createWorkoutSession({
			status: 'in_progress',
			completedAt: undefined,
			updatedAt: latest
		});
		const { rows, table, put } = createLocalTable(localCompleted);

		await dbCloudSync.putMergedRemoteRow(
			dependencies,
			'workout_sessions',
			table,
			staleRemoteActivity
		);

		expect(rows.get(localCompleted.id)).toEqual(localCompleted);
		expect(put).not.toHaveBeenCalled();
	});

	it('defers explicit exercise reconciliation instead of undoing a local swap', async () => {
		const localSwap = createSessionExercise({
			exerciseId: 'exercise-replacement',
			exerciseNameSnapshot: 'Replacement exercise',
			updatedAt: newer
		});
		const remoteReorder = createSessionExercise({ order: 2, updatedAt: latest });
		const { dependencies: reconcileDependencies, sessionExercises } = createReconcileDependencies({
			id: 'unused-workout'
		});
		sessionExercises.rows.set(localSwap.id, localSwap);
		supabaseMock.remoteRows.set('session_exercises', [
			{ ...remoteReorder, user_id: 'user-1', _modified: latest }
		]);

		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'richest'
		);
		const exerciseSummary = summary.tables.find((table) => table.table === 'session_exercises');

		expect(sessionExercises.rows.get(localSwap.id)).toEqual(localSwap);
		expect(sessionExercises.put).not.toHaveBeenCalled();
		expect(
			supabaseMock.writeCalls.filter((call) => call.tableName === 'session_exercises')
		).toEqual([]);
		expect(exerciseSummary).toEqual(
			expect.objectContaining({ mergedRows: 0, uploadedRows: 0, localWins: 0, remoteWins: 0 })
		);
	});

	it('does not reconcile or upload a live remote set over a pre-snapshot local tombstone', async () => {
		const workout = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: older };
		const deletedLocalRow = createSessionSet({
			updatedAt: newer,
			weightInput: '80',
			weight: 80
		});
		const remoteRow = createSessionSet({
			updatedAt: newest,
			weightInput: '100',
			weight: 100
		});
		const { dependencies: reconcileDependencies, sessionSets } =
			createReconcileDependencies(workout);
		sessionSets.deletedRows.set(deletedLocalRow.id, deletedLocalRow);
		supabaseMock.remoteRows.set('session_sets', [
			{ ...remoteRow, user_id: 'user-1', _deleted: false, _modified: newest }
		]);

		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'richest'
		);
		const setSummary = summary.tables.find((table) => table.table === 'session_sets');

		expect(sessionSets.rows.has(remoteRow.id)).toBe(false);
		expect(sessionSets.put).not.toHaveBeenCalled();
		expect(setSummary).toEqual(
			expect.objectContaining({ mergedRows: 0, uploadedRows: 0, localWins: 0, remoteWins: 0 })
		);
		expect(supabaseMock.uploadedRows.get('session_sets')).toBeUndefined();
		expect(supabaseMock.remoteRows.get('session_sets')).toEqual([
			expect.objectContaining({ id: remoteRow.id, _deleted: false })
		]);
	});

	it('keeps the more complete generic row even when it is older', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Push',
			createdAt: newer,
			updatedAt: newer
		};
		const remoteRow = {
			id: localRow.id,
			name: 'Push',
			normalizedName: 'push',
			archived: false,
			createdAt: older,
			updatedAt: older
		};
		const { rows, table } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'workouts', table, remoteRow);

		expect(rows.get(localRow.id)).toEqual(remoteRow);
	});

	it('protects a newer locally edited set from a richer stale remote copy', async () => {
		const localRow = createSessionSet({
			updatedAt: newest,
			weightInput: '80',
			weight: 80
		});
		const remoteRow = createSessionSet({
			updatedAt: newer,
			weightInput: '100',
			repsInput: '8',
			rirInput: '2',
			weight: 100,
			reps: 8,
			rir: 2
		});
		const { rows, table, put } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.get(localRow.id)).toEqual(localRow);
		expect(put).not.toHaveBeenCalled();
	});

	it('rechecks a set before applying a remote merge so an edit after the snapshot survives', async () => {
		const snapshotLocalRow = createSessionSet({
			updatedAt: older,
			weightInput: '80',
			weight: 80
		});
		const remoteRow = createSessionSet({
			updatedAt: newest,
			weightInput: '100',
			repsInput: '8',
			weight: 100,
			reps: 8
		});
		const latestLocalRow = createSessionSet({
			updatedAt: latest,
			weightInput: '82.5',
			weight: 82.5
		});
		const rows = new Map([[snapshotLocalRow.id, snapshotLocalRow]]);
		const snapshotRead = deferred<{ row?: SessionSet; deleted: boolean } | undefined>();
		const snapshotReadStarted = deferred<void>();
		const getSyncState = vi.fn((id: string) => {
			if (getSyncState.mock.calls.length === 1) {
				snapshotReadStarted.resolve();
				return snapshotRead.promise;
			}

			const row = rows.get(id);
			return Promise.resolve(row ? { row, deleted: false } : undefined);
		});
		const put = vi.fn(async (row: SessionSet) => {
			rows.set(row.id, row);
			return row.id;
		});
		const table = { getSyncState, put } as unknown as DataTable<SessionSet>;

		const merge = dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);
		await snapshotReadStarted.promise;
		rows.set(latestLocalRow.id, latestLocalRow);
		snapshotRead.resolve({ row: snapshotLocalRow, deleted: false });
		await merge;

		expect(getSyncState).toHaveBeenCalledTimes(2);
		expect(rows.get(latestLocalRow.id)).toEqual(latestLocalRow);
		expect(put).not.toHaveBeenCalled();
	});

	it('does not resurrect a set removed after the hydration snapshot', async () => {
		const snapshotLocalRow = createSessionSet({ updatedAt: older });
		const remoteRow = createSessionSet({
			updatedAt: newest,
			weightInput: '100',
			weight: 100
		});
		const rows = new Map([[snapshotLocalRow.id, snapshotLocalRow]]);
		const snapshotRead = deferred<{ row?: SessionSet; deleted: boolean } | undefined>();
		const snapshotReadStarted = deferred<void>();
		const getSyncState = vi.fn((id: string) => {
			if (getSyncState.mock.calls.length === 1) {
				snapshotReadStarted.resolve();
				return snapshotRead.promise;
			}

			const row = rows.get(id);
			return Promise.resolve(row ? { row, deleted: false } : undefined);
		});
		const put = vi.fn(async (row: SessionSet) => {
			rows.set(row.id, row);
			return row.id;
		});
		const table = { getSyncState, put } as unknown as DataTable<SessionSet>;

		const merge = dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);
		await snapshotReadStarted.promise;
		rows.delete(snapshotLocalRow.id);
		snapshotRead.resolve({ row: snapshotLocalRow, deleted: false });
		await merge;

		expect(getSyncState).toHaveBeenCalledTimes(2);
		expect(rows.has(snapshotLocalRow.id)).toBe(false);
		expect(put).not.toHaveBeenCalled();
	});

	it('defers a newer divergent remote set instead of replacing the local branch', async () => {
		const localRow = createSessionSet({
			updatedAt: newer,
			weightInput: '100',
			repsInput: '8',
			rirInput: '2',
			weight: 100,
			reps: 8,
			rir: 2
		});
		const remoteRow = createSessionSet({
			updatedAt: newest,
			weightInput: '105',
			weight: 105
		});
		const { rows, table, put } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.get(localRow.id)).toEqual(localRow);
		expect(put).not.toHaveBeenCalled();
	});

	it('defers divergent unedited sets without guessing a common base', async () => {
		const localRow = createSessionSet({
			weightInput: '100',
			repsInput: '8',
			weight: 100,
			reps: 8
		});
		const remoteRow = createSessionSet({
			createdAt: newest,
			updatedAt: newest,
			weightInput: '105',
			weight: 105
		});
		const { rows, table } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.get(localRow.id)).toEqual(localRow);
	});

	it('normalizes remote numeric strings before comparing and storing a set', async () => {
		const remoteRow = createSessionSet({
			weight: '82.5' as unknown as number,
			reps: '6' as unknown as number,
			rir: null as unknown as number
		});
		const { rows, table } = createLocalTable<SessionSet>();

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow, (row) =>
			dbCloudSync.normalizeRemoteSessionSet(dependencies, row)
		);

		expect(rows.get(remoteRow.id)).toEqual(
			expect.objectContaining({
				weightInput: '82.5',
				repsInput: '6',
				rirInput: '',
				weight: 82.5,
				reps: 6,
				rir: undefined
			})
		);
	});

	it('defers disjoint hydration branches so RxDB can merge both fields from the common base', async () => {
		const baseRow = createSessionSet({ updatedAt: older });
		const localWeightBranch = createSessionSet({
			updatedAt: newest,
			weightInput: '82.5',
			weight: 82.5
		});
		const remoteRepsBranch = createSessionSet({
			updatedAt: latest,
			repsInput: '8',
			reps: 8
		});
		const { rows, table, put } = createLocalTable(localWeightBranch);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRepsBranch);
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...baseRow, user_id: 'user-1', _deleted: false },
				realMasterState: { ...remoteRepsBranch, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localWeightBranch, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(rows.get(localWeightBranch.id)).toEqual(localWeightBranch);
		expect(put).not.toHaveBeenCalled();
		expect(resolved).toEqual(
			expect.objectContaining({ weightInput: '82.5', weight: 82.5, repsInput: '8', reps: 8 })
		);
	});

	it('preserves an explicit clear during hydration until RxDB merges against the common base', async () => {
		const baseRow = createSessionSet({
			updatedAt: older,
			weightInput: '100',
			weight: 100
		});
		const localClearBranch = createSessionSet({
			updatedAt: newest,
			weightInput: '',
			weight: undefined
		});
		const remoteRepsBranch = createSessionSet({
			updatedAt: latest,
			weightInput: '100',
			weight: 100,
			repsInput: '8',
			reps: 8
		});
		const { rows, table, put } = createLocalTable(localClearBranch);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRepsBranch);
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...baseRow, user_id: 'user-1', _deleted: false },
				realMasterState: { ...remoteRepsBranch, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localClearBranch, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(rows.get(localClearBranch.id)).toEqual(localClearBranch);
		expect(put).not.toHaveBeenCalled();
		expect(resolved).toEqual(
			expect.objectContaining({
				weightInput: '',
				repsInput: '8',
				reps: 8
			})
		);
		expect(resolved.weight).toBeUndefined();
	});

	it('defers disjoint reconciliation branches without uploading either whole-row winner', async () => {
		const localWeightBranch = createSessionSet({
			updatedAt: newest,
			weightInput: '82.5',
			weight: 82.5
		});
		const remoteRepsBranch = createSessionSet({
			updatedAt: latest,
			repsInput: '8',
			reps: 8
		});
		const { dependencies: reconcileDependencies, sessionSets } = createReconcileDependencies({
			id: 'unused-workout'
		});
		sessionSets.rows.set(localWeightBranch.id, localWeightBranch);
		supabaseMock.remoteRows.set('session_sets', [
			{ ...remoteRepsBranch, user_id: 'user-1', _modified: latest }
		]);

		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'richest'
		);
		const setSummary = summary.tables.find((table) => table.table === 'session_sets');

		expect(sessionSets.rows.get(localWeightBranch.id)).toEqual(localWeightBranch);
		expect(sessionSets.put).not.toHaveBeenCalled();
		expect(supabaseMock.remoteRows.get('session_sets')).toEqual([
			expect.objectContaining({ id: remoteRepsBranch.id, repsInput: '8', reps: 8 })
		]);
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'session_sets')).toEqual([]);
		expect(setSummary).toEqual(
			expect.objectContaining({ mergedRows: 0, uploadedRows: 0, localWins: 0, remoteWins: 0 })
		);
	});

	it('defers same-field reconciliation branches to RxDB deterministic conflict resolution', async () => {
		const baseRow = createSessionSet({
			updatedAt: older,
			weightInput: '70',
			weight: 70
		});
		const localBranch = createSessionSet({
			updatedAt: newest,
			weightInput: '80',
			weight: 80
		});
		const remoteBranch = createSessionSet({
			updatedAt: latest,
			weightInput: '100',
			weight: 100
		});
		const { dependencies: reconcileDependencies, sessionSets } = createReconcileDependencies({
			id: 'unused-workout'
		});
		sessionSets.rows.set(localBranch.id, localBranch);
		supabaseMock.remoteRows.set('session_sets', [
			{ ...remoteBranch, user_id: 'user-1', _modified: latest }
		]);

		await dbCloudSync.reconcileSupabaseDatabase(reconcileDependencies, 'user-1', 'richest');
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...baseRow, user_id: 'user-1', _deleted: false },
				realMasterState: { ...remoteBranch, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localBranch, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(sessionSets.rows.get(localBranch.id)).toEqual(localBranch);
		expect(supabaseMock.remoteRows.get('session_sets')).toEqual([
			expect.objectContaining({ id: remoteBranch.id, weightInput: '100', weight: 100 })
		]);
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'session_sets')).toEqual([]);
		expect(resolved).toEqual(expect.objectContaining({ weightInput: '100', weight: 100 }));
	});
});

describe('remote deletion conflicts', () => {
	const tombstone = (modifiedAt: string) => ({
		row: { id: 'workout-1', updatedAt: older },
		deleted: true,
		modifiedAt
	});

	it('applies only a tombstone at least as recent as the local row', () => {
		const localRow = { id: 'workout-1', updatedAt: newer };

		expect(dbCloudSync.shouldApplyRemoteDeletion(localRow, tombstone(newest))).toBe(true);
		expect(dbCloudSync.shouldApplyRemoteDeletion(localRow, tombstone(newer))).toBe(true);
		expect(dbCloudSync.shouldApplyRemoteDeletion(localRow, tombstone(older))).toBe(false);
		expect(dbCloudSync.shouldApplyRemoteDeletion(undefined, tombstone(older))).toBe(true);
	});

	it.each([newer, newest])(
		'applies a %s tombstone throughout reconciliation',
		async (modifiedAt) => {
			supabaseMock.remoteRows.clear();
			supabaseMock.uploadedRows.clear();
			const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
			const { dependencies: reconcileDependencies, workouts } =
				createReconcileDependencies(localRow);
			supabaseMock.remoteRows.set('workouts', [
				{ ...localRow, user_id: 'user-1', _deleted: true, _modified: modifiedAt }
			]);

			const summary = await dbCloudSync.reconcileSupabaseDatabase(
				reconcileDependencies,
				'user-1',
				'richest'
			);
			const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

			expect(workouts.rows.has(localRow.id)).toBe(false);
			expect(workoutSummary).toEqual(
				expect.objectContaining({ mergedRows: 0, uploadedRows: 0, remoteWins: 1 })
			);
			expect(supabaseMock.uploadedRows.get('workouts')).toBeUndefined();
		}
	);

	it('preserves and uploads a local row when the tombstone is stale', async () => {
		supabaseMock.remoteRows.clear();
		supabaseMock.uploadedRows.clear();
		const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [
			{ ...localRow, user_id: 'user-1', _deleted: true, _modified: older }
		]);

		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'richest'
		);
		const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

		expect(workouts.rows.get(localRow.id)).toEqual(localRow);
		expect(workoutSummary).toEqual(
			expect.objectContaining({ mergedRows: 1, uploadedRows: 1, localWins: 1, remoteWins: 0 })
		);
		expect(supabaseMock.uploadedRows.get('workouts')).toEqual([
			expect.objectContaining({ id: localRow.id, user_id: 'user-1' })
		]);
	});

	it('rechecks a row after the local snapshot so a newer edit survives a tombstone', async () => {
		const snapshotLocalRow = {
			id: 'workout-1',
			name: 'Push',
			createdAt: older,
			updatedAt: newer
		};
		const latestLocalRow = { ...snapshotLocalRow, name: 'Push day', updatedAt: latest };
		const { dependencies: reconcileDependencies, workouts } =
			createReconcileDependencies(snapshotLocalRow);
		const snapshotRead = deferred<SyncableRow[]>();
		const snapshotReadStarted = deferred<void>();
		workouts.table.toArray = vi.fn(() => {
			snapshotReadStarted.resolve();
			return snapshotRead.promise;
		});
		supabaseMock.remoteRows.set('workouts', [
			{
				...snapshotLocalRow,
				user_id: 'user-1',
				_deleted: true,
				_modified: newest
			}
		]);

		const reconciliation = dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'richest'
		);
		await snapshotReadStarted.promise;
		workouts.rows.set(latestLocalRow.id, latestLocalRow);
		snapshotRead.resolve([snapshotLocalRow]);
		const summary = await reconciliation;
		const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

		expect(workouts.rows.get(latestLocalRow.id)).toEqual(latestLocalRow);
		expect(workoutSummary).toEqual(
			expect.objectContaining({ mergedRows: 1, uploadedRows: 1, localWins: 1, remoteWins: 0 })
		);
		expect(supabaseMock.uploadedRows.get('workouts')).toEqual([
			expect.objectContaining({
				id: latestLocalRow.id,
				name: latestLocalRow.name,
				updatedAt: latest,
				user_id: 'user-1'
			})
		]);
	});

	it('rechecks a recent-backfill tombstone after fetching it so a newer edit survives', async () => {
		const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
		const latestLocalRow = { ...localRow, name: 'Push day', updatedAt: latest };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [
			{ ...localRow, user_id: 'user-1', _deleted: true, _modified: newest }
		]);
		supabaseMock.afterRange = () => {
			if (supabaseMock.queryCalls.at(-1)?.tableName === 'workouts') {
				workouts.rows.set(latestLocalRow.id, latestLocalRow);
				supabaseMock.afterRange = null;
			}
		};

		await dbCloudSync.backfillRecentRows(reconcileDependencies, 'user-1', 1000);

		expect(workouts.rows.get(latestLocalRow.id)).toEqual(latestLocalRow);
	});

	it.each([
		{ modifiedAt: newest, shouldDelete: true },
		{ modifiedAt: older, shouldDelete: false }
	])(
		'applies recent-backfill tombstones only when recency permits ($modifiedAt)',
		async ({ modifiedAt, shouldDelete }) => {
			const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
			const { dependencies: reconcileDependencies, workouts } =
				createReconcileDependencies(localRow);
			supabaseMock.remoteRows.set('workouts', [
				{ ...localRow, user_id: 'user-1', _deleted: true, _modified: modifiedAt }
			]);

			await dbCloudSync.backfillRecentRows(reconcileDependencies, 'user-1', 1000);

			expect(workouts.rows.has(localRow.id)).toBe(!shouldDelete);
			const workoutQuery = supabaseMock.queryCalls.find((call) => call.tableName === 'workouts');
			expect(workoutQuery?.filters).not.toContainEqual(
				expect.objectContaining({ field: '_deleted' })
			);
			expect(workoutQuery?.orders).toEqual([
				{ field: '_modified', ascending: false },
				{ field: 'id', ascending: true }
			]);
		}
	);
});

describe('optimistic remote reconciliation writes', () => {
	it('does not upload a row deleted after local reconciliation but before the remote write', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Local workout',
			createdAt: older,
			updatedAt: newest
		};
		const remoteRow = { ...localRow, name: 'Remote workout', updatedAt: newer };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [
			{ ...remoteRow, user_id: 'user-1', _modified: newer }
		]);
		const fence = pauseSecondTransactionForTable(
			reconcileDependencies,
			workouts.table as unknown as DataTable<SyncableRow>
		);

		const reconciliation = dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'local-preferred'
		);
		await fence.requested;
		const appliedRow = workouts.rows.get(localRow.id);
		expect(appliedRow).toBeDefined();
		workouts.deletedRows.set(localRow.id, appliedRow!);
		workouts.rows.delete(localRow.id);
		fence.release();
		const summary = await reconciliation;
		const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

		expect(workouts.rows.has(localRow.id)).toBe(false);
		expect(workouts.deletedRows.get(localRow.id)).toEqual(appliedRow);
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'workouts')).toEqual([]);
		expect(supabaseMock.remoteRows.get('workouts')).toEqual([
			expect.objectContaining({ id: remoteRow.id, name: 'Remote workout' })
		]);
		expect(workoutSummary).toEqual(expect.objectContaining({ uploadedRows: 0 }));
	});

	it('does not upload a row edited after local reconciliation but before the remote write', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Local workout',
			createdAt: older,
			updatedAt: newest
		};
		const remoteRow = { ...localRow, name: 'Remote workout', updatedAt: newer };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [
			{ ...remoteRow, user_id: 'user-1', _modified: newer }
		]);
		const fence = pauseSecondTransactionForTable(
			reconcileDependencies,
			workouts.table as unknown as DataTable<SyncableRow>
		);

		const reconciliation = dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'local-preferred'
		);
		await fence.requested;
		const latestLocalRow = {
			...workouts.rows.get(localRow.id)!,
			name: 'Latest local workout',
			updatedAt: latest
		};
		workouts.rows.set(localRow.id, latestLocalRow);
		fence.release();
		const summary = await reconciliation;
		const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

		expect(workouts.rows.get(localRow.id)).toEqual(latestLocalRow);
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'workouts')).toEqual([]);
		expect(supabaseMock.remoteRows.get('workouts')).toEqual([
			expect.objectContaining({ id: remoteRow.id, name: 'Remote workout' })
		]);
		expect(workoutSummary).toEqual(expect.objectContaining({ uploadedRows: 0 }));
	});

	it('refetches after a stale update and retries the recomputed generic row conditionally', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Local workout',
			createdAt: older,
			updatedAt: newest
		};
		const remoteRow = { ...localRow, name: 'Remote workout', updatedAt: newer };
		const concurrentRemoteRow = { ...remoteRow, name: 'Concurrent remote workout' };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [
			{ ...remoteRow, user_id: 'user-1', _modified: newer }
		]);
		supabaseMock.beforeWrite = ({ tableName, operation }) => {
			if (tableName !== 'workouts' || operation !== 'update') {
				return;
			}

			supabaseMock.remoteRows.set('workouts', [
				{ ...concurrentRemoteRow, user_id: 'user-1', _modified: latest }
			]);
			supabaseMock.beforeWrite = null;
		};

		const summary = await dbCloudSync.reconcileSupabaseDatabase(
			reconcileDependencies,
			'user-1',
			'local-preferred'
		);
		const workoutSummary = summary.tables.find((table) => table.table === 'workouts');

		expect(workouts.rows.get(localRow.id)).toEqual(localRow);
		expect(supabaseMock.remoteRows.get('workouts')).toEqual([
			expect.objectContaining({ id: localRow.id, name: localRow.name, updatedAt: newest })
		]);
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'workouts')).toHaveLength(2);
		expect(workoutSummary).toEqual(expect.objectContaining({ uploadedRows: 1 }));
	});

	it('treats an insert unique conflict as a stale absence and retries conditionally', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Local workout',
			createdAt: older,
			updatedAt: newest
		};
		const { dependencies: reconcileDependencies } = createReconcileDependencies(localRow);
		supabaseMock.beforeWrite = ({ tableName, operation }) => {
			if (tableName !== 'workouts' || operation !== 'insert') {
				return;
			}

			supabaseMock.remoteRows.set('workouts', [
				{
					...localRow,
					name: 'Concurrent remote workout',
					user_id: 'user-1',
					_modified: latest
				}
			]);
			supabaseMock.beforeWrite = null;
		};

		await dbCloudSync.reconcileSupabaseDatabase(reconcileDependencies, 'user-1', 'local-preferred');

		expect(
			supabaseMock.writeCalls
				.filter((call) => call.tableName === 'workouts')
				.map((call) => call.operation)
		).toEqual(['insert', 'update']);
		expect(supabaseMock.remoteRows.get('workouts')).toEqual([
			expect.objectContaining({ id: localRow.id, name: localRow.name, updatedAt: newest })
		]);
	});

	it('refuses a stale upload after the bounded retry budget is exhausted', async () => {
		const localRow = {
			id: 'workout-1',
			name: 'Local workout',
			createdAt: older,
			updatedAt: newest
		};
		const remoteRow = {
			...localRow,
			name: 'Remote workout',
			user_id: 'user-1',
			_modified: newer
		};
		const { dependencies: reconcileDependencies } = createReconcileDependencies(localRow);
		supabaseMock.remoteRows.set('workouts', [remoteRow]);
		let remoteRevision = 0;
		supabaseMock.beforeWrite = ({ tableName, operation }) => {
			if (tableName !== 'workouts' || operation !== 'update') {
				return;
			}

			remoteRevision += 1;
			supabaseMock.remoteRows.set('workouts', [
				{ ...remoteRow, _modified: `${latest}-${remoteRevision}` }
			]);
		};

		await expect(
			dbCloudSync.reconcileSupabaseDatabase(reconcileDependencies, 'user-1', 'local-preferred')
		).rejects.toThrow('No newer cloud data was overwritten');
		expect(supabaseMock.writeCalls.filter((call) => call.tableName === 'workouts')).toHaveLength(3);
		expect(supabaseMock.uploadedRows.get('workouts')).toBeUndefined();
		expect(supabaseMock.remoteRows.get('workouts')).toEqual([
			expect.objectContaining({ name: remoteRow.name })
		]);
	});
});

describe('Supabase pagination', () => {
	it('stops reconciliation when auth changes during a remote page', async () => {
		let activeUserId: string | null = 'user-1';
		const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
		const { dependencies: reconcileDependencies, workouts } = createReconcileDependencies(localRow);
		supabaseMock.afterRange = () => {
			activeUserId = 'user-2';
			supabaseMock.afterRange = null;
		};

		await expect(
			dbCloudSync.reconcileSupabaseDatabase(
				{ ...reconcileDependencies, getActiveSupabaseUserId: () => activeUserId },
				'user-1',
				'richest'
			)
		).rejects.toThrow('signed-in user changed');
		expect(workouts.rows.get(localRow.id)).toEqual(localRow);
		expect(supabaseMock.uploadedRows.size).toBe(0);
	});

	it('orders full reconciliation pages by stable row id', async () => {
		const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
		const { dependencies: reconcileDependencies } = createReconcileDependencies(localRow);

		await dbCloudSync.reconcileSupabaseDatabase(reconcileDependencies, 'user-1', 'richest');

		const workoutQuery = supabaseMock.queryCalls.find((call) => call.tableName === 'workouts');
		expect(workoutQuery?.orders).toEqual([{ field: 'id', ascending: true }]);
	});
});
