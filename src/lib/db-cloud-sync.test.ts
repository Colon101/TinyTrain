import { describe, expect, it, vi } from 'vitest';
import { dbCloudSync, type DatabaseCloudSyncDependencies, type SyncableRow } from './db-cloud-sync';
import type { DataTable } from './db/runtime';
import type { SessionSet } from './db/models';
import { hasInputValue, withExerciseDefaults, withSessionSetDefaults } from './db/shared';

vi.mock('./supabase', () => ({
	supabase: {
		from() {
			throw new Error('Cloud reconciliation tests must not access Supabase.');
		}
	}
}));

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
});
