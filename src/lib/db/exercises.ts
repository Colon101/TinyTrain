import {
	BASELINE_EXERCISE_BY_ID,
	BASELINE_EXERCISE_BY_NORMALIZED_NAME,
	BASELINE_EXERCISE_ROWS,
	createBaselineExerciseId as createSharedBaselineExerciseId
} from '../exercises';
import type {
	Exercise,
	ExerciseDetail,
	ExerciseHistoryEntry,
	ExerciseListItem,
	ExerciseResetEvent,
	ExerciseSource,
	ExerciseUsagePreference,
	SessionExercise,
	SessionSet,
	WorkoutSession
} from './models';
import { db, getActiveStorageBackend, requireLoggedInUser } from './runtime';
import {
	compareOptionalRecency,
	compareSessionSetRows,
	createId,
	dedupeExercises,
	displayName,
	hasAnySetValue,
	hasPerformedSetValues,
	inferExerciseSource,
	isDefined,
	normalizeName,
	pickPreferredExercise,
	timestamp,
	toDayKey,
	toValidDate,
	withExerciseDefaults,
	withSessionSetDefaults
} from './shared';

export type HistoricalSessionExerciseMatch = {
	session: WorkoutSession;
	sessionExercise: SessionExercise;
	sets: SessionSet[];
};

export function getSessionExerciseSortTime(
	sessionExercise: Pick<SessionExercise, 'performedAt'>,
	session: Pick<WorkoutSession, 'startedAt' | 'createdAt'>
) {
	return toValidDate(
		sessionExercise.performedAt || session.startedAt || session.createdAt
	).getTime();
}

export function compareHistoricalSessionExerciseMatches(
	first: HistoricalSessionExerciseMatch,
	second: HistoricalSessionExerciseMatch
) {
	return (
		getSessionExerciseSortTime(first.sessionExercise, first.session) -
			getSessionExerciseSortTime(second.sessionExercise, second.session) ||
		first.sessionExercise.id.localeCompare(second.sessionExercise.id)
	);
}

