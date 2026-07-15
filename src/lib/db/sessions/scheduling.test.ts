import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	Exercise,
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExerciseWithExercise,
	WorkoutSession
} from '../models';

type FailureStage = 'parent' | 'exercises' | 'sets' | 'workout' | null;

const runtimeHarness = vi.hoisted(() => {
	const state = {
		failureStage: null as FailureStage,
		sessionDeleteFailuresRemaining: 0,
		replacementOnSessionDeleteFailure: undefined as WorkoutSession | undefined,
		sessions: new Map<string, WorkoutSession>(),
		sessionTombstones: new Map<string, WorkoutSession>(),
		sessionSyncOverrides: new Map<string, { row?: WorkoutSession; deleted: boolean }>(),
		sessionExercises: new Map<string, SessionExercise>(),
		sessionExerciseTombstones: new Map<string, SessionExercise>(),
		sessionSets: new Map<string, SessionSet>(),
		sessionSetTombstones: new Map<string, SessionSet>(),
		workout: undefined as Workout | undefined
	};
	const db = {
		workoutSessions: {
			get: vi.fn(async (id: string) => state.sessions.get(id)),
			getSyncState: vi.fn(async (id: string) => {
				const override = state.sessionSyncOverrides.get(id);
				if (override) return override;
				const liveRow = state.sessions.get(id);
				if (liveRow) return { row: liveRow, deleted: false };
				const tombstone = state.sessionTombstones.get(id);
				return tombstone ? { row: tombstone, deleted: true } : undefined;
			}),
			add: vi.fn(async (row: WorkoutSession) => {
				if (state.failureStage === 'parent') throw new Error('Injected parent failure.');
				if (
					state.sessions.has(row.id) ||
					state.sessionTombstones.has(row.id) ||
					state.sessionSyncOverrides.has(row.id)
				) {
					throw new Error('Duplicate session.');
				}
				state.sessions.set(row.id, { ...row });
				return row.id;
			}),
			put: vi.fn(async (row: WorkoutSession) => {
				state.sessionTombstones.delete(row.id);
				state.sessionSyncOverrides.delete(row.id);
				state.sessions.set(row.id, { ...row });
				return row.id;
			}),
			delete: vi.fn(async (id: string) => {
				if (state.sessionDeleteFailuresRemaining > 0) {
					state.sessionDeleteFailuresRemaining -= 1;

					if (state.replacementOnSessionDeleteFailure) {
						state.sessions.set(id, { ...state.replacementOnSessionDeleteFailure, id });
					}

					throw new Error('Injected compensation delete failure.');
				}

				const row = state.sessions.get(id);
				if (row) state.sessionTombstones.set(id, { ...row });
				state.sessions.delete(id);
			}),
			where: vi.fn(() => ({
				equals: (dayKey: string) => ({
					toArray: async () =>
						[...state.sessions.values()].filter((session) => session.dayKey === dayKey)
				})
			}))
		},
		sessionExercises: {
			get: vi.fn(async (id: string) => state.sessionExercises.get(id)),
			getSyncState: vi.fn(async (id: string) => {
				const liveRow = state.sessionExercises.get(id);
				if (liveRow) return { row: liveRow, deleted: false };
				const tombstone = state.sessionExerciseTombstones.get(id);
				return tombstone ? { row: tombstone, deleted: true } : undefined;
			}),
			bulkAdd: vi.fn(async (rows: SessionExercise[]) => {
				if (
					rows.some(
						(row) =>
							state.sessionExercises.has(row.id) || state.sessionExerciseTombstones.has(row.id)
					)
				) {
					throw new Error('Duplicate session exercise.');
				}
				for (const row of rows) state.sessionExercises.set(row.id, { ...row });
				if (state.failureStage === 'exercises') throw new Error('Injected exercise failure.');
				return rows.map((row) => row.id);
			}),
			bulkPut: vi.fn(async (rows: SessionExercise[]) => {
				for (const row of rows) {
					state.sessionExerciseTombstones.delete(row.id);
					state.sessionExercises.set(row.id, { ...row });
				}
				if (state.failureStage === 'exercises') throw new Error('Injected exercise failure.');
				return rows.map((row) => row.id);
			}),
			put: vi.fn(async (row: SessionExercise) => {
				state.sessionExerciseTombstones.delete(row.id);
				state.sessionExercises.set(row.id, { ...row });
				return row.id;
			}),
			delete: vi.fn(async (id: string) => {
				const row = state.sessionExercises.get(id);
				if (row) state.sessionExerciseTombstones.set(id, { ...row });
				state.sessionExercises.delete(id);
			}),
			bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => state.sessionExercises.get(id))),
			bulkDelete: vi.fn(async (ids: string[]) => {
				for (const id of ids) {
					const row = state.sessionExercises.get(id);
					if (row) state.sessionExerciseTombstones.set(id, { ...row });
					state.sessionExercises.delete(id);
				}
			}),
			where: vi.fn(() => ({
				equals: (sessionId: string) => ({
					toArray: async () =>
						[...state.sessionExercises.values()].filter(
							(sessionExercise) => sessionExercise.sessionId === sessionId
						)
				})
			}))
		},
		sessionSets: {
			get: vi.fn(async (id: string) => state.sessionSets.get(id)),
			getSyncState: vi.fn(async (id: string) => {
				const liveRow = state.sessionSets.get(id);
				if (liveRow) return { row: liveRow, deleted: false };
				const tombstone = state.sessionSetTombstones.get(id);
				return tombstone ? { row: tombstone, deleted: true } : undefined;
			}),
			bulkAdd: vi.fn(async (rows: SessionSet[]) => {
				if (
					rows.some(
						(row) => state.sessionSets.has(row.id) || state.sessionSetTombstones.has(row.id)
					)
				) {
					throw new Error('Duplicate session set.');
				}
				for (const row of rows) state.sessionSets.set(row.id, { ...row });
				if (state.failureStage === 'sets') throw new Error('Injected set failure.');
				return rows.map((row) => row.id);
			}),
			bulkPut: vi.fn(async (rows: SessionSet[]) => {
				for (const row of rows) {
					state.sessionSetTombstones.delete(row.id);
					state.sessionSets.set(row.id, { ...row });
				}
				if (state.failureStage === 'sets') throw new Error('Injected set failure.');
				return rows.map((row) => row.id);
			}),
			put: vi.fn(async (row: SessionSet) => {
				state.sessionSetTombstones.delete(row.id);
				state.sessionSets.set(row.id, { ...row });
				return row.id;
			}),
			delete: vi.fn(async (id: string) => {
				const row = state.sessionSets.get(id);
				if (row) state.sessionSetTombstones.set(id, { ...row });
				state.sessionSets.delete(id);
			}),
			bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => state.sessionSets.get(id))),
			bulkDelete: vi.fn(async (ids: string[]) => {
				for (const id of ids) {
					const row = state.sessionSets.get(id);
					if (row) state.sessionSetTombstones.set(id, { ...row });
					state.sessionSets.delete(id);
				}
			}),
			where: vi.fn(() => ({
				anyOf: (sessionExerciseIds: string[]) => ({
					toArray: async () =>
						[...state.sessionSets.values()].filter((sessionSet) =>
							sessionExerciseIds.includes(sessionSet.sessionExerciseId)
						)
				})
			}))
		},
		workouts: {
			get: vi.fn(async (id: string) =>
				state.workout?.id === id ? { ...state.workout } : undefined
			),
			update: vi.fn(async (id: string, patch: Partial<Workout>) => {
				if (!state.workout || state.workout.id !== id) return 0;
				state.workout = { ...state.workout, ...patch };
				if (state.failureStage === 'workout') throw new Error('Injected workout failure.');
				return 1;
			}),
			put: vi.fn(async (row: Workout) => {
				state.workout = { ...row };
				return row.id;
			})
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback !== 'function') throw new Error('Missing transaction callback.');
			return callback();
		})
	};

	return { db, state };
});

