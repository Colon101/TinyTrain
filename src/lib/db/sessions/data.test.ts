import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	Exercise,
	SessionExercise,
	SessionSet,
	SessionSummary,
	WorkoutSession
} from '../models';
import { getScheduledWorkoutSessionId } from './schedule-identity';

const runtimeHarness = vi.hoisted(() => {
	type State = {
		sessions: WorkoutSession[];
		sessionExercises: SessionExercise[];
		sessionSets: SessionSet[];
		exercises: Exercise[];
		onSessionRead?: (sessionId: string) => void;
		beforeSessionBulkGet?: () => Promise<void> | void;
		beforeSessionExerciseList?: () => Promise<void> | void;
	};
	const createState = (): State => ({
		sessions: [] as WorkoutSession[],
		sessionExercises: [] as SessionExercise[],
		sessionSets: [] as SessionSet[],
		exercises: [] as Exercise[]
	});
	const createDatabase = (state: State) => ({
		workoutSessions: {
			get: vi.fn(async (id: string) => {
				state.onSessionRead?.(id);
				return state.sessions.find((session) => session.id === id);
			}),
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
			bulkGet: vi.fn(async (ids: string[]) => {
				await state.beforeSessionBulkGet?.();
				return ids.map((id) => state.sessions.find((session) => session.id === id));
			}),
			delete: vi.fn()
		},
		sessionExercises: {
			toArray: vi.fn(async () => [...state.sessionExercises]),
			where: vi.fn((field: string) => ({
				equals: (value: string) => ({
					toArray: async () =>
						state.sessionExercises.filter((row) => row[field as keyof SessionExercise] === value),
					sortBy: async (sortField: keyof SessionExercise) =>
						state.sessionExercises
							.filter((row) => row[field as keyof SessionExercise] === value)
							.sort((first, second) =>
								String(first[sortField]).localeCompare(String(second[sortField]))
							)
				}),
				anyOf: (sessionIds: string[]) => ({
					toArray: async () => {
						await state.beforeSessionExerciseList?.();
						return state.sessionExercises.filter((row) =>
							sessionIds.includes(String(row[field as keyof SessionExercise]))
						);
					}
				})
			})),
			bulkDelete: vi.fn()
		},
		sessionSets: {
			where: vi.fn((field: string) => ({
				anyOf: (sessionExerciseIds: string[]) => ({
					toArray: async () =>
						state.sessionSets.filter((row) =>
							sessionExerciseIds.includes(String(row[field as keyof SessionSet]))
						)
				})
			})),
			bulkDelete: vi.fn()
		},
		exercises: {
			bulkGet: vi.fn(async (ids: string[]) =>
				ids.map((id) => state.exercises.find((exercise) => exercise.id === id))
			)
		}
	});
	const state = createState();
	const userBState = createState();
	const db = createDatabase(state);
	const userBDb = createDatabase(userBState);
	let activeDatabase = db;
	let activeUserId = 'user-1';
	let activeOperations = 0;
	let switchRequested = false;
	let releaseSwitch: (() => void) | undefined;
	const ambientDb = new Proxy({} as typeof db, {
		get: (_target, property) => {
			if (switchRequested) {
				throw new Error('The authenticated local database changed.');
			}

			return activeDatabase[property as keyof typeof activeDatabase];
		}
	});

	const runAuthenticatedDatabaseOperation = vi.fn(async function runOperation<T>(
		callback: (operation: {
			userId: string;
			generation: number;
			database: typeof db;
		}) => Promise<T> | T
	) {
		if (switchRequested) {
			throw new Error('The authenticated local database changed before the operation could start.');
		}

		const operation = { userId: activeUserId, generation: 1, database: activeDatabase };
		activeOperations += 1;

		try {
			return await callback(operation);
		} finally {
			activeOperations -= 1;

			if (activeOperations === 0) {
				releaseSwitch?.();
				releaseSwitch = undefined;
			}
		}
	});

	async function switchToUserB() {
		switchRequested = true;

		if (activeOperations > 0) {
			await new Promise<void>((resolve) => {
				releaseSwitch = resolve;
			});
		}

		activeDatabase = userBDb;
		activeUserId = 'user-2';
		switchRequested = false;
	}

	function resetIdentity() {
		activeDatabase = db;
		activeUserId = 'user-1';
		activeOperations = 0;
		switchRequested = false;
		releaseSwitch = undefined;
	}

	return {
		ambientDb,
		db,
		resetIdentity,
		runAuthenticatedDatabaseOperation,
		state,
		switchToUserB,
		userBDb,
		userBState
	};
});

