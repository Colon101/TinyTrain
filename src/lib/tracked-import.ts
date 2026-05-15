import { strFromU8, unzipSync } from 'fflate';
import {
	db,
	ensureDbOpen,
	normalizeName,
	syncNow,
	toDayKey,
	type Exercise,
	type SessionSet,
	type SessionSetSide,
	type Workout,
	type WorkoutExercise,
	type WorkoutSession,
	type SessionExercise
} from './db';
import {
	BASELINE_EXERCISE_BY_ID,
	BASELINE_EXERCISE_BY_NORMALIZED_NAME,
	BASELINE_EXERCISE_ROWS
} from './exercises';

export type TrackedLimbPriority = 'primary-right' | 'primary-left';

export type TrackedExerciseLimbPriority = {
	normalizedName: string;
	name: string;
	setsWithSecondaryValues: number;
	limbPriority: TrackedLimbPriority;
};

export type TrackedImportPhase = 'reading' | 'planning' | 'writing' | 'syncing';

export type TrackedImportOptions = {
	limbPriorities?: Record<string, TrackedLimbPriority>;
	onProgress?: (phase: TrackedImportPhase) => void;
};

export type TrackedImportSummary = {
	fileName: string;
	requiredFilesPresent: string[];
	optionalFilesPresent: string[];
	ignoredFiles: string[];
	unsupportedCategories: string[];
	sessionsFound: number;
	sessionsImportable: number;
	sessionsImported: number;
	sessionsSkipped: number;
	strengthSetRowsFound: number;
	strengthSetRowsImportable: number;
	sessionSetsImported: number;
	sessionSetsSkipped: number;
	exercisesMatched: number;
	exercisesMerged: number;
	exercisesCreated: number;
	workoutsMatched: number;
	workoutsCreated: number;
	exerciseLimbPriorities: TrackedExerciseLimbPriority[];
	warnings: string[];
	syncStatus: 'not-run' | 'synced' | 'failed';
	syncError?: string;
};

type CsvRow = Record<string, string>;

type TrackedArchive = {
	fileName: string;
	files: Map<string, string>;
	ignoredFiles: string[];
	requiredFilesPresent: string[];
	optionalFilesPresent: string[];
	rows: {
		exercises: CsvRow[];
		workoutGroups: CsvRow[];
		workouts: CsvRow[];
		sessions: CsvRow[];
		sets: CsvRow[];
	};
};

type PlannedExercise = {
	trackedIds: Set<string>;
	trackedNames: Set<string>;
	displayName: string;
	normalizedName: string;
	unilateral: boolean;
	canonicalExercise: Exercise | null;
	createdExercise: Exercise | null;
	usedBySets: boolean;
};

type ImportPlan = {
	archive: TrackedArchive;
	summary: TrackedImportSummary;
	exercisesByTrackedId: Map<string, PlannedExercise>;
	exercisesByNormalizedName: Map<string, PlannedExercise>;
	workoutNameByTrackedId: Map<string, string>;
	sessionRows: CsvRow[];
	setRows: CsvRow[];
};

const REQUIRED_FILES = ['sessions.csv', 'sets.csv', 'exercises.csv'];
const OPTIONAL_FILES = ['workouts.csv', 'workout_groups.csv'];
const UNSUPPORTED_CATEGORIES = [
	'bodyweight',
	'daily steps',
	'nutrition',
	'progress photos',
	'programs',
	'cardio',
	'isometric sets'
];

export async function previewTrackedArchive(file: File): Promise<TrackedImportSummary> {
	const archive = await readTrackedArchive(file);
	const plan = await buildImportPlan(archive);

	return plan.summary;
}

