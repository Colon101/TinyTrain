import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbCloudSync, type DatabaseCloudSyncDependencies, type SyncableRow } from './db-cloud-sync';
import type { DataTable } from './db/runtime';
import type { SessionSet } from './db/models';
import { hasInputValue, withExerciseDefaults, withSessionSetDefaults } from './db/shared';

type SupabaseMockRow = SyncableRow & {
	user_id: string;
	_deleted?: boolean;
	_modified?: string;
};

const supabaseMock = vi.hoisted(() => ({
	remoteRows: new Map<string, SupabaseMockRow[]>(),
	uploadedRows: new Map<string, SyncableRow[]>(),
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

							return { data, error: null };
						}
					};

					return query;
				},
				upsert: async (rows: SyncableRow[]) => {
					supabaseMock.uploadedRows.set(tableName, rows);
					return { error: null };
				}
			};
		}
	}
}));

beforeEach(() => {
	supabaseMock.remoteRows.clear();
	supabaseMock.uploadedRows.clear();
	supabaseMock.queryCalls.length = 0;
});

const older = '2026-01-01T00:00:00.000Z';
const newer = '2026-01-02T00:00:00.000Z';
const newest = '2026-01-03T00:00:00.000Z';

const dependencies: DatabaseCloudSyncDependencies = {
	db: {} as DatabaseCloudSyncDependencies['db'],
	getActiveSupabaseUserId: () => 'user-1',
	markSupabaseCacheHydrated: () => undefined,
	markRecentBackfillComplete: () => undefined,
	withExerciseDefaults,
	withSessionSetDefaults,
	hasInputValue
};

function createLocalTable<T extends SyncableRow>(initialRow?: T) {
	const rows = new Map(initialRow ? [[initialRow.id, initialRow]] : []);
	const put = vi.fn(async (row: T) => {
		rows.set(row.id, row);
		return row.id;
	});
	const mergeOperations = {
		get: async (id: string) => rows.get(id),
		put
	};

	return {
		rows,
		table: mergeOperations as unknown as DataTable<T>,
		put
	};
}

function createReconcileTable<T extends SyncableRow>(initialRows: T[] = []) {
	const rows = new Map(initialRows.map((row) => [row.id, row]));

	return {
		rows,
		table: {
			toArray: async () => [...rows.values()],
			get: async (id: string) => rows.get(id),
			put: async (row: T) => {
				rows.set(row.id, row);
				return row.id;
			},
			delete: async (id: string) => rows.delete(id)
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
		workouts,
		dependencies: {
			...dependencies,
			db: {
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

describe('database cloud conflict reconciliation', () => {
	it('stores a remote row when no local row exists', async () => {
		const { rows, table } = createLocalTable<SyncableRow>();
		const remoteRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: older };

		await dbCloudSync.putMergedRemoteRow(dependencies, 'workouts', table, remoteRow);

		expect(rows.get(remoteRow.id)).toEqual(remoteRow);
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

	it('accepts a newer remotely edited set even when the local copy is richer', async () => {
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
		const { rows, table } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow);

		expect(rows.get(localRow.id)).toEqual(remoteRow);
	});

	it('uses completeness when the newer set was never edited after creation', async () => {
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
		const localRow = createSessionSet();
		const remoteRow = createSessionSet({
			weight: '82.5' as unknown as number,
			reps: '6' as unknown as number,
			rir: null as unknown as number
		});
		const { rows, table } = createLocalTable(localRow);

		await dbCloudSync.putMergedRemoteRow(dependencies, 'session_sets', table, remoteRow, (row) =>
			dbCloudSync.normalizeRemoteSessionSet(dependencies, row)
		);

		expect(rows.get(localRow.id)).toEqual(
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

describe('Supabase pagination', () => {
	it('orders full reconciliation pages by stable row id', async () => {
		const localRow = { id: 'workout-1', name: 'Push', createdAt: older, updatedAt: newer };
		const { dependencies: reconcileDependencies } = createReconcileDependencies(localRow);

		await dbCloudSync.reconcileSupabaseDatabase(reconcileDependencies, 'user-1', 'richest');

		const workoutQuery = supabaseMock.queryCalls.find((call) => call.tableName === 'workouts');
		expect(workoutQuery?.orders).toEqual([{ field: 'id', ascending: true }]);
	});
});