const workoutHarness = vi.hoisted(() => ({ listWorkoutExercises: vi.fn() }));
const seedingHarness = vi.hoisted(() => ({ buildSessionSeedSetRows: vi.fn() }));
const integrityHarness = vi.hoisted(() => ({ repairScheduledSessionDay: vi.fn() }));
const authHarness = vi.hoisted(() => ({ userId: 'user-1' }));

class MemoryStorage implements Storage {
	readonly values = new Map<string, string>();
	failWrites = false;

	get length() {
		return this.values.size;
	}

	clear() {
		this.values.clear();
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string) {
		this.values.delete(key);
	}

	setItem(key: string, value: string) {
		if (this.failWrites) {
			throw new Error('Injected localStorage write failure.');
		}

		this.values.set(key, value);
	}
}

const compensationStorage = new MemoryStorage();

vi.mock('../runtime', () => ({
	canAttemptSessionCleanup: vi.fn(() => false),
	confirmSessionCleanupIsFresh: vi.fn(),
	db: runtimeHarness.db,
	ensureDbOpen: vi.fn(),
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: authHarness.userId })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn(async (callback) =>
		callback({ userId: authHarness.userId, generation: 1, database: runtimeHarness.db })
	),
	syncNow: vi.fn(async () => undefined),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('../session-drafts', () => ({ clearSessionInputDraft: vi.fn() }));
vi.mock('../workouts', () => ({
	listWorkoutExercises: workoutHarness.listWorkoutExercises,
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () => [])
}));
vi.mock('./inputs', () => ({
	flushSessionInputDraft: vi.fn(),
	flushSessionInputDraftWithDatabase: vi.fn()
}));
vi.mock('./schedule-integrity', () => ({
	repairScheduledSessionDay: integrityHarness.repairScheduledSessionDay
}));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: seedingHarness.buildSessionSeedSetRows,
	deleteWorkoutSessionRows: vi.fn(),
	ensureEditableSessionSeedRows: vi.fn()
}));