export async function importTrackedArchive(
	file: File,
	options: TrackedImportOptions = {}
): Promise<TrackedImportSummary> {
	options.onProgress?.('reading');
	const archive = await readTrackedArchive(file);
	options.onProgress?.('planning');
	const plan = await buildImportPlan(archive);

	if (plan.summary.sessionsImportable === 0 || plan.summary.strengthSetRowsImportable === 0) {
		throw new Error('No importable Tracked strength workouts were found.');
	}

	await ensureDbOpen();

	if (!db.cloud.currentUser.value?.isLoggedIn) {
		throw new Error('Sign in with Google before importing from Tracked.');
	}

	options.onProgress?.('writing');
	const importedSummary = await writeImportPlan(plan, options);

	try {
		options.onProgress?.('syncing');
		await syncNow();
		return { ...importedSummary, syncStatus: 'synced' };
	} catch (error) {
		return {
			...importedSummary,
			syncStatus: 'failed',
			syncError: error instanceof Error ? error.message : 'Sync failed.'
		};
	}
}

async function readTrackedArchive(file: File): Promise<TrackedArchive> {
	if (!file.name.toLocaleLowerCase().endsWith('.zip')) {
		throw new Error('Choose a Tracked zip export.');
	}

	const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
	const files = new Map<string, string>();

	for (const [path, contents] of Object.entries(unzipped)) {
		const fileName = path.split('/').at(-1)?.toLocaleLowerCase() ?? '';

		if (!fileName || !fileName.endsWith('.csv')) {
			continue;
		}

		files.set(fileName, strFromU8(contents));
	}

	const missingRequiredFiles = REQUIRED_FILES.filter((fileName) => !files.has(fileName));

	if (missingRequiredFiles.length > 0) {
		throw new Error(`Missing required Tracked CSV: ${missingRequiredFiles.join(', ')}.`);
	}

	const ignoredFiles = [...files.keys()]
		.filter((fileName) => !REQUIRED_FILES.includes(fileName) && !OPTIONAL_FILES.includes(fileName))
		.sort();

	const rows = {
		exercises: parseCsvFile(files.get('exercises.csv') ?? '', 'exercises.csv'),
		workoutGroups: parseCsvFile(files.get('workout_groups.csv') ?? 'id,name', 'workout_groups.csv'),
		workouts: parseCsvFile(files.get('workouts.csv') ?? 'id,name', 'workouts.csv'),
		sessions: parseCsvFile(files.get('sessions.csv') ?? '', 'sessions.csv'),
		sets: parseCsvFile(files.get('sets.csv') ?? '', 'sets.csv')
	};

	assertCsvColumns('exercises.csv', rows.exercises, ['id', 'name']);
	assertCsvColumns('sessions.csv', rows.sessions, ['id', 'sessionDate']);
	assertCsvColumns('sets.csv', rows.sets, [
		'id',
		'sessionId',
		'exerciseId',
		'exerciseName',
		'repetitions',
		'weight',
		'rir'
	]);

	return {
		fileName: file.name,
		files,
		ignoredFiles,
		requiredFilesPresent: REQUIRED_FILES.filter((fileName) => files.has(fileName)),
		optionalFilesPresent: OPTIONAL_FILES.filter((fileName) => files.has(fileName)),
		rows
	};
}

