import { listExerciseHistory } from '../exercises';
import type {
	DayOverview,
	ExerciseHistoryEntry,
	SessionExercise,
	SessionExerciseDetail,
	SessionOverview,
	SessionSet,
	SessionSummary
} from '../models';
import { db } from '../runtime';
import {
	buildPreviousReferenceBySetKey,
	compareSessionRows,
	compareSessionSetRows,
	createFieldDelta,
	findLatestHistoryEntryWithPerformedSets,
	getExerciseHistorySortTime,
	getSessionSetKey,
	getSessionSetLabel,
	getSessionSortTime,
	isDefined,
	summarizeExerciseProgress,
	summarizeSession,
	toDayKey,
	toValidDate,
	withExerciseDefaults,
	withSessionSetDefaults
} from '../shared';

export async function listSessionExerciseDetails(
	sessionId: string
): Promise<SessionExerciseDetail[]> {
	const sessionExercises = await db.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.sortBy('order');
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises.map((sessionExercise) => ({
		...sessionExercise,
		sets: (setsBySessionExerciseId.get(sessionExercise.id) ?? []).sort(compareSessionSetRows)
	}));
}

export async function getLatestExerciseHistoryEntries(
	exerciseIds: string[],
	currentSessionId: string,
	beforeSessionAt: number
) {
	const uniqueExerciseIds = [...new Set(exerciseIds)];
	const sessionExercises = await db.sessionExercises.toArray();
	const previousEntries = await Promise.all(
		uniqueExerciseIds.map(async (exerciseId) => {
			const history = (await listExerciseHistory(exerciseId, { sessionExercises })).filter(
				(entry) =>
					entry.sessionId !== currentSessionId &&
					getExerciseHistorySortTime(entry) < beforeSessionAt
			);
			const previousEntry = findLatestHistoryEntryWithPerformedSets(history) ?? history[0] ?? null;

			return [exerciseId, previousEntry] as const;
		})
	);

	return new Map(
		previousEntries.filter(
			(entry): entry is readonly [string, ExerciseHistoryEntry] => entry[1] !== null
		)
	);
}

export async function getSessionSummariesByIds(sessionIds: string[]) {
	if (sessionIds.length === 0) {
		return new Map<string, SessionSummary>();
	}

	const sessions = (await db.workoutSessions.bulkGet(sessionIds)).filter(isDefined);
	const sessionExercises = await db.sessionExercises.where('sessionId').anyOf(sessionIds).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: (await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()).map(
					withSessionSetDefaults
				);
	const sessionExercisesBySessionId = new Map<string, SessionExercise[]>();
	const sessionSetsBySessionId = new Map<string, SessionSet[]>();
	const sessionExerciseById = new Map(
		sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
	);

	for (const sessionExercise of sessionExercises) {
		const rows = sessionExercisesBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionExercise);
		sessionExercisesBySessionId.set(sessionExercise.sessionId, rows);
	}

	for (const sessionSet of sessionSets) {
		const sessionExercise = sessionExerciseById.get(sessionSet.sessionExerciseId);

		if (!sessionExercise) {
			continue;
		}

		const rows = sessionSetsBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionSet);
		sessionSetsBySessionId.set(sessionExercise.sessionId, rows);
	}

	return new Map(
		sessions.map((session) => [
			session.id,
			summarizeSession(
				session,
				sessionExercisesBySessionId.get(session.id) ?? [],
				sessionSetsBySessionId.get(session.id) ?? []
			)
		])
	);
}

export async function getCurrentInProgressSession() {
	const sessions = await db.workoutSessions.where('status').equals('in_progress').toArray();
	const latestSession = sessions.sort((first, second) => compareSessionRows(second, first)).at(0);

	if (!latestSession) {
		return null;
	}

	return (await getSessionSummariesByIds([latestSession.id])).get(latestSession.id) ?? null;
}

export async function listSessionSummariesForMonth(monthDate: Date) {
	const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
	const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return [...(await getSessionSummariesByIds(sessions.map((session) => session.id))).values()].sort(
		(first, second) => compareSessionRows(first, second)
	);
}

