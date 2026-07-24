import { BASELINE_EXERCISE_BY_ID } from './exercises';
import { supabase } from './supabase';
import type {
	Exercise,
	ExerciseResetEvent,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from './db/models';
import { chooseSessionSetConflict } from './db/session-set-conflict';

type DataTable<T extends { id: string }> = {
	toArray(): Promise<T[]>;
	get(id: string): Promise<T | undefined>;
	put(doc: T): Promise<string>;
	delete(id: string): Promise<void>;
};

type DatabaseCloudSyncDatabase = {
	exercises: DataTable<Exercise>;
	workouts: DataTable<Workout>;
	workoutExercises: DataTable<WorkoutExercise>;
	workoutSessions: DataTable<WorkoutSession>;
	sessionExercises: DataTable<SessionExercise>;
	sessionSets: DataTable<SessionSet>;
	exerciseResetEvents: DataTable<ExerciseResetEvent>;
};

export type DatabaseCloudSyncDependencies = {
	db: DatabaseCloudSyncDatabase;
	getActiveSupabaseUserId(): string | null;
	markSupabaseCacheHydrated(userId: string): void;
	withExerciseDefaults(exercise: Exercise): Exercise;
	withSessionSetDefaults(sessionSet: SessionSet): SessionSet;
};

export type DatabaseUploadMode = 'local-preferred' | 'richest';

export type SyncProgress = {
	completedTables: number;
	totalTables: number;
};

export type DatabaseTableUploadSummary = {
	table: string;
	localRows: number;
	remoteRows: number;
	mergedRows: number;
	uploadedRows: number;
	localWins: number;
	remoteWins: number;
};

export type DatabaseUploadSummary = {
	mode: DatabaseUploadMode;
	tables: DatabaseTableUploadSummary[];
	localRows: number;
	remoteRows: number;
	mergedRows: number;
	uploadedRows: number;
	localWins: number;
	remoteWins: number;
};

export type SyncableRow = {
	id: string;
	createdAt?: string;
	updatedAt?: string;
};

export type SupabaseTableName =
	| 'exercises'
	| 'workouts'
	| 'workout_exercises'
	| 'workout_sessions'
	| 'session_exercises'
	| 'session_sets'
	| 'exercise_reset_events';

export type SupabaseSyncedRow = Record<string, unknown> & {
	id: string;
	user_id?: string;
	_deleted?: boolean;
	_modified?: string;
	updatedAt?: string;
};

type ReconcileTableOptions<T extends SyncableRow> = {
	tableName: SupabaseTableName;
	localTable: DataTable<T>;
	normalize?: (row: T) => T;
	filterLocal?: (row: T) => boolean;
};

type ReconcileDatabaseOptions = {
	onProgress?: (progress: SyncProgress) => void;
};

type ReconcileWinner = 'local' | 'remote';

type ReconcileChoice<T extends SyncableRow> = {
	row: T;
	winner: ReconcileWinner;
};

type RemoteReconcileRow<T extends SyncableRow> = {
	row: T;
	deleted: boolean;
	modifiedAt?: string;
};

type SyncedTableConfig<T extends SyncableRow = SyncableRow> = {
	tableName: SupabaseTableName;
	localTable: () => DataTable<T>;
	normalize?: (row: T) => T;
};

function assertSyncContextActive(deps: DatabaseCloudSyncDependencies, userId: string) {
	if (deps.getActiveSupabaseUserId() !== userId) {
		throw new Error('Cloud sync stopped because the signed-in user changed.');
	}
}

function getActiveSyncUserId(deps: DatabaseCloudSyncDependencies) {
	const userId = deps.getActiveSupabaseUserId();

	if (!userId) {
		throw new Error('Sign in with Google to sync workouts.');
	}

	return userId;
}

function stripSupabaseSyncFields<T extends { id: string }>(row: SupabaseSyncedRow): T {
	const doc = { ...row };
	delete doc.user_id;
	delete doc._deleted;
	delete doc._modified;

	return doc as T;
}

function areRowsEqual(first: unknown, second: unknown) {
	return JSON.stringify(first) === JSON.stringify(second);
}

function toRemoteOptionalNumber(value: unknown) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim()) {
		const nextValue = Number(value);
		return Number.isFinite(nextValue) ? nextValue : undefined;
	}

	return undefined;
}

