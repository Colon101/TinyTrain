import { listExerciseHistory } from '../exercises';
import type {
	DayOverview,
	ExerciseHistoryEntry,
	SessionExercise,
	SessionExerciseDetail,
	SessionOverview,
	SessionSet,
	SessionSummary,
	WorkoutSession
} from '../models';
import { runAuthenticatedDatabaseOperation, type AuthenticatedOperationDatabase } from '../runtime';
import {
	buildPreviousReferenceBySetKey,
	compareSessionRows,
	createFieldDelta,
	findLatestHistoryEntryWithPerformedSets,
	filterSessionSetsForSessionExercises,
	getExerciseHistorySortTime,
	getSessionSetKey,
	getSessionSetLabel,
	getSessionSortTime,
	isDefined,
	projectUniqueSessionExercises,
	reconcileSessionExerciseOrderCollisions,
	reconcileSessionSetOrderCollisions,
	summarizeExerciseProgress,
	summarizeSession,
	toDayKey,
	toValidDate,
	withExerciseDefaults,
	withSessionSetDefaults
} from '../shared';
import {
	projectScheduledSessionDayGraphs,
	projectSessionChildren,
	sessionExerciseBelongsToSession,
	type SessionGraph
} from './schedule-integrity';

type SessionDataDatabase = Pick<
	AuthenticatedOperationDatabase,
	'workoutSessions' | 'sessionExercises' | 'sessionSets' | 'exercises'
>;

export async function loadSessionGraphsWithDatabase(
	database: SessionDataDatabase,
	sessions: WorkoutSession[]
): Promise<SessionGraph[]> {
	if (sessions.length === 0) {
		return [];
	}

	const sessionIds = sessions.map((session) => session.id);
	const sessionExercises = await database.sessionExercises
		.where('sessionId')
		.anyOf(sessionIds)
		.toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();
	const sessionExercisesBySessionId = new Map<string, SessionExercise[]>();
	const sessionSetsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionExercise of sessionExercises) {
		const rows = sessionExercisesBySessionId.get(sessionExercise.sessionId) ?? [];
		rows.push(sessionExercise);
		sessionExercisesBySessionId.set(sessionExercise.sessionId, rows);
	}

	for (const sessionSet of sessionSets) {
		const rows = sessionSetsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		sessionSetsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessions.map((session) => {
		const graphSessionExercises = sessionExercisesBySessionId.get(session.id) ?? [];

		return {
			session,
			sessionExercises: graphSessionExercises,
			sessionSets: graphSessionExercises.flatMap(
				(sessionExercise) => sessionSetsBySessionExerciseId.get(sessionExercise.id) ?? []
			)
		};
	});
}

export async function projectVisibleSessionRowsWithDatabase(
	database: SessionDataDatabase,
	userId: string,
	sessions: WorkoutSession[]
) {
	const graphs = await loadSessionGraphsWithDatabase(database, sessions);
	const graphsByDayKey = new Map<string, SessionGraph[]>();
	const visibleSessionIds = new Set<string>();
	const todayDayKey = toDayKey(new Date());

	for (const graph of graphs) {
		const rows = graphsByDayKey.get(graph.session.dayKey) ?? [];
		rows.push(graph);
		graphsByDayKey.set(graph.session.dayKey, rows);
	}

	for (const [dayKey, dayGraphs] of graphsByDayKey) {
		const projection = projectScheduledSessionDayGraphs(userId, dayKey, dayGraphs, {
			hidePristinePlansBeforeDayKey: todayDayKey
		});

		for (const sessionId of projection.visibleSessionIds) {
			visibleSessionIds.add(sessionId);
		}
	}

	return sessions.filter((session) => visibleSessionIds.has(session.id));
}

type SessionDetailDatabase = SessionDataDatabase;

