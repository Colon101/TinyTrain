import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	SessionExercise,
	SessionSet,
	Workout,
	WorkoutExercise,
	WorkoutSession
} from '../models';

const harness = vi.hoisted(() => {
	type Row = { id: string };
	type State = {
		sessions: Map<string, WorkoutSession>;
		sessionExercises: Map<string, SessionExercise>;
		sessionSets: Map<string, SessionSet>;
		workouts: Map<string, Workout>;
		workoutExercises: Map<string, WorkoutExercise>;
		writeIndex: number;
		failAfterWrites: Set<number>;
		failBeforeWrites: Set<number>;
		onWriteFailure: (() => void) | undefined;
		beforeTransaction: (() => Promise<void>) | undefined;
		afterTransaction: (() => void) | undefined;
	};
	const state: State = {
		sessions: new Map(),
		sessionExercises: new Map(),
		sessionSets: new Map(),
		workouts: new Map(),
		workoutExercises: new Map(),
		writeIndex: 0,
		failAfterWrites: new Set(),
		failBeforeWrites: new Set(),
		onWriteFailure: undefined,
		beforeTransaction: undefined,
		afterTransaction: undefined
	};

	function clone<T>(value: T): T {
		return structuredClone(value);
	}

	async function write<T>(mutate: () => T) {
		state.writeIndex += 1;
		const writeIndex = state.writeIndex;

		if (state.failBeforeWrites.has(writeIndex)) {
			state.onWriteFailure?.();
			throw new Error(`Injected failure before write ${writeIndex}.`);
		}

		const result = mutate();

		if (state.failAfterWrites.has(writeIndex)) {
			state.onWriteFailure?.();
			throw new Error(`Injected failure after write ${writeIndex}.`);
		}

		return result;
	}

	function table<T extends Row>(rows: Map<string, T>) {
		return {
			get: vi.fn(async (id: string) => {
				const row = rows.get(id);
				return row ? clone(row) : undefined;
			}),
			put: vi.fn(async (row: T) =>
				write(() => {
					rows.set(row.id, clone(row));
					return row.id;
				})
			),
			delete: vi.fn(async (id: string) =>
				write(() => {
					rows.delete(id);
				})
			),
			bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => rows.get(id)).map(clone)),
			bulkPut: vi.fn(async (nextRows: T[]) =>
				write(() => {
					for (const row of nextRows) rows.set(row.id, clone(row));
				})
			),
			bulkDelete: vi.fn(async (ids: string[]) =>
				write(() => {
					for (const id of ids) rows.delete(id);
				})
			)
		};
	}

	const sessionTable = table(state.sessions);
	const sessionExerciseTable = table(state.sessionExercises);
	const sessionSetTable = table(state.sessionSets);
	const workoutTable = table(state.workouts);
	const workoutExerciseTable = table(state.workoutExercises);
	const db = {
		workoutSessions: {
			...sessionTable,
			update: vi.fn(async (id: string, patch: Partial<WorkoutSession>) => {
				const current = state.sessions.get(id);
				if (!current) return 0;
				return write(() => {
					state.sessions.set(id, { ...current, ...clone(patch) });
					return 1;
				});
			}),
			where: vi.fn((field: keyof WorkoutSession) => ({
				equals: (value: unknown) => ({
					toArray: async () =>
						[...state.sessions.values()].filter((row) => row[field] === value).map(clone)
				})
			}))
		},
		sessionExercises: {
			...sessionExerciseTable,
			update: vi.fn(async (id: string, patch: Partial<SessionExercise>) => {
				const current = state.sessionExercises.get(id);
				if (!current) return 0;
				return write(() => {
					state.sessionExercises.set(id, { ...current, ...clone(patch) });
					return 1;
				});
			}),
			where: vi.fn((field: keyof SessionExercise) => ({
				equals: (value: unknown) => ({
					toArray: async () =>
						[...state.sessionExercises.values()].filter((row) => row[field] === value).map(clone),
					sortBy: async (sortField: keyof SessionExercise) =>
						[...state.sessionExercises.values()]
							.filter((row) => row[field] === value)
							.sort((a, b) => Number(a[sortField]) - Number(b[sortField]))
							.map(clone)
				})
			}))
		},
		sessionSets: {
			...sessionSetTable,
			where: vi.fn((field: keyof SessionSet) => ({
				anyOf: (values: unknown[]) => ({
					toArray: async () =>
						[...state.sessionSets.values()].filter((row) => values.includes(row[field])).map(clone)
				}),
				equals: (value: unknown) => ({
					toArray: async () =>
						[...state.sessionSets.values()].filter((row) => row[field] === value).map(clone)
				})
			}))
		},
		workouts: {
			...workoutTable,
			update: vi.fn(async (id: string, patch: Partial<Workout>) => {
				const current = state.workouts.get(id);
				if (!current) return 0;
				return write(() => {
					state.workouts.set(id, { ...current, ...clone(patch) });
					return 1;
				});
			})
		},
		workoutExercises: {
			...workoutExerciseTable,
			where: vi.fn((field: keyof WorkoutExercise) => ({
				equals: (value: unknown) => ({
					toArray: async () =>
						[...state.workoutExercises.values()].filter((row) => row[field] === value).map(clone)
				})
			}))
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			await state.beforeTransaction?.();
			const callback = args.at(-1) as () => Promise<unknown>;
			const result = await callback();
			state.afterTransaction?.();
			return result;
		})
	};

	return { clone, db, state };
});

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
	confirmSessionCleanupIsFresh: vi.fn(async () => true),
	db: harness.db,
	ensureDbOpen: vi.fn(),
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: authHarness.userId })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn(async (callback) =>
		callback({ userId: authHarness.userId, generation: 1, database: harness.db })
	),
	syncNow: vi.fn(async () => undefined),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('../workouts', () => ({
	listWorkoutExercises: vi.fn(),
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () => [])
}));
vi.mock('./inputs', () => ({
	flushSessionInputDraft: vi.fn(async () => undefined),
	flushSessionInputDraftWithDatabase: vi.fn(async () => undefined)
}));
vi.mock('./schedule-integrity', () => ({ repairScheduledSessionDay: vi.fn() }));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: vi.fn(),
	deleteWorkoutSessionRows: vi.fn(),
	ensureEditableSessionSeedRows: vi.fn()
}));