function normalizeRemoteSessionSet(
	deps: DatabaseCloudSyncDependencies,
	row: SessionSet
): SessionSet {
	return deps.withSessionSetDefaults({
		...row,
		weight: toRemoteOptionalNumber(row.weight),
		reps: toRemoteOptionalNumber(row.reps),
		rir: toRemoteOptionalNumber(row.rir)
	});
}

function shouldSyncExercise(deps: DatabaseCloudSyncDependencies, exercise: Exercise) {
	const normalizedExercise = deps.withExerciseDefaults(exercise);

	return normalizedExercise.source !== 'baseline' && !BASELINE_EXERCISE_BY_ID.has(exercise.id);
}

function hasMeaningfulValue(value: unknown) {
	if (value === undefined || value === null) {
		return false;
	}

	if (typeof value === 'string') {
		return value.trim().length > 0;
	}

	if (typeof value === 'number') {
		return Number.isFinite(value);
	}

	if (typeof value === 'boolean') {
		return true;
	}

	return false;
}

function getGenericCompletenessScore(row: SyncableRow) {
	const ignoredFields = new Set([
		'id',
		'user_id',
		'_deleted',
		'_modified',
		'createdAt',
		'updatedAt'
	]);

	return Object.entries(row).reduce((score, [key, value]) => {
		if (ignoredFields.has(key)) {
			return score;
		}

		return score + Number(hasMeaningfulValue(value));
	}, 0);
}

function getRowTimestamp(row: SyncableRow) {
	const rawTimestamp =
		row.updatedAt ??
		row.createdAt ??
		('resetAt' in row && typeof row.resetAt === 'string' ? row.resetAt : undefined);
	const time = rawTimestamp ? new Date(rawTimestamp).getTime() : 0;

	return Number.isFinite(time) ? time : 0;
}

function getRemoteReconcileTimestamp(row: RemoteReconcileRow<SyncableRow>) {
	const modifiedTime = row.modifiedAt ? new Date(row.modifiedAt).getTime() : 0;

	return Number.isFinite(modifiedTime) && modifiedTime > 0
		? modifiedTime
		: getRowTimestamp(row.row);
}

function shouldApplyRemoteDeletion(
	localRow: SyncableRow | undefined,
	remoteRow: RemoteReconcileRow<SyncableRow>
) {
	return !localRow || getRemoteReconcileTimestamp(remoteRow) >= getRowTimestamp(localRow);
}

function getRowCreatedTimestamp(row: SyncableRow) {
	const time = row.createdAt ? new Date(row.createdAt).getTime() : 0;

	return Number.isFinite(time) ? time : 0;
}

function wasRowEditedAfterCreate(row: SyncableRow) {
	return getRowTimestamp(row) > getRowCreatedTimestamp(row);
}

function chooseReconciledRow<T extends SyncableRow>(
	tableName: SupabaseTableName,
	localRow: T | undefined,
	remoteRow: T | undefined,
	mode: DatabaseUploadMode
): ReconcileChoice<T> | null {
	if (localRow && !remoteRow) {
		return { row: localRow, winner: 'local' };
	}

	if (!localRow && remoteRow) {
		return { row: remoteRow, winner: 'remote' };
	}

	if (!localRow || !remoteRow) {
		return null;
	}

	if (mode === 'local-preferred') {
		return { row: localRow, winner: 'local' };
	}

	if (tableName === 'session_sets') {
		const choice = chooseSessionSetConflict(
			localRow as unknown as SessionSet,
			remoteRow as unknown as SessionSet
		);

		return choice.winner === 'first'
			? { row: localRow, winner: 'local' }
			: { row: remoteRow, winner: 'remote' };
	}

	if (tableName === 'workout_sessions') {
		const localTimestamp = getRowTimestamp(localRow);
		const remoteTimestamp = getRowTimestamp(remoteRow);
		const localIsNewer = localTimestamp > remoteTimestamp;
		const newerRow = localIsNewer ? localRow : remoteRow;

		if (localTimestamp !== remoteTimestamp && wasRowEditedAfterCreate(newerRow)) {
			return localIsNewer
				? { row: localRow, winner: 'local' }
				: { row: remoteRow, winner: 'remote' };
		}
	}

	const localScore = getGenericCompletenessScore(localRow);
	const remoteScore = getGenericCompletenessScore(remoteRow);

	if (localScore !== remoteScore) {
		return localScore > remoteScore
			? { row: localRow, winner: 'local' }
			: { row: remoteRow, winner: 'remote' };
	}

	return getRowTimestamp(localRow) >= getRowTimestamp(remoteRow)
		? { row: localRow, winner: 'local' }
		: { row: remoteRow, winner: 'remote' };
}

