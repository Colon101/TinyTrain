import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';

const maintenanceHarness = vi.hoisted(() => {
	const state = {
		sessions: [] as WorkoutSession[],
		sessionExercises: [] as SessionExercise[],
		sessionSets: [] as SessionSet[]
	};
	const deleteWorkoutSessionRows = vi.fn();
	const db = {
		workoutSessions: {
			get: vi.fn(async (id: string) => state.sessions.find((session) => session.id === id)),
			update: vi.fn(async () => 0),
			delete: vi.fn(),
			where: vi.fn((field: keyof WorkoutSession) => ({
				equals: (value: unknown) => ({
					toArray: async () => state.sessions.filter((session) => session[field] === value)
				})
			}))
		},
		sessionExercises: {
			bulkDelete: vi.fn(),
			where: vi.fn(() => ({
				equals: () => ({ toArray: async () => [] })
			}))
		},
		sessionSets: {
			bulkDelete: vi.fn()
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback !== 'function') throw new Error('Missing transaction callback.');
			return callback();
		})
	};

	return { db, deleteWorkoutSessionRows, state };
});

vi.mock('../runtime', () => ({
	canAttemptSessionCleanup: vi.fn(() => true),
	confirmSessionCleanupIsFresh: vi.fn(async () => true),
	db: maintenanceHarness.db,
	ensureDbOpen: vi.fn(),
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: 'user-1' })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn(async (callback) =>
		callback({ userId: 'user-1', generation: 1, database: maintenanceHarness.db })
	),
	syncNow: vi.fn(async () => undefined),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('../workouts', () => ({
	listWorkoutExercises: vi.fn(),
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('../session-drafts', () => ({ clearSessionInputDraft: vi.fn() }));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () => [])
}));
vi.mock('./inputs', () => ({
	flushSessionInputDraft: vi.fn(),
	flushSessionInputDraftWithDatabase: vi.fn()
}));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: vi.fn(),
	deleteWorkoutSessionRows: maintenanceHarness.deleteWorkoutSessionRows,
	ensureEditableSessionSeedRows: vi.fn()
}));

import { cleanupStaleSessions } from './lifecycle';

beforeEach(() => {
	vi.clearAllMocks();
	const createdAt = '2026-07-14T08:00:00.000Z';
	maintenanceHarness.state.sessions = [
		{
			id: 'offline-planned-session',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Upper body',
			dayKey: '2026-07-14',
			status: 'planned',
			createdAt,
			updatedAt: createdAt
		}
	];
	maintenanceHarness.state.sessionExercises = [
		{
			id: 'offline-session-exercise',
			sessionId: 'offline-planned-session',
			workoutId: 'workout-1',
			exerciseId: 'exercise-1',
			exerciseNameSnapshot: 'Bench press',
			order: 1,
			performedAt: createdAt,
			createdAt,
			updatedAt: createdAt
		}
	];
	maintenanceHarness.state.sessionSets = [
		{
			id: 'offline-session-set',
			sessionExerciseId: 'offline-session-exercise',
			exerciseId: 'exercise-1',
			order: 1,
			side: 'bilateral',
			weightInput: '',
			repsInput: '',
			rirInput: '',
			createdAt,
			updatedAt: createdAt
		}
	];
});

describe('cleanupStaleSessions', () => {
	it('never tombstones a prior-day planned graph during maintenance', async () => {
		const before = structuredClone(maintenanceHarness.state);

		await cleanupStaleSessions('2026-07-15');

		expect(maintenanceHarness.state).toEqual(before);
		expect(maintenanceHarness.deleteWorkoutSessionRows).not.toHaveBeenCalled();
		expect(maintenanceHarness.db.workoutSessions.delete).not.toHaveBeenCalled();
		expect(maintenanceHarness.db.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(maintenanceHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});
});
