import type { SessionExercise, SessionSet, WorkoutSession } from '../models';
import type { AppDatabase } from '../runtime';
import { hasAnySetValue } from '../shared';
import { getScheduledWorkoutSessionId } from './schedule-identity';

export type SessionGraph = {
	session: WorkoutSession;
	sessionExercises: SessionExercise[];
	sessionSets: SessionSet[];
};

export type SessionChildProjection = {
	visibleSessionExercises: SessionExercise[];
	visibleSessionSets: SessionSet[];
	quarantinedSessionExerciseIds: string[];
	recoverableSessionExerciseIds: string[];
};

export type ScheduledSessionDayProjection = {
	// Kept for callers that previously reported destructive repairs. Maintenance projections never
	// populate these arrays; only an explicit user action may delete source rows.
	deletedSessionIds: string[];
	deletedSessionExerciseIds: string[];
	preservedLoggedSessionIds: string[];
	protectedSessionIds: string[];
	visibleSessionIds: string[];
	quarantinedSessionIds: string[];
	quarantinedSessionExerciseIds: string[];
	recoverableSessionExerciseIds: string[];
	winnerSessionId?: string;
};

export type ScheduledSessionProjectionOptions = {
	hidePristinePlansBeforeDayKey?: string;
};

export type ScheduledSessionDayRepair = ScheduledSessionDayProjection;

export type SessionGraphDatabase = Pick<
	AppDatabase,
	'workoutSessions' | 'sessionExercises' | 'sessionSets'
>;

export function isPristineSessionSet(sessionSet: SessionSet) {
	return sessionSet.createdAt === sessionSet.updatedAt && !hasAnySetValue(sessionSet);
}

export function isPristineSessionExercise(
	sessionExercise: SessionExercise,
	sessionSets: SessionSet[]
) {
	return (
		sessionExercise.createdAt === sessionExercise.updatedAt &&
		sessionSets.every(isPristineSessionSet)
	);
}

export function isPristinePlannedSessionGraph(graph: SessionGraph) {
	return (
		graph.session.status === 'planned' &&
		!graph.session.startedAt &&
		!graph.session.completedAt &&
		graph.session.createdAt === graph.session.updatedAt &&
		graph.sessionExercises.every((sessionExercise) =>
			isPristineSessionExercise(
				sessionExercise,
				graph.sessionSets.filter(
					(sessionSet) => sessionSet.sessionExerciseId === sessionExercise.id
				)
			)
		)
	);
}

export function sessionExerciseBelongsToSession(
	session: WorkoutSession,
	sessionExercise: SessionExercise
) {
	return (
		sessionExercise.sessionId === session.id && sessionExercise.workoutId === session.workoutId
	);
}

export function projectSessionChildren(graph: SessionGraph): SessionChildProjection {
	const visibleSessionExercises = graph.sessionExercises.filter((sessionExercise) =>
		sessionExerciseBelongsToSession(graph.session, sessionExercise)
	);
	const visibleSessionExerciseIds = new Set(
		visibleSessionExercises.map((sessionExercise) => sessionExercise.id)
	);
	const visibleSessionSets = graph.sessionSets.filter((sessionSet) =>
		visibleSessionExerciseIds.has(sessionSet.sessionExerciseId)
	);
	const quarantinedSessionExerciseIds: string[] = [];
	const recoverableSessionExerciseIds: string[] = [];

	for (const sessionExercise of graph.sessionExercises) {
		if (visibleSessionExerciseIds.has(sessionExercise.id)) {
			continue;
		}

		const sessionSets = graph.sessionSets.filter(
			(sessionSet) => sessionSet.sessionExerciseId === sessionExercise.id
		);

		if (isPristineSessionExercise(sessionExercise, sessionSets)) {
			quarantinedSessionExerciseIds.push(sessionExercise.id);
		} else {
			recoverableSessionExerciseIds.push(sessionExercise.id);
		}
	}

	return {
		visibleSessionExercises,
		visibleSessionSets,
		quarantinedSessionExerciseIds,
		recoverableSessionExerciseIds
	};
}