function stripUndefinedFields(row: Record<string, unknown>) {
	const cleanRow: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(row)) {
		if (value !== undefined) {
			cleanRow[key] = value;
		}
	}

	return cleanRow;
}

const optionalSupabaseFieldsByTable: Record<SupabaseTableName, string[]> = {
	exercises: [],
	workouts: [],
	workout_exercises: [],
	workout_sessions: ['startedAt', 'completedAt'],
	session_exercises: [],
	session_sets: ['weightInput', 'repsInput', 'rirInput', 'weight', 'reps', 'rir'],
	exercise_reset_events: []
};

function toSupabaseUpsertRow(userId: string, tableName: SupabaseTableName, row: SyncableRow) {
	const upsertRow = stripUndefinedFields({
		...row,
		user_id: userId,
		_deleted: false
	});

	const sourceRow = row as Record<string, unknown>;

	for (const key of optionalSupabaseFieldsByTable[tableName]) {
		if (!(key in sourceRow) || sourceRow[key] === undefined) {
			upsertRow[key] = null;
		}
	}

	return upsertRow;
}

async function fetchAllSupabaseRows<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	tableName: SupabaseTableName,
	normalize: (row: T) => T = (row) => row
) {
	const pageSize = 1000;
	const rows: RemoteReconcileRow<T>[] = [];
	let from = 0;

	while (true) {
		assertSyncContextActive(deps, userId);
		const { data, error } = await supabase
			.from(tableName)
			.select('*')
			.eq('user_id', userId)
			.order('id', { ascending: true })
			.range(from, from + pageSize - 1);

		if (error) {
			throw error;
		}

		assertSyncContextActive(deps, userId);

		const pageRows = ((data ?? []) as SupabaseSyncedRow[]).map((row) => ({
			row: normalize(stripSupabaseSyncFields<T>(row)),
			deleted: row._deleted === true,
			modifiedAt: typeof row._modified === 'string' ? row._modified : undefined
		}));

		rows.push(...pageRows);

		if (pageRows.length < pageSize) {
			return rows;
		}

		from += pageSize;
	}
}

async function upsertSupabaseRows(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	tableName: SupabaseTableName,
	rows: SyncableRow[]
) {
	const pageSize = 200;

	for (let index = 0; index < rows.length; index += pageSize) {
		assertSyncContextActive(deps, userId);
		const pageRows = rows
			.slice(index, index + pageSize)
			.map((row) => toSupabaseUpsertRow(userId, tableName, row));

		if (pageRows.length === 0) {
			continue;
		}

		const { error } = await supabase.from(tableName).upsert(pageRows, { onConflict: 'id' });

		if (error) {
			throw error;
		}

		assertSyncContextActive(deps, userId);
	}
}

async function putReconciledRows<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	table: DataTable<T>,
	rows: T[]
) {
	for (const row of rows) {
		assertSyncContextActive(deps, userId);
		await table.put(row);
	}
}

async function reconcileTable<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	mode: DatabaseUploadMode,
	options: ReconcileTableOptions<T>
): Promise<DatabaseTableUploadSummary> {
	const normalize = options.normalize ?? ((row: T) => row);
	assertSyncContextActive(deps, userId);
	const localRows = (await options.localTable.toArray())
		.filter((row) => options.filterLocal?.(row) ?? true)
		.map(normalize);
	assertSyncContextActive(deps, userId);
	const remoteRows = await fetchAllSupabaseRows(deps, userId, options.tableName, normalize);
	assertSyncContextActive(deps, userId);
	const localRowsById = new Map(localRows.map((row) => [row.id, row]));
	const remoteRowsById = new Map(remoteRows.map((row) => [row.row.id, row]));
	const ids = [...new Set([...localRowsById.keys(), ...remoteRowsById.keys()])];
	const mergedRows: T[] = [];
	let localWins = 0;
	let remoteWins = 0;

	for (const id of ids) {
		const localRow = localRowsById.get(id);
		const remoteRow = remoteRowsById.get(id);

		if (remoteRow?.deleted) {
			if (shouldApplyRemoteDeletion(localRow, remoteRow)) {
				if (localRow) {
					assertSyncContextActive(deps, userId);
					await options.localTable.delete(id);
				}
				remoteWins += 1;
				continue;
			}

			if (localRow) {
				mergedRows.push(localRow);
				localWins += 1;
			}
			continue;
		}

		const choice = chooseReconciledRow(options.tableName, localRow, remoteRow?.row, mode);

		if (!choice) {
			continue;
		}

		mergedRows.push(choice.row);

		if (choice.winner === 'local') {
			localWins += 1;
		} else {
			remoteWins += 1;
		}
	}

	await putReconciledRows(deps, userId, options.localTable, mergedRows);
	await upsertSupabaseRows(deps, userId, options.tableName, mergedRows);

	return {
		table: options.tableName,
		localRows: localRows.length,
		remoteRows: remoteRows.length,
		mergedRows: mergedRows.length,
		uploadedRows: mergedRows.length,
		localWins,
		remoteWins
	};
}