async function buildImportPlan(archive: TrackedArchive): Promise<ImportPlan> {
	await ensureDbOpen();

	const existingExercises = await db.exercises.toArray();
	const existingWorkouts = await db.workouts.toArray();
	const existingExerciseByNormalizedName = new Map<string, Exercise>();
	const existingWorkoutByNormalizedName = new Map<string, Workout>();

	for (const exercise of [...BASELINE_EXERCISE_ROWS, ...existingExercises]) {
		const normalizedName = normalizeName(exercise.normalizedName || exercise.name);

		if (!normalizedName || existingExerciseByNormalizedName.has(normalizedName)) {
			continue;
		}

		existingExerciseByNormalizedName.set(normalizedName, exercise);
	}

	for (const workout of existingWorkouts) {
		const normalizedName = normalizeName(workout.normalizedName || workout.name);

		if (
			normalizedName &&
			!workout.archived &&
			!existingWorkoutByNormalizedName.has(normalizedName)
		) {
			existingWorkoutByNormalizedName.set(normalizedName, workout);
		}
	}

	const sessionById = new Map(archive.rows.sessions.map((session) => [session.id, session]));
	const setRows = archive.rows.sets.filter((set) => {
		return Boolean(
			set.sessionId && sessionById.has(set.sessionId) && normalizeName(set.exerciseName)
		);
	});
	const importableSessionIds = new Set(setRows.map((set) => set.sessionId));
	const sessionRows = archive.rows.sessions.filter((session) =>
		importableSessionIds.has(session.id)
	);
	const trackedExerciseById = new Map(
		archive.rows.exercises.map((exercise) => [exercise.id, exercise])
	);
	const exercisesByTrackedId = new Map<string, PlannedExercise>();
	const exercisesByNormalizedName = new Map<string, PlannedExercise>();

	for (const set of setRows) {
		const trackedExercise = trackedExerciseById.get(set.exerciseId);
		const name = resolveSetExerciseName(set, trackedExercise);
		const normalizedName = normalizeName(name);

		if (!normalizedName) {
			continue;
		}

		const plannedExercise = exercisesByNormalizedName.get(normalizedName) ?? {
			trackedIds: new Set<string>(),
			trackedNames: new Set<string>(),
			displayName: name,
			normalizedName,
			unilateral: parseBoolean(trackedExercise?.unilateral) || hasSecondarySetValues(set),
			canonicalExercise: existingExerciseByNormalizedName.get(normalizedName) ?? null,
			createdExercise: null,
			usedBySets: false
		};

		plannedExercise.usedBySets = true;
		plannedExercise.unilateral =
			plannedExercise.unilateral ||
			parseBoolean(trackedExercise?.unilateral) ||
			hasSecondarySetValues(set);
		plannedExercise.trackedNames.add(name);

		if (set.exerciseId) {
			plannedExercise.trackedIds.add(set.exerciseId);
			exercisesByTrackedId.set(set.exerciseId, plannedExercise);
		}

		exercisesByNormalizedName.set(normalizedName, plannedExercise);
	}

	const workoutGroupById = new Map(archive.rows.workoutGroups.map((group) => [group.id, group]));
	const workoutById = new Map(archive.rows.workouts.map((workout) => [workout.id, workout]));
	const workoutNameByTrackedId = new Map<string, string>();

	for (const session of sessionRows) {
		const trackedWorkout = workoutById.get(session.workoutId);
		const workoutGroup = trackedWorkout
			? workoutGroupById.get(trackedWorkout.workoutGroupId)
			: null;
		const name = displayName(
			session.workoutName || trackedWorkout?.name || workoutGroup?.name || 'Tracked Workout'
		);

		if (session.workoutId) {
			workoutNameByTrackedId.set(session.workoutId, name);
		}
	}

	const workoutNames = [
		...new Set(sessionRows.map((session) => getWorkoutName(session, workoutNameByTrackedId)))
	];
	const summary = createBaseSummary(archive);
	summary.sessionsFound = archive.rows.sessions.length;
	summary.sessionsImportable = sessionRows.length;
	summary.strengthSetRowsFound = archive.rows.sets.length;
	summary.strengthSetRowsImportable = setRows.length;
	summary.exercisesMatched = [...exercisesByNormalizedName.values()].filter(
		(exercise) => exercise.canonicalExercise
	).length;
	summary.exercisesMerged = [...exercisesByNormalizedName.values()].filter(
		(exercise) =>
			exercise.trackedIds.size > 1 || exercise.trackedNames.size > 1 || exercise.canonicalExercise
	).length;
	summary.exercisesCreated = [...exercisesByNormalizedName.values()].filter(
		(exercise) => !exercise.canonicalExercise
	).length;
	summary.exerciseLimbPriorities = [...exercisesByNormalizedName.values()]
		.map((exercise) => ({
			normalizedName: exercise.normalizedName,
			name: exercise.canonicalExercise?.name ?? exercise.displayName,
			setsWithSecondaryValues: setRows.filter(
				(set) =>
					resolveSetNormalizedName(set, trackedExerciseById) === exercise.normalizedName &&
					hasSecondarySetValues(set)
			).length,
			limbPriority: 'primary-right' as TrackedLimbPriority
		}))
		.filter((exercise) => exercise.setsWithSecondaryValues > 0)
		.sort(
			(first, second) =>
				second.setsWithSecondaryValues - first.setsWithSecondaryValues ||
				first.name.localeCompare(second.name)
		);
	summary.workoutsMatched = workoutNames.filter((name) =>
		existingWorkoutByNormalizedName.has(normalizeName(name))
	).length;
	summary.workoutsCreated = workoutNames.length - summary.workoutsMatched;

	const skippedSetRows = archive.rows.sets.length - setRows.length;

	if (skippedSetRows > 0) {
		summary.warnings.push(`${skippedSetRows} set rows reference missing sessions or exercises.`);
	}

	if (archive.ignoredFiles.length > 0) {
		summary.warnings.push(`${archive.ignoredFiles.length} unsupported CSV files will be ignored.`);
	}

	return {
		archive,
		summary,
		exercisesByTrackedId,
		exercisesByNormalizedName,
		workoutNameByTrackedId,
		sessionRows,
		setRows
	};
}