import {
	abandonStoredInactiveSession,
	completeWorkoutSession,
	deleteWorkoutSession,
	repairSessionLifecycleCompensation,
	SessionLifecycleCompensationError,
	startWorkoutSession,
	updateWorkoutSessionTiming
} from './lifecycle';

const session: WorkoutSession = {
	id: 'session-1',
	workoutId: 'workout-1',
	workoutNameSnapshot: 'Upper body',
	dayKey: '2026-05-05',
	startedAt: '2026-05-05T10:00:00.000Z',
	completedAt: '2026-05-05T11:00:00.000Z',
	status: 'abandoned',
	createdAt: '2026-05-05T10:00:00.000Z',
	updatedAt: '2026-05-05T11:00:00.000Z'
};
const sessionExercises: SessionExercise[] = [
	{
		id: 'session-exercise-1',
		sessionId: session.id,
		workoutId: session.workoutId,
		exerciseId: 'exercise-1',
		exerciseNameSnapshot: 'Press',
		order: 1,
		performedAt: '2026-05-05T10:15:00.000Z',
		createdAt: session.createdAt,
		updatedAt: session.updatedAt
	},
	{
		id: 'session-exercise-2',
		sessionId: session.id,
		workoutId: session.workoutId,
		exerciseId: 'exercise-2',
		exerciseNameSnapshot: 'Row',
		order: 2,
		performedAt: '2026-05-05T10:30:00.000Z',
		createdAt: session.createdAt,
		updatedAt: session.updatedAt
	}
];
const sessionSets: SessionSet[] = sessionExercises.map((sessionExercise, index) => ({
	id: `set-${index + 1}`,
	sessionExerciseId: sessionExercise.id,
	exerciseId: sessionExercise.exerciseId,
	order: 1,
	side: 'bilateral',
	weightInput: `${50 + index}`,
	createdAt: session.createdAt,
	updatedAt: session.updatedAt
}));
const workout: Workout = {
	id: session.workoutId,
	name: 'Upper body',
	normalizedName: 'upper body',
	archived: false,
	createdAt: '2026-05-01T08:00:00.000Z',
	updatedAt: '2026-05-04T08:00:00.000Z'
};