export async function listSessionExerciseDetailsWithDatabase(
	database: SessionDetailDatabase,
	sessionId: string
): Promise<SessionExerciseDetail[]> {
	const [session, storedSessionExercises] = await Promise.all([
		database.workoutSessions.get(sessionId),
		database.sessionExercises.where('sessionId').equals(sessionId).sortBy('order')
	]);

	if (!session) {
		return [];
	}

	const sessionExerciseIds = storedSessionExercises.map((sessionExercise) => sessionExercise.id);
	const storedSessionSets =
		sessionExerciseIds.length === 0
			? []
			: (
					await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()
				).map(withSessionSetDefaults);
	const childProjection = projectSessionChildren({
		session,
		sessionExercises: storedSessionExercises,
		sessionSets: storedSessionSets
	});
	const sessionExercises = reconcileSessionExerciseOrderCollisions(
		projectUniqueSessionExercises(childProjection.visibleSessionExercises)
	);
	const sessionSets = filterSessionSetsForSessionExercises(
		childProjection.visibleSessionSets,
		sessionExercises
	);
	const setsBySessionExerciseId = new Map<string, SessionSet[]>();

	for (const sessionSet of sessionSets) {
		const rows = setsBySessionExerciseId.get(sessionSet.sessionExerciseId) ?? [];
		rows.push(sessionSet);
		setsBySessionExerciseId.set(sessionSet.sessionExerciseId, rows);
	}

	return sessionExercises.map((sessionExercise) => ({
		...sessionExercise,
		sets: reconcileSessionSetOrderCollisions(setsBySessionExerciseId.get(sessionExercise.id) ?? [])
	}));
}

export async function listSessionExerciseDetails(
	sessionId: string
): Promise<SessionExerciseDetail[]> {
	return runAuthenticatedDatabaseOperation(({ database }) =>
		listSessionExerciseDetailsWithDatabase(database, sessionId)
	);
}