import {
	deleteWorkoutSession,
	repairScheduledSessionCompensation,
	scheduleWorkoutSession,
	ScheduledSessionCompensationError
} from './lifecycle';
import { getScheduledWorkoutSessionId } from './schedule-identity';

const exercise: Exercise = {
	id: 'exercise-1',
	name: 'Bench Press',
	normalizedName: 'bench press',
	unilateral: false,
	source: 'custom',
	archived: false,
	createdAt: '2026-07-01T08:00:00.000Z',
	updatedAt: '2026-07-01T08:00:00.000Z'
};
const workoutExercise: WorkoutExerciseWithExercise = {
	id: 'workout-exercise-1',
	workoutId: 'workout-1',
	exerciseId: exercise.id,
	order: 1,
	createdAt: exercise.createdAt,
	updatedAt: exercise.updatedAt,
	exercise
};
const originalWorkoutUpdatedAt = '2026-07-01T08:00:00.000Z';

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
	authHarness.userId = 'user-1';
	runtimeHarness.state.failureStage = null;
	runtimeHarness.state.sessionDeleteFailuresRemaining = 0;
	runtimeHarness.state.replacementOnSessionDeleteFailure = undefined;
	runtimeHarness.state.sessions = new Map();
	runtimeHarness.state.sessionTombstones = new Map();
	runtimeHarness.state.sessionSyncOverrides = new Map();
	runtimeHarness.state.sessionExercises = new Map();
	runtimeHarness.state.sessionExerciseTombstones = new Map();
	runtimeHarness.state.sessionSets = new Map();
	runtimeHarness.state.sessionSetTombstones = new Map();
	runtimeHarness.state.workout = {
		id: 'workout-1',
		name: 'Upper body',
		normalizedName: 'upper body',
		archived: false,
		createdAt: originalWorkoutUpdatedAt,
		updatedAt: originalWorkoutUpdatedAt
	};
	workoutHarness.listWorkoutExercises.mockResolvedValue([workoutExercise]);
	integrityHarness.repairScheduledSessionDay.mockResolvedValue(undefined);
	seedingHarness.buildSessionSeedSetRows.mockImplementation(
		async (
			sessionExerciseId: string,
			seedExercise: Exercise,
			now: string,
			_excludeSessionId: string | undefined,
			getLogicalSetId: (order: number) => string
		): Promise<SessionSet[]> => [
			{
				id: `${getLogicalSetId(1)}:bilateral`,
				sessionExerciseId,
				exerciseId: seedExercise.id,
				order: 1,
				side: 'bilateral',
				weightInput: '',
				repsInput: '',
				rirInput: '',
				createdAt: now,
				updatedAt: now
			}
		]
	);
	compensationStorage.clear();
	compensationStorage.failWrites = false;
	vi.stubGlobal('localStorage', compensationStorage);
});

