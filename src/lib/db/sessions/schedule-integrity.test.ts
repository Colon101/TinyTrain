import { describe, expect, it, vi } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';
import type { AppDatabase, DataTable } from '../runtime';
import {
	getScheduledSessionExerciseId,
	getScheduledSessionSetLogicalId,
	getScheduledWorkoutSessionId
} from './schedule-identity';
import { projectSessionChildren, repairScheduledSessionDay } from './schedule-integrity';

type StoredRow = { id: string };

function createMemoryTable<T extends StoredRow>(initialRows: T[] = []): DataTable<T> {
	const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
	const matches = (field: string, value: unknown) =>
		[...rows.values()].filter(
			(row) => (row as unknown as Record<string, unknown>)[field] === value
		);

	return {
		toArray: async () => [...rows.values()].map((row) => ({ ...row })),
		get: async (id) => {
			const row = rows.get(id);
			return row ? { ...row } : undefined;
		},
		getSyncState: async (id) => {
			const row = rows.get(id);
			return row ? { row: { ...row }, deleted: false } : undefined;
		},
		bulkGet: async (ids) => ids.map((id) => rows.get(id)).map((row) => (row ? { ...row } : row)),
		add: async (row) => {
			if (rows.has(row.id)) throw new Error('Duplicate row.');
			rows.set(row.id, { ...row });
			return row.id;
		},
		bulkAdd: async (nextRows) => {
			for (const row of nextRows) {
				if (rows.has(row.id)) throw new Error('Duplicate row.');
				rows.set(row.id, { ...row });
			}
			return nextRows.map((row) => row.id);
		},
		put: async (row) => {
			rows.set(row.id, { ...row });
			return row.id;
		},
		bulkPut: async (nextRows) => {
			for (const row of nextRows) rows.set(row.id, { ...row });
			return nextRows.map((row) => row.id);
		},
		update: async (id, patch) => {
			const row = rows.get(id);
			if (!row) return 0;
			rows.set(id, { ...row, ...patch });
			return 1;
		},
		delete: vi.fn(async (id) => {
			rows.delete(id);
		}),
		bulkDelete: vi.fn(async (ids) => {
			for (const id of ids) rows.delete(id);
		}),
		where: (field) => ({
			equals: (value) => ({
				toArray: async () => matches(field, value).map((row) => ({ ...row })),
				first: async () => matches(field, value)[0],
				sortBy: async (sortField) =>
					matches(field, value).sort((first, second) =>
						String((first as unknown as Record<string, unknown>)[sortField]).localeCompare(
							String((second as unknown as Record<string, unknown>)[sortField])
						)
					)
			}),
			anyOf: (values) => ({
				toArray: async () => values.flatMap((value) => matches(field, value)),
				first: async () => values.flatMap((value) => matches(field, value))[0],
				sortBy: async () => values.flatMap((value) => matches(field, value))
			}),
			between: () => ({
				toArray: async () => [],
				first: async () => undefined,
				sortBy: async () => []
			})
		})
	};
}

function createDatabase(
	sessions: WorkoutSession[],
	sessionExercises: SessionExercise[],
	sessionSets: SessionSet[]
) {
	return {
		workoutSessions: createMemoryTable(sessions),
		sessionExercises: createMemoryTable(sessionExercises),
		sessionSets: createMemoryTable(sessionSets),
		transaction: async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback !== 'function') throw new Error('Missing transaction callback.');
			return callback();
		}
	} as unknown as AppDatabase;
}

const userId = 'user-1';
const dayKey = '2026-07-15';
const createdAt = '2026-07-15T08:00:00.000Z';
const scheduledSessionId = getScheduledWorkoutSessionId(userId, dayKey);

function session(
	id: string,
	workoutId: string,
	patch: Partial<WorkoutSession> = {}
): WorkoutSession {
	return {
		id,
		workoutId,
		workoutNameSnapshot: workoutId,
		dayKey,
		status: 'planned',
		createdAt,
		updatedAt: createdAt,
		...patch
	};
}

function sessionExercise(
	sessionId: string,
	workoutId: string,
	exerciseId: string,
	order = 1
): SessionExercise {
	return {
		id: getScheduledSessionExerciseId(sessionId, workoutId, exerciseId, order),
		sessionId,
		workoutId,
		exerciseId,
		exerciseNameSnapshot: exerciseId,
		order,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt
	};
}

function sessionSet(row: SessionExercise, patch: Partial<SessionSet> = {}): SessionSet {
	return {
		id: `${getScheduledSessionSetLogicalId(row.id, 1)}:bilateral`,
		sessionExerciseId: row.id,
		exerciseId: row.exerciseId,
		order: 1,
		side: 'bilateral',
		weightInput: '',
		repsInput: '',
		rirInput: '',
		createdAt,
		updatedAt: createdAt,
		...patch
	};
}