async function getLatestExerciseHistoryEntriesWithDatabase(
	database: SessionDetailDatabase,
	exerciseIds: string[],
	currentSessionId: string,
	beforeSessionAt: number
) {
	const uniqueExerciseIds = [...new Set(exerciseIds)];
	const storedSessionExercises = await database.sessionExercises.toArray();
	const sessionIds = [...new Set(storedSessionExercises.map((row) => row.sessionId))];
	const sessions = await database.workoutSessions.bulkGet(sessionIds);
	const sessionById = new Map(sessions.filter(isDefined).map((session) => [session.id, session]));
	const sessionExercises = projectUniqueSessionExercises(
		storedSessionExercises.filter((sessionExercise) => {
			const session = sessionById.get(sessionExercise.sessionId);
			return Boolean(session && sessionExerciseBelongsToSession(session, sessionExercise));
		})
	);
	const previousEntries = await Promise.all(
		uniqueExerciseIds.map(async (exerciseId) => {
			const history = (
				await listExerciseHistory(exerciseId, { sessionExercises, database })
			).filter(
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

export async function getLatestExerciseHistoryEntries(
	exerciseIds: string[],
	currentSessionId: string,
	beforeSessionAt: number
) {
	return runAuthenticatedDatabaseOperation(({ database }) =>
		getLatestExerciseHistoryEntriesWithDatabase(
			database,
			exerciseIds,
			currentSessionId,
			beforeSessionAt
		)
	);
}

export async function getSessionSummariesByIdsWithDatabase(
	database: SessionDataDatabase,
	sessionIds: string[]
) {
	if (sessionIds.length === 0) {
		return new Map<string, SessionSummary>();
	}

	const sessions = (await database.workoutSessions.bulkGet(sessionIds)).filter(isDefined);
	const sessionById = new Map(sessions.map((session) => [session.id, session]));
	const storedSessionExercises = await database.sessionExercises
		.where('sessionId')
		.anyOf(sessionIds)
		.toArray();
	const sessionExercises = projectUniqueSessionExercises(
		storedSessionExercises.filter((sessionExercise) => {
			const session = sessionById.get(sessionExercise.sessionId);
			return Boolean(session && sessionExerciseBelongsToSession(session, sessionExercise));
		})
	);
	const sessionExerciseIds = storedSessionExercises.map((sessionExercise) => sessionExercise.id);
	const storedSessionSets =
		sessionExerciseIds.length === 0
			? []
			: (
					await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray()
				).map(withSessionSetDefaults);
	const sessionSets = filterSessionSetsForSessionExercises(storedSessionSets, sessionExercises);
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

export async function getSessionSummariesByIds(sessionIds: string[]) {
	return runAuthenticatedDatabaseOperation(({ database }) =>
		getSessionSummariesByIdsWithDatabase(database, sessionIds)
	);
}

export async function getCurrentInProgressSessionWithDatabase(
	database: SessionDataDatabase,
	userId: string
) {
	const sessions = await projectVisibleSessionRowsWithDatabase(
		database,
		userId,
		await database.workoutSessions.where('status').equals('in_progress').toArray()
	);
	const latestSession = sessions.sort((first, second) => compareSessionRows(second, first)).at(0);

	if (!latestSession) {
		return null;
	}

	return (
		(await getSessionSummariesByIdsWithDatabase(database, [latestSession.id])).get(
			latestSession.id
		) ?? null
	);
}

export async function getCurrentInProgressSession() {
	return runAuthenticatedDatabaseOperation(({ database, userId }) =>
		getCurrentInProgressSessionWithDatabase(database, userId)
	);
}

export async function listSessionSummariesForMonthWithDatabase(
	database: SessionDataDatabase,
	userId: string,
	monthDate: Date
) {
	const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
	const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
	const sessions = await database.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();
	const visibleSessions = await projectVisibleSessionRowsWithDatabase(database, userId, sessions);

	return [
		...(
			await getSessionSummariesByIdsWithDatabase(
				database,
				visibleSessions.map((session) => session.id)
			)
		).values()
	].sort((first, second) => compareSessionRows(first, second));
}

export async function listSessionSummariesForMonth(monthDate: Date) {
	return runAuthenticatedDatabaseOperation(({ database, userId }) =>
		listSessionSummariesForMonthWithDatabase(database, userId, monthDate)
	);
}

export async function listSessionCalendarRowsForWeekWithDatabase(
	database: SessionDataDatabase,
	userId: string,
	weekDate: Date
): Promise<SessionSummary[]> {
	const start = toValidDate(weekDate);
	const end = new Date(start);
	end.setDate(start.getDate() + 6);
	const sessions = await database.workoutSessions
		.where('dayKey')
		.between(toDayKey(start), toDayKey(end), true, true)
		.toArray();
	const visibleSessions = await projectVisibleSessionRowsWithDatabase(database, userId, sessions);

	return [
		...(
			await getSessionSummariesByIdsWithDatabase(
				database,
				visibleSessions.map((session) => session.id)
			)
		).values()
	].sort((first, second) => compareSessionRows(first, second));
}

export async function listSessionCalendarRowsForWeek(weekDate: Date): Promise<SessionSummary[]> {
	return runAuthenticatedDatabaseOperation(({ database, userId }) =>
		listSessionCalendarRowsForWeekWithDatabase(database, userId, weekDate)
	);
}

export async function getDayOverviewWithDatabase(
	database: SessionDataDatabase,
	userId: string,
	dayKey: string
): Promise<DayOverview> {
	const sessions = await projectVisibleSessionRowsWithDatabase(
		database,
		userId,
		await database.workoutSessions.where('dayKey').equals(dayKey).toArray()
	);
	const latestSession = sessions.sort(compareSessionRows).at(-1) ?? null;

	if (!latestSession) {
		return {
			dayKey,
			session: null,
			sessions: []
		};
	}

	const summaries = await getSessionSummariesByIdsWithDatabase(
		database,
		sessions.map((session) => session.id)
	);
	const daySessions = [...summaries.values()].sort(compareSessionRows);

	return {
		dayKey,
		session: summaries.get(latestSession.id) ?? null,
		sessions: daySessions
	};
}

export async function getDayOverview(dayKey: string): Promise<DayOverview> {
	return runAuthenticatedDatabaseOperation(({ database, userId }) =>
		getDayOverviewWithDatabase(database, userId, dayKey)
	);
}

export async function getSessionOverviewWithDatabase(
	database: SessionDetailDatabase,
	sessionId: string
): Promise<SessionOverview | null> {
	const session = await database.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const currentSessionAt = getSessionSortTime(session);
	const sessionExercisesPromise = listSessionExerciseDetailsWithDatabase(database, sessionId);
	const [sessionExercises, previousSession, exercises] = await Promise.all([
		sessionExercisesPromise,
		database.workoutSessions
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
			database.exercises.bulkGet(rows.map((sessionExercise) => sessionExercise.exerciseId))
		)
	]);
	const sessionSets = sessionExercises.flatMap((sessionExercise) => sessionExercise.sets);
	const previousExercises = previousSession
		? await listSessionExerciseDetailsWithDatabase(database, previousSession.id)
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
	const previousPerformanceByExerciseId = await getLatestExerciseHistoryEntriesWithDatabase(
		database,
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

export async function getSessionOverview(sessionId: string): Promise<SessionOverview | null> {
	return runAuthenticatedDatabaseOperation(({ database }) =>
		getSessionOverviewWithDatabase(database, sessionId)
	);
}
