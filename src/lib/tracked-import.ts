import { strFromU8, Unzip, UnzipInflate } from 'fflate';
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
	sessionStartedAtById: Map<string, string>;
	sessionRows: CsvRow[];
	setRows: CsvRow[];
};

const REQUIRED_FILES = ['sessions.csv', 'sets.csv', 'exercises.csv'];
const OPTIONAL_FILES = ['workouts.csv', 'workout_groups.csv'];
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 64;
const MAX_CSV_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_CSV_BYTES = 32 * 1024 * 1024;
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

	if (file.size > MAX_ARCHIVE_BYTES) {
		throw new Error('Tracked zip is too large. Choose an export smaller than 20 MB.');
	}

	const unzipped = await unzipTrackedArchive(new Uint8Array(await file.arrayBuffer()));
	const files = new Map<string, string>();

	for (const [path, contents] of Object.entries(unzipped)) {
		const fileName = path.split('/').at(-1)?.toLocaleLowerCase() ?? '';

		if (!fileName) {
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

function unzipTrackedArchive(data: Uint8Array) {
	return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
		let entryCount = 0;
		let totalCsvBytes = 0;
		let settled = false;
		const files: Record<string, Uint8Array> = {};
		const rejectInvalidArchive = (error: unknown) => {
			if (settled) {
				return;
			}

			settled = true;
			reject(new Error('Tracked zip could not be opened.', { cause: error }));
		};
		const rejectWith = (error: Error) => {
			if (settled) {
				return;
			}

			settled = true;
			reject(error);
		};
		const unzipper = new Unzip((entry) => {
			entryCount += 1;

			if (entryCount > MAX_ARCHIVE_ENTRIES) {
				rejectWith(new Error('Tracked zip contains too many files.'));
				return;
			}

			const fileName = entry.name.split('/').at(-1)?.toLowerCase() ?? '';

			if (!fileName.endsWith('.csv')) {
				return;
			}

			let fileBytes = 0;
			const chunks: Uint8Array[] = [];

			entry.ondata = (error, chunk, final) => {
				if (settled) {
					return;
				}

				if (error) {
					rejectInvalidArchive(error);
					return;
				}

				fileBytes += chunk.length;
				totalCsvBytes += chunk.length;

				if (fileBytes > MAX_CSV_BYTES) {
					rejectWith(new Error(`Tracked CSV is too large: ${fileName}.`));
					return;
				}

				if (totalCsvBytes > MAX_TOTAL_CSV_BYTES) {
					rejectWith(new Error('Tracked zip expands beyond the 32 MB safety limit.'));
					return;
				}

				chunks.push(chunk);

				if (final) {
					const contents = new Uint8Array(fileBytes);
					let offset = 0;

					for (const currentChunk of chunks) {
						contents.set(currentChunk, offset);
						offset += currentChunk.length;
					}

					files[entry.name] = contents;
				}
			};

			try {
				entry.start();
			} catch (error) {
				rejectInvalidArchive(error);
			}
		});

		unzipper.register(UnzipInflate);

		try {
			const inputChunkBytes = 64 * 1024;

			for (let offset = 0; offset < data.length && !settled; offset += inputChunkBytes) {
				const end = Math.min(offset + inputChunkBytes, data.length);
				unzipper.push(data.subarray(offset, end), end === data.length);
			}

			if (!settled) {
				settled = true;
				resolve(files);
			}
		} catch (error) {
			rejectInvalidArchive(error);
		}
	});
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

	const trackedExerciseById = new Map(
		archive.rows.exercises
			.filter((exercise) => exercise.id)
			.map((exercise) => [exercise.id, exercise])
	);
	const sessionStartedAtById = new Map<string, string>();
	const invalidTimestampSessionRows: CsvRow[] = [];

	for (const session of archive.rows.sessions) {
		const startedAt = resolveSessionStartedAt(session);

		if (!startedAt) {
			invalidTimestampSessionRows.push(session);
		} else if (session.id) {
			sessionStartedAtById.set(session.id, startedAt);
		}
	}

	const validTimestampSessionIds = new Set(sessionStartedAtById.keys());
	const setRows = archive.rows.sets.filter((set) => {
		return Boolean(
			set.sessionId &&
			validTimestampSessionIds.has(set.sessionId) &&
			set.exerciseId &&
			normalizeName(resolveSetExerciseName(set, trackedExerciseById.get(set.exerciseId)))
		);
	});
	const importableSessionIds = new Set(setRows.map((set) => set.sessionId));
	const sessionRows = archive.rows.sessions.filter((session) =>
		importableSessionIds.has(session.id)
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

		const plannedExercise = exercisesByTrackedId.get(set.exerciseId) ??
			exercisesByNormalizedName.get(normalizedName) ?? {
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

		plannedExercise.trackedIds.add(set.exerciseId);
		exercisesByTrackedId.set(set.exerciseId, plannedExercise);

		exercisesByNormalizedName.set(plannedExercise.normalizedName, plannedExercise);
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
					exercisesByTrackedId.get(set.exerciseId)?.normalizedName === exercise.normalizedName &&
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

	const invalidTimestampOnlySessionIds = new Set(
		invalidTimestampSessionRows
			.filter((session) => session.id && !validTimestampSessionIds.has(session.id))
			.map((session) => session.id)
	);
	const timestampSkippedSetRows = archive.rows.sets.filter((set) =>
		invalidTimestampOnlySessionIds.has(set.sessionId)
	).length;
	const skippedSetRows = archive.rows.sets.length - setRows.length - timestampSkippedSetRows;

	if (invalidTimestampSessionRows.length > 0) {
		const count = invalidTimestampSessionRows.length;
		summary.warnings.push(
			count === 1
				? '1 session row with a missing or invalid historical timestamp was skipped.'
				: `${count} session rows with missing or invalid historical timestamps were skipped.`
		);
	}

	if (skippedSetRows > 0) {
		summary.warnings.push(
			`${skippedSetRows} set row${skippedSetRows === 1 ? ' references' : 's reference'} missing sessions or exercises.`
		);
	}

	const invalidNumericValueCount = countInvalidImportedNumericValues(setRows);

	if (invalidNumericValueCount > 0) {
		summary.warnings.push(
			`${invalidNumericValueCount} invalid numeric set value${invalidNumericValueCount === 1 ? '' : 's'} will be ignored.`
		);
	}

	if (archive.ignoredFiles.length > 0) {
		summary.warnings.push(
			`${archive.ignoredFiles.length} unsupported CSV file${archive.ignoredFiles.length === 1 ? '' : 's'} will be ignored.`
		);
	}

	return {
		archive,
		summary,
		exercisesByTrackedId,
		exercisesByNormalizedName,
		workoutNameByTrackedId,
		sessionStartedAtById,
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
	const latestWorkoutTemplateByWorkoutId = new Map<
		string,
		{ startedAt: string; sessionId: string; exerciseIds: string[] }
	>();

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

		const workoutName = getWorkoutName(sessionRow, plan.workoutNameByTrackedId);
		const workout = workouts.byName.get(normalizeName(workoutName));

		if (!workout) {
			summary.sessionsSkipped += 1;
			summary.warnings.push(
				`Skipped session ${sessionRow.id} because its workout could not be resolved.`
			);
			continue;
		}

		const startedAt = plan.sessionStartedAtById.get(sessionRow.id)!;
		const exerciseIds = [
			...new Set(
				sessionSetRows.flatMap((setRow) => {
					const exercise = plan.exercisesByTrackedId.get(setRow.exerciseId)?.canonicalExercise;
					return exercise ? [exercise.id] : [];
				})
			)
		];
		const currentTemplate = latestWorkoutTemplateByWorkoutId.get(workout.id);

		if (
			!currentTemplate ||
			startedAt > currentTemplate.startedAt ||
			(startedAt === currentTemplate.startedAt && sessionId > currentTemplate.sessionId)
		) {
			latestWorkoutTemplateByWorkoutId.set(workout.id, {
				startedAt,
				sessionId,
				exerciseIds
			});
		}

		if (existingSessionIds.has(sessionId)) {
			summary.sessionsSkipped += 1;
			summary.sessionSetsSkipped += countImportedSetRows(sessionSetRows);
			continue;
		}

		const completedAt = toIsoTimestamp(sessionRow.endedAt) ?? startedAt;
		const session: WorkoutSession = {
			id: sessionId,
			workoutId: workout.id,
			workoutNameSnapshot: workout.name,
			dayKey: resolveSessionDayKey(sessionRow, startedAt),
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
		summary.sessionsImported += 1;
		summary.sessionSetsImported += setRowsForSession.length;
	}

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

			const workoutExerciseRewrite = await buildWorkoutExerciseRewrite(
				latestWorkoutTemplateByWorkoutId,
				workouts.byId,
				now
			);

			if (workoutExerciseRewrite.idsToDelete.length > 0) {
				await db.workoutExercises.bulkDelete(workoutExerciseRewrite.idsToDelete);
			}

			if (workoutExerciseRewrite.rows.length > 0) {
				await db.workoutExercises.bulkPut(workoutExerciseRewrite.rows);
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
	updatedAt: string
) {
	const trackedExerciseIds = [...new Set(setRows.map((set) => set.exerciseId).filter(Boolean))];

	return trackedExerciseIds
		.map((trackedExerciseId, index): SessionExercise | null => {
			const plannedExercise = exercisesByTrackedId.get(trackedExerciseId);
			const exercise = plannedExercise?.canonicalExercise;

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
	const weight = normalizeImportedNumericValue(weightInput, false);
	const reps = normalizeImportedNumericValue(repsInput, true);
	const rir = normalizeImportedNumericValue(rirInput, true);
	const createdAt =
		toIsoTimestamp(set.createdAt) ?? toIsoTimestamp(set.sessionDate) ?? sessionExercise.createdAt;
	const updatedAt = toIsoTimestamp(set.updatedAt) ?? sessionExercise.updatedAt;

	return {
		id: `${sessionExercise.id}:set:${set.id}:${sourceSide}`,
		sessionExerciseId: sessionExercise.id,
		exerciseId: sessionExercise.exerciseId,
		order,
		side,
		weightInput: weight.input,
		repsInput: reps.input,
		rirInput: rir.input,
		weight: weight.value,
		reps: reps.value,
		rir: rir.value,
		createdAt,
		updatedAt
	};
}

async function buildWorkoutExerciseRewrite(
	latestWorkoutTemplateByWorkoutId: Map<
		string,
		{ startedAt: string; sessionId: string; exerciseIds: string[] }
	>,
	workoutById: Map<string, Workout>,
	now: string
) {
	const rows: WorkoutExercise[] = [];
	const idsToDelete: string[] = [];
	const workoutIds = [...latestWorkoutTemplateByWorkoutId.keys()].filter((workoutId) =>
		workoutById.has(workoutId)
	);

	if (workoutIds.length === 0) {
		return { rows, idsToDelete };
	}

	const persistedSessions = await db.workoutSessions.where('workoutId').anyOf(workoutIds).toArray();
	const latestPersistedStartedAtByWorkoutId = new Map<string, string>();

	for (const session of persistedSessions) {
		if (!session.startedAt) {
			continue;
		}

		const currentStartedAt = latestPersistedStartedAtByWorkoutId.get(session.workoutId);

		if (!currentStartedAt || session.startedAt > currentStartedAt) {
			latestPersistedStartedAtByWorkoutId.set(session.workoutId, session.startedAt);
		}
	}

	const templatesToRewrite = [...latestWorkoutTemplateByWorkoutId.entries()].filter(
		([workoutId, template]) =>
			workoutById.has(workoutId) &&
			(latestPersistedStartedAtByWorkoutId.get(workoutId) ?? '') <= template.startedAt
	);

	if (templatesToRewrite.length === 0) {
		return { rows, idsToDelete };
	}

	const existingRowsByWorkoutId = groupBy(
		await db.workoutExercises
			.where('workoutId')
			.anyOf(templatesToRewrite.map(([workoutId]) => workoutId))
			.toArray(),
		(workoutExercise) => workoutExercise.workoutId
	);

	for (const [workoutId, template] of templatesToRewrite) {
		const workout = workoutById.get(workoutId);

		if (!workout) {
			continue;
		}

		const uniqueExerciseIds = [...new Set(template.exerciseIds)];
		const uniqueExerciseIdSet = new Set(uniqueExerciseIds);
		const existingRows = existingRowsByWorkoutId.get(workoutId) ?? [];
		const existingByExerciseId = new Map(
			existingRows.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
		);
		idsToDelete.push(
			...existingRows
				.filter((workoutExercise) => !uniqueExerciseIdSet.has(workoutExercise.exerciseId))
				.map((workoutExercise) => workoutExercise.id)
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

	return { rows, idsToDelete };
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
	return cleanDisplayName(trackedExercise?.name || set.exerciseName);
}

function toTrackedId(kind: string, id: string) {
	return `tracked:${kind}:${id || 'unknown'}`;
}

function displayName(name: string) {
	return cleanDisplayName(name) || 'Tracked Workout';
}

function cleanDisplayName(name: string | undefined) {
	return name?.trim().replace(/\s+/g, ' ') ?? '';
}

function normalizeImportedNumericValue(value: string | undefined, integer: boolean) {
	const rawValue = value?.trim() ?? '';

	if (!rawValue) {
		return { input: '', value: undefined, valid: true };
	}

	const normalizedValue = rawValue.replace(',', '.');

	if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalizedValue)) {
		return { input: '', value: undefined, valid: false };
	}

	const numericValue = Number(normalizedValue);

	if (
		!Number.isFinite(numericValue) ||
		numericValue < 0 ||
		(integer && !Number.isInteger(numericValue))
	) {
		return { input: '', value: undefined, valid: false };
	}

	return { input: String(numericValue), value: numericValue, valid: true };
}

function parseBoolean(value: string | undefined) {
	return value?.toLocaleLowerCase() === 'true';
}

function hasSecondarySetValues(set: CsvRow) {
	return (
		normalizeImportedNumericValue(set.secondaryRepetitions, true).value !== undefined ||
		normalizeImportedNumericValue(set.secondaryWeight, false).value !== undefined ||
		normalizeImportedNumericValue(set.secondaryRir, true).value !== undefined
	);
}

function countInvalidImportedNumericValues(setRows: CsvRow[]) {
	return setRows.reduce((count, set) => {
		return (
			count +
			Number(!normalizeImportedNumericValue(set.weight, false).valid) +
			Number(!normalizeImportedNumericValue(set.repetitions, true).valid) +
			Number(!normalizeImportedNumericValue(set.rir, true).valid) +
			Number(!normalizeImportedNumericValue(set.secondaryWeight, false).valid) +
			Number(!normalizeImportedNumericValue(set.secondaryRepetitions, true).valid) +
			Number(!normalizeImportedNumericValue(set.secondaryRir, true).valid)
		);
	}, 0);
}

function resolveSessionStartedAt(session: CsvRow) {
	return toIsoTimestamp(session.startedAt) ?? toIsoTimestamp(session.sessionDate);
}

function resolveSessionDayKey(session: CsvRow, startedAt: string) {
	const sessionDate = session.sessionDate?.trim() ?? '';
	const calendarDate = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/.exec(sessionDate)?.[1];

	return calendarDate && toIsoTimestamp(sessionDate) ? calendarDate : toDayKey(startedAt);
}

function normalizeTrackedTimestamp(value: string) {
	let normalized = value.trim();

	if (normalized.includes(' ')) {
		normalized = normalized.replace(' ', 'T');
	}

	return normalized.includes('T') ? normalized.replace(/([+-]\d{2})$/, '$1:00') : normalized;
}

function toIsoTimestamp(value: string | undefined) {
	if (!value?.trim()) {
		return undefined;
	}

	const calendarDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(value.trim());

	if (calendarDate) {
		const year = Number(calendarDate[1]);
		const month = Number(calendarDate[2]);
		const day = Number(calendarDate[3]);
		const daysInMonth =
			month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

		if (day < 1 || day > daysInMonth) {
			return undefined;
		}
	}

	const date = new Date(normalizeTrackedTimestamp(value));

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
