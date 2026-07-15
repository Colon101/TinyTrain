import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';

const runtimeHarness = vi.hoisted(() => {
	type FailurePoint =
		| 'after-set-write'
		| 'before-parent-activity'
		| 'after-parent-resume'
		| 'during-exercise-shift';
	const state = {
		session: undefined as WorkoutSession | undefined,
		sessionSet: undefined as SessionSet | undefined,
		sessionExercises: [] as SessionExercise[],
		failurePoint: null as FailurePoint | null,
		exerciseApplyCounts: new Map<string, number>()
	};
	const db = {
		sessionSets: {
			get: vi.fn(async (id: string) =>
				state.sessionSet?.id === id ? { ...state.sessionSet } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<SessionSet>) => {
				if (!state.sessionSet || state.sessionSet.id !== id) {
					return 0;
				}

				state.sessionSet = { ...state.sessionSet, ...patch };

				if (state.failurePoint === 'after-set-write') {
					state.failurePoint = null;
					throw new Error('Injected failure after set write.');
				}

				return 1;
			})
		},
		sessionExercises: {
			get: vi.fn(async (id: string) => {
				const sessionExercise = state.sessionExercises.find((candidate) => candidate.id === id);
				return sessionExercise ? { ...sessionExercise } : undefined;
			}),
			update: vi.fn(async (id: string, patch: Partial<SessionExercise>) => {
				const index = state.sessionExercises.findIndex((candidate) => candidate.id === id);

				if (index < 0) {
					return 0;
				}

				if (state.failurePoint === 'during-exercise-shift' && id === 'session-exercise-2') {
					state.failurePoint = null;
					throw new Error('Injected failure during exercise shift.');
				}

				state.sessionExercises[index] = { ...state.sessionExercises[index], ...patch };
				state.exerciseApplyCounts.set(id, (state.exerciseApplyCounts.get(id) ?? 0) + 1);
				return 1;
			}),
			where: vi.fn(() => ({
				equals: () => ({
					toArray: async () => state.sessionExercises.map((row) => ({ ...row }))
				})
			}))
		},
		workoutSessions: {
			get: vi.fn(async (id: string) =>
				state.session?.id === id ? { ...state.session } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<WorkoutSession>) => {
				if (!state.session || state.session.id !== id) {
					return 0;
				}

				if (state.failurePoint === 'before-parent-activity') {
					state.failurePoint = null;
					throw new Error('Injected parent activity failure.');
				}

				state.session = { ...state.session, ...patch };

				if (state.failurePoint === 'after-parent-resume') {
					state.failurePoint = null;
					throw new Error('Injected failure after parent resume.');
				}

				return 1;
			})
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				throw new Error('Expected a transaction callback.');
			}

			return callback();
		})
	};

	return { db, state };
});

vi.mock('../runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn((callback) =>
		callback({ userId: 'user-1', generation: 1, database: runtimeHarness.db })
	)
}));
vi.mock('$app/environment', () => ({ browser: false }));

import { updateSessionSetInputs } from './inputs';

const activityAt = '2026-05-05T14:00:00.000Z';
const activityMs = Date.parse(activityAt);

