import Dexie, { type Table } from 'dexie';
import { BASELINE_EXERCISES } from './exercises';
export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';

export interface Exercise {
	id: string;
	name: string;
	normalizedName: string;
	unilateral: boolean;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Workout {
	id: string;
	name: string;
	normalizedName: string;
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutExercise {
	id: string;
	workoutId: string;
	exerciseId: string;
	order: number;
	createdAt: string;
	updatedAt: string;
}

export interface WorkoutSession {
	id: string;
	workoutId: string;
	workoutNameSnapshot: string;
	startedAt: string;
	completedAt?: string;
	status: SessionStatus;
	createdAt: string;
	updatedAt: string;
}

export interface SessionExercise {
	id: string;
	sessionId: string;
	workoutId: string;
	exerciseId: string;
	exerciseNameSnapshot: string;
	order: number;
	performedAt: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionSet {
	id: string;
	sessionExerciseId: string;
	exerciseId: string;
	order: number;
	weight: number;
	reps: number;
	createdAt: string;
	updatedAt: string;
}

export type WorkoutExerciseWithExercise = WorkoutExercise & {
	exercise: Exercise;
};

const STORES = {
	exercises: '&id, &normalizedName, archived, updatedAt',
	workouts: '&id, &normalizedName, archived, updatedAt',
	workoutExercises: '&id, workoutId, exerciseId, [workoutId+order], [workoutId+exerciseId]',
	workoutSessions: '&id, workoutId, startedAt, completedAt, status, [workoutId+startedAt]',
	sessionExercises:
		'&id, sessionId, workoutId, exerciseId, performedAt, [sessionId+order], [exerciseId+performedAt], [workoutId+performedAt]',
	sessionSets:
		'&id, sessionExerciseId, exerciseId, createdAt, [sessionExerciseId+order], [exerciseId+createdAt]'
};

class TinyTrainDatabase extends Dexie {
	exercises!: Table<Exercise, string>;
	workouts!: Table<Workout, string>;
	workoutExercises!: Table<WorkoutExercise, string>;
	workoutSessions!: Table<WorkoutSession, string>;
	sessionExercises!: Table<SessionExercise, string>;
	sessionSets!: Table<SessionSet, string>;

	constructor() {
		super('tinytrain');

		this.version(1).stores(STORES);
		this.version(2)
			.stores(STORES)
			.upgrade((transaction) => {
				return transaction
					.table('exercises')
					.toCollection()
					.modify((exercise) => {
						exercise.unilateral = Boolean(exercise.unilateral);
					});
			});
	}
}

export const db = new TinyTrainDatabase();

function withExerciseDefaults(exercise: Exercise): Exercise {
	return {
		...exercise,
		unilateral: Boolean(exercise.unilateral)
	};
}

function createId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function timestamp() {
	return new Date().toISOString();
}

export function normalizeName(name: string) {
	return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function displayName(name: string) {
	return name.trim().replace(/\s+/g, ' ');
}

function createExerciseRow(name: string, unilateral = false, now = timestamp()): Exercise {
	const cleanName = displayName(name);

	return {
		id: createId(),
		name: cleanName,
		unilateral,
		normalizedName: normalizeName(cleanName),
		archived: false,
		createdAt: now,
		updatedAt: now
	};
}

export async function ensureBaselineExercises() {
	const baselineExerciseByNormalizedName = new Map(
		BASELINE_EXERCISES.map((exercise) => [normalizeName(exercise.name), exercise])
	);
	const normalizedNames = [...baselineExerciseByNormalizedName.keys()];
	const existingExercises = await db.exercises
		.where('normalizedName')
		.anyOf(normalizedNames)
		.toArray();
	const existingNames = new Set(existingExercises.map((exercise) => exercise.normalizedName));
	const now = timestamp();
	const missingExercises = [...baselineExerciseByNormalizedName.values()]
		.filter((exercise) => !existingNames.has(normalizeName(exercise.name)))
		.map((exercise) => createExerciseRow(exercise.name, exercise.unilateral, now));

	if (missingExercises.length > 0) {
		await db.exercises.bulkAdd(missingExercises);
	}
}

export async function listExercises() {
	const exercises = await db.exercises.toArray();

	return exercises
		.map(withExerciseDefaults)
		.filter((exercise) => !exercise.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function createExercise(name: string, unilateral = false) {
	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Exercise name is required.');
	}

	const existingExercise = await db.exercises
		.where('normalizedName')
		.equals(normalizedName)
		.first();

	if (existingExercise) {
		if (existingExercise.archived) {
			const updatedAt = timestamp();
			await db.exercises.update(existingExercise.id, {
				archived: false,
				unilateral,
				updatedAt
			});

			return { ...existingExercise, archived: false, unilateral, updatedAt };
		}

		return withExerciseDefaults(existingExercise);
	}

	const exercise = createExerciseRow(cleanName, unilateral);
	await db.exercises.add(exercise);

	return exercise;
}

export async function listWorkouts() {
	const workouts = await db.workouts.toArray();

	return workouts
		.filter((workout) => !workout.archived)
		.sort((first, second) => first.name.localeCompare(second.name));
}

export async function createWorkout(name: string) {
	const cleanName = displayName(name);
	const normalizedName = normalizeName(cleanName);

	if (!normalizedName) {
		throw new Error('Workout name is required.');
	}

	const existingWorkout = await db.workouts.where('normalizedName').equals(normalizedName).first();

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
			.filter((exercise): exercise is Exercise => Boolean(exercise))
			.map((exercise) => withExerciseDefaults(exercise))
			.map((exercise) => [exercise.id, exercise])
	);

	return workoutExerciseRows
		.map((workoutExercise) => {
			const exercise = exerciseById.get(workoutExercise.exerciseId);

			if (!exercise || exercise.archived) {
				return undefined;
			}

			return { ...workoutExercise, exercise };
		})
		.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
			Boolean(workoutExercise)
		);
}

export async function addExerciseToWorkout(workoutId: string, exerciseId: string) {
	return db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const existingWorkoutExercise = await db.workoutExercises
			.where('[workoutId+exerciseId]')
			.equals([workoutId, exerciseId])
			.first();

		if (existingWorkoutExercise) {
			return existingWorkoutExercise;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutId)
			.toArray();
		const nextOrder =
			workoutExercises.reduce(
				(highestOrder, workoutExercise) => Math.max(highestOrder, workoutExercise.order),
				0
			) + 1;
		const now = timestamp();
		const workoutExercise: WorkoutExercise = {
			id: createId(),
			workoutId,
			exerciseId,
			order: nextOrder,
			createdAt: now,
			updatedAt: now
		};

		await db.workoutExercises.add(workoutExercise);
		await db.workouts.update(workoutId, { updatedAt: now });

		return workoutExercise;
	});
}

export async function reorderWorkoutExercises(
	workoutId: string,
	orderedWorkoutExerciseIds: string[]
) {
	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
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

export async function moveWorkoutExercise(workoutExerciseId: string, direction: 'up' | 'down') {
	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
		const workoutExercise = await db.workoutExercises.get(workoutExerciseId);

		if (!workoutExercise) {
			return;
		}

		const workoutExercises = await db.workoutExercises
			.where('workoutId')
			.equals(workoutExercise.workoutId)
			.sortBy('order');
		const currentIndex = workoutExercises.findIndex((row) => row.id === workoutExerciseId);
		const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

		if (currentIndex < 0 || targetIndex < 0 || targetIndex >= workoutExercises.length) {
			return;
		}

		const currentRow = workoutExercises[currentIndex];
		const targetRow = workoutExercises[targetIndex];
		const now = timestamp();

		await Promise.all([
			db.workoutExercises.update(currentRow.id, { order: targetRow.order, updatedAt: now }),
			db.workoutExercises.update(targetRow.id, { order: currentRow.order, updatedAt: now }),
			db.workouts.update(workoutExercise.workoutId, { updatedAt: now })
		]);
	});
}

export async function removeWorkoutExercise(workoutExerciseId: string) {
	await db.transaction('rw', db.workoutExercises, db.workouts, async () => {
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