function resetRows() {
	harness.state.sessions.clear();
	harness.state.sessions.set(session.id, harness.clone(session));
	harness.state.sessionExercises.clear();
	for (const row of sessionExercises) {
		harness.state.sessionExercises.set(row.id, harness.clone(row));
	}
	harness.state.sessionSets.clear();
	for (const row of sessionSets) {
		harness.state.sessionSets.set(row.id, harness.clone(row));
	}
	harness.state.workouts.clear();
	harness.state.workouts.set(workout.id, harness.clone(workout));
	harness.state.workoutExercises.clear();
}

function snapshotGraph() {
	const rows = <T extends { id: string }>(values: Iterable<T>) =>
		[...values].sort((first, second) => first.id.localeCompare(second.id));

	return {
		sessions: rows(harness.state.sessions.values()),
		sessionExercises: rows(harness.state.sessionExercises.values()),
		sessionSets: rows(harness.state.sessionSets.values()),
		workouts: rows(harness.state.workouts.values()),
		workoutExercises: rows(harness.state.workoutExercises.values())
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-05-05T14:00:00.000Z'));
	resetRows();
	harness.state.writeIndex = 0;
	harness.state.failAfterWrites = new Set();
	harness.state.failBeforeWrites = new Set();
	harness.state.onWriteFailure = undefined;
	harness.state.beforeTransaction = undefined;
	harness.state.afterTransaction = undefined;
	authHarness.userId = 'user-1';
	compensationStorage.clear();
	compensationStorage.failWrites = false;
	vi.stubGlobal('localStorage', compensationStorage);
});

describe('startWorkoutSession compensation', () => {
	it.each([1, 2, 3])(
		'rolls back write stage %s and retries without double-shifting',
		async (stage) => {
			const before = snapshotGraph();
			harness.state.failAfterWrites = new Set([stage]);

			await expect(startWorkoutSession(session.id)).rejects.toThrow(`write ${stage}`);
			expect(snapshotGraph()).toEqual(before);

			harness.state.failAfterWrites.clear();
			await startWorkoutSession(session.id);

			expect(harness.state.sessions.get(session.id)).toMatchObject({
				status: 'in_progress',
				startedAt: '2026-05-05T13:00:00.000Z',
				completedAt: undefined
			});
			expect(
				[...harness.state.sessionExercises.values()].map(({ performedAt }) => performedAt)
			).toEqual(['2026-05-05T13:15:00.000Z', '2026-05-05T13:30:00.000Z']);
		}
	);

	it('returns its transaction snapshot even if the committed session is deleted immediately after', async () => {
		harness.state.afterTransaction = () => {
			harness.state.sessions.delete(session.id);
			harness.state.sessionExercises.clear();
			harness.state.sessionSets.clear();
		};

		await expect(startWorkoutSession(session.id)).resolves.toMatchObject({
			id: session.id,
			status: 'in_progress',
			totalExercises: 2,
			totalSets: 2
		});
	});
});

