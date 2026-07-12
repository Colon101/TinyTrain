import { getExercise, listHistoricalSessionExerciseMatches } from '../exercises';
import type {
	Exercise,
	SessionExerciseDetail,
	SessionSet,
	SessionSetSide,
	WorkoutSession
} from '../models';
import { db } from '../runtime';
import { createId, getSessionSetOrderCount, timestamp } from '../shared';
import { listSessionExerciseDetails } from './data';

export async function getSeedSetOrderCount(exercise: Exercise, excludeSessionId?: string) {
	const latestHistoricalMatch = (await listHistoricalSessionExerciseMatches(exercise.id)).find(
		({ session, sets }) => session.id !== excludeSessionId && sets.length > 0
	);

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
	now = timestamp()
): SessionSet {
	return {
		id: createId(),
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
	now = timestamp()
) {
	const sessionSets: SessionSet[] = [];

	for (let order = 1; order <= orderCount; order += 1) {
		if (unilateral) {
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'right', now));
			sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'left', now));
			continue;
		}

		sessionSets.push(createSessionSetRow(sessionExerciseId, exerciseId, order, 'bilateral', now));
	}

	return sessionSets;
}

export async function buildSessionSeedSetRows(
	sessionExerciseId: string,
	exercise: Exercise,
	now = timestamp(),
	excludeSessionId?: string
) {
	const orderCount = await getSeedSetOrderCount(exercise, excludeSessionId);

	return buildSeedSessionSetRows(
		sessionExerciseId,
		exercise.id,
		orderCount,
		exercise.unilateral,
		now
	);
}

export async function ensureEditableSessionSeedRows(
	session: WorkoutSession,
	sessionExercises: SessionExerciseDetail[]
) {
	if (session.status === 'completed' || session.status === 'abandoned') {
		return sessionExercises;
	}

	const missingSeedRows = sessionExercises.filter(
		(sessionExercise) => sessionExercise.sets.length === 0
	);

	if (missingSeedRows.length === 0) {
		return sessionExercises;
	}

	const exercises = await Promise.all(
		missingSeedRows.map((sessionExercise) => getExercise(sessionExercise.exerciseId))
	);
	const exerciseById = new Map(
		exercises.flatMap((exercise) => (exercise ? ([[exercise.id, exercise]] as const) : []))
	);
	const now = timestamp();
	const seedRowsBySessionExerciseId = new Map(
		await Promise.all(
			missingSeedRows.map(async (sessionExercise) => {
				const exercise = exerciseById.get(sessionExercise.exerciseId);

				if (!exercise) {
					return [sessionExercise.id, [] as SessionSet[]] as const;
				}

				return [
					sessionExercise.id,
					await buildSessionSeedSetRows(sessionExercise.id, exercise, now, session.id)
				] as const;
			})
		)
	);
	const seededSessionExerciseIds = [...seedRowsBySessionExerciseId.entries()]
		.filter(([, sessionSets]) => sessionSets.length > 0)
		.map(([sessionExerciseId]) => sessionExerciseId);

	if (seededSessionExerciseIds.length === 0) {
		return sessionExercises;
	}

	await db.transaction('rw', db.sessionSets, db.sessionExercises, db.workoutSessions, async () => {
		await db.sessionSets.bulkAdd(
			seededSessionExerciseIds.flatMap(
				(sessionExerciseId) => seedRowsBySessionExerciseId.get(sessionExerciseId) ?? []
			)
		);
		await Promise.all(
			seededSessionExerciseIds.map((sessionExerciseId) =>
				db.sessionExercises.update(sessionExerciseId, { updatedAt: now })
			)
		);
		await db.workoutSessions.update(session.id, { updatedAt: now });
	});

	return listSessionExerciseDetails(session.id);
}

export async function deleteWorkoutSessionRows(sessionId: string) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return null;
	}

	const sessionExercises = await db.sessionExercises.where('sessionId').equals(sessionId).toArray();
	const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
	const sessionSets =
		sessionExerciseIds.length === 0
			? []
			: await db.sessionSets.where('sessionExerciseId').anyOf(sessionExerciseIds).toArray();

	if (sessionSets.length > 0) {
		await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
	}

	if (sessionExerciseIds.length > 0) {
		await db.sessionExercises.bulkDelete(sessionExerciseIds);
	}

	await db.workoutSessions.delete(sessionId);

	return session;
}
