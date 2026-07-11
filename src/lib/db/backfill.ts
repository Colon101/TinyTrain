import { ensureBaselineExercises, getPreferredExerciseByNormalizedNames } from './exercises';
import type {
	BackfillSeedResult,
	BackfillWorkoutSessionInput,
	SessionExercise,
	SessionSet,
	WorkoutExerciseWithExercise,
	WorkoutSession
} from './models';
import { db, requireLoggedInUser, syncNow } from './runtime';
import {
	createId,
	isDefined,
	normalizeName,
	normalizeSessionSetSide,
	summarizeSession,
	timestamp,
	toCleanSessionInputValue,
	toDayKey,
	toParsedInputValue,
	toStoredInputValue
} from './shared';
import { addExerciseToWorkout, createWorkout, listWorkoutExercises } from './workouts';

const EXAMPLE_WORKOUT_NAME = 'Upper Builder Demo';
const EXAMPLE_EXERCISE_NAMES = ['Barbell Bench Press', 'Wide Grip Pull-up', 'Cable Lateral Raise'];

export function toBackfillSessionDate(dayKey: string, timeValue: string) {
	const cleanDayKey = dayKey.trim();
	const cleanTimeValue = timeValue.trim() || '12:00';
	const date = new Date(`${cleanDayKey}T${cleanTimeValue}`);

	if (!cleanDayKey || Number.isNaN(date.getTime())) {
		throw new Error('Choose a valid backfill date.');
	}

	return date;
}

export async function createBackfillWorkoutSession(input: BackfillWorkoutSessionInput) {
	requireLoggedInUser();

	const workout = await db.workouts.get(input.workoutId);

	if (!workout || workout.archived) {
		throw new Error('Workout not found.');
	}

	const workoutExercises = await listWorkoutExercises(workout.id);

	if (workoutExercises.length === 0) {
		throw new Error('Add exercises to this workout before backfilling it.');
	}

	const workoutExerciseByExerciseId = new Map(
		workoutExercises.map((workoutExercise) => [workoutExercise.exercise.id, workoutExercise])
	);
	const includedExercises = input.exercises
		.map((entry) => ({
			...entry,
			workoutExercise: workoutExerciseByExerciseId.get(entry.exerciseId) ?? null,
			sets: entry.sets.filter(
				(set) => set.weightInput?.trim() || set.repsInput?.trim() || set.rirInput?.trim()
			)
		}))
		.filter((entry) => entry.workoutExercise && entry.sets.length > 0);

	if (includedExercises.length === 0) {
		throw new Error('Log at least one set before saving.');
	}

	const startedAtDate = toBackfillSessionDate(input.dayKey, input.startTime);
	const durationMinutes =
		Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
			? input.durationMinutes
			: 60;
	const completedAtDate = new Date(startedAtDate.getTime() + durationMinutes * 60 * 1000);
	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey: toDayKey(startedAtDate),
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};
	const sessionExercises: SessionExercise[] = includedExercises.map((entry, index) => {
		const workoutExercise = entry.workoutExercise as WorkoutExerciseWithExercise;

		return {
			id: createId(),
			sessionId,
			workoutId: workout.id,
			exerciseId: workoutExercise.exercise.id,
			exerciseNameSnapshot: workoutExercise.exercise.name,
			order: index + 1,
			performedAt: timestamp(new Date(startedAtDate.getTime() + index * 8 * 60 * 1000)),
			createdAt: startedAt,
			updatedAt: completedAt
		};
	});
	const sessionSets: SessionSet[] = sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
		includedExercises[exerciseIndex].sets.map((set, setIndex) => {
			const weightInput = toCleanSessionInputValue(set.weightInput ?? '', 'weight');
			const repsInput = toCleanSessionInputValue(set.repsInput ?? '', 'reps');
			const rirInput = toCleanSessionInputValue(set.rirInput ?? '', 'rir');

			return {
				id: createId(),
				sessionExerciseId: sessionExercise.id,
				exerciseId: sessionExercise.exerciseId,
				order:
					typeof set.order === 'number' && Number.isFinite(set.order) && set.order > 0
						? set.order
						: setIndex + 1,
				side: normalizeSessionSetSide(set.side),
				weightInput,
				repsInput,
				rirInput,
				weight: toParsedInputValue(weightInput, 'weight'),
				reps: toParsedInputValue(repsInput, 'reps'),
				rir: toParsedInputValue(rirInput, 'rir'),
				createdAt: timestamp(
					new Date(startedAtDate.getTime() + (exerciseIndex * 8 + setIndex * 3) * 60 * 1000)
				),
				updatedAt: completedAt
			};
		})
	);

	await db.transaction(
		'rw',
		db.workoutSessions,
		db.sessionExercises,
		db.sessionSets,
		db.workouts,
		async () => {
			await db.workoutSessions.add(session);
			await db.sessionExercises.bulkAdd(sessionExercises);
			await db.sessionSets.bulkAdd(sessionSets);
			await db.workouts.update(workout.id, { updatedAt: timestamp() });
		}
	);

	void syncNow().catch((error) => {
		console.warn('Background Supabase sync failed.', error);
	});

	return summarizeSession(session, sessionExercises, sessionSets);
}

