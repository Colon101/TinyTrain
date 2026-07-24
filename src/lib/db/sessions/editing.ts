import { getExercise } from '../exercises';
import type { SessionExercise, SessionInputField, SessionSet } from '../models';
import { db, requireLoggedInUser } from '../runtime';
import { clearSessionInputDraft, removeSessionInputDraftSets } from '../session-drafts';
import { compareSessionSetRows, createId, timestamp, withSessionSetDefaults } from '../shared';
import { listWorkoutExercises } from '../workouts';
import { updateSessionSetInputs } from './inputs';
import { buildSeedSessionSetRows, buildSessionSeedSetRows } from './seeding';

export async function reorderSessionExercises(
	sessionId: string,
	orderedSessionExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction(async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseById = new Map(
			sessionExercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
		);
		const orderedIds = orderedSessionExerciseIds.filter((id) => sessionExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = sessionExercises
			.filter((sessionExercise) => !orderedIdSet.has(sessionExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((sessionExercise) => sessionExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.sessionExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});
}

export async function replaceSessionExercise(sessionExerciseId: string, exerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const [session, exercise, sessionExercises] = await Promise.all([
		db.workoutSessions.get(sessionExercise.sessionId),
		getExercise(exerciseId),
		db.sessionExercises.where('sessionId').equals(sessionExercise.sessionId).toArray()
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	if (
		sessionExercises.some(
			(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
		)
	) {
		throw new Error('That exercise is already in this session.');
	}

	const now = timestamp();
	const seedSets = await buildSessionSeedSetRows(sessionExerciseId, exercise, now, session.id);

	await db.transaction(async () => {
		const currentSessionExercise = await db.sessionExercises.get(sessionExerciseId);

		if (!currentSessionExercise || currentSessionExercise.sessionId !== session.id) {
			throw new Error('Exercise not found in this session.');
		}

		const duplicateExercise = (
			await db.sessionExercises.where('sessionId').equals(session.id).toArray()
		).some(
			(candidate) => candidate.id !== sessionExerciseId && candidate.exerciseId === exerciseId
		);

		if (duplicateExercise) {
			throw new Error('That exercise is already in this session.');
		}

		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.update(sessionExerciseId, {
			exerciseId: exercise.id,
			exerciseNameSnapshot: exercise.name,
			updatedAt: now
		});

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(session.id, { updatedAt: now });
	});
}

export async function removeSessionExercise(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		return;
	}

	await db.transaction(async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();

		if (currentSets.length > 0) {
			await db.sessionSets.bulkDelete(currentSets.map((sessionSet) => sessionSet.id));
		}

		await db.sessionExercises.delete(sessionExerciseId);

		const remainingSessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionExercise.sessionId)
			.sortBy('order');
		const now = timestamp();

		await Promise.all(
			remainingSessionExercises.map((remainingSessionExercise, index) =>
				db.sessionExercises.update(remainingSessionExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});
}

export async function addExerciseToSession(sessionId: string, exerciseId: string) {
	const [sessionExercise] = await addExercisesToSession(sessionId, [exerciseId]);

	return sessionExercise;
}

export async function addExercisesToSession(sessionId: string, exerciseIds: string[]) {
	requireLoggedInUser();
	const uniqueExerciseIds = [...new Set(exerciseIds)];

	if (uniqueExerciseIds.length === 0) {
		return [];
	}

	const [session, exercises] = await Promise.all([
		db.workoutSessions.get(sessionId),
		Promise.all(uniqueExerciseIds.map((exerciseId) => getExercise(exerciseId)))
	]);

	if (!session) {
		throw new Error('Session not found.');
	}

	if (exercises.some((exercise) => !exercise)) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	const candidateSessionExercises = exercises.map((exercise) => ({
		id: createId(),
		exercise: exercise!,
		seedSets: [] as SessionSet[]
	}));

	await Promise.all(
		candidateSessionExercises.map(async (candidate) => {
			candidate.seedSets = await buildSessionSeedSetRows(
				candidate.id,
				candidate.exercise,
				now,
				session.id
			);
		})
	);

	return db.transaction<SessionExercise[]>(async () => {
		const currentSession = await db.workoutSessions.get(sessionId);

		if (!currentSession) {
			throw new Error('Session not found.');
		}

		const existingSessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const existingExerciseIds = new Set(
			existingSessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
		);

		if (
			candidateSessionExercises.some((candidate) => existingExerciseIds.has(candidate.exercise.id))
		) {
			throw new Error('That exercise is already in this session.');
		}

		let nextOrder =
			existingSessionExercises.reduce(
				(highestOrder, currentSessionExercise) =>
					Math.max(highestOrder, currentSessionExercise.order),
				0
			) + 1;
		const sessionExercises = candidateSessionExercises.map((candidate) => ({
			id: candidate.id,
			sessionId,
			workoutId: currentSession.workoutId,
			exerciseId: candidate.exercise.id,
			exerciseNameSnapshot: candidate.exercise.name,
			order: nextOrder++,
			performedAt: currentSession.startedAt ?? now,
			createdAt: now,
			updatedAt: now
		})) satisfies SessionExercise[];
		const seedSets = candidateSessionExercises.flatMap((candidate) => candidate.seedSets);

		await db.sessionExercises.bulkAdd(sessionExercises);

		if (seedSets.length > 0) {
			await db.sessionSets.bulkAdd(seedSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });

		return sessionExercises;
	});
}

export async function addSessionSetRow(sessionExerciseId: string) {
	requireLoggedInUser();

	const sessionExercise = await db.sessionExercises.get(sessionExerciseId);

	if (!sessionExercise) {
		throw new Error('Exercise not found in this session.');
	}

	const exercise = await getExercise(sessionExercise.exerciseId);

	if (!exercise) {
		throw new Error('Exercise not found.');
	}

	const now = timestamp();
	let nextSets: SessionSet[] = [];

	await db.transaction(async () => {
		const currentSessionExercise = await db.sessionExercises.get(sessionExerciseId);

		if (!currentSessionExercise || currentSessionExercise.exerciseId !== exercise.id) {
			throw new Error('Exercise not found in this session.');
		}

		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionExerciseId)
			.toArray();
		const nextOrder =
			currentSets.reduce(
				(highestOrder, currentSet) => Math.max(highestOrder, currentSet.order),
				0
			) + 1;
		nextSets = buildSeedSessionSetRows(
			sessionExerciseId,
			currentSessionExercise.exerciseId,
			1,
			exercise.unilateral,
			now
		).map((sessionSet) => ({
			...sessionSet,
			order: nextOrder
		}));

		await db.sessionSets.bulkAdd(nextSets);
		await db.sessionExercises.update(sessionExerciseId, { updatedAt: now });
		await db.workoutSessions.update(currentSessionExercise.sessionId, { updatedAt: now });
	});

	return nextSets.map(withSessionSetDefaults).sort(compareSessionSetRows);
}

export async function removeSessionSetRow(sessionSetId: string) {
	requireLoggedInUser();

	const sessionSet = await db.sessionSets.get(sessionSetId);

	if (!sessionSet) {
		return;
	}

	const sessionExercise = await db.sessionExercises.get(sessionSet.sessionExerciseId);

	if (!sessionExercise) {
		await db.sessionSets.delete(sessionSetId);
		return;
	}

	let deletedSetIds: string[] = [];

	await db.transaction(async () => {
		const currentSets = await db.sessionSets
			.where('sessionExerciseId')
			.equals(sessionSet.sessionExerciseId)
			.toArray();
		const deleteSetIds = currentSets
			.filter((currentSet) => currentSet.order === sessionSet.order)
			.map((currentSet) => currentSet.id);
		deletedSetIds = deleteSetIds;

		if (deleteSetIds.length > 0) {
			await db.sessionSets.bulkDelete(deleteSetIds);
		}

		const remainingSets = currentSets
			.filter((currentSet) => !deleteSetIds.includes(currentSet.id))
			.sort(compareSessionSetRows);
		const uniqueOrders = [...new Set(remainingSets.map((currentSet) => currentSet.order))].sort(
			(first, second) => first - second
		);
		const nextOrderByCurrentOrder = new Map(
			uniqueOrders.map((order, index) => [order, index + 1] as const)
		);
		const now = timestamp();

		await Promise.all(
			remainingSets.map((remainingSet) => {
				const nextOrder = nextOrderByCurrentOrder.get(remainingSet.order) ?? remainingSet.order;

				if (nextOrder === remainingSet.order) {
					return Promise.resolve(0);
				}

				return db.sessionSets.update(remainingSet.id, {
					order: nextOrder,
					updatedAt: now
				});
			})
		);
		await db.sessionExercises.update(sessionExercise.id, { updatedAt: now });
		await db.workoutSessions.update(sessionExercise.sessionId, { updatedAt: now });
	});

	removeSessionInputDraftSets(sessionExercise.sessionId, deletedSetIds);
}

export async function updateSessionSetInput(
	sessionSetId: string,
	field: SessionInputField,
	rawValue: string
) {
	requireLoggedInUser();

	return updateSessionSetInputs(sessionSetId, field, rawValue);
}

export async function resetSessionInputs(sessionId: string) {
	requireLoggedInUser();

	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		throw new Error('Session not found.');
	}

	const workoutExercises = await listWorkoutExercises(session.workoutId);
	const now = timestamp();
	const nextSessionExercises: SessionExercise[] = workoutExercises.map(
		(workoutExercise, index) => ({
			id: createId(),
			sessionId,
			workoutId: session.workoutId,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: session.startedAt ?? now,
			createdAt: now,
			updatedAt: now
		})
	);
	const nextSessionSets = (
		await Promise.all(
			nextSessionExercises.map((sessionExercise, index) =>
				buildSessionSeedSetRows(
					sessionExercise.id,
					workoutExercises[index].exercise,
					now,
					sessionId
				)
			)
		)
	).flat();

	await db.transaction(async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);

		if (sessionExerciseIds.length > 0) {
			const sessionSets = await db.sessionSets
				.where('sessionExerciseId')
				.anyOf(sessionExerciseIds)
				.toArray();

			if (sessionSets.length > 0) {
				await db.sessionSets.bulkDelete(sessionSets.map((sessionSet) => sessionSet.id));
			}

			await db.sessionExercises.bulkDelete(sessionExerciseIds);
		}

		if (nextSessionExercises.length > 0) {
			await db.sessionExercises.bulkAdd(nextSessionExercises);
		}

		if (nextSessionSets.length > 0) {
			await db.sessionSets.bulkAdd(nextSessionSets);
		}

		await db.workoutSessions.update(sessionId, { updatedAt: now });
	});

	clearSessionInputDraft(sessionId);
}