async function writeImportPlan(
	plan: ImportPlan,
	options: TrackedImportOptions
): Promise<TrackedImportSummary> {
	const now = timestamp();
	const summary = { ...plan.summary, warnings: [...plan.summary.warnings] };
	const exercises = await upsertImportedExercises(plan, now);
	const workouts = await upsertImportedWorkouts(plan, now);
	const setRowsBySessionId = groupBy(plan.setRows, (set) => set.sessionId);
	const existingSessionIds = new Set(
		(
			await db.workoutSessions.bulkGet(
				plan.sessionRows.map((session) => toTrackedId('session', session.id))
			)
		)
			.filter(isDefined)
			.map((session) => session.id)
	);
	const sessionsToAdd: WorkoutSession[] = [];
	const sessionExercisesToAdd: SessionExercise[] = [];
	const sessionSetsToAdd: SessionSet[] = [];
	const latestExerciseIdsByWorkoutId = new Map<string, string[]>();

	summary.exercisesCreated = exercises.created;
	summary.exercisesMatched = exercises.matched;
	summary.exercisesMerged = exercises.merged;
	summary.workoutsCreated = workouts.created;
	summary.workoutsMatched = workouts.matched;
	summary.exerciseLimbPriorities = summary.exerciseLimbPriorities.map((exercise) => ({
		...exercise,
		limbPriority: options.limbPriorities?.[exercise.normalizedName] ?? exercise.limbPriority
	}));

	for (const sessionRow of plan.sessionRows) {
		const sessionId = toTrackedId('session', sessionRow.id);
		const sessionSetRows = setRowsBySessionId.get(sessionRow.id) ?? [];

		if (existingSessionIds.has(sessionId)) {
			summary.sessionsSkipped += 1;
			summary.sessionSetsSkipped += countImportedSetRows(sessionSetRows);
			continue;
		}

		const workoutName = getWorkoutName(sessionRow, plan.workoutNameByTrackedId);
		const workout = workouts.byName.get(normalizeName(workoutName));

		if (!workout) {
			summary.sessionsSkipped += 1;
			summary.warnings.push(
				`Skipped session ${sessionRow.id} because its workout could not be resolved.`
			);
			continue;
		}

		const startedAt = toIsoTimestamp(sessionRow.startedAt || sessionRow.sessionDate) ?? now;
		const completedAt = toIsoTimestamp(sessionRow.endedAt) ?? startedAt;
		const session: WorkoutSession = {
			id: sessionId,
			workoutId: workout.id,
			workoutNameSnapshot: workout.name,
			dayKey: sessionRow.sessionDate || toDayKey(startedAt),
			startedAt,
			completedAt,
			status: parseBoolean(sessionRow.completed) ? 'completed' : 'abandoned',
			createdAt: startedAt,
			updatedAt: completedAt
		};
		const exerciseRowsForSession = buildSessionExerciseRows(
			session,
			sessionSetRows,
			plan.exercisesByTrackedId,
			exercises.byNormalizedName,
			completedAt
		);
		const sessionExerciseByTrackedExerciseId = new Map(
			exerciseRowsForSession.map((sessionExercise) => [
				sessionExercise.id.split(':exercise:').at(-1) ?? '',
				sessionExercise
			])
		);
		const setRowsForSession = buildTrackedSessionSetRows(
			sessionSetRows,
			sessionExerciseByTrackedExerciseId,
			plan.exercisesByTrackedId,
			options
		);

		sessionsToAdd.push(session);
		sessionExercisesToAdd.push(...exerciseRowsForSession);
		sessionSetsToAdd.push(...setRowsForSession);
		latestExerciseIdsByWorkoutId.set(
			workout.id,
			exerciseRowsForSession.map((sessionExercise) => sessionExercise.exerciseId)
		);
		summary.sessionsImported += 1;
		summary.sessionSetsImported += setRowsForSession.length;
	}

	const workoutExercisesToPut = await buildWorkoutExerciseRows(
		latestExerciseIdsByWorkoutId,
		workouts.byId,
		now
	);

	await db.transaction(
		'rw',
		db.exercises,
		db.workouts,
		db.workoutExercises,
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		async () => {
			if (exercises.toAdd.length > 0) {
				await db.exercises.bulkAdd(exercises.toAdd);
			}

			if (workouts.toAdd.length > 0) {
				await db.workouts.bulkAdd(workouts.toAdd);
			}

			if (sessionsToAdd.length > 0) {
				await db.workoutSessions.bulkAdd(sessionsToAdd);
			}

			if (sessionExercisesToAdd.length > 0) {
				await db.sessionExercises.bulkAdd(sessionExercisesToAdd);
			}

			if (sessionSetsToAdd.length > 0) {
				await db.sessionSets.bulkAdd(sessionSetsToAdd);
			}

			if (workoutExercisesToPut.length > 0) {
				await db.workoutExercises.bulkPut(workoutExercisesToPut);
			}
		}
	);

	return summary;
}