vi.mock('../runtime', () => ({
	db: runtimeHarness.ambientDb,
	getActiveCloudUser: vi.fn(() => ({ isLoggedIn: true, userId: 'user-1' })),
	runAuthenticatedDatabaseOperation: runtimeHarness.runAuthenticatedDatabaseOperation
}));
vi.mock('../exercises', () => ({ listExerciseHistory: vi.fn(async () => []) }));

import {
	getCurrentInProgressSession,
	getDayOverview,
	getSessionOverview,
	getSessionSummariesByIds,
	listSessionCalendarRowsForWeek,
	listSessionExerciseDetails,
	listSessionSummariesForMonth
} from './data';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

function seedUserBWithSameIds() {
	runtimeHarness.userBState.sessions = [
		{
			...runtimeHarness.state.sessions[0],
			workoutId: 'workout-b',
			workoutNameSnapshot: 'User B workout'
		}
	];
	runtimeHarness.userBState.sessionExercises = [
		{
			...runtimeHarness.state.sessionExercises[0],
			workoutId: 'workout-b',
			exerciseNameSnapshot: 'User B exercise'
		}
	];
	runtimeHarness.userBState.sessionSets = [
		{
			...runtimeHarness.state.sessionSets[0],
			weight: 999,
			weightInput: '999',
			reps: 1,
			repsInput: '1'
		}
	];
	runtimeHarness.userBState.exercises = [
		{
			...runtimeHarness.state.exercises[0],
			name: 'User B exercise',
			normalizedName: 'user b exercise'
		}
	];
}