describe('abandonStoredInactiveSession write verification', () => {
	it('fails instead of reporting abandonment when the terminal parent update writes no row', async () => {
		harness.state.sessions.set(session.id, {
			...session,
			status: 'in_progress',
			completedAt: undefined,
			updatedAt: '2026-05-05T10:00:00.000Z'
		});
		harness.db.workoutSessions.update.mockImplementationOnce(async () => 0);

		await expect(
			abandonStoredInactiveSession(session.id, Date.parse('2026-05-05T14:00:00.000Z'))
		).rejects.toThrow('disappeared while it was being abandoned');
		expect(harness.state.sessions.get(session.id)?.status).toBe('in_progress');
	});
});

describe('updateWorkoutSessionTiming compensation', () => {
	it.each([1, 2, 3])(
		'rolls back write stage %s and retries with exactly one shift',
		async (stage) => {
			harness.state.sessions.set(session.id, { ...session, status: 'completed' });
			const before = snapshotGraph();
			harness.state.failAfterWrites = new Set([stage]);
			const baseTiming = { startedAt: session.startedAt, completedAt: session.completedAt };

			await expect(
				updateWorkoutSessionTiming(
					session.id,
					'2026-05-05T09:00:00.000Z',
					session.completedAt,
					baseTiming
				)
			).rejects.toThrow(`write ${stage}`);
			expect(snapshotGraph()).toEqual(before);

			harness.state.failAfterWrites.clear();
			await updateWorkoutSessionTiming(
				session.id,
				'2026-05-05T09:00:00.000Z',
				session.completedAt,
				baseTiming
			);
			expect(
				[...harness.state.sessionExercises.values()].map(({ performedAt }) => performedAt)
			).toEqual(['2026-05-05T09:15:00.000Z', '2026-05-05T09:30:00.000Z']);
		}
	);

	it('reports failed rollback and repairs it before a retry', async () => {
		harness.state.sessions.set(session.id, { ...session, status: 'completed' });
		harness.state.failAfterWrites = new Set([1]);
		harness.state.failBeforeWrites = new Set([2]);
		const baseTiming = { startedAt: session.startedAt, completedAt: session.completedAt };
		const error = await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(SessionLifecycleCompensationError);
		if (!(error instanceof SessionLifecycleCompensationError)) throw error;
		expect(error.originalError).toEqual(new Error('Injected failure after write 1.'));
		expect(error.cleanupErrors).toHaveLength(1);
		expect(error.remainingMutationLabels).toEqual(['session exercise session-exercise-1']);

		harness.state.failAfterWrites.clear();
		harness.state.failBeforeWrites.clear();
		await expect(repairSessionLifecycleCompensation(error)).resolves.toBe(true);
		await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		);
		expect(harness.state.sessionExercises.get('session-exercise-1')?.performedAt).toBe(
			'2026-05-05T09:15:00.000Z'
		);
	});

	it('refuses to run a pending user-A repair after user B signs in', async () => {
		harness.state.sessions.set(session.id, { ...session, status: 'completed' });
		harness.state.failAfterWrites = new Set([1]);
		harness.state.failBeforeWrites = new Set([2]);
		const baseTiming = { startedAt: session.startedAt, completedAt: session.completedAt };
		const error = await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(SessionLifecycleCompensationError);
		if (!(error instanceof SessionLifecycleCompensationError)) throw error;
		expect(error.userId).toBe('user-1');
		const beforeCrossOwnerRepair = snapshotGraph();
		const writesBeforeCrossOwnerRepair = harness.state.writeIndex;

		authHarness.userId = 'user-2';
		harness.state.failAfterWrites.clear();
		harness.state.failBeforeWrites.clear();
		await expect(repairSessionLifecycleCompensation(error)).rejects.toThrow(
			'different signed-in user'
		);

		expect(harness.state.writeIndex).toBe(writesBeforeCrossOwnerRepair);
		expect(snapshotGraph()).toEqual(beforeCrossOwnerRepair);
	});

	it('hydrates an incomplete timing repair after a module reload and converges before retry', async () => {
		harness.state.sessions.set(session.id, { ...session, status: 'completed' });
		harness.state.failAfterWrites = new Set([1]);
		harness.state.failBeforeWrites = new Set([2]);
		const baseTiming = { startedAt: session.startedAt, completedAt: session.completedAt };

		const error = await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(SessionLifecycleCompensationError);
		expect(compensationStorage.values.size).toBe(1);
		harness.state.failAfterWrites.clear();
		harness.state.failBeforeWrites.clear();
		vi.resetModules();
		const freshLifecycle = await import('./lifecycle');

		await freshLifecycle.updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		);

		expect(harness.state.sessionExercises.get('session-exercise-1')?.performedAt).toBe(
			'2026-05-05T09:15:00.000Z'
		);
		expect(harness.state.sessionExercises.get('session-exercise-2')?.performedAt).toBe(
			'2026-05-05T09:30:00.000Z'
		);
		expect(compensationStorage.values.size).toBe(0);
	});

	it('keeps a reloaded user-A journal untouched when user B attempts manual repair', async () => {
		harness.state.sessions.set(session.id, { ...session, status: 'completed' });
		harness.state.failAfterWrites = new Set([1]);
		harness.state.failBeforeWrites = new Set([2]);
		const baseTiming = { startedAt: session.startedAt, completedAt: session.completedAt };
		const error = await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(SessionLifecycleCompensationError);
		const storedJournal = [...compensationStorage.values.entries()];
		const writesBeforeUserB = harness.state.writeIndex;
		harness.state.failAfterWrites.clear();
		harness.state.failBeforeWrites.clear();
		authHarness.userId = 'user-2';
		vi.resetModules();
		const freshLifecycle = await import('./lifecycle');

		await expect(
			freshLifecycle.repairSessionLifecycleCompensation(error as SessionLifecycleCompensationError)
		).rejects.toThrow('different signed-in user');
		expect(harness.state.writeIndex).toBe(writesBeforeUserB);
		expect([...compensationStorage.values.entries()]).toEqual(storedJournal);

		authHarness.userId = 'user-1';
		await freshLifecycle.updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			baseTiming
		);
		expect(compensationStorage.values.size).toBe(0);
	});

	it('surfaces a non-durable warning when an incomplete repair cannot be journaled', async () => {
		harness.state.sessions.set(session.id, { ...session, status: 'completed' });
		harness.state.failAfterWrites = new Set([1]);
		harness.state.failBeforeWrites = new Set([2]);
		compensationStorage.failWrites = true;
		const error = await updateWorkoutSessionTiming(
			session.id,
			'2026-05-05T09:00:00.000Z',
			session.completedAt,
			{ startedAt: session.startedAt, completedAt: session.completedAt }
		).catch((failure: unknown) => failure);

		expect(error).toBeInstanceOf(SessionLifecycleCompensationError);
		if (!(error instanceof SessionLifecycleCompensationError)) throw error;
		expect(error.durabilityErrors).toHaveLength(1);
		expect(error.message).toContain('Recovery could not be saved for reload safety.');
		expect(error.message).toContain('Keep this tab open');
		expect(compensationStorage.values.size).toBe(0);
	});
});

