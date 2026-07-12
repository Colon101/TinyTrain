import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutSession } from '../models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		session: undefined as WorkoutSession | undefined
	};
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
			where: vi.fn(() => ({
				equals: () => ({ toArray: async () => [] })
			}))
		},
		sessionSets: {},
		workoutExercises: {},
		workouts: {},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1) as () => Promise<unknown>;
			return callback();
		})
	};

	return { db, state };
});

vi.mock('../runtime', () => ({
	canAttemptSessionCleanup: vi.fn(() => false),
	confirmSessionCleanupIsFresh: vi.fn(),
	db: runtimeHarness.db,
	ensureDbOpen: vi.fn(),
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: false })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	syncNow: vi.fn(),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('../session-drafts', () => ({ clearSessionInputDraft: vi.fn() }));
vi.mock('../workouts', () => ({
	listWorkoutExercises: vi.fn(),
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () => [])
}));
vi.mock('./inputs', () => ({ flushSessionInputDraft: vi.fn() }));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: vi.fn(),
	deleteWorkoutSessionRows: vi.fn(),
	ensureEditableSessionSeedRows: vi.fn()
}));

import { updateWorkoutSessionTiming } from './lifecycle';

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.session = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Upper body',
		dayKey: '2026-05-05',
		startedAt: '2026-05-05T10:00:00.000Z',
		completedAt: '2026-05-05T11:00:00.000Z',
		status: 'completed',
		createdAt: '2026-05-05T10:00:00.000Z',
		updatedAt: '2026-05-05T11:00:00.000Z'
	};
});

describe('updateWorkoutSessionTiming', () => {
	it('does not clear the end time while retaining completed status', async () => {
		await expect(
			updateWorkoutSessionTiming('session-1', '2026-05-05T09:30:00.000Z')
		).rejects.toThrow('End time is required for a completed session.');

		expect(runtimeHarness.db.transaction).not.toHaveBeenCalled();
		expect(runtimeHarness.state.session?.completedAt).toBe('2026-05-05T11:00:00.000Z');
	});
});
