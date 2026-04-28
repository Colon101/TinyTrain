import { legacyDb, markSupabaseMigrationComplete, activateSupabaseBackend } from '$lib/db';
import type {
	Exercise,
	ExerciseResetEvent,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from '$lib/db';
import {
	awaitSupabaseInitialReplication,
	getTinyTrainRxDatabase,
	resetTinyTrainRxDatabase,
	startSupabaseReplication,
	toSupabaseRowId
} from '$lib/rxdb';
import { getSupabaseUser, loginWithSupabaseGoogle, supabase } from '$lib/supabase';
import {
	BASELINE_EXERCISE_BY_ID,
	BASELINE_EXERCISE_BY_NORMALIZED_NAME,
	BASELINE_EXERCISE_ROWS,
	normalizeExerciseName
} from '$lib/exercises';

export type MigrationStatus = 'not_started' | 'running' | 'completed' | 'failed';

export type MigrationLogLevel = 'info' | 'success' | 'error';

export type MigrationLogEntry = {
	id: string;
	level: MigrationLogLevel;
	message: string;
	createdAt: string;
};

export type MigrationCounts = Record<string, number>;

export type MigrationStatusRow = {
	user_id: string;
	dexie_user_id?: string;
	dexie_email?: string;
	status: MigrationStatus;
	started_at?: string;
	completed_at?: string;
	last_error?: string;
	dexie_counts: MigrationCounts;
	supabase_counts: MigrationCounts;
	logs: MigrationLogEntry[];
	app_version?: string;
	updated_at?: string;
};

type MigrationLogger = (entry: MigrationLogEntry) => void;
type RemoteExercise = Exercise & {
	id: string;
	user_id: string;
	_deleted?: boolean;
};

const replicatedTables = [
	'exercises',
	'workouts',
	'workout_exercises',
	'workout_sessions',
	'session_exercises',
	'session_sets',
	'exercise_reset_events'
] as const;
const cleanupTables = [
	'exercise_reset_events',
	'session_sets',
	'session_exercises',
	'workout_sessions',
	'workout_exercises',
	'workouts',
	'exercises'
] as const;
export const MIGRATION_APP_VERSION = 'supabase-rxdb-shared-baseline-v2';

function now() {
	return new Date().toISOString();
}

function createLog(level: MigrationLogLevel, message: string): MigrationLogEntry {
	return {
		id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		level,
		message,
		createdAt: now()
	};
}

function emit(log: MigrationLogger | undefined, level: MigrationLogLevel, message: string) {
	const entry = createLog(level, message);
	log?.(entry);
	return entry;
}

async function getSupabaseCounts(userId: string): Promise<MigrationCounts> {
	const entries = await Promise.all(
		replicatedTables.map(async (tableName) => {
			const { count, error } = await supabase
				.from(tableName)
				.select('id', { count: 'exact', head: true })
				.eq('user_id', userId)
				.eq('_deleted', false);

			if (error) {
				throw error;
			}

			return [tableName, count ?? 0] as const;
		})
	);

	return Object.fromEntries(entries);
}

export async function getMigrationStatus(userId: string) {
	const { data, error } = await supabase
		.from('migration_status')
		.select('*')
		.eq('user_id', userId)
		.maybeSingle();

	if (error) {
		throw error;
	}

	return data as MigrationStatusRow | null;
}

async function writeMigrationStatus(row: MigrationStatusRow) {
	const { error } = await supabase.from('migration_status').upsert(row, {
		onConflict: 'user_id'
	});

	if (error) {
		throw error;
	}
}

function mapId(userId: string, id: string) {
	return toSupabaseRowId(userId, id);
}

function getExerciseNormalizedName(row: Pick<Exercise, 'name' | 'normalizedName'>) {
	return normalizeExerciseName(row.normalizedName || row.name);
}

function getSharedBaselineExerciseId(row: Pick<Exercise, 'id' | 'name' | 'normalizedName' | 'source'>) {
	if (BASELINE_EXERCISE_BY_ID.has(row.id)) {
		return row.id;
	}

	const baselineExercise = BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(getExerciseNormalizedName(row));

	if (baselineExercise) {
		return baselineExercise.id;
	}

	return null;
}

function isLegacyBaselineExercise(row: Pick<Exercise, 'id' | 'name' | 'normalizedName' | 'source'>) {
	return (
		row.source === 'baseline' ||
		row.id.startsWith('baseline:') ||
		BASELINE_EXERCISE_BY_ID.has(row.id) ||
		BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(getExerciseNormalizedName(row))
	);
}

function describeExercise(row: Pick<Exercise, 'id' | 'name' | 'normalizedName'>) {
	return `${row.name || row.normalizedName || row.id} (${row.id})`;
}

function validateBaselineExerciseMappings(exercises: Exercise[]) {
	const baselineExercises = exercises.filter(isLegacyBaselineExercise);
	const unmappedBaselineExercises = baselineExercises.filter(
		(exercise) => !getSharedBaselineExerciseId(exercise)
	);

	if (unmappedBaselineExercises.length > 0) {
		throw new Error(
			`Could not map ${unmappedBaselineExercises.length} Dexie built-in exercise row(s) to the shared Supabase baseline catalog: ${unmappedBaselineExercises
				.slice(0, 12)
				.map(describeExercise)
				.join(', ')}${
				unmappedBaselineExercises.length > 12 ? ', ...' : ''
			}. Add these baseline names to src/lib/exercises.ts and rerun scripts/generate-baseline-exercises-sql.mjs, then rerun the Supabase bootstrap SQL.`
		);
	}

	return {
		baselineCount: baselineExercises.length,
		customCount: exercises.length - baselineExercises.length
	};
}

async function assertBaselineCatalogReady(addLog: (level: MigrationLogLevel, message: string) => void) {
	addLog('info', 'Checking Supabase shared baseline exercise catalog.');
	const { count, error } = await supabase
		.from('baseline_exercises')
		.select('id', { count: 'exact', head: true });

	if (error) {
		throw new Error(
			`Could not read Supabase baseline_exercises. Run scripts/supabase-bootstrap-new-project.sql in the Supabase SQL editor, then retry. ${error.message}`
		);
	}

	const baselineCount = count ?? 0;

	if (baselineCount < BASELINE_EXERCISE_ROWS.length) {
		throw new Error(
			`Supabase baseline_exercises has ${baselineCount} row(s), expected at least ${BASELINE_EXERCISE_ROWS.length}. Run scripts/supabase-bootstrap-new-project.sql in the Supabase SQL editor, then retry.`
		);
	}

	addLog('success', `Supabase shared baseline catalog has ${baselineCount} exercises.`);
}

function createExerciseIdMap(userId: string, exercises: Exercise[]) {
	return new Map(
		exercises.map((exercise) => [
			exercise.id,
			getSharedBaselineExerciseId(exercise) ?? mapId(userId, exercise.id)
		])
	);
}

function mapExerciseReference(exerciseIdByLegacyId: Map<string, string>, userId: string, exerciseId: string) {
	if (BASELINE_EXERCISE_BY_ID.has(exerciseId)) {
		return exerciseId;
	}

	if (exerciseId.startsWith('baseline:')) {
		const baselineExercise = BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(
			normalizeExerciseName(exerciseId.slice('baseline:'.length))
		);

		if (baselineExercise) {
			return baselineExercise.id;
		}
	}

	return exerciseIdByLegacyId.get(exerciseId) ?? mapId(userId, exerciseId);
}

function mapExercise(userId: string, row: Exercise) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		name: row.name,
		normalizedName: row.normalizedName,
		unilateral: Boolean(row.unilateral),
		source: row.source ?? (BASELINE_EXERCISE_BY_ID.has(row.id) ? 'baseline' : 'custom'),
		archived: Boolean(row.archived),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapWorkout(userId: string, row: Workout) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		name: row.name,
		normalizedName: row.normalizedName,
		archived: Boolean(row.archived),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapWorkoutExercise(
	userId: string,
	row: WorkoutExercise,
	exerciseIdByLegacyId: Map<string, string>
) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		workoutId: mapId(userId, row.workoutId),
		exerciseId: mapExerciseReference(exerciseIdByLegacyId, userId, row.exerciseId),
		order: row.order,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapWorkoutSession(userId: string, row: WorkoutSession) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		workoutId: mapId(userId, row.workoutId),
		workoutNameSnapshot: row.workoutNameSnapshot,
		dayKey: row.dayKey,
		...(row.startedAt ? { startedAt: row.startedAt } : {}),
		...(row.completedAt ? { completedAt: row.completedAt } : {}),
		status: row.status,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapSessionExercise(
	userId: string,
	row: SessionExercise,
	exerciseIdByLegacyId: Map<string, string>
) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		sessionId: mapId(userId, row.sessionId),
		workoutId: mapId(userId, row.workoutId),
		exerciseId: mapExerciseReference(exerciseIdByLegacyId, userId, row.exerciseId),
		exerciseNameSnapshot: row.exerciseNameSnapshot,
		order: row.order,
		performedAt: row.performedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapSessionSet(userId: string, row: SessionSet, exerciseIdByLegacyId: Map<string, string>) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		sessionExerciseId: mapId(userId, row.sessionExerciseId),
		exerciseId: mapExerciseReference(exerciseIdByLegacyId, userId, row.exerciseId),
		order: row.order,
		side: row.side,
		...(row.weightInput !== undefined ? { weightInput: row.weightInput } : {}),
		...(row.repsInput !== undefined ? { repsInput: row.repsInput } : {}),
		...(row.rirInput !== undefined ? { rirInput: row.rirInput } : {}),
		...(row.weight !== undefined ? { weight: row.weight } : {}),
		...(row.reps !== undefined ? { reps: row.reps } : {}),
		...(row.rir !== undefined ? { rir: row.rir } : {}),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function mapExerciseResetEvent(
	userId: string,
	row: ExerciseResetEvent,
	exerciseIdByLegacyId: Map<string, string>
) {
	return {
		id: mapId(userId, row.id),
		user_id: userId,
		exerciseId: mapExerciseReference(exerciseIdByLegacyId, userId, row.exerciseId),
		resetAt: row.resetAt,
		createdAt: row.createdAt
	};
}

async function clearExistingSupabaseRows(userId: string) {
	for (const tableName of cleanupTables) {
		const { error } = await supabase.from(tableName).delete().eq('user_id', userId);

		if (error) {
			throw error;
		}
	}

	const remainingCounts = await getSupabaseCounts(userId);
	const remainingTables = replicatedTables.filter((tableName) => remainingCounts[tableName] > 0);

	if (remainingTables.length > 0) {
		throw new Error(
			`Could not clear existing Supabase rows from ${remainingTables.join(
				', '
			)}. Run scripts/supabase-user-row-delete-policies.sql in Supabase, then retry migration.`
		);
	}
}

async function listRemoteExercises(userId: string) {
	const { data, error } = await supabase
		.from('exercises')
		.select('*')
		.eq('user_id', userId)
		.eq('_deleted', false);

	if (error) {
		throw error;
	}

	return (data ?? []) as RemoteExercise[];
}

async function normalizeExistingSupabaseBaselineRows(userId: string, addLog: (level: MigrationLogLevel, message: string) => void) {
	addLog('info', 'Reading existing Supabase exercise rows.');
	const remoteExercises = await listRemoteExercises(userId);
	validateBaselineExerciseMappings(remoteExercises);
	const baselineIdMap = new Map(
		remoteExercises
			.map((exercise) => [exercise.id, getSharedBaselineExerciseId(exercise)] as const)
			.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
			.filter(([currentId, sharedId]) => currentId !== sharedId)
	);

	if (baselineIdMap.size === 0) {
		addLog('success', 'Existing Supabase rows already use shared built-in exercise IDs.');
	} else {
		addLog('info', `Rewriting ${baselineIdMap.size} built-in exercise references.`);
		for (const [oldExerciseId, sharedExerciseId] of baselineIdMap) {
			for (const tableName of ['workout_exercises', 'session_exercises', 'session_sets', 'exercise_reset_events'] as const) {
				const { error } = await supabase
					.from(tableName)
					.update({ exerciseId: sharedExerciseId })
					.eq('user_id', userId)
					.eq('exerciseId', oldExerciseId);

				if (error) {
					throw error;
				}
			}
		}

		const oldExerciseIds = [...baselineIdMap.keys()];
		const { error } = await supabase
			.from('exercises')
			.delete()
			.eq('user_id', userId)
			.in('id', oldExerciseIds);

		if (error) {
			throw error;
		}

		const remainingBaselineRows = (await listRemoteExercises(userId)).filter((exercise) =>
			oldExerciseIds.includes(exercise.id)
		);

		if (remainingBaselineRows.length > 0) {
			throw new Error(
				'Built-in exercise references were rewritten, but old duplicated exercise rows could not be deleted. Run scripts/supabase-user-row-delete-policies.sql in Supabase, then retry migration.'
			);
		}

		addLog('success', 'Built-in exercise references now point to the shared catalog.');
	}

	addLog('info', 'Resetting local RxDB so it can pull the normalized Supabase rows.');
	await withTimeout('Resetting local RxDB', resetTinyTrainRxDatabase(userId));
	await withTimeout('Opening RxDB database', getTinyTrainRxDatabase(userId));
	await startSupabaseReplication(userId);
	await awaitSupabaseInitialReplication(userId);
	addLog('success', 'Local RxDB rebuilt from normalized Supabase rows.');
}

function assertCountsMatch(dexieCounts: MigrationCounts, supabaseCounts: MigrationCounts) {
	const mismatches = replicatedTables.filter(
		(tableName) => dexieCounts[tableName] !== supabaseCounts[tableName]
	);

	if (mismatches.length > 0) {
		throw new Error(
			`Supabase count mismatch: ${mismatches
				.map((tableName) => `${tableName} Dexie=${dexieCounts[tableName]} Supabase=${supabaseCounts[tableName]}`)
				.join(', ')}`
		);
	}
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 30000) {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

export async function ensureSupabaseMigrationLogin(redirectPath = '/migrate/supabase') {
	const user = await getSupabaseUser();

	if (user) {
		return user;
	}

	await loginWithSupabaseGoogle(redirectPath);
	return null;
}

export async function runSupabaseMigration(log?: MigrationLogger) {
	const logs: MigrationLogEntry[] = [];
	const addLog = (level: MigrationLogLevel, message: string) => {
		const entry = emit(log, level, message);
		logs.push(entry);
	};

	addLog('info', 'Checking Dexie Cloud session.');
	await legacyDb.open();

	const dexieUser = legacyDb.cloud.currentUser.value;

	if (!dexieUser?.isLoggedIn) {
		throw new Error('Sign in with Dexie Cloud before migrating.');
	}

	addLog('success', `Dexie Cloud signed in as ${dexieUser.email || dexieUser.name || 'current user'}.`);
	addLog('info', 'Checking Supabase session.');
	const supabaseUser = await getSupabaseUser();

	if (!supabaseUser) {
		throw new Error('Sign in with Supabase before migrating.');
	}

	await assertBaselineCatalogReady(addLog);

	const existingStatus = await getMigrationStatus(supabaseUser.id).catch(() => null);

	if (existingStatus?.status === 'completed' && existingStatus.app_version === MIGRATION_APP_VERSION) {
		addLog('success', 'This Supabase account is already marked as migrated.');
		markSupabaseMigrationComplete(supabaseUser.id, {
			dexieUserId: dexieUser.userId,
			email: supabaseUser.email
		});
		await activateSupabaseBackend();
		return existingStatus;
	}

	if (existingStatus?.status === 'completed') {
		addLog('info', 'Existing migration uses an older data layout. Rebuilding Supabase rows.');
		await normalizeExistingSupabaseBaselineRows(supabaseUser.id, addLog);
		const completedAt = now();
		const supabaseCounts = await getSupabaseCounts(supabaseUser.id);
		const nextStatus: MigrationStatusRow = {
			...existingStatus,
			user_id: supabaseUser.id,
			dexie_user_id: dexieUser.userId,
			dexie_email: dexieUser.email,
			status: 'completed',
			completed_at: completedAt,
			supabase_counts: supabaseCounts,
			logs,
			app_version: MIGRATION_APP_VERSION,
			updated_at: completedAt
		};
		await writeMigrationStatus(nextStatus);
		markSupabaseMigrationComplete(supabaseUser.id, {
			dexieUserId: dexieUser.userId,
			email: supabaseUser.email
		});
		await activateSupabaseBackend();
		addLog('success', 'Migration rebuilt with shared built-in exercises.');
		return nextStatus;
	}

	addLog('info', 'Pulling latest Dexie Cloud changes.');
	await legacyDb.cloud.sync({ wait: true, purpose: 'push' });
	await legacyDb.cloud.sync({ wait: true, purpose: 'pull' });
	addLog('success', 'Dexie Cloud is up to date.');

	const startedAt = now();
	await writeMigrationStatus({
		user_id: supabaseUser.id,
		dexie_user_id: dexieUser.userId,
		dexie_email: dexieUser.email,
		status: 'running',
		started_at: startedAt,
		dexie_counts: {},
		supabase_counts: {},
		logs,
		app_version: MIGRATION_APP_VERSION
	});

	addLog('info', 'Reading local Dexie rows.');
	const [
		exercises,
		workouts,
		workoutExercises,
		workoutSessions,
		sessionExercises,
		sessionSets,
		exerciseResetEvents
	] = await Promise.all([
		legacyDb.exercises.toArray(),
		legacyDb.workouts.toArray(),
		legacyDb.workoutExercises.toArray(),
		legacyDb.workoutSessions.toArray(),
		legacyDb.sessionExercises.toArray(),
		legacyDb.sessionSets.toArray(),
		legacyDb.exerciseResetEvents.toArray()
	]);
	const exerciseMappingSummary = validateBaselineExerciseMappings(exercises);
	const dexieCounts: MigrationCounts = {
		exercises: exercises.filter((exercise) => !getSharedBaselineExerciseId(exercise)).length,
		workouts: workouts.length,
		workout_exercises: workoutExercises.length,
		workout_sessions: workoutSessions.length,
		session_exercises: sessionExercises.length,
		session_sets: sessionSets.length,
		exercise_reset_events: exerciseResetEvents.length
	};

	addLog('success', `Read ${Object.values(dexieCounts).reduce((sum, count) => sum + count, 0)} Dexie rows.`);
	addLog(
		'success',
		`Mapped ${exerciseMappingSummary.baselineCount} Dexie built-in exercise row(s) to shared Supabase baseline IDs. ${exerciseMappingSummary.customCount} custom exercise row(s) will be migrated for this user.`
	);
	addLog('info', 'Clearing existing Supabase rows for this user.');
	await clearExistingSupabaseRows(supabaseUser.id);
	addLog('success', 'Existing Supabase rows cleared.');

	addLog('info', 'Resetting local RxDB migration database.');
	await withTimeout('Resetting local RxDB', resetTinyTrainRxDatabase(supabaseUser.id));
	addLog('success', 'Local RxDB migration database is clean.');

	addLog('info', 'Opening RxDB database.');
	const rxdb = await withTimeout('Opening RxDB database', getTinyTrainRxDatabase(supabaseUser.id));
	addLog('success', 'RxDB database opened.');

	addLog('info', 'Copying rows into RxDB with Supabase-safe IDs.');
	const exerciseIdByLegacyId = createExerciseIdMap(supabaseUser.id, exercises);
	const customExercises = exercises.filter((exercise) => !getSharedBaselineExerciseId(exercise));
	const sharedBaselineCount = exercises.length - customExercises.length;
	await rxdb.exercises.bulkUpsert(customExercises.map((row) => mapExercise(supabaseUser.id, row)));
	addLog(
		'success',
		`Copied ${customExercises.length} custom exercises. Shared ${sharedBaselineCount} built-in exercises.`
	);
	await rxdb.workouts.bulkUpsert(workouts.map((row) => mapWorkout(supabaseUser.id, row)));
	addLog('success', `Copied ${workouts.length} workouts.`);
	await rxdb.workoutExercises.bulkUpsert(
		workoutExercises.map((row) => mapWorkoutExercise(supabaseUser.id, row, exerciseIdByLegacyId))
	);
	addLog('success', `Copied ${workoutExercises.length} workout exercise rows.`);
	await rxdb.workoutSessions.bulkUpsert(
		workoutSessions.map((row) => mapWorkoutSession(supabaseUser.id, row))
	);
	addLog('success', `Copied ${workoutSessions.length} workout sessions.`);
	await rxdb.sessionExercises.bulkUpsert(
		sessionExercises.map((row) => mapSessionExercise(supabaseUser.id, row, exerciseIdByLegacyId))
	);
	addLog('success', `Copied ${sessionExercises.length} session exercises.`);
	await rxdb.sessionSets.bulkUpsert(
		sessionSets.map((row) => mapSessionSet(supabaseUser.id, row, exerciseIdByLegacyId))
	);
	addLog('success', `Copied ${sessionSets.length} session sets.`);
	await rxdb.exerciseResetEvents.bulkUpsert(
		exerciseResetEvents.map((row) =>
			mapExerciseResetEvent(supabaseUser.id, row, exerciseIdByLegacyId)
		)
	);
	addLog('success', `Copied ${exerciseResetEvents.length} reset events.`);

	addLog('info', 'Starting Supabase replication.');
	await startSupabaseReplication(supabaseUser.id);
	await awaitSupabaseInitialReplication(supabaseUser.id);
	addLog('success', 'Initial Supabase replication completed.');

	addLog('info', 'Verifying Supabase counts.');
	const supabaseCounts = await getSupabaseCounts(supabaseUser.id);
	assertCountsMatch(dexieCounts, supabaseCounts);
	addLog('success', 'Supabase counts match local Dexie counts.');

	const completedAt = now();
	const nextStatus: MigrationStatusRow = {
		user_id: supabaseUser.id,
		dexie_user_id: dexieUser.userId,
		dexie_email: dexieUser.email,
		status: 'completed',
		started_at: startedAt,
		completed_at: completedAt,
		dexie_counts: dexieCounts,
		supabase_counts: supabaseCounts,
		logs,
		app_version: MIGRATION_APP_VERSION
	};
	await writeMigrationStatus(nextStatus);
	markSupabaseMigrationComplete(supabaseUser.id, {
		dexieUserId: dexieUser.userId,
		email: supabaseUser.email
	});
	await activateSupabaseBackend();
	addLog('success', 'Migration complete. TinyTrain will now use Supabase for this account.');

	return nextStatus;
}

export async function recordMigrationFailure(userId: string, error: unknown, logs: MigrationLogEntry[]) {
	await writeMigrationStatus({
		user_id: userId,
		status: 'failed',
		last_error: error instanceof Error ? error.message : 'Migration failed.',
		dexie_counts: {},
		supabase_counts: {},
		logs,
		app_version: MIGRATION_APP_VERSION
	});
}