describe('completeWorkoutSession compensation', () => {
	beforeEach(() => {
		harness.state.sessions.set(session.id, {
			...session,
			status: 'in_progress',
			completedAt: undefined
		});
		harness.state.workoutExercises.clear();
		for (const row of [
			[
				'template-existing',
				{
					id: 'template-existing',
					workoutId: workout.id,
					exerciseId: 'exercise-1',
					order: 2,
					createdAt: workout.createdAt,
					updatedAt: workout.updatedAt
				}
			],
			[
				'template-removed',
				{
					id: 'template-removed',
					workoutId: workout.id,
					exerciseId: 'exercise-removed',
					order: 1,
					createdAt: workout.createdAt,
					updatedAt: workout.updatedAt
				}
			]
		] as const) {
			harness.state.workoutExercises.set(row[0], row[1]);
		}
	});

	it.each([1, 2, 3, 4])(
		'rolls back template/terminal write stage %s and converges on retry',
		async (stage) => {
			const before = snapshotGraph();
			harness.state.failAfterWrites = new Set([stage]);

			await expect(completeWorkoutSession(session.id)).rejects.toThrow(`write ${stage}`);
			expect(snapshotGraph()).toEqual(before);

			harness.state.failAfterWrites.clear();
			await completeWorkoutSession(session.id);
			expect(harness.state.sessions.get(session.id)?.status).toBe('completed');
			expect([...harness.state.workoutExercises.values()]).toHaveLength(2);
			expect(
				[...harness.state.workoutExercises.values()].map(({ exerciseId }) => exerciseId).sort()
			).toEqual(['exercise-1', 'exercise-2']);
		}
	);

	it('preserves a concurrent template winner while rolling back its own completion attempt', async () => {
		harness.state.failAfterWrites = new Set([4]);
		let winner: WorkoutExercise | undefined;
		harness.state.onWriteFailure = () => {
			const insertedRow = [...harness.state.workoutExercises.values()].find(
				({ exerciseId }) => exerciseId === 'exercise-2'
			);

			if (insertedRow) {
				winner = {
					...insertedRow,
					order: 9,
					updatedAt: '2026-05-05T14:01:00.000Z'
				};
				harness.state.workoutExercises.set(winner.id, winner);
			}
		};

		await expect(completeWorkoutSession(session.id)).rejects.toThrow('Injected failure');
		expect(harness.state.sessions.get(session.id)?.status).toBe('in_progress');
		expect(winner).toBeDefined();
		expect(harness.state.workoutExercises.get(winner!.id)).toEqual(winner);
	});
});

