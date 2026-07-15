import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutSession } from '../models';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		session: undefined as WorkoutSession | undefined,
		conflictingSessions: [] as WorkoutSession[],
		workoutUpdatedAt: '2026-05-01T10:00:00.000Z'
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
			}),
			where: vi.fn(() => ({
				equals: (dayKey: string) => ({
					toArray: async () =>
						[state.session, ...state.conflictingSessions].filter(
							(session): session is WorkoutSession => session?.dayKey === dayKey
						)
				})
			}))
		},
		sessionExercises: {
			get: vi.fn(async () => undefined),
			put: vi.fn(async () => undefined),
			where: vi.fn(() => ({
				equals: () => ({
					toArray: async () => [],
					sortBy: async () => []
				})
			}))
		},
		sessionSets: {},
		workoutExercises: {
			get: vi.fn(async () => undefined),
			put: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
			bulkDelete: vi.fn(async () => undefined),
			bulkPut: vi.fn(async () => undefined),
			bulkGet: vi.fn(async (ids: string[]) => ids.map(() => undefined)),
			where: vi.fn(() => ({ equals: () => ({ toArray: async () => [] }) }))
		},
		workouts: {
			get: vi.fn(async (id: string) => ({
				id,
				name: 'Upper body',
				normalizedName: 'upper body',
				archived: false,
				createdAt: '2026-05-01T10:00:00.000Z',
				updatedAt: state.workoutUpdatedAt
			})),
			put: vi.fn(async () => undefined),
			update: vi.fn(async (_id: string, patch: { updatedAt?: string }) => {
				if (patch.updatedAt) state.workoutUpdatedAt = patch.updatedAt;
				return 1;
			})
		},
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1) as () => Promise<unknown>;
			return callback();
		})
	};

	return { db, state };
});

const cleanupHarness = vi.hoisted(() => ({
	canAttempt: false,
	confirmFresh: true
}));

const authHarness = vi.hoisted(() => ({
	ensureDbOpen: vi.fn(async (): Promise<void> => undefined),
	userId: 'user-1'
}));

const draftHarness = vi.hoisted(() => {
	const state = { versions: [] as string[] };
	const flush = vi.fn(async (_sessionId: string, options: { clearDraft?: boolean } = {}) => {
		const snapshot = [...state.versions];

		if (options.clearDraft !== false) {
			state.versions = state.versions.filter((version) => !snapshot.includes(version));
		}
	});

	return {
		clear: vi.fn(() => {
			state.versions = [];
		}),
		flush,
		state
	};
});

const dataHarness = vi.hoisted(() => ({
	sessionExerciseDetails: [] as Array<{ sets: Array<Record<string, unknown>> }>
}));

vi.mock('../runtime', () => ({
	canAttemptSessionCleanup: vi.fn(() => cleanupHarness.canAttempt),
	confirmSessionCleanupIsFresh: vi.fn(async () => cleanupHarness.confirmFresh),
	db: runtimeHarness.db,
	ensureDbOpen: authHarness.ensureDbOpen,
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: authHarness.userId })),
	markStaleSessionCleanupCompleted: vi.fn(),
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn(async (callback) =>
		callback({ userId: authHarness.userId, generation: 1, database: runtimeHarness.db })
	),
	syncNow: vi.fn(async () => undefined),
	wasStaleSessionCleanupCompleted: vi.fn(() => false)
}));
vi.mock('../session-drafts', () => ({ clearSessionInputDraft: draftHarness.clear }));
vi.mock('../workouts', () => ({
	listWorkoutExercises: vi.fn(),
	syncWorkoutExercisesFromSession: vi.fn()
}));
vi.mock('./data', () => ({
	getSessionOverview: vi.fn(),
	listSessionExerciseDetails: vi.fn(async () => dataHarness.sessionExerciseDetails)
}));
vi.mock('./inputs', () => ({
	flushSessionInputDraft: draftHarness.flush,
	flushSessionInputDraftWithDatabase: vi.fn(
		async (_database, sessionId: string, options?: { clearDraft?: boolean }) =>
			draftHarness.flush(sessionId, options)
	)
}));
vi.mock('./seeding', () => ({
	buildSessionSeedSetRows: vi.fn(),
	deleteWorkoutSessionRows: vi.fn(),
	ensureEditableSessionSeedRows: vi.fn()
}));

