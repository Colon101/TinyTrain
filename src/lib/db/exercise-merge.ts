import { BASELINE_EXERCISE_BY_ID, BASELINE_EXERCISE_BY_NORMALIZED_NAME } from '../exercises';
import { getExercise, getPerformedSessionExerciseIdSet, listExercises } from './exercises';
import type {
	Exercise,
	ExerciseMergeInput,
	ExerciseMergeOption,
	ExerciseMergeResult,
	SessionExercise,
	SessionSet
} from './models';
import { db, requireLoggedInUser, syncNow } from './runtime';
import {
	compareOptionalRecency,
	displayName,
	hasPerformedSetValues,
	isDefined,
	normalizeName,
	timestamp,
	withExerciseDefaults,
	withSessionSetDefaults
} from './shared';

export async function listExerciseMergeOptions(): Promise<ExerciseMergeOption[]> {
	const [exercises, sessionExercises] = await Promise.all([
		listExercises(),
		db.sessionExercises.toArray()
	]);
	const sessionIds = [
		...new Set(sessionExercises.map((sessionExercise) => sessionExercise.sessionId))
	];
	const sessions = sessionIds.length === 0 ? [] : await db.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const performedSessionExerciseIds = await getPerformedSessionExerciseIdSet(sessionExercises);
	const usageByExerciseId = new Map<
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

		const performedAt =
			session.completedAt ?? session.startedAt ?? sessionExercise.performedAt ?? session.createdAt;
		const usage = usageByExerciseId.get(sessionExercise.exerciseId) ?? {
			historySessionIds: new Set<string>(),
			lastPerformedAt: undefined
		};

		usage.historySessionIds.add(sessionExercise.sessionId);

		if (!usage.lastPerformedAt || usage.lastPerformedAt < performedAt) {
			usage.lastPerformedAt = performedAt;
		}

		usageByExerciseId.set(sessionExercise.exerciseId, usage);
	}

	return exercises
		.map((exercise) => {
			const usage = usageByExerciseId.get(exercise.id);

			return {
				exercise,
				historyCount: usage?.historySessionIds.size ?? 0,
				lastPerformedAt: usage?.lastPerformedAt,
				canRename: !BASELINE_EXERCISE_BY_ID.has(exercise.id) && exercise.source === 'custom'
			};
		})
		.sort(
			(first, second) =>
				compareOptionalRecency(first.lastPerformedAt, second.lastPerformedAt) ||
				second.historyCount - first.historyCount ||
				first.exercise.name.localeCompare(second.exercise.name)
		);
}

export function getMergedSessionExerciseId(
	mainExerciseId: string,
	secondarySessionExerciseId: string
) {
	return `merge:${mainExerciseId}:${secondarySessionExerciseId}`;
}

export function getMergedSessionSetId(
	mainSessionExerciseId: string,
	secondarySessionSetId: string
) {
	return `${mainSessionExerciseId}:set:${secondarySessionSetId}`;
}

export async function renameCustomExercise(
	exercise: Exercise,
	nextName: string,
	now = timestamp()
): Promise<{ exercise: Exercise; renamed: boolean }> {
	const cleanName = displayName(nextName);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	if (BASELINE_EXERCISE_BY_ID.has(exercise.id) || exercise.source !== 'custom') {
		return { exercise, renamed: false };
	}

	if (normalizedName === exercise.normalizedName && cleanName === exercise.name) {
		return { exercise, renamed: false };
	}

	const matchingExercises = (
		await db.exercises.where('normalizedName').equals(normalizedName).toArray()
	)
		.map(withExerciseDefaults)
		.filter((candidate) => candidate.id !== exercise.id && !candidate.archived);

	if (
		matchingExercises.length > 0 ||
		(BASELINE_EXERCISE_BY_NORMALIZED_NAME.has(normalizedName) &&
			BASELINE_EXERCISE_BY_NORMALIZED_NAME.get(normalizedName)?.id !== exercise.id)
	) {
		throw new Error('That exercise name is already in use.');
	}

	const nextExercise = {
		...exercise,
		name: cleanName,
		normalizedName,
		updatedAt: now
	};

	await db.exercises.update(exercise.id, {
		name: cleanName,
		normalizedName,
		updatedAt: now
	});

	return { exercise: nextExercise, renamed: true };
}

