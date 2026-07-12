import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		sessions: [] as WorkoutSession[],
		sessionExercises: [] as SessionExercise[],
		sessionSets: [] as SessionSet[]
	};
	const db = {
		workoutSessions: {
			where: vi.fn((field: string) => ({
				between: (lower: string, upper: string) => ({
					toArray: async () =>
						state.sessions.filter((session) => {
							const value = session[field as keyof WorkoutSession];
							return typeof value === 'string' && value >= lower && value <= upper;
						})
				}),
				equals: (value: string) => ({
					toArray: async () =>
						state.sessions.filter((session) => session[field as keyof WorkoutSession] === value)
				})
			})),
			bulkGet: vi.fn(async (ids: string[]) =>
				ids.map((id) => state.sessions.find((session) => session.id === id))
			)
		},
		sessionExercises: {
			where: vi.fn(() => ({
				anyOf: (sessionIds: string[]) => ({
					toArray: async () =>
						state.sessionExercises.filter((row) => sessionIds.includes(row.sessionId))
				})
			}))
		},
		sessionSets: {
			where: vi.fn(() => ({
				anyOf: (sessionExerciseIds: string[]) => ({
					toArray: async () =>
						state.sessionSets.filter((row) => sessionExerciseIds.includes(row.sessionExerciseId))
				})
			}))
		},
		exercises: {}
	};

	return { db, state };
});

vi.mock('../runtime', () => ({ db: runtimeHarness.db }));
vi.mock('../exercises', () => ({ listExerciseHistory: vi.fn() }));

import { listSessionCalendarRowsForWeek } from './data';

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.sessions = [
		{
			id: 'session-1',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Upper body',
			dayKey: '2026-05-05',
			startedAt: '2026-05-05T10:00:00.000Z',
			completedAt: '2026-05-05T11:00:00.000Z',
			status: 'completed',
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T11:00:00.000Z'
		}
	];
	runtimeHarness.state.sessionExercises = [
		{
			id: 'session-exercise-1',
			sessionId: 'session-1',
			workoutId: 'workout-1',
			exerciseId: 'exercise-1',
			exerciseNameSnapshot: 'Bench Press',
			order: 1,
			performedAt: '2026-05-05T10:00:00.000Z',
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T10:00:00.000Z'
		}
	];
	runtimeHarness.state.sessionSets = [
		{
			id: 'set-1',
			sessionExerciseId: 'session-exercise-1',
			exerciseId: 'exercise-1',
			order: 1,
			side: 'bilateral',
			weight: 100,
			reps: 5,
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T10:15:00.000Z'
		},
		{
			id: 'set-2',
			sessionExerciseId: 'session-exercise-1',
			exerciseId: 'exercise-1',
			order: 2,
			side: 'bilateral',
			weight: 50,
			reps: 10,
			createdAt: '2026-05-05T10:00:00.000Z',
			updatedAt: '2026-05-05T10:30:00.000Z'
		}
	];
});

describe('listSessionCalendarRowsForWeek', () => {
	it('builds totals from the persisted exercise and set graph', async () => {
		const rows = await listSessionCalendarRowsForWeek(new Date(2026, 4, 5));

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			totalExercises: 1,
			totalSets: 2,
			totalReps: 15,
			totalVolume: 1000
		});
	});
});
