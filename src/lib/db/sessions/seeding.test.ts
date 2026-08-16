import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exercise, SessionExerciseDetail, SessionSet, WorkoutSession } from '../models';

const exerciseHarness = vi.hoisted(() => ({
	getExercise: vi.fn(),
	listHistoricalSessionExerciseMatches: vi.fn()
}));

const dataHarness = vi.hoisted(() => ({
	listSessionExerciseDetails: vi.fn()
}));

const runtimeHarness = vi.hoisted(() => {
	const state = {
		existingSessionSetIds: new Set<string>()
	};
	const db = {
		exercises: {
			bulkGet: vi.fn(async () => [])
		},
		sessionSets: {
			bulkAdd: vi.fn(async (rows: SessionSet[]) => rows.map((row) => row.id)),
			where: vi.fn(() => ({
				anyOf: () => ({ toArray: async () => [] }),
				equals: (sessionExerciseId: string) => ({
					toArray: async () =>
						state.existingSessionSetIds.has(sessionExerciseId) ? [{ id: 'concurrent-set' }] : []
				})
			})),
			bulkDelete: vi.fn()
		},
		sessionExercises: {
			update: vi.fn(async () => 1),
			where: vi.fn(() => ({
				equals: () => ({ toArray: async () => [] })
			})),
			bulkDelete: vi.fn()
		},
		workoutSessions: {
			get: vi.fn(),
			update: vi.fn(async () => 1),
			delete: vi.fn()
		},
		transaction: vi.fn(async (callback: () => Promise<unknown>) => callback())
	};

	return { db, state };
});

vi.mock('../exercises', () => exerciseHarness);
vi.mock('../runtime', () => ({ db: runtimeHarness.db }));
vi.mock('./data', () => dataHarness);

import { ensureEditableSessionSeedRows } from './seeding';

const baselineExercise: Exercise = {
	id: 'baseline-exercise',
	name: 'Bench Press',
	normalizedName: 'bench press',
	unilateral: false,
	source: 'baseline',
	archived: false,
	createdAt: '2026-04-01T00:00:00.000Z',
	updatedAt: '2026-04-01T00:00:00.000Z'
};
const session: WorkoutSession = {
	id: 'session-1',
	workoutId: 'workout-1',
	workoutNameSnapshot: 'Upper body',
	dayKey: '2026-05-05',
	status: 'in_progress',
	createdAt: '2026-05-05T10:00:00.000Z',
	updatedAt: '2026-05-05T10:00:00.000Z'
};
const sessionExercise: SessionExerciseDetail = {
	id: 'session-exercise-1',
	sessionId: session.id,
	workoutId: session.workoutId,
	exerciseId: baselineExercise.id,
	exerciseNameSnapshot: baselineExercise.name,
	order: 1,
	performedAt: session.createdAt,
	createdAt: session.createdAt,
	updatedAt: session.createdAt,
	sets: []
};

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.existingSessionSetIds.clear();
	exerciseHarness.getExercise.mockResolvedValue(baselineExercise);
	exerciseHarness.listHistoricalSessionExerciseMatches.mockResolvedValue([
		{
			session: { ...session, id: 'previous-session', status: 'completed' },
			sessionExercise: { ...sessionExercise, id: 'previous-session-exercise' },
			sets: [
				{
					id: 'previous-set',
					sessionExerciseId: 'previous-session-exercise',
					exerciseId: baselineExercise.id,
					order: 1,
					side: 'bilateral',
					createdAt: session.createdAt,
					updatedAt: session.createdAt
				}
			]
		}
	]);
	dataHarness.listSessionExerciseDetails.mockResolvedValue([
		{ ...sessionExercise, sets: [{ id: 'seeded-set' }] }
	]);
});

describe('ensureEditableSessionSeedRows', () => {
	it('resolves baseline exercises through the canonical exercise lookup', async () => {
		await ensureEditableSessionSeedRows(session, [sessionExercise]);

		expect(exerciseHarness.getExercise).toHaveBeenCalledWith(baselineExercise.id);
		expect(runtimeHarness.db.exercises.bulkGet).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionSets.bulkAdd).toHaveBeenCalledWith([
			expect.objectContaining({
				sessionExerciseId: sessionExercise.id,
				exerciseId: baselineExercise.id,
				order: 1,
				side: 'bilateral'
			})
		]);
	});

	it('rechecks for concurrent seed insertion inside the write transaction', async () => {
		runtimeHarness.state.existingSessionSetIds.add(sessionExercise.id);

		await ensureEditableSessionSeedRows(session, [sessionExercise]);

		expect(runtimeHarness.db.sessionSets.bulkAdd).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionExercises.update).not.toHaveBeenCalled();
		expect(runtimeHarness.db.workoutSessions.update).not.toHaveBeenCalled();
	});
});