export async function listEquivalentExerciseIds(exerciseId: string) {
	const exercise = await getExercise(exerciseId);

	if (!exercise) {
		return [exerciseId];
	}

	const normalizedName = normalizeName(exercise.normalizedName || exercise.name);

	if (!normalizedName) {
		return [exerciseId];
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.equals(normalizedName)
		.toArray();

	return [
		...new Set([exerciseId, ...matchingExercises.map((matchingExercise) => matchingExercise.id)])
	];
}

export async function listHistoricalSessionExerciseMatches(
	exerciseId: string
): Promise<HistoricalSessionExerciseMatch[]> {
	const exercise = await getExercise(exerciseId);
	const equivalentExerciseIds = await listEquivalentExerciseIds(exerciseId);
	const normalizedName = exercise ? normalizeName(exercise.normalizedName || exercise.name) : '';
	const [idMatchedSessionExercises, nameMatchedSessionExercises] = await Promise.all([
		equivalentExerciseIds.length === 0
			? Promise.resolve([])
			: equivalentExerciseIds.length === 1
				? db.sessionExercises.where('exerciseId').equals(equivalentExerciseIds[0]).toArray()
				: db.sessionExercises.where('exerciseId').anyOf(equivalentExerciseIds).toArray(),
		normalizedName
			? db.sessionExercises
					.toArray()
					.then((rows) =>
						rows.filter(
							(sessionExercise) =>
								normalizeName(sessionExercise.exerciseNameSnapshot) === normalizedName
						)
					)
			: Promise.resolve([])
	]);
	const sessionExercises = [
		...new Map(
			[...idMatchedSessionExercises, ...nameMatchedSessionExercises].map((sessionExercise) => [
				sessionExercise.id,
				sessionExercise
			])
		).values()
	];

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const [sessions, sessionSets] = await Promise.all([
		db.workoutSessions.bulkGet(sessionIds),
		db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
			.toArray()
			.then((rows) => rows.map(withSessionSetDefaults))
	]);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises
		.flatMap((sessionExercise) => {
			const session = sessionById.get(sessionExercise.sessionId);
			const sets = (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(
				compareSessionSetRows
			);

			if (!session || session.status === 'planned' || !hasPerformedSetValues(sets)) {
				return [];
			}

			return [
				{
					session,
					sessionExercise,
					sets
				}
			];
		})
		.sort((first, second) => compareHistoricalSessionExerciseMatches(second, first));
}

export async function getPreferredExerciseByNormalizedNames(normalizedNames: string[]) {
	const uniqueNormalizedNames = [...new Set(normalizedNames.filter(Boolean))];

	if (uniqueNormalizedNames.length === 0) {
		return new Map<string, Exercise>();
	}

	const matchingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(uniqueNormalizedNames)
		.toArray();
	const exercisesByNormalizedName = new Map<string, Exercise[]>();

	for (const exercise of matchingExercises) {
		const rows = exercisesByNormalizedName.get(exercise.normalizedName) ?? [];
		rows.push(exercise);
		exercisesByNormalizedName.set(exercise.normalizedName, rows);
	}

	return new Map(
		uniqueNormalizedNames.flatMap((normalizedName) => {
			const preferredExercise = pickPreferredExercise(
				exercisesByNormalizedName.get(normalizedName) ?? []
			);

			return preferredExercise ? ([[normalizedName, preferredExercise]] as const) : [];
		})
	);
}

export function createExerciseRow(
	name: string,
	unilateral = false,
	source: ExerciseSource = 'custom',
	now = timestamp(),
	id = createId()
): Exercise {
	const cleanName = displayName(name);

	return {
		id,
		name: cleanName,
		unilateral,
		source,
		normalizedName: normalizeName(cleanName),
		archived: false,
		createdAt: now,
		updatedAt: now
	};
}

export function createBaselineExerciseId(normalizedName: string) {
	return createSharedBaselineExerciseId(normalizedName);
}

export async function ensureBaselineExercises() {
	requireLoggedInUser();

	if (getActiveStorageBackend() === 'supabase-rxdb') {
		return;
	}

	const normalizedNames = [...BASELINE_EXERCISE_BY_NORMALIZED_NAME.keys()];
	const existingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(normalizedNames)
		.toArray();
	const existingNames = new Set(existingExercises.map((exercise) => exercise.normalizedName));
	const now = timestamp();
	const missingExercisesByName = new Map<string, Exercise>();

	for (const exercise of BASELINE_EXERCISE_ROWS) {
		const normalizedName = exercise.normalizedName;

		if (existingNames.has(normalizedName) || missingExercisesByName.has(normalizedName)) {
			continue;
		}

		missingExercisesByName.set(
			normalizedName,
			createExerciseRow(
				exercise.name,
				exercise.unilateral,
				'baseline',
				now,
				createBaselineExerciseId(normalizedName)
			)
		);
	}

	const missingExercises = [...missingExercisesByName.values()];

	if (missingExercises.length > 0) {
		await db.exercises.bulkAdd(missingExercises);
	}
}

export async function listExercises() {
	const exercises = dedupeExercises([...BASELINE_EXERCISE_ROWS, ...(await db.exercises.toArray())]);

	return exercises
		.filter((exercise) => !exercise.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function getPerformedSessionExerciseIdSet(sessionExercises: SessionExercise[]) {
	if (sessionExercises.length === 0) {
		return new Set<string>();
	}

	const sessionSets = await db.sessionSets
		.where('sessionExerciseId')
		.anyOf(sessionExercises.map((sessionExercise) => sessionExercise.id))
		.toArray();
	const hasPerformedValuesBySessionExerciseId = new Set<string>();

	for (const sessionSet of sessionSets.map(withSessionSetDefaults)) {
		if (hasAnySetValue(sessionSet)) {
			hasPerformedValuesBySessionExerciseId.add(sessionSet.sessionExerciseId);
		}
	}

	return hasPerformedValuesBySessionExerciseId;
}

export async function listExerciseUsagePreferences(): Promise<ExerciseUsagePreference[]> {
	const sessionExercises = await db.sessionExercises.toArray();

	if (sessionExercises.length === 0) {
		return [];
	}

	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByNormalizedName = new Map<
		string,
		{
			exerciseIds: Set<string>;
			lastPerformedAt: string;
			sessionIds: Set<string>;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const normalizedName = normalizeName(sessionExercise.exerciseNameSnapshot);

		if (!normalizedName) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const currentUsage = usageByNormalizedName.get(normalizedName) ?? {
			exerciseIds: new Set<string>(),
			lastPerformedAt: performedAt,
			sessionIds: new Set<string>()
		};

		currentUsage.exerciseIds.add(sessionExercise.exerciseId);
		currentUsage.sessionIds.add(sessionExercise.sessionId);

		if (currentUsage.lastPerformedAt < performedAt) {
			currentUsage.lastPerformedAt = performedAt;
		}

		usageByNormalizedName.set(normalizedName, currentUsage);
	}

	return [...usageByNormalizedName.entries()]
		.map(([normalizedName, usage]) => ({
			normalizedName,
			exerciseIds: [...usage.exerciseIds],
			lastPerformedAt: usage.lastPerformedAt,
			sessionCount: usage.sessionIds.size
		}))
		.sort(
			(first, second) =>
				second.lastPerformedAt.localeCompare(first.lastPerformedAt) ||
				second.sessionCount - first.sessionCount ||
				first.normalizedName.localeCompare(second.normalizedName)
		);
}

export async function listCustomExercises() {
	const exercises = dedupeExercises(await db.exercises.toArray());

	return exercises
		.filter((exercise) => !exercise.archived && exercise.source === 'custom')
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listCustomExerciseItems(): Promise<ExerciseListItem[]> {
	const exercises = await listCustomExercises();
	const exerciseIds = exercises.map((exercise) => exercise.id);

	if (exerciseIds.length === 0) {
		return [];
	}

	const [sessionExercises, resetEvents] = await Promise.all([
		db.sessionExercises.where('exerciseId').anyOf(exerciseIds).toArray(),
		db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);

	const historyByExerciseId = new Map<string, Set<string>>();
	const lastPerformedAtByExerciseId = new Map<string, string>();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const historySessions =
			historyByExerciseId.get(sessionExercise.exerciseId) ?? new Set<string>();
		historySessions.add(sessionExercise.sessionId);
		historyByExerciseId.set(sessionExercise.exerciseId, historySessions);

		const currentValue = lastPerformedAtByExerciseId.get(sessionExercise.exerciseId);
		const performedAt = session.startedAt ?? sessionExercise.performedAt;

		if (!currentValue || currentValue < performedAt) {
			lastPerformedAtByExerciseId.set(sessionExercise.exerciseId, performedAt);
		}
	}

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return exercises.map((exercise) => ({
		exercise,
		historyCount: historyByExerciseId.get(exercise.id)?.size ?? 0,
		lastPerformedAt: lastPerformedAtByExerciseId.get(exercise.id),
		latestResetAt: latestResetAtByExerciseId.get(exercise.id)
	}));
}

export async function listExerciseItems(): Promise<ExerciseListItem[]> {
	const [customExercises, sessionExercises] = await Promise.all([
		listCustomExercises(),
		db.sessionExercises.toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByNormalizedName = new Map<
		string,
		{
			historySessionIds: Set<string>;
			lastPerformedAt?: string;
		}
	>();

	for (const sessionExercise of sessionExercises) {
		const session = sessionById.get(sessionExercise.sessionId);

		if (
			!session ||
			session.status === 'planned' ||
			!performedSessionExerciseIds.has(sessionExercise.id)
		) {
			continue;
		}

		const normalizedName = normalizeName(sessionExercise.exerciseNameSnapshot);

		if (!normalizedName) {
			continue;
		}

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const usage = usageByNormalizedName.get(normalizedName) ?? {
			historySessionIds: new Set<string>(),
			lastPerformedAt: undefined
		};

		usage.historySessionIds.add(sessionExercise.sessionId);

		if (!usage.lastPerformedAt || usage.lastPerformedAt < performedAt) {
			usage.lastPerformedAt = performedAt;
		}

		usageByNormalizedName.set(normalizedName, usage);
	}

	const customByNormalizedName = new Map(
		customExercises.map((exercise) => [exercise.normalizedName, exercise])
	);
	const performedNormalizedNames = [...usageByNormalizedName.keys()];
	const preferredExercises = await getPreferredExerciseByNormalizedNames(performedNormalizedNames);
	const itemsByNormalizedName = new Map<string, ExerciseListItem>();

	for (const [normalizedName, usage] of usageByNormalizedName.entries()) {
		const exercise = [
			preferredExercises.get(normalizedName),
			BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(normalizedName),
			customByNormalizedName.get(normalizedName)
		]
			.filter(isDefined)
			.find((candidate) => !candidate.archived);

		if (!exercise) {
			continue;
		}

		itemsByNormalizedName.set(normalizedName, {
			exercise,
			historyCount: usage.historySessionIds.size,
			lastPerformedAt: usage.lastPerformedAt
		});
	}

	for (const exercise of customExercises) {
		if (itemsByNormalizedName.has(exercise.normalizedName)) {
			continue;
		}

		itemsByNormalizedName.set(exercise.normalizedName, {
			exercise,
			historyCount: 0
		});
	}

	const exerciseIds = [...itemsByNormalizedName.values()].map((item) => item.exercise.id);
	const resetEvents =
		exerciseIds.length === 0
			? []
			: await db.exerciseResetEvents.where('exerciseId').anyOf(exerciseIds).toArray();
	const latestResetAtByExerciseId = new Map<string, string>();

	for (const resetEvent of resetEvents) {
		const currentValue = latestResetAtByExerciseId.get(resetEvent.exerciseId);

		if (!currentValue || currentValue < resetEvent.resetAt) {
			latestResetAtByExerciseId.set(resetEvent.exerciseId, resetEvent.resetAt);
		}
	}

	return [...itemsByNormalizedName.values()]
		.map((item) => ({
			...item,
			latestResetAt: latestResetAtByExerciseId.get(item.exercise.id)
		}))
		.sort(
			(first, second) =>
				compareOptionalRecency(first.lastPerformedAt, second.lastPerformedAt) ||
				second.historyCount - first.historyCount ||
				first.exercise.name.localeCompare(second.exercise.name)
		);
}

export async function getExercise(exerciseId: string) {
	const baselineExercise = BASELINE_EXERCISE_BY_ID.get(exerciseId);

	if (baselineExercise) {
		return baselineExercise;
	}

	const exercise = await db.exercises.get(exerciseId);

	return exercise ? withExerciseDefaults(exercise) : null;
}

export async function createExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const existingExercise = pickPreferredExercise(
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	);

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, inferExerciseSource(normalizedName));
	await db.exercises.add(exercise);

	return exercise;
}

export async function createCustomExercise(name: string, unilateral = false) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const matchingExercises = (
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	).map(withExerciseDefaults);
	const existingExercise = pickPreferredExercise(matchingExercises);

	if (matchingExercises.some((exercise) => exercise.source === 'baseline')) {
		throw new Error('That name already belongs to a built-in exercise.');
	}

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return withExerciseDefaults({ ...existingExercise, archived: false, unilateral, updatedAt });
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral, 'custom');
	await db.exercises.add(exercise);

	return exercise;
}

export async function setExerciseUnilateral(exerciseId: string, unilateral: boolean) {
	requireLoggedInUser();

	if (BASELINE_EXERCISE_BY_ID.has(exerciseId)) {
		throw new Error('Built-in exercises are shared and cannot be edited.');
	}

	const exercise = await db.exercises.get(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const updatedAt = timestamp();
	await db.exercises.update(exerciseId, { unilateral, updatedAt });

	return withExerciseDefaults({ ...exercise, unilateral, updatedAt });
}

export async function recordExerciseReset(exerciseId: string) {
	requireLoggedInUser();

	const exercise = await getExercise(exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const resetEvent: ExerciseResetEvent = {
		id: createId(),
		exerciseId,
		resetAt: now,
		createdAt: now
	};

	await db.exerciseResetEvents.add(resetEvent);

	return resetEvent;
}

export async function listExerciseResetEvents(exerciseId: string) {
	const resetEvents = await db.exerciseResetEvents.where('exerciseId').equals(exerciseId).toArray();

	return resetEvents.sort((first, second) => second.resetAt.localeCompare(first.resetAt));
}

export async function listExerciseHistory(exerciseId: string): Promise<ExerciseHistoryEntry[]> {
	return (await listHistoricalSessionExerciseMatches(exerciseId)).map(
		({ session, sessionExercise, sets }) => ({
			sessionId: session.id,
			workoutId: session.workoutId,
			workoutNameSnapshot: session.workoutNameSnapshot,
			dayKey: session.dayKey || toDayKey(session.startedAt ?? session.createdAt),
			performedAt: sessionExercise.performedAt,
			startedAt: session.startedAt,
			completedAt: session.completedAt,
			status: session.status,
			sets
		})
	);
}

export async function getExerciseDetail(exerciseId: string): Promise<ExerciseDetail | null> {
	const [exercise, history, resetEvents] = await Promise.all([
		getExercise(exerciseId),
		listExerciseHistory(exerciseId),
		listExerciseResetEvents(exerciseId)
	]);

	if (!exercise) {
		return null;
	}

	return {
		exercise,
		history,
		resetEvents
	};
}