function expectCoherentResumedGraph() {
	expect(runtimeHarness.state.sessionSet).toMatchObject({
		weightInput: '100',
		weight: 100,
		updatedAt: activityAt
	});
	expect(runtimeHarness.state.session).toMatchObject({
		status: 'in_progress',
		startedAt: '2026-05-05T13:30:00.000Z',
		completedAt: undefined,
		updatedAt: activityAt
	});
	expect(runtimeHarness.state.sessionExercises).toMatchObject([
		{ id: 'session-exercise-1', performedAt: '2026-05-05T13:40:00.000Z', updatedAt: activityAt },
		{ id: 'session-exercise-2', performedAt: '2026-05-05T13:50:00.000Z', updatedAt: activityAt }
	]);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(Date, 'now').mockReturnValue(activityMs);
	runtimeHarness.state.failurePoint = null;
	runtimeHarness.state.exerciseApplyCounts.clear();
	runtimeHarness.state.session = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Upper body',
		dayKey: '2026-05-05',
		startedAt: '2026-05-05T10:00:00.000Z',
		completedAt: '2026-05-05T10:30:00.000Z',
		status: 'abandoned',
		createdAt: '2026-05-05T10:00:00.000Z',
		updatedAt: '2026-05-05T10:30:00.000Z'
	};
	runtimeHarness.state.sessionExercises = [
		{
			id: 'session-exercise-1',
			sessionId: 'session-1',
			workoutId: 'workout-1',
			exerciseId: 'exercise-1',
			exerciseNameSnapshot: 'Bench press',
			order: 1,
			performedAt: '2026-05-05T10:10:00.000Z',
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T10:10:00.000Z'
		},
		{
			id: 'session-exercise-2',
			sessionId: 'session-1',
			workoutId: 'workout-1',
			exerciseId: 'exercise-2',
			exerciseNameSnapshot: 'Row',
			order: 2,
			performedAt: '2026-05-05T10:20:00.000Z',
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T10:20:00.000Z'
		}
	];
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
	vi.restoreAllMocks();
});

async function saveWeight() {
	return updateSessionSetInputs('set-1', 'weight', '100', {
		updatedAt: activityMs,
		baseValue: '95'
	});
}

describe('session input mutation recovery', () => {
	it('finishes metadata on retry when the set write committed before throwing', async () => {
		runtimeHarness.state.failurePoint = 'after-set-write';

		await expect(saveWeight()).rejects.toThrow('Injected failure after set write.');
		expect(runtimeHarness.state.sessionSet).toMatchObject({ weightInput: '100', weight: 100 });
		expect(runtimeHarness.state.session?.status).toBe('abandoned');

		await expect(saveWeight()).resolves.toMatchObject({ skipped: false });

		expectCoherentResumedGraph();
		expect(runtimeHarness.db.sessionSets.update).toHaveBeenCalledOnce();
	});

	it('finishes in-progress parent activity when its first update fails after the set write', async () => {
		runtimeHarness.state.session = {
			...runtimeHarness.state.session!,
			status: 'in_progress',
			completedAt: undefined
		};
		runtimeHarness.state.failurePoint = 'before-parent-activity';

		await expect(saveWeight()).rejects.toThrow('Injected parent activity failure.');
		await expect(saveWeight()).resolves.toMatchObject({ skipped: false });

		expect(runtimeHarness.state.sessionSet).toMatchObject({ weightInput: '100', weight: 100 });
		expect(runtimeHarness.state.session?.updatedAt).toBe(activityAt);
		expect(runtimeHarness.db.sessionSets.update).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.workoutSessions.update).toHaveBeenCalledTimes(2);
	});

	it('does not shift exercises twice when the parent resume committed before throwing', async () => {
		runtimeHarness.state.failurePoint = 'after-parent-resume';

		await expect(saveWeight()).rejects.toThrow('Injected failure after parent resume.');
		await expect(saveWeight()).resolves.toMatchObject({ skipped: false });

		expectCoherentResumedGraph();
		expect(runtimeHarness.state.exerciseApplyCounts).toEqual(
			new Map([
				['session-exercise-1', 1],
				['session-exercise-2', 1]
			])
		);
	});

	it('resumes a partial exercise shift without shifting an updated row twice', async () => {
		runtimeHarness.state.failurePoint = 'during-exercise-shift';

		await expect(saveWeight()).rejects.toThrow('Injected failure during exercise shift.');
		expect(runtimeHarness.state.session?.status).toBe('abandoned');
		expect(runtimeHarness.state.sessionExercises[0]).toMatchObject({
			performedAt: '2026-05-05T13:40:00.000Z',
			updatedAt: activityAt
		});
		expect(runtimeHarness.state.sessionExercises[1].performedAt).toBe('2026-05-05T10:20:00.000Z');

		await expect(saveWeight()).resolves.toMatchObject({ skipped: false });

		expectCoherentResumedGraph();
		expect(runtimeHarness.state.exerciseApplyCounts).toEqual(
			new Map([
				['session-exercise-1', 1],
				['session-exercise-2', 1]
			])
		);
	});
});