export function createExampleStartedAt(daysAgo: number, hours: number, minutes: number) {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hours, minutes, 0, 0);

	return date;
}

export type ExampleSetSeed = Pick<SessionSet, 'weight' | 'reps' | 'rir'>;

export type ExampleSessionSeed = {
	daysAgo: number;
	startedAt: {
		hours: number;
		minutes: number;
	};
	completedAt: {
		hours: number;
		minutes: number;
	};
	setsByExercise: ExampleSetSeed[][];
};

const EXAMPLE_BASELINE_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 60, reps: 8, rir: 2 },
		{ weight: 65, reps: 8, rir: 1 },
		{ weight: 67.5, reps: 6, rir: 1 }
	],
	[
		{ reps: 10, rir: 2 },
		{ reps: 9, rir: 1 },
		{ reps: 8, rir: 1 }
	],
	[
		{ weight: 10, reps: 15, rir: 2 },
		{ weight: 12.5, reps: 12, rir: 1 },
		{ weight: 12.5, reps: 12, rir: 1 }
	]
];

const EXAMPLE_IMPROVEMENT_SETS: ExampleSetSeed[][] = [
	[
		{ weight: 62.5, reps: 8, rir: 2 },
		{ weight: 67.5, reps: 8, rir: 1 },
		{ weight: 70, reps: 6, rir: 1 }
	],
	[
		{ reps: 11, rir: 2 },
		{ reps: 10, rir: 1 },
		{ weight: 2.5, reps: 8, rir: 1 }
	],
	[
		{ weight: 12.5, reps: 15, rir: 2 },
		{ weight: 15, reps: 12, rir: 1 },
		{ weight: 15, reps: 12, rir: 1 }
	]
];

export async function listExampleBaselineExercises() {
	const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
		EXAMPLE_EXERCISE_NAMES.map((name) => normalizeName(name))
	);

	return EXAMPLE_EXERCISE_NAMES.map((name) =>
		preferredExerciseByNormalizedName.get(normalizeName(name))
	).filter(isDefined);
}

export async function normalizeExampleSessionExerciseIds(sessionId: string) {
	const now = timestamp();

	await db.transaction('rw', db.exercises, db.sessionExercises, db.sessionSets, async () => {
		const sessionExercises = await db.sessionExercises
			.where('sessionId')
			.equals(sessionId)
			.toArray();
		const preferredExerciseByNormalizedName = await getPreferredExerciseByNormalizedNames(
			sessionExercises.map((sessionExercise) => normalizeName(sessionExercise.exerciseNameSnapshot))
		);
		const exerciseIdsBySessionExerciseId = new Map(
			sessionExercises.flatMap((sessionExercise) => {
				const preferredExercise = preferredExerciseByNormalizedName.get(
					normalizeName(sessionExercise.exerciseNameSnapshot)
				);

				return preferredExercise ? ([[sessionExercise.id, preferredExercise.id]] as const) : [];
			})
		);

		for (const sessionExercise of sessionExercises) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionExercise.id);

			if (!nextExerciseId || sessionExercise.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionExercises.update(sessionExercise.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}

		if (sessionExercises.length === 0) {
			return;
		}

		const sessionExerciseIds = sessionExercises.map((sessionExercise) => sessionExercise.id);
		const sessionSets = await db.sessionSets
			.where('sessionExerciseId')
			.anyOf(sessionExerciseIds)
			.toArray();

		for (const sessionSet of sessionSets) {
			const nextExerciseId = exerciseIdsBySessionExerciseId.get(sessionSet.sessionExerciseId);

			if (!nextExerciseId || sessionSet.exerciseId === nextExerciseId) {
				continue;
			}

			await db.sessionSets.update(sessionSet.id, {
				exerciseId: nextExerciseId,
				updatedAt: now
			});
		}
	});
}