async function upsertImportedExercises(plan: ImportPlan, now: string) {
	const existingExercises = await db.exercises.toArray();
	const existingByNormalizedName = new Map<string, Exercise>();
	const toAdd: Exercise[] = [];
	let matched = 0;
	let merged = 0;
	let created = 0;

	for (const exercise of [...BASELINE_EXERCISE_ROWS, ...existingExercises]) {
		const normalizedName = normalizeName(exercise.normalizedName || exercise.name);

		if (normalizedName && !existingByNormalizedName.has(normalizedName)) {
			existingByNormalizedName.set(normalizedName, exercise);
		}
	}

	for (const plannedExercise of plan.exercisesByNormalizedName.values()) {
		const existingExercise = existingByNormalizedName.get(plannedExercise.normalizedName);

		if (existingExercise) {
			plannedExercise.canonicalExercise = existingExercise;
			matched += 1;
			if (plannedExercise.trackedIds.size > 0) {
				merged += 1;
			}
			continue;
		}

		const exercise: Exercise = {
			id: toTrackedId('exercise', plannedExercise.normalizedName),
			name: plannedExercise.displayName,
			normalizedName: plannedExercise.normalizedName,
			unilateral: plannedExercise.unilateral,
			source: BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(plannedExercise.normalizedName)
				? 'baseline'
				: 'custom',
			archived: false,
			createdAt: now,
			updatedAt: now
		};

		plannedExercise.createdExercise = exercise;
		plannedExercise.canonicalExercise = exercise;
		existingByNormalizedName.set(plannedExercise.normalizedName, exercise);

		if (!BASELINE_EXERCISE_BY_ID.has(exercise.id)) {
			toAdd.push(exercise);
		}

		created += 1;
	}

	return { toAdd, byNormalizedName: existingByNormalizedName, matched, merged, created };
}