export function projectScheduledSessionDayGraphs(
	userId: string | undefined,
	dayKey: string,
	graphs: SessionGraph[],
	options: ScheduledSessionProjectionOptions = {}
): ScheduledSessionDayProjection {
	const dayGraphs = graphs.filter((graph) => graph.session.dayKey === dayKey);
	const pristineGraphs = dayGraphs.filter(isPristinePlannedSessionGraph);
	const protectedGraphs = dayGraphs.filter((graph) => !isPristinePlannedSessionGraph(graph));
	let winner: SessionGraph | undefined;

	if (protectedGraphs.length === 1) {
		winner = protectedGraphs[0];
	} else if (protectedGraphs.length === 0) {
		const scheduledSessionId = userId ? getScheduledWorkoutSessionId(userId, dayKey) : undefined;
		winner =
			(scheduledSessionId
				? pristineGraphs.find((graph) => graph.session.id === scheduledSessionId)
				: undefined) ??
			[...pristineGraphs].sort((first, second) =>
				first.session.id.localeCompare(second.session.id)
			)[0];
	}

	const hidePristinePlans = Boolean(
		options.hidePristinePlansBeforeDayKey && dayKey < options.hidePristinePlansBeforeDayKey
	);
	const visibleGraphs = protectedGraphs.length
		? protectedGraphs
		: winner && !hidePristinePlans
			? [winner]
			: [];
	const visibleSessionIds = new Set(visibleGraphs.map((graph) => graph.session.id));
	const quarantinedSessionIds = pristineGraphs
		.filter((graph) => !visibleSessionIds.has(graph.session.id))
		.map((graph) => graph.session.id);
	const childProjections = dayGraphs.map(projectSessionChildren);

	return {
		deletedSessionIds: [],
		deletedSessionExerciseIds: [],
		preservedLoggedSessionIds: protectedGraphs.map((graph) => graph.session.id),
		protectedSessionIds: protectedGraphs.map((graph) => graph.session.id),
		visibleSessionIds: [...visibleSessionIds],
		quarantinedSessionIds,
		quarantinedSessionExerciseIds: childProjections.flatMap(
			(projection) => projection.quarantinedSessionExerciseIds
		),
		recoverableSessionExerciseIds: childProjections.flatMap(
			(projection) => projection.recoverableSessionExerciseIds
		),
		winnerSessionId: winner?.session.id
	};
}

export async function loadSessionGraph(database: SessionGraphDatabase, session: WorkoutSession) {
	const sessionExercises = await database.sessionExercises
		.where('sessionId')
		.equals(session.id)
		.toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();

	return { session, sessionExercises, sessionSets } satisfies SessionGraph;
}

export async function getScheduledSessionDayProjection(
	database: SessionGraphDatabase,
	userId: string | undefined,
	dayKey: string,
	options: ScheduledSessionProjectionOptions = {}
): Promise<ScheduledSessionDayProjection> {
	const sessions = await database.workoutSessions.where('dayKey').equals(dayKey).toArray();
	const graphs = await Promise.all(sessions.map((session) => loadSessionGraph(database, session)));

	return projectScheduledSessionDayGraphs(userId, dayKey, graphs, options);
}

/**
 * Historical name retained for sync/runtime call sites. Repair is intentionally projection-only:
 * a locally pristine graph is not evidence that another replica has not edited it offline.
 */
export async function repairScheduledSessionDay(
	database: SessionGraphDatabase,
	userId: string,
	dayKey: string
): Promise<ScheduledSessionDayRepair> {
	return getScheduledSessionDayProjection(database, userId, dayKey);
}

export async function repairScheduledSessionDays(database: SessionGraphDatabase, userId: string) {
	if (!database.workoutSessions || !database.sessionExercises || !database.sessionSets) {
		return;
	}

	const sessions = await database.workoutSessions.toArray();
	const dayKeys = [...new Set(sessions.map((session) => session.dayKey))];

	for (const dayKey of dayKeys) {
		await repairScheduledSessionDay(database, userId, dayKey);
	}
}