async function reconcileSupabaseDatabase(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	mode: DatabaseUploadMode,
	options: ReconcileDatabaseOptions = {}
) {
	assertSyncContextActive(deps, userId);
	const totalTables = 7;
	let completedTables = 0;

	options.onProgress?.({ completedTables, totalTables });

	async function reconcileNextTable<T extends SyncableRow>(
		tableOptions: ReconcileTableOptions<T>
	): Promise<DatabaseTableUploadSummary> {
		assertSyncContextActive(deps, userId);
		const summary = await reconcileTable<T>(deps, userId, mode, tableOptions);
		assertSyncContextActive(deps, userId);
		completedTables += 1;
		options.onProgress?.({ completedTables, totalTables });
		return summary;
	}

	const tables = [
		await reconcileNextTable<Exercise>({
			tableName: 'exercises',
			localTable: deps.db.exercises,
			normalize: deps.withExerciseDefaults,
			filterLocal: (exercise) => shouldSyncExercise(deps, exercise)
		}),
		await reconcileNextTable<Workout>({
			tableName: 'workouts',
			localTable: deps.db.workouts
		}),
		await reconcileNextTable<WorkoutExercise>({
			tableName: 'workout_exercises',
			localTable: deps.db.workoutExercises
		}),
		await reconcileNextTable<WorkoutSession>({
			tableName: 'workout_sessions',
			localTable: deps.db.workoutSessions
		}),
		await reconcileNextTable<SessionExercise>({
			tableName: 'session_exercises',
			localTable: deps.db.sessionExercises
		}),
		await reconcileNextTable<SessionSet>({
			tableName: 'session_sets',
			localTable: deps.db.sessionSets,
			normalize: (row) => normalizeRemoteSessionSet(deps, row)
		}),
		await reconcileNextTable<ExerciseResetEvent>({
			tableName: 'exercise_reset_events',
			localTable: deps.db.exerciseResetEvents
		})
	];

	const summary = tables.reduce<DatabaseUploadSummary>(
		(total, table) => ({
			mode,
			tables,
			localRows: total.localRows + table.localRows,
			remoteRows: total.remoteRows + table.remoteRows,
			mergedRows: total.mergedRows + table.mergedRows,
			uploadedRows: total.uploadedRows + table.uploadedRows,
			localWins: total.localWins + table.localWins,
			remoteWins: total.remoteWins + table.remoteWins
		}),
		{
			mode,
			tables,
			localRows: 0,
			remoteRows: 0,
			mergedRows: 0,
			uploadedRows: 0,
			localWins: 0,
			remoteWins: 0
		}
	);

	assertSyncContextActive(deps, userId);
	deps.markSupabaseCacheHydrated(userId);

	return summary;
}

async function putMergedRemoteRow<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	tableName: SupabaseTableName,
	table: DataTable<T>,
	row: T,
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	const userId = getActiveSyncUserId(deps);
	const currentRow = await table.get(row.id);
	assertSyncContextActive(deps, userId);
	const choice = chooseReconciledRow(tableName, currentRow, normalize(row), 'richest');

	if (!choice) {
		return;
	}

	if (currentRow && areRowsEqual(currentRow, choice.row)) {
		return;
	}

	assertSyncContextActive(deps, userId);
	await table.put(choice.row);
}

async function putMergedRemoteRows<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	tableName: SupabaseTableName,
	table: DataTable<T>,
	rows: T[],
	normalize: (row: T) => T = (nextRow) => nextRow
) {
	for (const row of rows) {
		await putMergedRemoteRow(deps, tableName, table, row, normalize);
	}
}