export async function ensureExampleWorkoutSetup() {
	requireLoggedInUser();

	await ensureBaselineExercises();

	const workout = await createWorkout(EXAMPLE_WORKOUT_NAME);
	const exercises = await listExampleBaselineExercises();

	for (const exercise of exercises) {
		await addExerciseToWorkout(workout.id, exercise.id);
	}

	return {
		workout,
		exercises
	};
}

export async function seedExampleSession(seed: ExampleSessionSeed): Promise<BackfillSeedResult> {
	const { workout, exercises } = await ensureExampleWorkoutSetup();
	const startedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.startedAt.hours,
		seed.startedAt.minutes
	);
	const completedAtDate = createExampleStartedAt(
		seed.daysAgo,
		seed.completedAt.hours,
		seed.completedAt.minutes
	);
	const dayKey = toDayKey(startedAtDate);
	const existingSession = (await db.workoutSessions.where('dayKey').equals(dayKey).toArray()).find(
		(session) => session.workoutId === workout.id && session.workoutNameSnapshot === workout.name
	);

	if (existingSession) {
		await normalizeExampleSessionExerciseIds(existingSession.id);

		return {
			workoutId: workout.id,
			sessionId: existingSession.id,
			created: false
		};
	}

	const startedAt = timestamp(startedAtDate);
	const completedAt = timestamp(completedAtDate);
	const sessionId = createId();
	const session: WorkoutSession = {
		id: sessionId,
		workoutId: workout.id,
		workoutNameSnapshot: workout.name,
		dayKey,
		startedAt,
		completedAt,
		status: 'completed',
		createdAt: startedAt,
		updatedAt: completedAt
	};

	const sessionExercises: SessionExercise[] = exercises.map((exercise, index) => ({
		id: createId(),
		sessionId,
		workoutId: workout.id,
		exerciseId: exercise.id,
		exerciseNameSnapshot: exercise.name,
		order: index + 1,
		performedAt: timestamp(new Date(startedAtDate.getTime() + index * 12 * 60 * 1000)),
		createdAt: startedAt,
		updatedAt: completedAt
	}));

	const sessionSets: SessionSet[] = sessionExercises.flatMap((sessionExercise, exerciseIndex) =>
		(seed.setsByExercise[exerciseIndex] ?? []).map((set, setIndex) => ({
			id: createId(),
			sessionExerciseId: sessionExercise.id,
			exerciseId: sessionExercise.exerciseId,
			order: setIndex + 1,
			side: 'bilateral' as const,
			weightInput: toStoredInputValue(undefined, set.weight),
			repsInput: toStoredInputValue(undefined, set.reps),
			rirInput: toStoredInputValue(undefined, set.rir),
			weight: set.weight,
			reps: set.reps,
			rir: set.rir,
			createdAt: timestamp(
				new Date(startedAtDate.getTime() + (exerciseIndex * 12 + setIndex * 3) * 60 * 1000)
			),
			updatedAt: completedAt
		}))
	);

	await db.transaction('rw', db.workoutSessions, db.sessionExercises, db.sessionSets, async () => {
		await db.workoutSessions.add(session);
		await db.sessionExercises.bulkAdd(sessionExercises);
		await db.sessionSets.bulkAdd(sessionSets);
	});

	return {
		workoutId: workout.id,
		sessionId,
		created: true
	};
}

export async function seedExampleBackfill(): Promise<BackfillSeedResult> {
	return seedExampleSession({
		daysAgo: 2,
		startedAt: {
			hours: 18,
			minutes: 10
		},
		completedAt: {
			hours: 18,
			minutes: 58
		},
		setsByExercise: EXAMPLE_BASELINE_SETS
	});
}

export async function seedImprovedBackfill(): Promise<BackfillSeedResult> {
	await seedExampleBackfill();

	return seedExampleSession({
		daysAgo: 1,
		startedAt: {
			hours: 18,
			minutes: 12
		},
		completedAt: {
			hours: 19,
			minutes: 1
		},
		setsByExercise: EXAMPLE_IMPROVEMENT_SETS
	});
}
