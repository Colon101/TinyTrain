import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoricalSessionExerciseMatch } from '../exercises';
import type {
	Exercise,
	SessionExercise,
	SessionExerciseDetail,
	SessionSet,
	WorkoutSession
} from '../models';

const exerciseHarness = vi.hoisted(() => ({
	getExercise: vi.fn(),
	listHistoricalSessionExerciseMatches: vi.fn()
}));

const dataHarness = vi.hoisted(() => ({
	listSessionExerciseDetails: vi.fn()
}));

const runtimeHarness = vi.hoisted(() => {
	const state = {
		existingSessionSetIds: new Set<string>(),
		sessionExercise: undefined as SessionExercise | undefined,
		workoutSession: undefined as WorkoutSession | undefined
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
			get: vi.fn(async (id: string) =>
				state.sessionExercise?.id === id ? { ...state.sessionExercise } : undefined
			),
			update: vi.fn(async () => 1),
			where: vi.fn(() => ({
				equals: () => ({ toArray: async () => [] })
			})),
			bulkDelete: vi.fn()
		},
		workoutSessions: {
			get: vi.fn(async (id: string) =>
				state.workoutSession?.id === id ? { ...state.workoutSession } : undefined
			),
			update: vi.fn(async () => 1),
			delete: vi.fn()
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1) as () => Promise<unknown>;
			return callback();
		})
	};

	return { db, state };
});

vi.mock('../exercises', () => exerciseHarness);
vi.mock('../runtime', () => ({ db: runtimeHarness.db }));
vi.mock('./data', () => dataHarness);

import { buildSeedSessionSetRows, ensureEditableSessionSeedRows } from './seeding';

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
const historicalMatches: HistoricalSessionExerciseMatch[] = [
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
];

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.state.existingSessionSetIds.clear();
	runtimeHarness.state.sessionExercise = { ...sessionExercise };
	runtimeHarness.state.workoutSession = { ...session };
	exerciseHarness.getExercise.mockResolvedValue(baselineExercise);
	exerciseHarness.listHistoricalSessionExerciseMatches.mockResolvedValue(historicalMatches);
	dataHarness.listSessionExerciseDetails.mockResolvedValue([
		{ ...sessionExercise, sets: [{ id: 'seeded-set' }] }
	]);
});

describe('ensureEditableSessionSeedRows', () => {
	it('never resurrects the final set after its tombstone syncs onto a pristine-looking parent', async () => {
		const finalSet = historicalMatches[0].sets[0];
		const beforeRemoval = { ...sessionExercise, sets: [finalSet] };
		const firstLoad = await ensureEditableSessionSeedRows(session, [beforeRemoval]);
		// A remote final-set tombstone can become visible before any parent metadata change. The
		// parent therefore still looks pristine when the next load observes the intentional empty state.
		const afterTombstoneSync = { ...firstLoad[0], sets: [] };
		const secondLoad = await ensureEditableSessionSeedRows(session, [afterTombstoneSync]);
		const thirdLoad = await ensureEditableSessionSeedRows(session, [
			{ ...secondLoad[0], sets: [] }
		]);

		expect(firstLoad).toEqual([beforeRemoval]);
		expect(secondLoad).toEqual([afterTombstoneSync]);
		expect(thirdLoad[0].sets).toEqual([]);
		expect(exerciseHarness.getExercise).not.toHaveBeenCalled();
		expect(exerciseHarness.listHistoricalSessionExerciseMatches).not.toHaveBeenCalled();
		expect(dataHarness.listSessionExerciseDetails).not.toHaveBeenCalled();
		expect(runtimeHarness.db.transaction).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionSets.bulkAdd).not.toHaveBeenCalled();
	});
});

describe('session set logical identities', () => {
	it('gives both sides of a unilateral set one stable shared identity', () => {
		const rows = buildSeedSessionSetRows(
			'session-exercise-1',
			'exercise-1',
			1,
			true,
			'2026-07-15T12:00:00.000Z'
		);
		const rightId = rows.find((row) => row.side === 'right')?.id;
		const leftId = rows.find((row) => row.side === 'left')?.id;

		expect(rightId).toBeTruthy();
		expect(leftId).toBeTruthy();
		expect(rightId?.replace(/:right$/, '')).toBe(leftId?.replace(/:left$/, ''));
	});
});
