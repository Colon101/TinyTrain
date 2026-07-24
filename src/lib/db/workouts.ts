import type { Workout, WorkoutExercise, WorkoutExerciseWithExercise } from './models';
import { db, requireLoggedInUser } from './runtime';
import {
	compareOptionalRecency,
	createId,
	displayName,
	getWorkoutSessionRecencyTimestamp,
	isDefined,
	normalizeName,
	timestamp,
	withExerciseDefaults
} from './shared';

export async function listWorkouts() {
	const workouts = await db.workouts.toArray();

	return workouts
		.filter((workout) => !workout.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listWorkoutSchedulingOptions() {
	const [workouts, sessions] = await Promise.all([listWorkouts(), db.workoutSessions.toArray()]);
	const latestSessionAtByWorkoutId = new Map<string, string>();

	for (const session of sessions) {
		if (session.status === 'planned') {
			continue;
		}

		const sessionAt = getWorkoutSessionRecencyTimestamp(session);
		const currentValue = latestSessionAtByWorkoutId.get(session.workoutId);

		if (!currentValue || currentValue < sessionAt) {
			latestSessionAtByWorkoutId.set(session.workoutId, sessionAt);
		}
	}

	return workouts.sort(
		(first, second) =>
			compareOptionalRecency(
				latestSessionAtByWorkoutId.get(first.id),
				latestSessionAtByWorkoutId.get(second.id)
			) || first.name.localeCompare(second.name)
	);
}

export async function createWorkout(name: string) {
	requireLoggedInUser();

	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Workout name is required.');
	}

	return db.transaction<Workout>(async () => {
		const existingWorkout = await db.workouts
			.where('normalizedName')
			.equals(normalizedName)
			.first();

		if (existingWorkout) {
			if (existingWorkout.archived) {
				const updatedAt = timestamp();
				await db.workouts.update(existingWorkout.id, { archived: false, updatedAt });

				return { ...existingWorkout, archived: false, updatedAt };
			}

			return existingWorkout;
		}

		const now = timestamp();
		const workout: Workout = {
			id: createId(),
			name: cleanName,
			normalizedName,
			archived: false,
			createdAt: now,
			updatedAt: now
		};

		await db.workouts.add(workout);

		return workout;
	});
}

export async function listWorkoutExercises(workoutId: string) {
	const workoutExerciseRows = await db.workoutExercises
		.where('workoutId')
		.equals(workoutId)
		.sortBy('order');
	const exercises = await db.exercises.bulkGet(
		workoutExerciseRows.map((workoutExercise) => workoutExercise.exerciseId)
	);
	const exerciseById = new Map(
		exercises
			.filter(isDefined)
			.map((exercise) => withExerciseDefaults(exercise))
			.map((exercise) => [exercise.id, exercise])
	);

	return workoutExerciseRows
		.map<WorkoutExerciseWithExercise | null>((workoutExercise) => {
			const exercise = exerciseById.get(workoutExercise.exerciseId);

			if (!exercise || exercise.archived) {
				return null;
			}

			return { ...workoutExercise, exercise };
		})
		.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
			Boolean(workoutExercise)
		);
}

