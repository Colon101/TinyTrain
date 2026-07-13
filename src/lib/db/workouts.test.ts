import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workout, WorkoutExercise } from './models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		workouts: [] as Workout[],
		workoutExercises: [] as WorkoutExercise[],
		transactionQueue: Promise.resolve() as Promise<unknown>
	};
	const workouts = {
		where: vi.fn(() => ({
			equals: (normalizedName: string) => ({
				first: async () => {
					await Promise.resolve();
					return state.workouts.find((workout) => workout.normalizedName === normalizedName);
				}
			})
		})),
		add: vi.fn(async (workout: Workout) => {
			state.workouts.push(workout);
			return workout.id;
		}),
		update: vi.fn(async (id: string, patch: Partial<Workout>) => {
			const index = state.workouts.findIndex((workout) => workout.id === id);

			if (index < 0) {
				return 0;
			}

			state.workouts[index] = { ...state.workouts[index], ...patch };
			return 1;
		})
	};
	const workoutExercises = {
		where: vi.fn(() => ({
			equals: (workoutId: string) => ({
				toArray: async () =>
					state.workoutExercises.filter(
						(workoutExercise) => workoutExercise.workoutId === workoutId
					)
			})
		})),
		bulkAdd: vi.fn(async (rows: WorkoutExercise[]) => {
			state.workoutExercises.push(...rows);
			return rows.map((row) => row.id);
		})
	};
	const db = {
		workouts,
		workoutExercises,
		transaction: vi.fn((_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1) as () => Promise<unknown>;
			const nextTransaction = state.transactionQueue.then(callback, callback);

			state.transactionQueue = nextTransaction.then(
				() => undefined,
				() => undefined
			);

			return nextTransaction;
		})
	};

	return { db, state };
});

vi.mock('./runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn()
}));

import { addExercisesToWorkout, createWorkout } from './workouts';

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.workouts = [];
	runtimeHarness.state.workoutExercises = [];
	runtimeHarness.state.transactionQueue = Promise.resolve();
});

describe('createWorkout', () => {
	it('serializes the duplicate guard with creation in the local database', async () => {
		const [first, second] = await Promise.all([
			createWorkout('Upper Body'),
			createWorkout('  upper   body  ')
		]);

		expect(first.id).toBe(second.id);
		expect(runtimeHarness.state.workouts).toHaveLength(1);
		expect(runtimeHarness.state.workouts[0]).toMatchObject({
			name: 'Upper Body',
			normalizedName: 'upper body'
		});
		expect(runtimeHarness.db.transaction).toHaveBeenCalledTimes(2);
	});
});

describe('addExercisesToWorkout', () => {
	it('adds the selected exercises atomically with stable sequential order', async () => {
		const existing: WorkoutExercise = {
			id: 'workout-exercise-existing',
			workoutId: 'workout-1',
			exerciseId: 'exercise-1',
			order: 3,
			createdAt: '2026-07-01T00:00:00.000Z',
			updatedAt: '2026-07-01T00:00:00.000Z'
		};
		runtimeHarness.state.workoutExercises = [existing];

		const rows = await addExercisesToWorkout('workout-1', [
			'exercise-1',
			'exercise-2',
			'exercise-2',
			'exercise-3'
		]);

		expect(rows.map((row) => [row.exerciseId, row.order])).toEqual([
			['exercise-1', 3],
			['exercise-2', 4],
			['exercise-3', 5]
		]);
		expect(runtimeHarness.db.workoutExercises.bulkAdd).toHaveBeenCalledOnce();
		expect(runtimeHarness.state.workoutExercises).toHaveLength(3);
		expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.workouts.update).toHaveBeenCalledOnce();
	});
});