async function upsertImportedWorkouts(plan: ImportPlan, now: string) {
	const existingWorkouts = await db.workouts.toArray();
	const byName = new Map<string, Workout>();
	const byId = new Map<string, Workout>();
	const toAdd: Workout[] = [];
	let matched = 0;
	let created = 0;

	for (const workout of existingWorkouts) {
		const normalizedName = normalizeName(workout.normalizedName || workout.name);

		if (normalizedName && !workout.archived && !byName.has(normalizedName)) {
			byName.set(normalizedName, workout);
			byId.set(workout.id, workout);
		}
	}

	const importedWorkoutNames = [
		...new Set(
			plan.sessionRows.map((session) => getWorkoutName(session, plan.workoutNameByTrackedId))
		)
	];

	for (const name of importedWorkoutNames) {
		const normalizedName = normalizeName(name);

		if (!normalizedName || byName.has(normalizedName)) {
			if (normalizedName) {
				matched += 1;
			}
			continue;
		}

		const workout: Workout = {
			id: toTrackedId('workout', normalizedName),
			name,
			normalizedName,
			archived: false,
			createdAt: now,
			updatedAt: now
		};

		byName.set(normalizedName, workout);
		byId.set(workout.id, workout);
		toAdd.push(workout);
		created += 1;
	}

	return { toAdd, byName, byId, matched, created };
}

function buildSessionExerciseRows(
	session: WorkoutSession,
	setRows: CsvRow[],
	exercisesByTrackedId: Map<string, PlannedExercise>,
	exercisesByNormalizedName: Map<string, Exercise>,
	updatedAt: string
) {
	const trackedExerciseIds = [...new Set(setRows.map((set) => set.exerciseId).filter(Boolean))];

	return trackedExerciseIds
		.map((trackedExerciseId, index): SessionExercise | null => {
			const plannedExercise = exercisesByTrackedId.get(trackedExerciseId);
			const exercise =
				plannedExercise?.canonicalExercise ??
				exercisesByNormalizedName.get(
					normalizeName(
						setRows.find((set) => set.exerciseId === trackedExerciseId)?.exerciseName ?? ''
					)
				);

			if (!exercise) {
				return null;
			}

			const performedAt = timestamp(
				new Date(new Date(session.startedAt ?? session.createdAt).getTime() + index * 8 * 60 * 1000)
			);

			return {
				id: `${session.id}:exercise:${trackedExerciseId}`,
				sessionId: session.id,
				workoutId: session.workoutId,
				exerciseId: exercise.id,
				exerciseNameSnapshot: exercise.name,
				order: index + 1,
				performedAt,
				createdAt: session.createdAt,
				updatedAt
			};
		})
		.filter(isDefined);
}

function buildTrackedSessionSetRows(
	setRows: CsvRow[],
	sessionExerciseByTrackedExerciseId: Map<string, SessionExercise>,
	exercisesByTrackedId: Map<string, PlannedExercise>,
	options: TrackedImportOptions
) {
	const rows: SessionSet[] = [];
	const orderByExerciseId = new Map<string, number>();

	for (const set of setRows) {
		const sessionExercise = sessionExerciseByTrackedExerciseId.get(set.exerciseId);

		if (!sessionExercise) {
			continue;
		}

		const nextOrder = (orderByExerciseId.get(set.exerciseId) ?? 0) + 1;
		orderByExerciseId.set(set.exerciseId, nextOrder);

		if (hasSecondarySetValues(set)) {
			const normalizedName = exercisesByTrackedId.get(set.exerciseId)?.normalizedName;
			const limbPriority = normalizedName
				? (options.limbPriorities?.[normalizedName] ?? 'primary-right')
				: 'primary-right';
			const primarySide: SessionSetSide = limbPriority === 'primary-left' ? 'left' : 'right';
			const secondarySide: SessionSetSide = limbPriority === 'primary-left' ? 'right' : 'left';

			rows.push(createImportedSet(set, sessionExercise, nextOrder, primarySide, 'primary'));
			rows.push(createImportedSet(set, sessionExercise, nextOrder, secondarySide, 'secondary'));
			continue;
		}

		rows.push(createImportedSet(set, sessionExercise, nextOrder, 'bilateral', 'primary'));
	}

	return rows;
}