export async function addExercisesToWorkout(workoutId: string, exerciseIds: string[]) {
	requireLoggedInUser();
	const uniqueExerciseIds = [...new Set(exerciseIds)];

	if (uniqueExerciseIds.length === 0) {
		return [];
	}

	return db.transaction<WorkoutExercise[]>(async () => {
		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const workoutExerciseByExerciseId = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
		);
		let nextOrder =
			workoutExercises.reduce(
				(highestOrder, workoutExercise) => Math.max(highestOrder, workoutExercise.order),
				0
			) + 1;
		const now = timestamp();
		const workoutExercisesToAdd = uniqueExerciseIds.flatMap((exerciseId) => {
			if (workoutExerciseByExerciseId.has(exerciseId)) {
				return [];
			}

			const workoutExercise: WorkoutExercise = {
				id: createId(),
				workoutId,
				exerciseId,
				order: nextOrder,
				createdAt: now,
				updatedAt: now
			};
			nextOrder += 1;
			workoutExerciseByExerciseId.set(exerciseId, workoutExercise);
			return [workoutExercise];
		});

		if (workoutExercisesToAdd.length > 0) {
			await db.workoutExercises.bulkAdd(workoutExercisesToAdd);
			await db.workouts.update(workoutId, { updatedAt: now });
		}

		return uniqueExerciseIds.flatMap((exerciseId) => {
			const workoutExercise = workoutExerciseByExerciseId.get(exerciseId);
			return workoutExercise ? [workoutExercise] : [];
		});
	});
}

export async function syncWorkoutExercisesFromSession(sessionId: string, now = timestamp()) {
	const session = await db.workoutSessions.get(sessionId);

	if (!session) {
		return;
	}

	const [sessionExercises, workoutExercises] = await Promise.all([
		db.sessionExercises.where('sessionId').equals(sessionId).sortBy('order'),
		db.workoutExercises.where('workoutId').equals(session.workoutId).toArray()
	]);
	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exerciseId, workoutExercise])
	);
	const sessionExerciseIdSet = new Set(
		sessionExercises.map((sessionExercise) => sessionExercise.exerciseId)
	);
	const workoutExerciseIdsToDelete = workoutExercises
		.filter((workoutExercise) => !sessionExerciseIdSet.has(workoutExercise.exerciseId))
		.map((workoutExercise) => workoutExercise.id);
	const nextWorkoutExercises = sessionExercises.map((sessionExercise, index) => {
		const existingWorkoutExercise = workoutExerciseByExerciseId.get(sessionExercise.exerciseId);

		return {
			id: existingWorkoutExercise?.id ?? createId(),
			workoutId: session.workoutId,
			exerciseId: sessionExercise.exerciseId,
			order: index + 1,
			createdAt: existingWorkoutExercise?.createdAt ?? now,
			updatedAt: now
		} satisfies WorkoutExercise;
	});

	if (workoutExerciseIdsToDelete.length > 0) {
		await db.workoutExercises.bulkDelete(workoutExerciseIdsToDelete);
	}

	if (nextWorkoutExercises.length > 0) {
		await db.workoutExercises.bulkPut(nextWorkoutExercises);
	}

	await db.workouts.update(session.workoutId, { updatedAt: now });
}

export async function reorderWorkoutExercises(
	workoutId: string,
	orderedWorkoutExerciseIds: string[]
) {
	requireLoggedInUser();

	await db.transaction(async () => {
		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const workoutExerciseById = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
		);
		const orderedIds = orderedWorkoutExerciseIds.filter((id) => workoutExerciseById.has(id));
		const orderedIdSet = new Set(orderedIds);
		const missingIds = workoutExercises
			.filter((workoutExercise) => !orderedIdSet.has(workoutExercise.id))
			.sort((first, second) => first.order - second.order)
			.map((workoutExercise) => workoutExercise.id);
		const nextIds = [...orderedIds, ...missingIds];
		const now = timestamp();

		await Promise.all(
			nextIds.map((id, index) =>
				db.workoutExercises.update(id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutId, { updatedAt: now });
	});
}

export async function removeWorkoutExercise(workoutExerciseId: string) {
	requireLoggedInUser();

	await db.transaction(async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const now = timestamp();

		await db.workoutExercises.delete(workoutExerciseId);

		const remainingWorkoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');

		await Promise.all(
			remainingWorkoutExercises.map((remainingWorkoutExercise, index) =>
				db.workoutExercises.update(remainingWorkoutExercise.id, {
					order: index + 1,
					updatedAt: now
				})
			)
		);
		await db.workouts.update(workoutExercise.workoutId, { updatedAt: now });
	});
}