describe('deleteWorkoutSession fencing and compensation', () => {
	it('rejects a confirmation that became stale before the transaction acquired its lock', async () => {
		let releaseTransaction!: () => void;
		const transactionBarrier = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		harness.state.beforeTransaction = () => transactionBarrier;
		const expectation = { status: session.status, updatedAt: session.updatedAt };
		const deletion = deleteWorkoutSession(session.id, expectation);

		await Promise.resolve();
		harness.state.sessions.set(session.id, {
			...session,
			updatedAt: '2026-05-05T12:00:00.000Z'
		});
		harness.state.sessionSets.set('set-1', {
			...sessionSets[0],
			weightInput: '999',
			updatedAt: '2026-05-05T12:00:00.000Z'
		});
		releaseTransaction();

		await expect(deletion).rejects.toThrow('changed after you confirmed deletion');
		expect(harness.state.sessions.has(session.id)).toBe(true);
		expect(harness.state.sessionSets.get('set-1')?.weightInput).toBe('999');
		expect(harness.state.sessionExercises.size).toBe(2);
	});

	it.each([1, 2, 3, 4, 5, 6])(
		'restores the exact graph after delete write stage %s fails',
		async (stage) => {
			const before = snapshotGraph();
			harness.state.failAfterWrites = new Set([stage]);

			await expect(
				deleteWorkoutSession(session.id, { status: session.status, updatedAt: session.updatedAt })
			).rejects.toThrow(`write ${stage}`);
			expect(snapshotGraph()).toEqual(before);
		}
	);

	it('does not resurrect the deleted graph over a concurrent replacement session', async () => {
		harness.state.failAfterWrites = new Set([6]);
		const replacement: WorkoutSession = {
			...session,
			workoutId: 'winner-workout',
			workoutNameSnapshot: 'Concurrent winner',
			updatedAt: '2026-05-05T15:00:00.000Z'
		};
		harness.state.onWriteFailure = () => {
			harness.state.sessions.set(session.id, replacement);
		};

		await expect(
			deleteWorkoutSession(session.id, { status: session.status, updatedAt: session.updatedAt })
		).rejects.toThrow('Injected failure');
		expect(harness.state.sessions.get(session.id)).toEqual(replacement);
		expect(harness.state.sessionExercises.size).toBe(0);
		expect(harness.state.sessionSets.size).toBe(0);
	});
});
