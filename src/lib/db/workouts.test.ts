import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workout } from './models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		workouts: [] as Workout[],
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
	const db = {
		workouts,
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

import { createWorkout } from './workouts';

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.workouts = [];
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