function countImportedSetRows(setRows: CsvRow[]) {
	return setRows.reduce((total, set) => total + (hasSecondarySetValues(set) ? 2 : 1), 0);
}

function createImportedSet(
	set: CsvRow,
	sessionExercise: SessionExercise,
	order: number,
	side: SessionSetSide,
	sourceSide: 'primary' | 'secondary'
): SessionSet {
	const weightInput = sourceSide === 'secondary' ? set.secondaryWeight : set.weight;
	const repsInput = sourceSide === 'secondary' ? set.secondaryRepetitions : set.repetitions;
	const rirInput = sourceSide === 'secondary' ? set.secondaryRir : set.rir;
	const createdAt = toIsoTimestamp(set.createdAt || set.sessionDate) ?? sessionExercise.createdAt;
	const updatedAt = toIsoTimestamp(set.updatedAt) ?? sessionExercise.updatedAt;

	return {
		id: `${sessionExercise.id}:set:${set.id}:${sourceSide}`,
		sessionExerciseId: sessionExercise.id,
		exerciseId: sessionExercise.exerciseId,
		order,
		side,
		weightInput: cleanDecimalInput(weightInput),
		repsInput: cleanIntegerInput(repsInput),
		rirInput: cleanIntegerInput(rirInput),
		weight: parseOptionalNumber(weightInput),
		reps: parseOptionalNumber(repsInput),
		rir: parseOptionalNumber(rirInput),
		createdAt,
		updatedAt
	};
}

async function buildWorkoutExerciseRows(
	latestExerciseIdsByWorkoutId: Map<string, string[]>,
	workoutById: Map<string, Workout>,
	now: string
) {
	const rows: WorkoutExercise[] = [];

	for (const [workoutId, exerciseIds] of latestExerciseIdsByWorkoutId.entries()) {
		const workout = workoutById.get(workoutId);

		if (!workout) {
			continue;
		}

		const uniqueExerciseIds = [...new Set(exerciseIds)];
		const existingRows = await db.workoutExercises.where('workoutId').equals(workoutId).toArray();
		const existingByExerciseId = new Map(
			existingRows.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
		);

		rows.push(
			...uniqueExerciseIds.map((exerciseId, index) => {
				const existingRow = existingByExerciseId.get(exerciseId);

				return {
					id: existingRow?.id ?? `${workoutId}:exercise:${exerciseId}`,
					workoutId,
					exerciseId,
					order: index + 1,
					createdAt: existingRow?.createdAt ?? now,
					updatedAt: now
				};
			})
		);
	}

	return rows;
}

function parseCsvFile(contents: string, fileName: string): CsvRow[] {
	const rows = parseCsv(contents, fileName);

	if (rows.length === 0) {
		return [];
	}

	const [header, ...dataRows] = rows;
	const normalizedHeader = header.map((field) => field.trim());

	if (normalizedHeader.length === 0 || normalizedHeader.every((field) => !field)) {
		throw new Error(`${fileName} has no header row.`);
	}

	return dataRows
		.filter((row) => row.some((field) => field.trim()))
		.map((row) =>
			Object.fromEntries(normalizedHeader.map((field, index) => [field, row[index]?.trim() ?? '']))
		);
}