function getSyncedTableConfigs(deps: DatabaseCloudSyncDependencies): SyncedTableConfig[] {
	return [
		{
			tableName: 'exercises',
			localTable: () => deps.db.exercises as unknown as DataTable<SyncableRow>,
			normalize: deps.withExerciseDefaults as unknown as (row: SyncableRow) => SyncableRow
		},
		{
			tableName: 'workouts',
			localTable: () => deps.db.workouts as unknown as DataTable<SyncableRow>
		},
		{
			tableName: 'workout_exercises',
			localTable: () => deps.db.workoutExercises as unknown as DataTable<SyncableRow>
		},
		{
			tableName: 'workout_sessions',
			localTable: () => deps.db.workoutSessions as unknown as DataTable<SyncableRow>
		},
		{
			tableName: 'session_exercises',
			localTable: () => deps.db.sessionExercises as unknown as DataTable<SyncableRow>
		},
		{
			tableName: 'session_sets',
			localTable: () => deps.db.sessionSets as unknown as DataTable<SyncableRow>,
			normalize: ((row: SyncableRow) =>
				normalizeRemoteSessionSet(deps, row as SessionSet) as SyncableRow) as (
				row: SyncableRow
			) => SyncableRow
		},
		{
			tableName: 'exercise_reset_events',
			localTable: () => deps.db.exerciseResetEvents as unknown as DataTable<SyncableRow>
		}
	];
}

async function fetchSupabaseRows<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	tableName: SupabaseTableName,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	buildQuery: (query: any) => PromiseLike<{ data: unknown; error: unknown }>,
	normalize: (row: T) => T = (row) => row
) {
	const userId = getActiveSyncUserId(deps);

	const { data, error } = await buildQuery(
		supabase.from(tableName).select('*').eq('user_id', userId).eq('_deleted', false)
	);

	if (error) {
		throw error;
	}

	assertSyncContextActive(deps, userId);

	return ((data ?? []) as SupabaseSyncedRow[]).map((row) =>
		normalize(stripSupabaseSyncFields<T>(row))
	);
}

async function fetchRecentSupabaseRows<T extends SyncableRow>(
	deps: DatabaseCloudSyncDependencies,
	tableName: SupabaseTableName,
	sinceIso: string,
	normalize: (row: T) => T = (row) => row
) {
	const pageSize = 1000;
	const rows: RemoteReconcileRow<T>[] = [];
	let from = 0;
	const userId = getActiveSyncUserId(deps);

	while (true) {
		assertSyncContextActive(deps, userId);
		const { data, error } = await supabase
			.from(tableName)
			.select('*')
			.eq('user_id', userId)
			.gte('_modified', sinceIso)
			.order('_modified', { ascending: false })
			.order('id', { ascending: true })
			.range(from, from + pageSize - 1);

		if (error) {
			throw error;
		}

		assertSyncContextActive(deps, userId);

		const pageRows = ((data ?? []) as SupabaseSyncedRow[]).map((row) => ({
			row: normalize(stripSupabaseSyncFields<T>(row)),
			deleted: row._deleted === true,
			modifiedAt: typeof row._modified === 'string' ? row._modified : undefined
		}));

		rows.push(...pageRows);

		if (pageRows.length < pageSize) {
			return rows;
		}

		from += pageSize;
	}
}

async function backfillRecentRows(
	deps: DatabaseCloudSyncDependencies,
	userId: string,
	days: number
) {
	assertSyncContextActive(deps, userId);
	const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	for (const tableConfig of getSyncedTableConfigs(deps)) {
		assertSyncContextActive(deps, userId);
		const remoteRows = await fetchRecentSupabaseRows(
			deps,
			tableConfig.tableName,
			sinceDate,
			tableConfig.normalize
		);
		const localTable = tableConfig.localTable();

		for (const remoteRow of remoteRows) {
			assertSyncContextActive(deps, userId);
			if (remoteRow.deleted) {
				const localRow = await localTable.get(remoteRow.row.id);
				assertSyncContextActive(deps, userId);

				if (localRow && shouldApplyRemoteDeletion(localRow, remoteRow)) {
					await localTable.delete(remoteRow.row.id);
				}
				continue;
			}

			await putMergedRemoteRow(
				deps,
				tableConfig.tableName,
				localTable,
				remoteRow.row,
				tableConfig.normalize
			);
		}
	}

	assertSyncContextActive(deps, userId);
	deps.markSupabaseCacheHydrated(userId);
}

export const dbCloudSync = {
	backfillRecentRows,
	fetchSupabaseRows,
	getRowTimestamp,
	normalizeRemoteSessionSet,
	putMergedRemoteRow,
	putMergedRemoteRows,
	reconcileSupabaseDatabase,
	shouldApplyRemoteDeletion,
	shouldSyncExercise,
	stripSupabaseSyncFields
};
