import { listHistoricalSessionExerciseMatches } from '../exercises';
import type {
	Exercise,
	SessionExerciseDetail,
	SessionSet,
	SessionSetSide,
	WorkoutSession
} from '../models';
import { db, type AppDatabase } from '../runtime';
import { createId, getSessionSetOrderCount, timestamp } from '../shared';

export type SessionSetLogicalIdFactory = (order: number) => string;

type SessionSeedDatabase = Pick<
	AppDatabase,
	'exercises' | 'sessionExercises' | 'workoutSessions' | 'sessionSets'
>;

export async function getSeedSetOrderCount(
	exercise: Exercise,
	excludeSessionId?: string,
	database: SessionSeedDatabase = db
) {
	const latestHistoricalMatch = (
		await listHistoricalSessionExerciseMatches(exercise.id, { database })
	).find(({ session, sets }) => session.id !== excludeSessionId && sets.length > 0);

	if (!latestHistoricalMatch) {
		return 0;
	}

	return getSessionSetOrderCount(latestHistoricalMatch.sets);
}

export function createSessionSetRow(
	sessionExerciseId: string,
	exerciseId: string,
	order: number,
	side: SessionSetSide,
	now = timestamp(),
	id = createId()
): SessionSet {
	return {
		id,
		sessionExerciseId,
		exerciseId,
		order,
		side,
		weightInput: '',
		repsInput: '',
		rirInput: '',
		createdAt: now,
		updatedAt: now
	};
}

export function buildSeedSessionSetRows(
	sessionExerciseId: string,
	exerciseId: string,
	orderCount: number,
	unilateral: boolean,
	now = timestamp(),
	getLogicalSetId: SessionSetLogicalIdFactory = () => createId()
) {
	const sessionSets: SessionSet[] = [];

	for (let order = 1; order <= orderCount; order += 1) {
		const logicalSetId = getLogicalSetId(order);

		if (unilateral) {
			sessionSets.push(
				createSessionSetRow(
					sessionExerciseId,
					exerciseId,
					order,
					'right',
					now,
					`${logicalSetId}:right`
				)
			);
			sessionSets.push(
				createSessionSetRow(
					sessionExerciseId,
					exerciseId,
					order,
					'left',
					now,
					`${logicalSetId}:left`
				)
			);
			continue;
		}

		sessionSets.push(
			createSessionSetRow(
				sessionExerciseId,
				exerciseId,
				order,
				'bilateral',
				now,
				`${logicalSetId}:bilateral`
			)
		);
	}

	return sessionSets;
}

export async function buildSessionSeedSetRows(
	sessionExerciseId: string,
	exercise: Exercise,
	now = timestamp(),
	excludeSessionId?: string,
	getLogicalSetId?: SessionSetLogicalIdFactory,
	database: SessionSeedDatabase = db
) {
	const orderCount = await getSeedSetOrderCount(exercise, excludeSessionId, database);

	return buildSeedSessionSetRows(
		sessionExerciseId,
		exercise.id,
		orderCount,
		exercise.unilateral,
		now,
		getLogicalSetId
	);
}

export async function ensureEditableSessionSeedRows(
	_session: WorkoutSession,
	sessionExercises: SessionExerciseDetail[]
) {
	// Creation paths write a parent and its seed rows as one compensated operation. An empty
	// exercise is therefore valid user-owned state, including when its final set tombstone reaches
	// this replica before the parent update. Inferring "missing" rows from timestamps can resurrect
	// deliberately deleted data, so loading a session must remain a read-only normalization step.
	return sessionExercises;
}

export async function deleteWorkoutSessionRows(
	sessionId: string,
	database: Pick<AppDatabase, 'workoutSessions' | 'sessionExercises' | 'sessionSets'> = db
) {
	const session = await database.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const sessionExercises = await database.sessionExercises
		.where('sessionId')
		.equals(sessionId)
		.toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await database.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();

	if (sessionSets.length > 0) {
		await database.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
	}

	if (sessionExerciseIds.length > 0) {
		await database.sessionExercises.bulkDelete(sessionExerciseIds);
	}

	await database.workoutSessions.delete(sessionId);

	return session;
}