function assertCsvColumns(fileName: string, rows: CsvRow[], requiredColumns: string[]) {
	if (rows.length === 0) {
		throw new Error(`${fileName} does not contain any data rows.`);
	}

	const columns = new Set(Object.keys(rows[0] ?? {}));
	const missingColumns = requiredColumns.filter((column) => !columns.has(column));

	if (missingColumns.length > 0) {
		throw new Error(`${fileName} is missing required columns: ${missingColumns.join(', ')}.`);
	}
}

function parseCsv(contents: string, fileName: string) {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;

	for (let index = 0; index < contents.length; index += 1) {
		const character = contents[index];

		if (quoted) {
			if (character === '"' && contents[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
			} else {
				field += character;
			}
			continue;
		}

		if (character === '"') {
			quoted = true;
		} else if (character === ',') {
			row.push(field);
			field = '';
		} else if (character === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (character !== '\r') {
			field += character;
		}
	}

	if (field || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	if (quoted) {
		throw new Error(`${fileName} has an unterminated quoted field.`);
	}

	return rows;
}

function createBaseSummary(archive: TrackedArchive): TrackedImportSummary {
	return {
		fileName: archive.fileName,
		requiredFilesPresent: archive.requiredFilesPresent,
		optionalFilesPresent: archive.optionalFilesPresent,
		ignoredFiles: archive.ignoredFiles,
		unsupportedCategories: UNSUPPORTED_CATEGORIES,
		sessionsFound: 0,
		sessionsImportable: 0,
		sessionsImported: 0,
		sessionsSkipped: 0,
		strengthSetRowsFound: 0,
		strengthSetRowsImportable: 0,
		sessionSetsImported: 0,
		sessionSetsSkipped: 0,
		exercisesMatched: 0,
		exercisesMerged: 0,
		exercisesCreated: 0,
		workoutsMatched: 0,
		workoutsCreated: 0,
		exerciseLimbPriorities: [],
		warnings: [],
		syncStatus: 'not-run'
	};
}

function getWorkoutName(session: CsvRow, workoutNameByTrackedId: Map<string, string>) {
	return displayName(
		session.workoutName || workoutNameByTrackedId.get(session.workoutId) || 'Tracked Workout'
	);
}

function resolveSetExerciseName(set: CsvRow, trackedExercise: CsvRow | undefined) {
	return displayName(trackedExercise?.name || set.exerciseName);
}

function resolveSetNormalizedName(set: CsvRow, trackedExerciseById: Map<string, CsvRow>) {
	return normalizeName(resolveSetExerciseName(set, trackedExerciseById.get(set.exerciseId)));
}

function toTrackedId(kind: string, id: string) {
	return `tracked:${kind}:${id || 'unknown'}`;
}

function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ') || 'Tracked Workout';
}

function cleanDecimalInput(value: string | undefined) {
	return value?.trim() ?? '';
}

function cleanIntegerInput(value: string | undefined) {
	return value?.trim().replace(/\D/g, '') ?? '';
}

function parseOptionalNumber(value: string | undefined) {
	const nextValue = Number(value);
	return value?.trim() && Number.isFinite(nextValue) ? nextValue : undefined;
}

function parseBoolean(value: string | undefined) {
	return value?.toLocaleLowerCase() === 'true';
}

function hasSecondarySetValues(set: CsvRow) {
	return Boolean(set.secondaryRepetitions || set.secondaryWeight || set.secondaryRir);
}

function toIsoTimestamp(value: string | undefined) {
	if (!value?.trim()) {
		return undefined;
	}

	const normalizedValue = value.includes(' ') ? value.replace(' ', 'T') : value;
	const date = new Date(normalizedValue);

	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timestamp(date = new Date()) {
	return date.toISOString();
}

function groupBy<T>(rows: T[], getKey: (row: T) => string) {
	const grouped = new Map<string, T[]>();

	for (const row of rows) {
		const key = getKey(row);
		const group = grouped.get(key) ?? [];
		group.push(row);
		grouped.set(key, group);
	}

	return grouped;
}

function isDefined<T>(value: T): value is NonNullable<T> {
	return value !== undefined && value !== null;
}