import {
	abandonInactiveWorkoutSession,
	completeWorkoutSession,
	updateWorkoutSessionTiming
} from './lifecycle';

beforeEach(() => {
	vi.clearAllMocks();
	cleanupHarness.canAttempt = false;
	cleanupHarness.confirmFresh = true;
	authHarness.userId = 'user-1';
	authHarness.ensureDbOpen.mockResolvedValue(undefined);
	draftHarness.state.versions = [];
	dataHarness.sessionExerciseDetails = [];
	runtimeHarness.state.conflictingSessions = [];
	runtimeHarness.state.workoutUpdatedAt = '2026-05-01T10:00:00.000Z';
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
			updateWorkoutSessionTiming('session-1', '2026-05-05T09:30:00.000Z', undefined, {
				startedAt: '2026-05-05T10:00:00.000Z',
				completedAt: '2026-05-05T11:00:00.000Z'
			})
		).rejects.toThrow('End time is required for a completed session.');

		expect(runtimeHarness.db.transaction).not.toHaveBeenCalled();
		expect(runtimeHarness.state.session?.completedAt).toBe('2026-05-05T11:00:00.000Z');
	});

	it('rejects moving a session onto a day that already has a session', async () => {
		runtimeHarness.state.conflictingSessions = [
			{
				...runtimeHarness.state.session!,
				id: 'session-2'
			}
		];

		await expect(
			updateWorkoutSessionTiming(
				'session-1',
				'2026-05-05T09:30:00.000Z',
				'2026-05-05T10:30:00.000Z',
				{
					startedAt: '2026-05-05T10:00:00.000Z',
					completedAt: '2026-05-05T11:00:00.000Z'
				}
			)
		).rejects.toThrow('A session already exists for that day.');

		expect(runtimeHarness.db.workoutSessions.update).not.toHaveBeenCalled();
	});

	it('saves a same-tab timing edit when its base still matches', async () => {
		await updateWorkoutSessionTiming(
			'session-1',
			'2026-05-05T09:30:00.000Z',
			'2026-05-05T11:15:00.000Z',
			{
				startedAt: '2026-05-05T10:00:00.000Z',
				completedAt: '2026-05-05T11:00:00.000Z'
			}
		);

		expect(runtimeHarness.state.session).toMatchObject({
			startedAt: '2026-05-05T09:30:00.000Z',
			completedAt: '2026-05-05T11:15:00.000Z'
		});
	});

	it('merges disjoint edits from two tabs without restoring the stale field', async () => {
		const sharedBase = {
			startedAt: '2026-05-05T10:00:00.000Z',
			completedAt: '2026-05-05T11:00:00.000Z'
		};

		await updateWorkoutSessionTiming(
			'session-1',
			'2026-05-05T09:30:00.000Z',
			sharedBase.completedAt,
			sharedBase
		);
		await updateWorkoutSessionTiming(
			'session-1',
			sharedBase.startedAt,
			'2026-05-05T11:30:00.000Z',
			sharedBase
		);

		expect(runtimeHarness.state.session).toMatchObject({
			startedAt: '2026-05-05T09:30:00.000Z',
			completedAt: '2026-05-05T11:30:00.000Z'
		});
	});

	it('rejects a stale edit to a timing field instead of overwriting the winner', async () => {
		const sharedBase = {
			startedAt: '2026-05-05T10:00:00.000Z',
			completedAt: '2026-05-05T11:00:00.000Z'
		};

		await updateWorkoutSessionTiming(
			'session-1',
			sharedBase.startedAt,
			'2026-05-05T11:15:00.000Z',
			sharedBase
		);

		await expect(
			updateWorkoutSessionTiming(
				'session-1',
				sharedBase.startedAt,
				'2026-05-05T11:30:00.000Z',
				sharedBase
			)
		).rejects.toThrow('The session time changed while you were editing.');
		expect(runtimeHarness.state.session?.completedAt).toBe('2026-05-05T11:15:00.000Z');
	});
});