afterEach(() => {
	vi.useRealTimers();
});

function snapshotGraph() {
	return {
		sessions: [...runtimeHarness.state.sessions.values()],
		sessionExercises: [...runtimeHarness.state.sessionExercises.values()],
		sessionSets: [...runtimeHarness.state.sessionSets.values()]
	};
}

describe('scheduleWorkoutSession convergence', () => {
	it('resurrects the exact deterministic graph after explicit deletion left tombstones', async () => {
		await scheduleWorkoutSession('workout-1', '2026-07-15');
		const firstGraph = snapshotGraph();
		const scheduledSession = firstGraph.sessions[0];
		vi.setSystemTime(new Date('2026-07-15T10:01:00.000Z'));
		await deleteWorkoutSession(scheduledSession.id, {
			status: scheduledSession.status,
			updatedAt: scheduledSession.updatedAt
		});
		vi.clearAllMocks();
		vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));

		await scheduleWorkoutSession('workout-1', '2026-07-15');
		const resurrectedGraph = snapshotGraph();

		expect(resurrectedGraph.sessions.map(({ id }) => id)).toEqual(
			firstGraph.sessions.map(({ id }) => id)
		);
		expect(resurrectedGraph.sessionExercises.map(({ id }) => id)).toEqual(
			firstGraph.sessionExercises.map(({ id }) => id)
		);
		expect(resurrectedGraph.sessionSets.map(({ id }) => id)).toEqual(
			firstGraph.sessionSets.map(({ id }) => id)
		);
		expect(runtimeHarness.db.workoutSessions.put).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.workoutSessions.add).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionExercises.bulkPut).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.sessionExercises.bulkAdd).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionSets.bulkPut).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.sessionSets.bulkAdd).not.toHaveBeenCalled();
	});

	it('rejects an exact live sync-state winner even when the normal day query cannot see it', async () => {
		const scheduledId = getScheduledWorkoutSessionId('user-1', '2026-07-15');
		const hiddenLiveWinner: WorkoutSession = {
			id: scheduledId,
			workoutId: 'workout-2',
			workoutNameSnapshot: 'Concurrent winner',
			dayKey: '2026-07-15',
			status: 'planned',
			createdAt: '2026-07-15T09:59:00.000Z',
			updatedAt: '2026-07-15T09:59:00.000Z'
		};
		runtimeHarness.state.sessionSyncOverrides.set(scheduledId, {
			row: hiddenLiveWinner,
			deleted: false
		});

		await expect(scheduleWorkoutSession('workout-1', '2026-07-15')).rejects.toThrow(
			'A session already exists for today.'
		);
		expect(runtimeHarness.db.workoutSessions.put).not.toHaveBeenCalled();
		expect(runtimeHarness.db.workoutSessions.add).not.toHaveBeenCalled();
	});

	it('allows only one of two concurrent schedules to create the deterministic graph', async () => {
		const results = await Promise.allSettled([
			scheduleWorkoutSession('workout-1', '2026-07-15'),
			scheduleWorkoutSession('workout-1', '2026-07-15')
		]);

		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
		expect(snapshotGraph().sessions).toHaveLength(1);
		expect(snapshotGraph().sessionExercises).toHaveLength(1);
		expect(snapshotGraph().sessionSets).toHaveLength(1);
	});

	it('returns a failed resurrection to tombstones so a later retry converges', async () => {
		await scheduleWorkoutSession('workout-1', '2026-07-15');
		const scheduledSession = snapshotGraph().sessions[0];
		vi.setSystemTime(new Date('2026-07-15T10:01:00.000Z'));
		await deleteWorkoutSession(scheduledSession.id, {
			status: scheduledSession.status,
			updatedAt: scheduledSession.updatedAt
		});
		runtimeHarness.state.failureStage = 'sets';
		vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));

		await expect(scheduleWorkoutSession('workout-1', '2026-07-15')).rejects.toThrow(
			'Injected set failure.'
		);
		expect(snapshotGraph()).toEqual({ sessions: [], sessionExercises: [], sessionSets: [] });
		await expect(
			runtimeHarness.db.workoutSessions.getSyncState(
				getScheduledWorkoutSessionId('user-1', '2026-07-15')
			)
		).resolves.toMatchObject({ deleted: true });

		runtimeHarness.state.failureStage = null;
		await expect(scheduleWorkoutSession('workout-1', '2026-07-15')).resolves.toMatchObject({
			status: 'planned'
		});
		expect(snapshotGraph().sessions).toHaveLength(1);
		expect(snapshotGraph().sessionExercises).toHaveLength(1);
		expect(snapshotGraph().sessionSets).toHaveLength(1);
	});

	it('gives two offline replicas identical parent and seeded child identities', async () => {
		await scheduleWorkoutSession('workout-1', '2026-07-15');
		const firstReplica = snapshotGraph();

		runtimeHarness.state.sessions = new Map();
		runtimeHarness.state.sessionExercises = new Map();
		runtimeHarness.state.sessionSets = new Map();
		vi.setSystemTime(new Date('2026-07-15T10:05:00.000Z'));
		await scheduleWorkoutSession('workout-1', '2026-07-15');
		const secondReplica = snapshotGraph();

		expect(secondReplica.sessions.map((row) => row.id)).toEqual(
			firstReplica.sessions.map((row) => row.id)
		);
		expect(secondReplica.sessionExercises.map((row) => row.id)).toEqual(
			firstReplica.sessionExercises.map((row) => row.id)
		);
		expect(secondReplica.sessionSets.map((row) => row.id)).toEqual(
			firstReplica.sessionSets.map((row) => row.id)
		);
	});

	it.each(['parent', 'exercises', 'sets', 'workout'] as const)(
		'compensates a failure at the %s write stage without leaving a partial graph',
		async (failureStage) => {
			runtimeHarness.state.failureStage = failureStage;

			const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
				(caughtError: unknown) => caughtError
			);

			if (failureStage === 'workout') {
				expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
				expect((error as ScheduledSessionCompensationError).originalError).toEqual(
					expect.objectContaining({ message: 'Injected workout failure.' })
				);
			} else {
				expect(error).toEqual(
					expect.objectContaining({ message: expect.stringContaining('Injected') })
				);
			}

			expect(snapshotGraph()).toEqual({
				sessions: [],
				sessionExercises: [],
				sessionSets: []
			});
			expect(runtimeHarness.state.workout?.updatedAt).toBe(originalWorkoutUpdatedAt);
		}
	);

	it('reports failed compensation and allows a later bounded repair to converge', async () => {
		runtimeHarness.state.failureStage = 'sets';
		// The first compensation and the automatic bounded retry both fail to remove the parent.
		runtimeHarness.state.sessionDeleteFailuresRemaining = 2;

		const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
			(caughtError: unknown) => caughtError
		);

		expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
		if (!(error instanceof ScheduledSessionCompensationError)) {
			throw new Error('Expected a compensation error.');
		}
		expect(error.originalError).toEqual(
			expect.objectContaining({ message: 'Injected set failure.' })
		);
		expect(error.cleanupErrors).toHaveLength(2);
		expect(error.remainingRowIds).toEqual([...runtimeHarness.state.sessions.keys()]);
		expect(snapshotGraph()).toMatchObject({
			sessionExercises: [],
			sessionSets: []
		});
		expect(snapshotGraph().sessions).toHaveLength(1);

		await expect(repairScheduledSessionCompensation(error)).resolves.toBe(true);
		expect(snapshotGraph()).toEqual({ sessions: [], sessionExercises: [], sessionSets: [] });
		expect(error.remainingRowIds).toEqual([]);
		expect(integrityHarness.repairScheduledSessionDay).toHaveBeenCalledWith(
			runtimeHarness.db,
			'user-1',
			'2026-07-15'
		);
	});

	it('hydrates a failed scheduled-session repair after reload before retrying creation', async () => {
		runtimeHarness.state.failureStage = 'sets';
		runtimeHarness.state.sessionDeleteFailuresRemaining = 2;

		const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
			(caughtError: unknown) => caughtError
		);

		expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
		expect(compensationStorage.values.size).toBe(1);
		runtimeHarness.state.failureStage = null;
		vi.resetModules();
		const freshLifecycle = await import('./lifecycle');

		await expect(
			freshLifecycle.scheduleWorkoutSession('workout-1', '2026-07-15')
		).resolves.toMatchObject({ status: 'planned' });
		expect(snapshotGraph().sessions).toHaveLength(1);
		expect(snapshotGraph().sessionExercises).toHaveLength(1);
		expect(snapshotGraph().sessionSets).toHaveLength(1);
		expect(compensationStorage.values.size).toBe(0);
	});

	it('surfaces non-durable scheduling compensation when journal storage rejects the snapshot', async () => {
		runtimeHarness.state.failureStage = 'sets';
		runtimeHarness.state.sessionDeleteFailuresRemaining = 2;
		compensationStorage.failWrites = true;

		const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
			(caughtError: unknown) => caughtError
		);

		expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
		if (!(error instanceof ScheduledSessionCompensationError)) throw error;
		expect(error.durabilityErrors).toHaveLength(1);
		expect(error.message).toContain('Recovery could not be saved for reload safety.');
		expect(error.message).toContain('Keep this tab open');
		expect(compensationStorage.values.size).toBe(0);
	});

	it('keeps a pending user-A schedule repair away from user B data', async () => {
		runtimeHarness.state.failureStage = 'sets';
		runtimeHarness.state.sessionDeleteFailuresRemaining = 2;
		const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
			(caughtError: unknown) => caughtError
		);

		expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
		if (!(error instanceof ScheduledSessionCompensationError)) throw error;
		const beforeCrossOwnerRepair = snapshotGraph();
		authHarness.userId = 'user-2';

		await expect(repairScheduledSessionCompensation(error)).rejects.toThrow(
			'different signed-in user'
		);
		expect(snapshotGraph()).toEqual(beforeCrossOwnerRepair);
		expect(integrityHarness.repairScheduledSessionDay).not.toHaveBeenCalledWith(
			runtimeHarness.db,
			'user-2',
			'2026-07-15'
		);

		authHarness.userId = 'user-1';
		await expect(repairScheduledSessionCompensation(error)).resolves.toBe(true);
	});

	it('does not delete a concurrent winner while verifying attempted-row ownership', async () => {
		runtimeHarness.state.failureStage = 'sets';
		runtimeHarness.state.sessionDeleteFailuresRemaining = 1;
		const concurrentWinner: WorkoutSession = {
			id: 'replaced-after-attempt',
			workoutId: 'workout-2',
			workoutNameSnapshot: 'Lower body',
			dayKey: '2026-07-15',
			status: 'planned',
			createdAt: '2026-07-15T10:01:00.000Z',
			updatedAt: '2026-07-15T10:01:00.000Z'
		};
		// The harness stores this replacement under the attempted deterministic key, like a sync
		// conflict winner that lands between the failed delete and ownership verification.
		runtimeHarness.state.replacementOnSessionDeleteFailure = concurrentWinner;

		const error = await scheduleWorkoutSession('workout-1', '2026-07-15').catch(
			(caughtError: unknown) => caughtError
		);

		expect(error).toBeInstanceOf(ScheduledSessionCompensationError);
		expect([...runtimeHarness.state.sessions.values()]).toEqual([
			expect.objectContaining({
				workoutId: concurrentWinner.workoutId,
				createdAt: concurrentWinner.createdAt
			})
		]);
		expect(runtimeHarness.db.workoutSessions.delete).toHaveBeenCalledTimes(1);
	});

	it('does not replace or duplicate an existing legacy same-day session', async () => {
		const legacySession: WorkoutSession = {
			id: 'legacy-session',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Upper body',
			dayKey: '2026-07-15',
			status: 'planned',
			createdAt: '2026-07-15T09:00:00.000Z',
			updatedAt: '2026-07-15T09:00:00.000Z'
		};
		runtimeHarness.state.sessions.set(legacySession.id, legacySession);

		await expect(scheduleWorkoutSession('workout-1', '2026-07-15')).rejects.toThrow(
			'A session already exists for today.'
		);
		expect([...runtimeHarness.state.sessions.values()]).toEqual([legacySession]);
		expect(runtimeHarness.db.workoutSessions.add).not.toHaveBeenCalled();
	});
});
