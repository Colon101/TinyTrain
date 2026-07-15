import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		session: undefined as WorkoutSession | undefined,
		sessionExercise: undefined as SessionExercise | undefined,
		sessionSet: undefined as SessionSet | undefined
	};
	let transactionTail = Promise.resolve();

	const db = {
		workoutSessions: {
			get: vi.fn(async (id: string) =>
				state.session?.id === id ? { ...state.session } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<WorkoutSession>) => {
				if (!state.session || state.session.id !== id) {
					return 0;
				}

				state.session = { ...state.session, ...patch };
				return 1;
			})
		},
		sessionExercises: {
			get: vi.fn(async (id: string) =>
				state.sessionExercise?.id === id ? { ...state.sessionExercise } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<SessionExercise>) => {
				if (!state.sessionExercise || state.sessionExercise.id !== id) {
					return 0;
				}

				state.sessionExercise = { ...state.sessionExercise, ...patch };
				return 1;
			}),
			where: vi.fn(() => ({
				equals: () => ({
					toArray: async () => (state.sessionExercise ? [{ ...state.sessionExercise }] : [])
				})
			}))
		},
		sessionSets: {
			get: vi.fn(async (id: string) =>
				state.sessionSet?.id === id ? { ...state.sessionSet } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<SessionSet>) => {
				if (!state.sessionSet || state.sessionSet.id !== id) {
					return 0;
				}

				state.sessionSet = { ...state.sessionSet, ...patch };
				return 1;
			}),
			where: vi.fn(() => ({
				anyOf: () => ({
					toArray: async () => (state.sessionSet ? [{ ...state.sessionSet }] : [])
				})
			}))
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				throw new Error('Expected a transaction callback.');
			}

			const previousTransaction = transactionTail;
			let finishTransaction!: () => void;
			transactionTail = new Promise<void>((resolve) => {
				finishTransaction = resolve;
			});
			await previousTransaction;

			try {
				return await callback();
			} finally {
				finishTransaction();
			}
		})
	};

	return {
		db,
		resetTransactionQueue: () => {
			transactionTail = Promise.resolve();
		},
		state
	};
});

vi.mock('../runtime', () => ({
	canAttemptSessionCleanup: vi.fn(() => true),
	confirmSessionCleanupIsFresh: vi.fn(async () => true),
	db: runtimeHarness.db,
	ensureDbOpen: vi.fn(),
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: 'user-1' })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn(async (callback) =>
		callback({ userId: 'user-1', generation: 1, database: runtimeHarness.db })
	),
	syncNow: vi.fn(async () => undefined),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('../workouts', () => ({
	listWorkoutExercises: vi.fn(),
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () =>
		runtimeHarness.state.sessionExercise && runtimeHarness.state.sessionSet
			? [
					{
						...runtimeHarness.state.sessionExercise,
						sets: [{ ...runtimeHarness.state.sessionSet }]
					}
				]
			: []
	)
}));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: vi.fn(),
	deleteWorkoutSessionRows: vi.fn(),
	ensureEditableSessionSeedRows: vi.fn()
}));

import { updateSessionSetInputs } from './inputs';
import { abandonStoredInactiveSession } from './lifecycle';

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.resetTransactionQueue();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-05-05T14:00:00.000Z'));
	runtimeHarness.state.session = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Upper body',
		dayKey: '2026-05-05',
		startedAt: '2026-05-05T10:00:00.000Z',
		status: 'in_progress',
		createdAt: '2026-05-05T10:00:00.000Z',
		updatedAt: '2026-05-05T10:30:00.000Z'
	};
	runtimeHarness.state.sessionExercise = {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'exercise-1',
		exerciseNameSnapshot: 'Bench press',
		order: 1,
		performedAt: '2026-05-05T10:10:00.000Z',
		createdAt: '2026-05-05T10:00:00.000Z',
		updatedAt: '2026-05-05T10:10:00.000Z'
	};
	runtimeHarness.state.sessionSet = {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput: '95',
		weight: 95,
		createdAt: '2026-05-05T10:00:00.000Z',
		updatedAt: '2026-05-05T10:30:00.000Z'
	};
});

afterEach(() => {
	vi.useRealTimers();
});

describe('inactive session revival', () => {
	it('excludes inactive hours when a queued live input commits after abandonment', async () => {
		const nowMs = Date.now();
		const abandonPromise = abandonStoredInactiveSession('session-1', nowMs);
		const liveInputPromise = updateSessionSetInputs('set-1', 'weight', '100', {
			updatedAt: nowMs,
			baseValue: '95'
		});

		expect(runtimeHarness.db.transaction).toHaveBeenCalledTimes(2);
		await expect(abandonPromise).resolves.toBe(true);
		await expect(liveInputPromise).resolves.toMatchObject({ skipped: false });

		expect(runtimeHarness.state.session).toMatchObject({
			status: 'in_progress',
			startedAt: '2026-05-05T13:30:00.000Z',
			completedAt: undefined,
			updatedAt: '2026-05-05T14:00:00.000Z'
		});
		expect(runtimeHarness.state.sessionExercise).toMatchObject({
			performedAt: '2026-05-05T13:40:00.000Z',
			updatedAt: '2026-05-05T14:00:00.000Z'
		});
		expect(runtimeHarness.state.sessionSet).toMatchObject({
			weightInput: '100',
			weight: 100,
			updatedAt: '2026-05-05T14:00:00.000Z'
		});
		expect(nowMs - new Date(runtimeHarness.state.session!.startedAt!).getTime()).toBe(
			30 * 60 * 1_000
		);
	});
});