export async function mergeExerciseHistory(
	input: ExerciseMergeInput
): Promise<ExerciseMergeResult> {
	requireLoggedInUser();

	if (input.mainExerciseId === input.secondaryExerciseId) {
		throw new Error('Choose two different exercises to merge.');
	}

	const [mainExercise, secondaryExercise] = await Promise.all([
		getExercise(input.mainExerciseId),
		getExercise(input.secondaryExerciseId)
	]);

	if (!mainExercise) {
		throw new Error('Main exercise not found.');
	}

	if (!secondaryExercise) {
		throw new Error('Secondary exercise not found.');
	}

	const now = timestamp();
	const secondarySessionExercises = await db.sessionExercises
		.where('exerciseId')
		.equals(secondaryExercise.id)
		.toArray();
	const secondarySessionExerciseIds = secondarySessionExercises.map(
		(sessionExercise) => sessionExercise.id
	);
	const [existingMainSessionExercises, existingCopiedSessionExercises, secondarySessionSets] =
		await Promise.all([
			db.sessionExercises.where('exerciseId').equals(mainExercise.id).toArray(),
			secondarySessionExerciseIds.length === 0
				? Promise.resolve([])
				: db.sessionExercises
						.bulkGet(
							secondarySessionExerciseIds.map((sessionExerciseId) =>
								getMergedSessionExerciseId(mainExercise.id, sessionExerciseId)
							)
						)
						.then((rows) => rows.filter(isDefined)),
			secondarySessionExerciseIds.length === 0
				? Promise.resolve([])
				: db.sessionSets.where('sessionExerciseId').anyOf(secondarySessionExerciseIds).toArray()
		]);
	const mainSessionIds = new Set(
		existingMainSessionExercises.map((sessionExercise) => sessionExercise.sessionId)
	);
	const existingCopiedIds = new Set(
		existingCopiedSessionExercises.map((sessionExercise) => sessionExercise.id)
	);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of secondarySessionSets.map(withSessionSetDefaults)) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	const sessionExercisesToAdd: SessionExercise[] = [];
	const sessionSetsToAdd: SessionSet[] = [];
	let skippedConflicts = 0;

	for (const secondarySessionExercise of secondarySessionExercises) {
		const copiedSessionExerciseId = getMergedSessionExerciseId(
			mainExercise.id,
			secondarySessionExercise.id
		);
		const sourceSets = setsBySessionExerciseId.get(secondarySessionExercise.id) ?? [];

		if (!hasPerformedSetValues(sourceSets)) {
			continue;
		}

		if (
			mainSessionIds.has(secondarySessionExercise.sessionId) ||
			existingCopiedIds.has(copiedSessionExerciseId)
		) {
			skippedConflicts += 1;
			continue;
		}

		const copiedSessionExercise: SessionExercise = {
			...secondarySessionExercise,
			id: copiedSessionExerciseId,
			exerciseId: mainExercise.id,
			exerciseNameSnapshot: mainExercise.name,
			createdAt: now,
			updatedAt: now
		};
		const copiedSessionSets = sourceSets.map((sessionSet) => ({
			...sessionSet,
			id: getMergedSessionSetId(copiedSessionExerciseId, sessionSet.id),
			sessionExerciseId: copiedSessionExerciseId,
			exerciseId: mainExercise.id,
			createdAt: now,
			updatedAt: now
		}));

		sessionExercisesToAdd.push(copiedSessionExercise);
		sessionSetsToAdd.push(...copiedSessionSets);
		mainSessionIds.add(secondarySessionExercise.sessionId);
	}

	let renamedMainExercise = mainExercise;
	let renamed = false;

	await db.transaction(async () => {
		if (input.mainExerciseName !== undefined) {
			const renameResult = await renameCustomExercise(mainExercise, input.mainExerciseName, now);
			renamedMainExercise = renameResult.exercise;
			renamed = renameResult.renamed;
		}

		for (const sessionExercise of sessionExercisesToAdd) {
			sessionExercise.exerciseNameSnapshot = renamedMainExercise.name;
		}

		if (sessionExercisesToAdd.length > 0) {
			await db.sessionExercises.bulkAdd(sessionExercisesToAdd);
		}

		if (sessionSetsToAdd.length > 0) {
			await db.sessionSets.bulkAdd(sessionSetsToAdd);
		}

		const touchedSessionIds = [...new Set(sessionExercisesToAdd.map((row) => row.sessionId))];

		await Promise.all(
			touchedSessionIds.map((sessionId) => db.workoutSessions.update(sessionId, { updatedAt: now }))
		);
	});

	try {
		await syncNow();
		return {
			mainExercise: renamedMainExercise,
			copiedSessionExercises: sessionExercisesToAdd.length,
			copiedSessionSets: sessionSetsToAdd.length,
			skippedConflicts,
			renamed,
			syncStatus: 'synced'
		};
	} catch (error) {
		return {
			mainExercise: renamedMainExercise,
			copiedSessionExercises: sessionExercisesToAdd.length,
			copiedSessionSets: sessionSetsToAdd.length,
			skippedConflicts,
			renamed,
			syncStatus: 'failed',
			syncError: error instanceof Error ? error.message : 'Sync failed.'
		};
	}
}