describe('scheduled session identity', () => {
	it('is stable for one user/day and namespaced across users, days, and child cohorts', () => {
		expect(getScheduledWorkoutSessionId(userId, dayKey)).toBe(scheduledSessionId);
		expect(scheduledSessionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(getScheduledWorkoutSessionId('user-2', dayKey)).not.toBe(scheduledSessionId);
		expect(getScheduledWorkoutSessionId(userId, '2026-07-16')).not.toBe(scheduledSessionId);
		expect(getScheduledSessionExerciseId(scheduledSessionId, 'workout-a', 'squat', 1)).not.toBe(
			getScheduledSessionExerciseId(scheduledSessionId, 'workout-b', 'deadlift', 1)
		);
	});
});

describe('repairScheduledSessionDay', () => {
	it('quarantines a pristine mismatched cohort without deleting either replica', async () => {
		const workoutAExercise = sessionExercise(scheduledSessionId, 'workout-a', 'squat');
		const workoutBExercise = sessionExercise(scheduledSessionId, 'workout-b', 'deadlift');
		const workoutASet = sessionSet(workoutAExercise);
		const workoutBSet = sessionSet(workoutBExercise);
		// Parent A won while independently replicated child tables interleaved both cohorts.
		const database = createDatabase(
			[session(scheduledSessionId, 'workout-a')],
			[workoutBExercise, workoutAExercise],
			[workoutASet, workoutBSet]
		);

		const result = await repairScheduledSessionDay(database, userId, dayKey);

		expect(result).toMatchObject({
			deletedSessionIds: [],
			deletedSessionExerciseIds: [],
			quarantinedSessionExerciseIds: [workoutBExercise.id],
			recoverableSessionExerciseIds: []
		});
		expect(await database.workoutSessions.toArray()).toEqual([
			expect.objectContaining({ id: scheduledSessionId, workoutId: 'workout-a' })
		]);
		expect(await database.sessionExercises.toArray()).toEqual([workoutBExercise, workoutAExercise]);
		expect(await database.sessionSets.toArray()).toEqual([workoutASet, workoutBSet]);
		expect(database.workoutSessions.delete).not.toHaveBeenCalled();
		expect(database.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(database.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});

	it('projects a deterministic winner while preserving a pristine legacy duplicate', async () => {
		const deterministicExercise = sessionExercise(scheduledSessionId, 'workout-a', 'squat');
		const legacyExercise = {
			...sessionExercise('legacy-session', 'workout-b', 'deadlift'),
			id: 'legacy-session-exercise'
		};
		const database = createDatabase(
			[session('legacy-session', 'workout-b'), session(scheduledSessionId, 'workout-a')],
			[legacyExercise, deterministicExercise],
			[sessionSet(legacyExercise), sessionSet(deterministicExercise)]
		);

		const result = await repairScheduledSessionDay(database, userId, dayKey);

		expect(result).toMatchObject({
			winnerSessionId: scheduledSessionId,
			visibleSessionIds: [scheduledSessionId],
			quarantinedSessionIds: ['legacy-session'],
			deletedSessionIds: []
		});
		expect(await database.workoutSessions.toArray()).toHaveLength(2);
		expect(await database.sessionExercises.toArray()).toEqual([
			legacyExercise,
			deterministicExercise
		]);
		expect(await database.sessionSets.toArray()).toEqual([
			sessionSet(legacyExercise),
			sessionSet(deterministicExercise)
		]);
		expect(database.workoutSessions.delete).not.toHaveBeenCalled();
		expect(database.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(database.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});

	it('shows logged legacy data while quarantining and preserving the untouched duplicate', async () => {
		const deterministicExercise = sessionExercise(scheduledSessionId, 'workout-a', 'squat');
		const legacyExercise = {
			...sessionExercise('legacy-session', 'workout-b', 'deadlift'),
			id: 'legacy-session-exercise'
		};
		const loggedSet = sessionSet(legacyExercise, {
			weightInput: '100',
			weight: 100,
			updatedAt: '2026-07-15T08:30:00.000Z'
		});
		const database = createDatabase(
			[
				session(scheduledSessionId, 'workout-a'),
				session('legacy-session', 'workout-b', {
					status: 'in_progress',
					startedAt: createdAt,
					updatedAt: '2026-07-15T08:30:00.000Z'
				})
			],
			[deterministicExercise, legacyExercise],
			[sessionSet(deterministicExercise), loggedSet]
		);

		const result = await repairScheduledSessionDay(database, userId, dayKey);

		expect(result).toMatchObject({
			winnerSessionId: 'legacy-session',
			visibleSessionIds: ['legacy-session'],
			quarantinedSessionIds: [scheduledSessionId],
			deletedSessionIds: [],
			preservedLoggedSessionIds: ['legacy-session']
		});
		expect(await database.workoutSessions.toArray()).toHaveLength(2);
		expect(await database.sessionSets.toArray()).toEqual([
			sessionSet(deterministicExercise),
			loggedSet
		]);
		expect(database.workoutSessions.delete).not.toHaveBeenCalled();
		expect(database.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(database.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});

	it('preserves every independently logged same-day graph for the day API to expose', async () => {
		const firstExercise = sessionExercise('logged-a', 'workout-a', 'squat');
		const secondExercise = sessionExercise('logged-b', 'workout-b', 'deadlift');
		const firstSet = sessionSet(firstExercise, { repsInput: '5', reps: 5 });
		const secondSet = sessionSet(secondExercise, { repsInput: '8', reps: 8 });
		const database = createDatabase(
			[
				session('logged-a', 'workout-a', { status: 'completed', completedAt: createdAt }),
				session('logged-b', 'workout-b', { status: 'completed', completedAt: createdAt })
			],
			[firstExercise, secondExercise],
			[firstSet, secondSet]
		);

		const result = await repairScheduledSessionDay(database, userId, dayKey);

		expect(result).toMatchObject({
			deletedSessionIds: [],
			visibleSessionIds: ['logged-a', 'logged-b'],
			preservedLoggedSessionIds: ['logged-a', 'logged-b']
		});
		expect(await database.workoutSessions.toArray()).toHaveLength(2);
		expect(await database.sessionSets.toArray()).toEqual([firstSet, secondSet]);
	});

	it('automatically exposes a pristine loser after an offline replica starts and types into it', async () => {
		const deterministicExercise = sessionExercise(scheduledSessionId, 'workout-a', 'squat');
		const legacyExercise = {
			...sessionExercise('offline-legacy', 'workout-b', 'deadlift'),
			id: 'offline-legacy-exercise'
		};
		const legacySet = sessionSet(legacyExercise);
		const database = createDatabase(
			[session(scheduledSessionId, 'workout-a'), session('offline-legacy', 'workout-b')],
			[deterministicExercise, legacyExercise],
			[sessionSet(deterministicExercise), legacySet]
		);

		const beforeOfflineForkArrives = await repairScheduledSessionDay(database, userId, dayKey);

		expect(beforeOfflineForkArrives).toMatchObject({
			visibleSessionIds: [scheduledSessionId],
			quarantinedSessionIds: ['offline-legacy']
		});

		const offlineEditAt = '2026-07-15T08:30:00.000Z';
		await database.workoutSessions.update('offline-legacy', {
			status: 'in_progress',
			startedAt: offlineEditAt,
			updatedAt: offlineEditAt
		});
		await database.sessionSets.update(legacySet.id, {
			weightInput: '137.5',
			weight: 137.5,
			repsInput: '5',
			reps: 5,
			updatedAt: offlineEditAt
		});

		const afterOfflineForkArrives = await repairScheduledSessionDay(database, userId, dayKey);
		const storedOfflineSet = await database.sessionSets.get(legacySet.id);

		expect(afterOfflineForkArrives).toMatchObject({
			visibleSessionIds: ['offline-legacy'],
			quarantinedSessionIds: [scheduledSessionId],
			protectedSessionIds: ['offline-legacy']
		});
		expect(storedOfflineSet).toMatchObject({
			weightInput: '137.5',
			weight: 137.5,
			repsInput: '5',
			reps: 5
		});
		expect(database.workoutSessions.delete).not.toHaveBeenCalled();
		expect(database.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(database.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});

	it('keeps an edited mismatched cohort recoverable without rendering it under the winner', async () => {
		const workoutAExercise = sessionExercise(scheduledSessionId, 'workout-a', 'squat');
		const workoutBExercise = sessionExercise(scheduledSessionId, 'workout-b', 'deadlift');
		const workoutBSet = sessionSet(workoutBExercise, {
			weightInput: '180',
			weight: 180,
			updatedAt: '2026-07-15T08:45:00.000Z'
		});
		const storedSession = session(scheduledSessionId, 'workout-a');
		const database = createDatabase(
			[storedSession],
			[workoutAExercise, workoutBExercise],
			[sessionSet(workoutAExercise), workoutBSet]
		);

		const result = await repairScheduledSessionDay(database, userId, dayKey);
		const childProjection = projectSessionChildren({
			session: storedSession,
			sessionExercises: await database.sessionExercises.toArray(),
			sessionSets: await database.sessionSets.toArray()
		});

		expect(result.recoverableSessionExerciseIds).toEqual([workoutBExercise.id]);
		expect(childProjection.visibleSessionExercises).toEqual([workoutAExercise]);
		expect(childProjection.visibleSessionSets).toEqual([sessionSet(workoutAExercise)]);
		expect(await database.sessionExercises.get(workoutBExercise.id)).toEqual(workoutBExercise);
		expect(await database.sessionSets.get(workoutBSet.id)).toEqual(workoutBSet);
		expect(database.workoutSessions.delete).not.toHaveBeenCalled();
		expect(database.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(database.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});
});