describe('completeWorkoutSession', () => {
	it('does not allow a planned session to skip the in-progress state', async () => {
		runtimeHarness.state.session = {
			...runtimeHarness.state.session!,
			status: 'planned',
			startedAt: undefined,
			completedAt: undefined
		};

		await expect(completeWorkoutSession('session-1')).rejects.toThrow(
			'Start the session before completing it.'
		);

		expect(runtimeHarness.db.workoutSessions.update).not.toHaveBeenCalled();
	});

	it('clears the flushed version but preserves a newer draft written during completion', async () => {
		runtimeHarness.state.session = {
			...runtimeHarness.state.session!,
			status: 'in_progress',
			completedAt: undefined
		};
		draftHarness.state.versions = ['old-version'];
		let releaseUpdate!: () => void;
		const updateBarrier = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async (id, patch) => {
			await updateBarrier;

			if (!runtimeHarness.state.session || runtimeHarness.state.session.id !== id) {
				return 0;
			}

			runtimeHarness.state.session = { ...runtimeHarness.state.session, ...patch };
			return 1;
		});

		const completion = completeWorkoutSession('session-1');
		await vi.waitFor(() => expect(runtimeHarness.db.workoutSessions.update).toHaveBeenCalledOnce());
		expect(draftHarness.state.versions).toEqual([]);

		draftHarness.state.versions = ['new-version'];
		releaseUpdate();
		await completion;

		expect(runtimeHarness.state.session?.status).toBe('completed');
		expect(draftHarness.state.versions).toEqual(['new-version']);
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});
});

describe('inactive session abandonment', () => {
	it('rejects a stale session id when the user changes while the database opens', async () => {
		let releaseOpen!: () => void;
		authHarness.ensureDbOpen.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseOpen = resolve;
				})
		);
		const abandonment = abandonInactiveWorkoutSession(
			'session-1',
			Date.parse('2026-05-05T14:00:00.000Z')
		);
		authHarness.userId = 'user-2';
		releaseOpen();

		await expect(abandonment).rejects.toThrow('signed-in user changed');
		expect(runtimeHarness.db.transaction).not.toHaveBeenCalled();
	});

	it('preserves a draft written after cleanup flushed its initiating snapshot', async () => {
		cleanupHarness.canAttempt = true;
		runtimeHarness.state.session = {
			...runtimeHarness.state.session!,
			status: 'in_progress',
			completedAt: undefined,
			updatedAt: '2026-05-05T10:00:00.000Z'
		};
		dataHarness.sessionExerciseDetails = [
			{
				sets: [
					{
						id: 'set-1',
						createdAt: '2026-05-05T10:00:00.000Z',
						updatedAt: '2026-05-05T10:00:00.000Z'
					}
				]
			}
		];
		draftHarness.state.versions = ['old-version'];
		let releaseUpdate!: () => void;
		const updateBarrier = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async (id, patch) => {
			await updateBarrier;

			if (!runtimeHarness.state.session || runtimeHarness.state.session.id !== id) {
				return 0;
			}

			runtimeHarness.state.session = { ...runtimeHarness.state.session, ...patch };
			return 1;
		});

		const abandonment = abandonInactiveWorkoutSession(
			'session-1',
			Date.parse('2026-05-05T14:00:00.000Z')
		);
		await vi.waitFor(() => expect(runtimeHarness.db.workoutSessions.update).toHaveBeenCalledOnce());
		expect(draftHarness.state.versions).toEqual([]);

		draftHarness.state.versions = ['new-version'];
		releaseUpdate();
		await expect(abandonment).resolves.toBe(true);

		expect(runtimeHarness.state.session?.status).toBe('abandoned');
		expect(draftHarness.state.versions).toEqual(['new-version']);
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});
});