async function expectUserAGraphAcrossProjectionSummaryBoundary(
	query: () => Promise<SessionSummary | null>
) {
	runtimeHarness.state.sessions[0] = {
		...runtimeHarness.state.sessions[0],
		status: 'in_progress',
		completedAt: undefined
	};
	seedUserBWithSameIds();
	const reachedSummaryRead = deferred<void>();
	const releaseSummaryRead = deferred<void>();
	let summaryReadCount = 0;
	runtimeHarness.state.beforeSessionBulkGet = async () => {
		summaryReadCount += 1;

		if (summaryReadCount === 1) {
			reachedSummaryRead.resolve(undefined);
			await releaseSummaryRead.promise;
		}
	};

	const resultPromise = query();
	await reachedSummaryRead.promise;
	let switchSettled = false;
	const switchUser = runtimeHarness.switchToUserB().then(() => {
		switchSettled = true;
	});
	await Promise.resolve();

	expect(switchSettled).toBe(false);
	releaseSummaryRead.resolve(undefined);
	const summary = await resultPromise;
	await switchUser;

	expect(summary).toMatchObject({
		id: 'session-1',
		workoutNameSnapshot: 'Upper body',
		totalExercises: 1,
		totalSets: 2,
		totalVolume: 1000
	});
	expect(runtimeHarness.runAuthenticatedDatabaseOperation).toHaveBeenCalledTimes(1);
	expect(runtimeHarness.userBDb.workoutSessions.where).not.toHaveBeenCalled();
	expect(runtimeHarness.userBDb.workoutSessions.bulkGet).not.toHaveBeenCalled();
	expect(runtimeHarness.userBDb.sessionExercises.where).not.toHaveBeenCalled();
	expect(runtimeHarness.userBDb.sessionSets.where).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	runtimeHarness.resetIdentity();
	runtimeHarness.state.onSessionRead = undefined;
	runtimeHarness.state.beforeSessionBulkGet = undefined;
	runtimeHarness.state.beforeSessionExerciseList = undefined;
	runtimeHarness.userBState.onSessionRead = undefined;
	runtimeHarness.userBState.beforeSessionBulkGet = undefined;
	runtimeHarness.userBState.beforeSessionExerciseList = undefined;
	runtimeHarness.userBState.sessions = [];
	runtimeHarness.userBState.sessionExercises = [];
	runtimeHarness.userBState.sessionSets = [];
	runtimeHarness.userBState.exercises = [];
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
	runtimeHarness.state.exercises = [
		{
			id: 'exercise-1',
			name: 'Bench Press A',
			normalizedName: 'bench press a',
			unilateral: false,
			source: 'custom',
			archived: false,
			createdAt: '2026-05-01T10:00:00.000Z',
			updatedAt: '2026-05-01T10:00:00.000Z'
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

describe('authenticated session summary read chains', () => {
	it('keeps summary parent and child reads on user A while same-id user B waits', async () => {
		seedUserBWithSameIds();
		const reachedChildRead = deferred<void>();
		const releaseChildRead = deferred<void>();
		runtimeHarness.state.beforeSessionExerciseList = async () => {
			reachedChildRead.resolve(undefined);
			await releaseChildRead.promise;
		};

		const summariesPromise = getSessionSummariesByIds(['session-1']);
		await reachedChildRead.promise;
		let switchSettled = false;
		const switchUser = runtimeHarness.switchToUserB().then(() => {
			switchSettled = true;
		});
		await Promise.resolve();

		expect(switchSettled).toBe(false);
		releaseChildRead.resolve(undefined);
		const summaries = await summariesPromise;
		await switchUser;

		expect(summaries.get('session-1')).toMatchObject({
			id: 'session-1',
			workoutNameSnapshot: 'Upper body',
			totalExercises: 1,
			totalSets: 2,
			totalVolume: 1000
		});
		expect(runtimeHarness.runAuthenticatedDatabaseOperation).toHaveBeenCalledTimes(1);
		expect(runtimeHarness.userBDb.workoutSessions.bulkGet).not.toHaveBeenCalled();
		expect(runtimeHarness.userBDb.sessionExercises.where).not.toHaveBeenCalled();
		expect(runtimeHarness.userBDb.sessionSets.where).not.toHaveBeenCalled();
	});

	it.each<{
		name: string;
		query: () => Promise<SessionSummary | null>;
	}>([
		{
			name: 'current in-progress session',
			query: () => getCurrentInProgressSession()
		},
		{
			name: 'month listing',
			query: async () => (await listSessionSummariesForMonth(new Date(2026, 4, 1)))[0] ?? null
		},
		{
			name: 'week listing',
			query: async () => (await listSessionCalendarRowsForWeek(new Date(2026, 4, 5)))[0] ?? null
		},
		{
			name: 'day overview',
			query: async () => (await getDayOverview('2026-05-05')).session
		}
	])('keeps the $name projection and summary reads on one owner', async ({ query }) => {
		await expectUserAGraphAcrossProjectionSummaryBoundary(query);
	});
});

describe('getDayOverview', () => {
	it('returns every protected same-day session instead of silently collapsing one', async () => {
		runtimeHarness.state.sessions.push({
			...runtimeHarness.state.sessions[0],
			id: 'session-2',
			workoutId: 'workout-2',
			workoutNameSnapshot: 'Lower body'
		});

		const overview = await getDayOverview('2026-05-05');

		expect(overview.sessions.map((session) => session.id)).toEqual(['session-1', 'session-2']);
		expect(overview.session?.id).toBe('session-2');
	});

	it('hides a stale pristine plan without deleting its stored graph', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
		const stalePlan: WorkoutSession = {
			id: 'stale-plan',
			workoutId: 'workout-stale',
			workoutNameSnapshot: 'Stored plan',
			dayKey: '2026-07-14',
			status: 'planned',
			createdAt: '2026-07-14T08:00:00.000Z',
			updatedAt: '2026-07-14T08:00:00.000Z'
		};
		runtimeHarness.state.sessions = [stalePlan];
		runtimeHarness.state.sessionExercises = [];
		runtimeHarness.state.sessionSets = [];

		try {
			const overview = await getDayOverview(stalePlan.dayKey);

			expect(overview).toEqual({ dayKey: stalePlan.dayKey, session: null, sessions: [] });
			expect(runtimeHarness.state.sessions).toEqual([stalePlan]);
			expect(runtimeHarness.db.workoutSessions.delete).not.toHaveBeenCalled();
			expect(runtimeHarness.db.sessionExercises.bulkDelete).not.toHaveBeenCalled();
			expect(runtimeHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('reveals a quarantined offline fork after it starts and preserves all typed values', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
		const dayKey = '2026-07-15';
		const createdAt = '2026-07-15T08:00:00.000Z';
		const deterministicSessionId = getScheduledWorkoutSessionId('user-1', dayKey);
		const deterministicSession: WorkoutSession = {
			id: deterministicSessionId,
			workoutId: 'workout-a',
			workoutNameSnapshot: 'Workout A',
			dayKey,
			status: 'planned',
			createdAt,
			updatedAt: createdAt
		};
		const offlineSession: WorkoutSession = {
			...deterministicSession,
			id: 'offline-session',
			workoutId: 'workout-b',
			workoutNameSnapshot: 'Workout B'
		};
		const deterministicExercise: SessionExercise = {
			id: 'deterministic-exercise',
			sessionId: deterministicSession.id,
			workoutId: deterministicSession.workoutId,
			exerciseId: 'squat',
			exerciseNameSnapshot: 'Squat',
			order: 1,
			performedAt: createdAt,
			createdAt,
			updatedAt: createdAt
		};
		const offlineExercise: SessionExercise = {
			...deterministicExercise,
			id: 'offline-exercise',
			sessionId: offlineSession.id,
			workoutId: offlineSession.workoutId,
			exerciseId: 'deadlift',
			exerciseNameSnapshot: 'Deadlift'
		};
		const deterministicSet: SessionSet = {
			id: 'deterministic-set',
			sessionExerciseId: deterministicExercise.id,
			exerciseId: deterministicExercise.exerciseId,
			order: 1,
			side: 'bilateral',
			weightInput: '',
			repsInput: '',
			rirInput: '',
			createdAt,
			updatedAt: createdAt
		};
		const offlineSet: SessionSet = {
			...deterministicSet,
			id: 'offline-set',
			sessionExerciseId: offlineExercise.id,
			exerciseId: offlineExercise.exerciseId
		};
		runtimeHarness.state.sessions = [offlineSession, deterministicSession];
		runtimeHarness.state.sessionExercises = [offlineExercise, deterministicExercise];
		runtimeHarness.state.sessionSets = [offlineSet, deterministicSet];

		try {
			const beforeOfflineEdit = await getDayOverview(dayKey);
			expect(beforeOfflineEdit.sessions.map((session) => session.id)).toEqual([
				deterministicSessionId
			]);

			const editedAt = '2026-07-15T08:30:00.000Z';
			runtimeHarness.state.sessions[0] = {
				...offlineSession,
				status: 'in_progress',
				startedAt: editedAt,
				updatedAt: editedAt
			};
			runtimeHarness.state.sessionSets[0] = {
				...offlineSet,
				weightInput: '137.5',
				weight: 137.5,
				repsInput: '5',
				reps: 5,
				updatedAt: editedAt
			};

			const afterOfflineEdit = await getDayOverview(dayKey);

			expect(afterOfflineEdit.sessions).toEqual([
				expect.objectContaining({
					id: offlineSession.id,
					status: 'in_progress',
					totalSets: 1,
					totalReps: 5,
					totalVolume: 687.5
				})
			]);
			expect(runtimeHarness.state.sessions).toHaveLength(2);
			expect(runtimeHarness.state.sessionExercises).toHaveLength(2);
			expect(runtimeHarness.state.sessionSets[0]).toMatchObject({
				weightInput: '137.5',
				repsInput: '5'
			});
			expect(runtimeHarness.db.workoutSessions.delete).not.toHaveBeenCalled();
			expect(runtimeHarness.db.sessionExercises.bulkDelete).not.toHaveBeenCalled();
			expect(runtimeHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('listSessionExerciseDetails', () => {
	it('keeps an edited mismatched cohort stored but never renders it under the wrong parent', async () => {
		const session = runtimeHarness.state.sessions[0];
		const matchingExercise = runtimeHarness.state.sessionExercises[0];
		const matchingSetIds = runtimeHarness.state.sessionSets.map((sessionSet) => sessionSet.id);
		const matchingSet = runtimeHarness.state.sessionSets[0];
		const mismatchedExercise: SessionExercise = {
			...matchingExercise,
			id: 'recoverable-exercise',
			workoutId: 'other-workout',
			exerciseId: 'other-exercise',
			exerciseNameSnapshot: 'Recoverable exercise'
		};
		const mismatchedSet: SessionSet = {
			...matchingSet,
			id: 'recoverable-set',
			sessionExerciseId: mismatchedExercise.id,
			exerciseId: mismatchedExercise.exerciseId,
			weightInput: '200',
			weight: 200,
			updatedAt: '2026-05-05T10:45:00.000Z'
		};
		runtimeHarness.state.sessionExercises.push(mismatchedExercise);
		runtimeHarness.state.sessionSets.push(mismatchedSet);

		const details = await listSessionExerciseDetails(session.id);

		expect(details.map((row) => row.id)).toEqual([matchingExercise.id]);
		expect(details[0].sets.map((row) => row.id)).toEqual(matchingSetIds);
		expect(runtimeHarness.state.sessionExercises).toContainEqual(mismatchedExercise);
		expect(runtimeHarness.state.sessionSets).toContainEqual(mismatchedSet);
		expect(runtimeHarness.db.sessionExercises.bulkDelete).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
	});
});

describe('getSessionOverview authenticated identity', () => {
	it('keeps one user-A graph while user B with the same ids waits to become active', async () => {
		runtimeHarness.userBState.sessions = [
			{
				...runtimeHarness.state.sessions[0],
				workoutId: 'workout-b',
				workoutNameSnapshot: 'User B workout'
			}
		];
		runtimeHarness.userBState.sessionExercises = [
			{
				...runtimeHarness.state.sessionExercises[0],
				workoutId: 'workout-b',
				exerciseNameSnapshot: 'User B exercise'
			}
		];
		runtimeHarness.userBState.sessionSets = [
			{
				...runtimeHarness.state.sessionSets[0],
				weight: 999,
				weightInput: '999'
			}
		];
		runtimeHarness.userBState.exercises = [
			{
				...runtimeHarness.state.exercises[0],
				name: 'User B exercise',
				normalizedName: 'user b exercise'
			}
		];
		let observeParentRead!: () => void;
		const parentRead = new Promise<void>((resolve) => {
			observeParentRead = resolve;
		});
		let didObserveParent = false;
		runtimeHarness.state.onSessionRead = () => {
			if (!didObserveParent) {
				didObserveParent = true;
				observeParentRead();
			}
		};

		const overviewPromise = getSessionOverview('session-1');
		await parentRead;
		let switchSettled = false;
		const switchUser = runtimeHarness.switchToUserB().then(() => {
			switchSettled = true;
		});
		await Promise.resolve();

		expect(switchSettled).toBe(false);
		const overview = await overviewPromise;
		await switchUser;

		expect(overview?.summary).toMatchObject({
			id: 'session-1',
			workoutNameSnapshot: 'Upper body',
			totalVolume: 1000
		});
		expect(overview?.exercises).toEqual([
			expect.objectContaining({
				exerciseNameSnapshot: 'Bench Press',
				exercise: expect.objectContaining({ name: 'Bench Press A' })
			})
		]);
		expect(runtimeHarness.userBDb.workoutSessions.get).not.toHaveBeenCalled();
		expect(runtimeHarness.userBDb.sessionExercises.where).not.toHaveBeenCalled();
		expect(runtimeHarness.userBDb.sessionSets.where).not.toHaveBeenCalled();
	});
});
