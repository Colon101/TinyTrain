import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exercise, SessionExercise, SessionSet, WorkoutSession } from '../../db/models';

const timestamp = '2026-07-15T12:00:00.000Z';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		sessionExercises: [] as SessionExercise[],
		sets: [] as SessionSet[],
		workoutSession: undefined as WorkoutSession | undefined
	};
	const sessionExercises = {
		getSyncState: vi.fn(async () => undefined),
		bulkGet: vi.fn(async (ids: string[]) =>
			ids.map((id) => state.sessionExercises.find((row) => row.id === id))
		),
		bulkAdd: vi.fn(async (rows: SessionExercise[]) => {
			state.sessionExercises.push(...rows.map((row) => ({ ...row })));
		}),
		where: vi.fn((field: keyof SessionExercise) => ({
			equals: (value: unknown) => ({
				toArray: async () =>
					state.sessionExercises.filter((row) => row[field] === value).map((row) => ({ ...row }))
			})
		}))
	};
	const sessionSets = {
		getSyncState: vi.fn(async () => undefined),
		bulkGet: vi.fn(async (ids: string[]) =>
			ids.map((id) => state.sets.find((row) => row.id === id))
		),
		bulkAdd: vi.fn(async (rows: SessionSet[]) => {
			state.sets.push(...rows.map((row) => ({ ...row })));
		})
	};
	const workoutSessions = {
		get: vi.fn(async (id: string) =>
			state.workoutSession?.id === id ? { ...state.workoutSession } : undefined
		),
		update: vi.fn(async (id: string, patch: Partial<WorkoutSession>) => {
			if (state.workoutSession?.id !== id) {
				return 0;
			}

			state.workoutSession = { ...state.workoutSession, ...patch };
			return 1;
		})
	};
	const db = {
		sessionExercises,
		sessionSets,
		workoutSessions,
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

const exerciseHarness = vi.hoisted(() => ({
	get: vi.fn()
}));

const seedingHarness = vi.hoisted(() => ({
	buildSessionRows: vi.fn()
}));

vi.mock('../../db/runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn((callback) =>
		callback({
			userId: 'user-1',
			generation: 1,
			database: runtimeHarness.db
		})
	)
}));

vi.mock('../../db/exercises', () => ({
	BASELINE_EXERCISE_BY_ID: new Map(),
	BASELINE_EXERCISE_BY_NORMALIZED_NAME: new Map(),
	getExercise: exerciseHarness.get
}));

vi.mock('../../db/session-drafts', () => ({
	clearSessionInputDraft: vi.fn(),
	removeSessionInputDraftSets: vi.fn()
}));

vi.mock('../../db/workouts', () => ({ listWorkoutExercises: vi.fn() }));
vi.mock('../../db/sessions/inputs', () => ({ updateSessionSetInputs: vi.fn() }));
vi.mock('../../db/sessions/seeding', () => ({
	buildSeedSessionSetRows: vi.fn(),
	buildSessionSeedSetRows: seedingHarness.buildSessionRows
}));

import { addExercisesToSession } from '../../db/sessions/editing';

function createExercise(id: string): Exercise {
	return {
		id,
		name: id,
		normalizedName: id,
		unilateral: false,
		source: 'custom',
		archived: false,
		createdAt: timestamp,
		updatedAt: timestamp
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.workoutSession = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Push',
		dayKey: '2026-07-15',
		status: 'in_progress',
		startedAt: timestamp,
		createdAt: timestamp,
		updatedAt: timestamp
	};
	runtimeHarness.state.sessionExercises = [
		{
			id: 'session-exercise-1',
			sessionId: 'session-1',
			workoutId: 'workout-1',
			exerciseId: 'exercise-1',
			exerciseNameSnapshot: 'exercise-1',
			order: 1,
			performedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp
		}
	];
	runtimeHarness.state.sets = [];
	exerciseHarness.get.mockImplementation(async (id: string) => createExercise(id));
	seedingHarness.buildSessionRows.mockResolvedValue([]);
});

describe('exercise-screen multi-add', () => {
	it('submits the complete selection through one batch call and retains last-selection navigation', () => {
		const source = readFileSync(
			resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'),
			'utf8'
		);
		const applyStart = source.indexOf('async function applyPickedExercises');
		const applyEnd = source.indexOf('\n\tfunction handleAddSelected()', applyStart);
		const applySource = source.slice(applyStart, applyEnd);
		const addStart = applyEnd;
		const addEnd = source.indexOf('\n\tfunction handleCreateExercise', addStart);
		const addSource = source.slice(addStart, addEnd);

		expect(applyStart).toBeGreaterThan(-1);
		expect(applyEnd).toBeGreaterThan(applyStart);
		expect(applySource.match(/dbApi\.addExercisesToSession/g)).toHaveLength(1);
		expect(applySource).toContain(
			'await dbApi.addExercisesToSession(target.sessionId, exerciseIds, expectation);'
		);
		expect(applySource).not.toMatch(/dbApi\.addExerciseToSession\b/);
		expect(addSource).toContain('pickedIds[pickedIds.length - 1]');
	});

	it('does not add an earlier selection when a later selection makes the batch fail', async () => {
		const originalRows = runtimeHarness.state.sessionExercises.map((row) => ({ ...row }));

		await expect(
			addExercisesToSession('session-1', ['exercise-2', 'exercise-1'], {
				status: 'in_progress',
				allowCompleted: false
			})
		).rejects.toThrow('That exercise is already in this session.');

		expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.sessionExercises.bulkAdd).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionSets.bulkAdd).not.toHaveBeenCalled();
		expect(runtimeHarness.db.workoutSessions.update).not.toHaveBeenCalled();
		expect(runtimeHarness.state.sessionExercises).toEqual(originalRows);
		expect(runtimeHarness.state.sets).toEqual([]);
	});
});