export async function listSessionCalendarRowsForWeek(weekDate: Date): Promise<SessionSummary[]> {
	const start = toValidDate(weekDate);
	const end = new Date(start);
	end.setDate(start.getDate() + 6);
	const sessions = await db.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();

	return sessions
		.map((session) => summarizeSession(session, [], []))
		.sort((first, second) => compareSessionRows(first, second));
}

export async function getDayOverview(dayKey: string): Promise<DayOverview> {
	const sessions = await db.workoutSessions.where('dayKey').equals(dayKey).toArray();
	const latestSession = sessions.sort(compareSessionRows).at(-1) ?? null;

	if (!latestSession) {
		return {
			dayKey,
			session: null
		};
	}

	const summaries = await getSessionSummariesByIds([latestSession.id]);

	return {
		dayKey,
		session: summaries.get(latestSession.id) ?? null
	};
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview | null> {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const currentSessionAt = getSessionSortTime(session);
	const sessionExercisesPromise = listSessionExerciseDetails(sessionId);
	const [sessionExercises, previousSession, exercises] = await Promise.all([
		sessionExercisesPromise,
		db.workoutSessions
			.where('workoutId')
			.equals(session.workoutId)
			.toArray()
			.then(
				(sessions) =>
					sessions
						.filter(
							(candidate) =>
								candidate.id !== session.id &&
								candidate.status !== 'planned' &&
								getSessionSortTime(candidate) < currentSessionAt
						)
						.sort(compareSessionRows)
						.at(-1) ?? null
			),
		sessionExercisesPromise.then((rows) =>
			db.exercises.bulkGet(rows.map((sessionExercise) => sessionExercise.exerciseId))
		)
	]);
	const sessionSets = sessionExercises.flatMap((sessionExercise) => sessionExercise.sets);
	const previousExercises = previousSession
		? await listSessionExerciseDetails(previousSession.id)
		: [];
	const previousSummary = previousSession
		? summarizeSession(
				previousSession,
				previousExercises,
				previousExercises.flatMap((sessionExercise) => sessionExercise.sets)
			)
		: null;
	const exerciseById = new Map(
		exercises.filter(isDefined).map((exercise) => {
			const nextExercise = withExerciseDefaults(exercise);
			return [nextExercise.id, nextExercise] as const;
		})
	);
	const previousPerformanceByExerciseId = await getLatestExerciseHistoryEntries(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId),
		session.id,
		currentSessionAt
	);
	const progress =
		sessionExercises.length === 0
			? null
			: {
					improvedExercises: 0,
					matchedExercises: 0,
					regressedExercises: 0,
					mixedExercises: 0,
					newExercises: 0
				};
	const nextExercises = sessionExercises.map((sessionExercise) => {
		const previousPerformance =
			previousPerformanceByExerciseId.get(sessionExercise.exerciseId) ?? null;
		const previousReferenceBySetKey = buildPreviousReferenceBySetKey(
			sessionExercise,
			previousPerformance
		);
		const { progressStatus, progressSummary } = summarizeExerciseProgress(
			sessionExercise,
			previousReferenceBySetKey
		);
		const sets = sessionExercise.sets.map((sessionSet) => {
			const previousReference = previousReferenceBySetKey.get(getSessionSetKey(sessionSet)) ?? null;

			return {
				...sessionSet,
				label: getSessionSetLabel(sessionSet),
				previousReference,
				weightDelta: createFieldDelta(sessionSet.weight, previousReference?.weight),
				repsDelta: createFieldDelta(sessionSet.reps, previousReference?.reps),
				rirDelta: createFieldDelta(sessionSet.rir, previousReference?.rir)
			};
		});

		if (progress) {
			switch (progressStatus) {
				case 'improved':
					progress.improvedExercises += 1;
					break;
				case 'regressed':
					progress.regressedExercises += 1;
					break;
				case 'mixed':
					progress.mixedExercises += 1;
					break;
				case 'new':
					progress.newExercises += 1;
					break;
				default:
					progress.matchedExercises += 1;
			}
		}

		return {
			...sessionExercise,
			exercise: exerciseById.get(sessionExercise.exerciseId) ?? null,
			previousPerformance,
			progressStatus,
			progressSummary,
			sets
		};
	});

	return {
		summary: summarizeSession(session, sessionExercises, sessionSets),
		previousSummary,
		progress,
		exercises: nextExercises
	};
}
