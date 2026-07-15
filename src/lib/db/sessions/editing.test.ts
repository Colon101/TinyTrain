import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompensationJournalStorage } from '../compensation-journal';
import type {
	Exercise,
	SessionExercise,
	SessionSet,
	SessionStatus,
	WorkoutSession
} from '../models';

class MemoryStorage implements CompensationJournalStorage {
	readonly values = new Map<string, string>();
	failWrites = false;

	get length() {
		return this.values.size;
	}

	key(index: number) {
		return [...this.values.keys()][index] ?? null;
	}

	getItem(key: string) {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string) {
		if (this.failWrites) throw new Error('storage write failed');
		this.values.set(key, value);
	}

	removeItem(key: string) {
		this.values.delete(key);
	}
}

const runtimeHarness = vi.hoisted(() => {
	const state = {
		sets: [] as SessionSet[],
		deletedSets: new Map<string, SessionSet>(),
		sessionExercise: undefined as SessionExercise | undefined,
		additionalSessionExercises: [] as SessionExercise[],
		deletedSessionExercises: new Map<string, SessionExercise>(),
		workoutSession: undefined as WorkoutSession | undefined
	};
	const getSessionExercises = () => [
		...(state.sessionExercise ? [state.sessionExercise] : []),
		...state.additionalSessionExercises
	];
	const setSessionExercises = (sessionExercises: SessionExercise[]) => {
		state.sessionExercise = sessionExercises[0] ? { ...sessionExercises[0] } : undefined;
		state.additionalSessionExercises = sessionExercises
			.slice(1)
			.map((sessionExercise) => ({ ...sessionExercise }));
	};
	const upsertSessionExercises = (sessionExercises: SessionExercise[]) => {
		const sessionExerciseById = new Map(
			getSessionExercises().map((sessionExercise) => [sessionExercise.id, sessionExercise])
		);

		for (const sessionExercise of sessionExercises) {
			sessionExerciseById.set(sessionExercise.id, { ...sessionExercise });
			state.deletedSessionExercises.delete(sessionExercise.id);
		}

		setSessionExercises([...sessionExerciseById.values()]);
	};
	let releaseTransaction = () => {};
	let transactionBarrier: Promise<void> = Promise.resolve();
	const resetTransactionBarrier = () => {
		transactionBarrier = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
	};
	const sessionSets = {
		getSyncState: vi.fn(async (id: string) => {
			const liveRow = state.sets.find((candidate) => candidate.id === id);

			if (liveRow) {
				return { row: { ...liveRow }, deleted: false };
			}

			const deletedRow = state.deletedSets.get(id);
			return deletedRow ? { row: { ...deletedRow }, deleted: true } : undefined;
		}),
		get: vi.fn(async (id: string) => {
			const sessionSet = state.sets.find((candidate) => candidate.id === id);
			return sessionSet ? { ...sessionSet } : undefined;
		}),
		bulkGet: vi.fn(async (ids: string[]) =>
			ids.map((id) => {
				const sessionSet = state.sets.find((candidate) => candidate.id === id);
				return sessionSet ? { ...sessionSet } : undefined;
			})
		),
		put: vi.fn(async (sessionSet: SessionSet) => {
			const index = state.sets.findIndex((candidate) => candidate.id === sessionSet.id);

			if (index === -1) {
				state.sets.push({ ...sessionSet });
			} else {
				state.sets[index] = { ...sessionSet };
			}
			state.deletedSets.delete(sessionSet.id);

			return sessionSet.id;
		}),
		bulkPut: vi.fn(async (sessionSets: SessionSet[]) => {
			for (const sessionSet of sessionSets) {
				const index = state.sets.findIndex((candidate) => candidate.id === sessionSet.id);

				if (index === -1) {
					state.sets.push({ ...sessionSet });
				} else {
					state.sets[index] = { ...sessionSet };
				}
				state.deletedSets.delete(sessionSet.id);
			}

			return sessionSets.map((sessionSet) => sessionSet.id);
		}),
		delete: vi.fn(async (id: string) => {
			const deletedRow = state.sets.find((candidate) => candidate.id === id);
			if (deletedRow) {
				state.deletedSets.set(id, { ...deletedRow });
			}
			state.sets = state.sets.filter((candidate) => candidate.id !== id);
		}),
		bulkDelete: vi.fn(async (ids: string[]) => {
			const idSet = new Set(ids);
			for (const deletedRow of state.sets.filter((candidate) => idSet.has(candidate.id))) {
				state.deletedSets.set(deletedRow.id, { ...deletedRow });
			}
			state.sets = state.sets.filter((candidate) => !idSet.has(candidate.id));
		}),
		bulkAdd: vi.fn(async (sessionSets: SessionSet[]) => {
			if (sessionSets.some((sessionSet) => state.deletedSets.has(sessionSet.id))) {
				throw new Error('session set tombstone collision');
			}
			state.sets.push(...sessionSets.map((sessionSet) => ({ ...sessionSet })));
		}),
		update: vi.fn(async (id: string, patch: Partial<SessionSet>) => {
			const index = state.sets.findIndex((candidate) => candidate.id === id);

			if (index === -1) {
				return 0;
			}

			state.sets[index] = { ...state.sets[index], ...patch };
			return 1;
		}),
		where: vi.fn((field: keyof SessionSet) => ({
			equals: (value: unknown) => ({
				toArray: async () =>
					state.sets
						.filter((candidate) => candidate[field] === value)
						.map((candidate) => ({ ...candidate }))
			}),
			anyOf: (values: unknown[]) => ({
				toArray: async () =>
					state.sets
						.filter((candidate) => values.includes(candidate[field]))
						.map((candidate) => ({ ...candidate }))
			})
		}))
	};
	const sessionExercises = {
		getSyncState: vi.fn(async (id: string) => {
			const liveRow = getSessionExercises().find((candidate) => candidate.id === id);

			if (liveRow) {
				return { row: { ...liveRow }, deleted: false };
			}

			const deletedRow = state.deletedSessionExercises.get(id);
			return deletedRow ? { row: { ...deletedRow }, deleted: true } : undefined;
		}),
		get: vi.fn(async (id: string) => {
			const sessionExercise = getSessionExercises().find((candidate) => candidate.id === id);
			return sessionExercise ? { ...sessionExercise } : undefined;
		}),
		bulkGet: vi.fn(async (ids: string[]) =>
			ids.map((id) => {
				const sessionExercise = getSessionExercises().find((candidate) => candidate.id === id);
				return sessionExercise ? { ...sessionExercise } : undefined;
			})
		),
		put: vi.fn(async (sessionExercise: SessionExercise) => {
			upsertSessionExercises([sessionExercise]);
			return sessionExercise.id;
		}),
		bulkPut: vi.fn(async (sessionExerciseRows: SessionExercise[]) => {
			upsertSessionExercises(sessionExerciseRows);
			return sessionExerciseRows.map((sessionExercise) => sessionExercise.id);
		}),
		update: vi.fn(async (id: string, patch: Partial<SessionExercise>) => {
			if (state.sessionExercise?.id === id) {
				state.sessionExercise = { ...state.sessionExercise, ...patch };
				return 1;
			}

			const index = state.additionalSessionExercises.findIndex((candidate) => candidate.id === id);

			if (index === -1) {
				return 0;
			}

			state.additionalSessionExercises[index] = {
				...state.additionalSessionExercises[index],
				...patch
			};
			return 1;
		}),
		delete: vi.fn(async (id: string) => {
			const deletedRow = getSessionExercises().find((candidate) => candidate.id === id);
			if (deletedRow) {
				state.deletedSessionExercises.set(id, { ...deletedRow });
			}
			setSessionExercises(getSessionExercises().filter((candidate) => candidate.id !== id));
		}),
		bulkDelete: vi.fn(async (ids: string[]) => {
			for (const deletedRow of getSessionExercises().filter((candidate) =>
				ids.includes(candidate.id)
			)) {
				state.deletedSessionExercises.set(deletedRow.id, { ...deletedRow });
			}
			setSessionExercises(getSessionExercises().filter((candidate) => !ids.includes(candidate.id)));
		}),
		bulkAdd: vi.fn(async (sessionExerciseRows: SessionExercise[]) => {
			if (
				sessionExerciseRows.some((sessionExercise) =>
					state.deletedSessionExercises.has(sessionExercise.id)
				)
			) {
				throw new Error('session exercise tombstone collision');
			}
			upsertSessionExercises(sessionExerciseRows);
			return sessionExerciseRows.map((sessionExercise) => sessionExercise.id);
		}),
		where: vi.fn((field: keyof SessionExercise) => ({
			equals: (value: unknown) => ({
				toArray: async () =>
					getSessionExercises()
						.filter((sessionExercise) => sessionExercise[field] === value)
						.map((sessionExercise) => ({ ...sessionExercise })),
				sortBy: async (sortField: keyof SessionExercise) =>
					getSessionExercises()
						.filter((sessionExercise) => sessionExercise[field] === value)
						.map((sessionExercise) => ({ ...sessionExercise }))
						.sort((first, second) => Number(first[sortField] ?? 0) - Number(second[sortField] ?? 0))
			})
		}))
	};
	const workoutSessions = {
		get: vi.fn(async (id: string) =>
			state.workoutSession?.id === id ? { ...state.workoutSession } : undefined
		),
		put: vi.fn(async (workoutSession: WorkoutSession) => {
			state.workoutSession = { ...workoutSession };
			return workoutSession.id;
		}),
		update: vi.fn(async (id: string, patch: Partial<WorkoutSession>) => {
			if (state.workoutSession?.id !== id) {
				return 0;
			}

			state.workoutSession = { ...state.workoutSession, ...patch };
			return 1;
		})
	};
	const db = {
		sessionSets,
		sessionExercises,
		workoutSessions,
		transaction: vi.fn(async (_mode: string, ...args: unknown[]) => {
			const callback = args.at(-1);

			if (typeof callback !== 'function') {
				throw new Error('Expected a transaction callback.');
			}

			await transactionBarrier;
			return callback();
		})
	};
	const operation = {
		userId: 'owner-1',
		generation: 1,
		database: db
	};

	return {
		db,
		operation,
		state,
		resetTransactionBarrier,
		releaseTransaction: () => releaseTransaction()
	};
});

const draftHarness = vi.hoisted(() => {
	const state = {
		sessionId: 'session-1',
		sets: {} as Record<string, Record<string, string | number>>
	};
	const removeSets = vi.fn((sessionId: string, sessionSetIds: string[]) => {
		if (sessionId !== state.sessionId) {
			return;
		}

		const removedIdSet = new Set(sessionSetIds);
		state.sets = Object.fromEntries(
			Object.entries(state.sets).filter(([sessionSetId]) => !removedIdSet.has(sessionSetId))
		);
	});
	const read = vi.fn((sessionId: string) =>
		sessionId === state.sessionId
			? {
					sessionId,
					sets: structuredClone(state.sets),
					updatedAt: 1
				}
			: null
	);
	const finalize = vi.fn(
		(snapshot: { sessionId: string; sets: Record<string, Record<string, string | number>> }) => {
			if (snapshot.sessionId !== state.sessionId) {
				return false;
			}

			state.sets = Object.fromEntries(
				Object.entries(state.sets).filter(
					([sessionSetId, currentSet]) =>
						JSON.stringify(currentSet) !== JSON.stringify(snapshot.sets[sessionSetId])
				)
			);
			return true;
		}
	);
	const capture = vi.fn((sessionId: string, sessionSetIds?: string[]) => {
		const draft = read(sessionId);
		const sessionSetIdSet = sessionSetIds ? new Set(sessionSetIds) : null;
		const fields = Object.entries(draft?.sets ?? {}).flatMap(([sessionSetId, draftSet]) => {
			if (sessionSetIdSet && !sessionSetIdSet.has(sessionSetId)) {
				return [];
			}

			return (['weight', 'reps', 'rir'] as const).flatMap((field) => {
				const fieldKey = `${field}Input`;

				if (!Object.hasOwn(draftSet, fieldKey)) {
					return [];
				}

				return [
					{
						sessionSetId,
						field,
						fieldVersion: (draftSet[`${fieldKey}Version`] as string | undefined) ?? null,
						rawValue: (draftSet[fieldKey] as string | undefined) ?? '',
						baseValue: (draftSet[`${fieldKey}Base`] as string | undefined) ?? null,
						intentAt: (draftSet[`${fieldKey}IntentAt`] as number | undefined) ?? null
					}
				];
			});
		});

		return {
			sessionId,
			ownerId: 'owner-1',
			scope: sessionSetIds ? ('sets' as const) : ('all' as const),
			sessionSetIds: sessionSetIds ? [...new Set(sessionSetIds)].sort() : [],
			fields: fields.sort(
				(first, second) =>
					first.sessionSetId.localeCompare(second.sessionSetId) ||
					first.field.localeCompare(second.field)
			),
			draft
		};
	});
	const matches = vi.fn((snapshot: ReturnType<typeof capture>) => {
		const current = capture(
			snapshot.sessionId,
			snapshot.scope === 'sets' ? snapshot.sessionSetIds : undefined
		);

		return (
			current.ownerId === snapshot.ownerId &&
			JSON.stringify(current.fields) === JSON.stringify(snapshot.fields)
		);
	});
	const finalizeSets = vi.fn((snapshot: ReturnType<typeof capture>, sessionSetIds: string[]) => {
		if (!snapshot.draft) {
			return true;
		}

		const unchangedIds = sessionSetIds.filter(
			(sessionSetId) =>
				JSON.stringify(state.sets[sessionSetId]) ===
				JSON.stringify(snapshot.draft?.sets[sessionSetId])
		);
		removeSets(snapshot.sessionId, unchangedIds);
		return true;
	});

	return {
		state,
		capture,
		clear: vi.fn(),
		finalize,
		finalizeSets,
		matches,
		read,
		removeSets
	};
});

const exerciseHarness = vi.hoisted(() => ({
	get: vi.fn()
}));

const workoutHarness = vi.hoisted(() => ({
	list: vi.fn()
}));

const seedingHarness = vi.hoisted(() => ({
	buildRows: vi.fn(),
	buildSessionRows: vi.fn(),
	nextLogicalSetId: 1
}));

vi.mock('../runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn((callback) => callback({ ...runtimeHarness.operation }))
}));

vi.mock('../exercises', () => ({
	BASELINE_EXERCISE_BY_ID: new Map(),
	BASELINE_EXERCISE_BY_NORMALIZED_NAME: new Map(),
	getExercise: exerciseHarness.get
}));

vi.mock('../session-drafts', () => ({
	captureSessionInputDraftVersionSnapshot: draftHarness.capture,
	clearSessionInputDraft: draftHarness.clear,
	finalizeSessionInputDraftIfUnchanged: draftHarness.finalize,
	finalizeSessionInputDraftSetsIfUnchanged: draftHarness.finalizeSets,
	readSessionInputDraft: draftHarness.read,
	removeSessionInputDraftSets: draftHarness.removeSets,
	sessionInputDraftVersionSnapshotMatches: draftHarness.matches
}));

vi.mock('../workouts', () => ({ listWorkoutExercises: workoutHarness.list }));
vi.mock('./inputs', () => ({ updateSessionSetInputs: vi.fn() }));
vi.mock('./seeding', () => ({
	buildSeedSessionSetRows: seedingHarness.buildRows,
	buildSessionSeedSetRows: seedingHarness.buildSessionRows
}));

import { getAddedSessionExerciseId, getResetSessionExerciseId } from './schedule-identity';
import {
	addExercisesToSession,
	addSessionSetRow,
	captureSessionExerciseDestructiveEditExpectation,
	captureSessionResetExpectation,
	captureSessionSetRemovalExpectation,
	removeSessionExercise,
	removeSessionSetRow,
	repairSessionCreationCompensation,
	repairSessionEditCompensation,
	reorderSessionExercises,
	replaceSessionExercise,
	resetSessionInputs,
	SessionCreationCompensationError,
	SessionEditCompensationError,
	SessionReorderCompensationError,
	type SessionDestructiveEditExpectation
} from './editing';

const timestamp = '2026-07-15T12:00:00.000Z';
const renderedInProgress = { status: 'in_progress', allowCompleted: false } as const;
let storage: MemoryStorage;

function createSessionExercise(id: string, order: number): SessionExercise {
	return {
		id,
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: `exercise-${id.toLowerCase()}`,
		exerciseNameSnapshot: `Exercise ${id}`,
		order,
		performedAt: timestamp,
		createdAt: timestamp,
		updatedAt: timestamp
	};
}

function setSessionExerciseOrder(ids: string[]) {
	const sessionExercises = ids.map((id, index) => createSessionExercise(id, index + 1));
	runtimeHarness.state.sessionExercise = sessionExercises[0];
	runtimeHarness.state.additionalSessionExercises = sessionExercises.slice(1);
}

function readSessionExerciseOrder() {
	return [
		...(runtimeHarness.state.sessionExercise ? [runtimeHarness.state.sessionExercise] : []),
		...runtimeHarness.state.additionalSessionExercises
	]
		.sort((first, second) => first.order - second.order)
		.map((sessionExercise) => sessionExercise.id);
}

function applySessionExercisePatch(id: string, patch: Partial<SessionExercise>) {
	if (runtimeHarness.state.sessionExercise?.id === id) {
		runtimeHarness.state.sessionExercise = {
			...runtimeHarness.state.sessionExercise,
			...patch
		};
		return 1;
	}

	const index = runtimeHarness.state.additionalSessionExercises.findIndex(
		(sessionExercise) => sessionExercise.id === id
	);

	if (index === -1) {
		return 0;
	}

	runtimeHarness.state.additionalSessionExercises[index] = {
		...runtimeHarness.state.additionalSessionExercises[index],
		...patch
	};
	return 1;
}

function snapshotPersistedSessionGraph() {
	return structuredClone({
		session: runtimeHarness.state.workoutSession,
		exercises: [
			...(runtimeHarness.state.sessionExercise ? [runtimeHarness.state.sessionExercise] : []),
			...runtimeHarness.state.additionalSessionExercises
		].sort((first, second) => first.id.localeCompare(second.id)),
		sets: [...runtimeHarness.state.sets].sort((first, second) => first.id.localeCompare(second.id))
	});
}

function createSet(order: number, side: 'left' | 'right'): SessionSet {
	return {
		id: `set-${order}-${side}`,
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order,
		side,
		createdAt: timestamp,
		updatedAt: timestamp
	};
}

function setSessionStatus(status: SessionStatus) {
	runtimeHarness.state.workoutSession = {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Push',
		dayKey: '2026-07-15',
		startedAt: timestamp,
		completedAt: status === 'completed' || status === 'abandoned' ? timestamp : undefined,
		status,
		createdAt: timestamp,
		updatedAt: timestamp
	};
}

beforeEach(() => {
	storage = new MemoryStorage();
	vi.stubGlobal('localStorage', storage);
	vi.clearAllMocks();
	runtimeHarness.operation.userId = 'owner-1';
	runtimeHarness.operation.generation = 1;
	runtimeHarness.operation.database = runtimeHarness.db;
	runtimeHarness.resetTransactionBarrier();
	runtimeHarness.state.deletedSets.clear();
	runtimeHarness.state.deletedSessionExercises.clear();
	runtimeHarness.state.sessionExercise = {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'exercise-1',
		exerciseNameSnapshot: 'Single-arm row',
		order: 1,
		performedAt: timestamp,
		createdAt: timestamp,
		updatedAt: timestamp
	};
	runtimeHarness.state.additionalSessionExercises = [];
	runtimeHarness.state.sets = [
		createSet(1, 'left'),
		createSet(1, 'right'),
		createSet(2, 'left'),
		createSet(2, 'right'),
		createSet(3, 'left'),
		createSet(3, 'right')
	];
	draftHarness.state.sessionId = 'session-1';
	draftHarness.state.sets = Object.fromEntries([
		...runtimeHarness.state.sets.map((sessionSet) => [
			sessionSet.id,
			{ weightInput: `${sessionSet.order}01`, updatedAt: 1 }
		]),
		['unrelated-set', { repsInput: '12', updatedAt: 2 }]
	]);
	setSessionStatus('in_progress');
	exerciseHarness.get.mockImplementation(
		async (exerciseId: string) =>
			({
				id: exerciseId,
				name: exerciseId === 'exercise-1' ? 'Single-arm row' : 'Bench press',
				normalizedName: exerciseId === 'exercise-1' ? 'single-arm row' : 'bench press',
				unilateral: exerciseId === 'exercise-1',
				source: 'custom',
				archived: false,
				createdAt: timestamp,
				updatedAt: timestamp
			}) satisfies Exercise
	);
	workoutHarness.list.mockResolvedValue([
		{
			id: 'workout-exercise-1',
			workoutId: 'workout-1',
			exerciseId: 'exercise-2',
			order: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			exercise: {
				id: 'exercise-2',
				name: 'Bench press',
				normalizedName: 'bench press',
				unilateral: false,
				source: 'custom',
				archived: false,
				createdAt: timestamp,
				updatedAt: timestamp
			}
		}
	]);
	seedingHarness.nextLogicalSetId = 1;
	seedingHarness.buildRows.mockImplementation(
		(
			sessionExerciseId: string,
			exerciseId: string,
			_orderCount: number,
			unilateral: boolean,
			now: string
		) => {
			const logicalSetId = `added-set-${seedingHarness.nextLogicalSetId++}`;

			return (unilateral ? (['right', 'left'] as const) : (['bilateral'] as const)).map((side) => ({
				id: `${logicalSetId}:${side}`,
				sessionExerciseId,
				exerciseId,
				order: 1,
				side,
				weightInput: '',
				repsInput: '',
				rirInput: '',
				createdAt: now,
				updatedAt: now
			}));
		}
	);
	seedingHarness.buildSessionRows.mockImplementation(
		(sessionExerciseId: string, exercise: { id: string }, now: string) => [
			{
				id: `replacement-set-${sessionExerciseId}`,
				sessionExerciseId,
				exerciseId: exercise.id,
				order: 1,
				side: 'bilateral',
				createdAt: now,
				updatedAt: now
			}
		]
	);
});

describe('structural edit status compare-and-set', () => {
	const mutationCases: Array<{
		name: string;
		prepare?: () => void;
		run: () => Promise<unknown>;
	}> = [
		{
			name: 'exercise reorder',
			prepare: () => {
				runtimeHarness.state.additionalSessionExercises = [
					createSessionExercise('session-exercise-2', 2)
				];
			},
			run: () =>
				reorderSessionExercises(
					'session-1',
					['session-exercise-2', 'session-exercise-1'],
					renderedInProgress
				)
		},
		{
			name: 'exercise replacement',
			run: () => replaceSessionExercise('session-exercise-1', 'exercise-2', renderedInProgress)
		},
		{
			name: 'exercise removal',
			run: () => removeSessionExercise('session-exercise-1', renderedInProgress)
		},
		{
			name: 'exercise addition',
			run: () => addExercisesToSession('session-1', ['exercise-2'], renderedInProgress)
		},
		{
			name: 'set addition',
			run: () => addSessionSetRow('session-exercise-1', renderedInProgress)
		},
		{
			name: 'set removal',
			run: () => removeSessionSetRow('set-2-left', renderedInProgress)
		}
	];

	describe.each(['completed', 'abandoned'] as const)(
		'when another tab marks the session %s',
		(terminalStatus) => {
			it.each(mutationCases)(
				'rejects stale $name without changing rows or drafts',
				async (testCase) => {
					testCase.prepare?.();
					const originalDraftSets = structuredClone(draftHarness.state.sets);
					const mutation = testCase.run();
					await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

					setSessionStatus(terminalStatus);
					const terminalGraph = snapshotPersistedSessionGraph();
					runtimeHarness.releaseTransaction();

					await expect(mutation).rejects.toThrow();
					expect(snapshotPersistedSessionGraph()).toEqual(terminalGraph);
					expect(draftHarness.state.sets).toEqual(originalDraftSets);
					expect(draftHarness.removeSets).not.toHaveBeenCalled();
					expect(draftHarness.clear).not.toHaveBeenCalled();
				}
			);
		}
	);

	it('allows a completed-session mutation only with the captured edit-mode capability', async () => {
		setSessionStatus('completed');
		const reorder = reorderSessionExercises('session-1', ['session-exercise-1'], {
			status: 'completed',
			allowCompleted: true
		});
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(reorder).resolves.toBeUndefined();
	});

	it('rejects when a planned session started after the tab rendered it', async () => {
		setSessionStatus('planned');
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		const reorder = reorderSessionExercises('session-1', ['session-exercise-1'], {
			status: 'planned',
			allowCompleted: false
		});
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		setSessionStatus('in_progress');
		const startedGraph = snapshotPersistedSessionGraph();
		runtimeHarness.releaseTransaction();

		await expect(reorder).rejects.toThrow('status changed');
		expect(snapshotPersistedSessionGraph()).toEqual(startedGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
	});

	it('rejects a completed-session mutation initiated outside completed edit mode', async () => {
		setSessionStatus('completed');
		const originalGraph = snapshotPersistedSessionGraph();
		const reorder = reorderSessionExercises('session-1', ['session-exercise-1'], {
			status: 'completed',
			allowCompleted: false
		});
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(reorder).rejects.toThrow('completed-session edit mode');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
	});

	it('never allows structural edits to abandoned sessions', async () => {
		setSessionStatus('abandoned');
		const originalGraph = snapshotPersistedSessionGraph();
		const reorder = reorderSessionExercises('session-1', ['session-exercise-1'], {
			status: 'abandoned',
			allowCompleted: true
		});
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(reorder).rejects.toThrow('Abandoned sessions');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
	});
});

describe('destructive edit graph and draft compare-and-set', () => {
	const destructiveCases: Array<{
		name: string;
		targetSessionSetId: string;
		capture: () => Promise<SessionDestructiveEditExpectation>;
		run: (expectation: SessionDestructiveEditExpectation) => Promise<unknown>;
	}> = [
		{
			name: 'exercise replacement',
			targetSessionSetId: 'set-1-left',
			capture: () =>
				captureSessionExerciseDestructiveEditExpectation('session-exercise-1', {
					activeSetsOnly: true
				}),
			run: (expectation) =>
				replaceSessionExercise('session-exercise-1', 'exercise-2', renderedInProgress, expectation)
		},
		{
			name: 'exercise removal',
			targetSessionSetId: 'set-1-left',
			capture: () => captureSessionExerciseDestructiveEditExpectation('session-exercise-1'),
			run: (expectation) =>
				removeSessionExercise('session-exercise-1', renderedInProgress, expectation)
		},
		{
			name: 'logical set removal',
			targetSessionSetId: 'set-2-right',
			capture: () => captureSessionSetRemovalExpectation('set-2-left'),
			run: (expectation) => removeSessionSetRow('set-2-left', renderedInProgress, expectation)
		},
		{
			name: 'session reset',
			targetSessionSetId: 'set-3-left',
			capture: () => captureSessionResetExpectation('session-1'),
			run: (expectation) => resetSessionInputs('session-1', expectation)
		}
	];

	it.each(destructiveCases)(
		'rejects $name when another tab durably journals input before the DB save',
		async (testCase) => {
			const expectation = await testCase.capture();
			const originalGraph = snapshotPersistedSessionGraph();
			const mutation = testCase.run(expectation);
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			draftHarness.state.sets[testCase.targetSessionSetId] = {
				weightInput: '225',
				weightInputBase: '205',
				weightInputIntentAt: 4,
				weightInputVersion: 'other-tab-version',
				updatedAt: 4
			};
			runtimeHarness.releaseTransaction();

			await expect(mutation).rejects.toThrow('changed in another tab');
			expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
			expect(draftHarness.state.sets[testCase.targetSessionSetId]).toEqual(
				expect.objectContaining({
					weightInput: '225',
					weightInputVersion: 'other-tab-version'
				})
			);
			expect(draftHarness.finalizeSets).not.toHaveBeenCalled();
			expect(draftHarness.finalize).not.toHaveBeenCalled();
		}
	);

	it.each(destructiveCases)(
		'rejects $name when a DB input commit lands before the mutation lock',
		async (testCase) => {
			const expectation = await testCase.capture();
			const originalDraftSets = structuredClone(draftHarness.state.sets);
			const mutation = testCase.run(expectation);
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			const targetIndex = runtimeHarness.state.sets.findIndex(
				({ id }) => id === testCase.targetSessionSetId
			);
			runtimeHarness.state.sets[targetIndex] = {
				...runtimeHarness.state.sets[targetIndex],
				repsInput: '13',
				updatedAt: '2026-07-15T12:01:00.000Z'
			};
			const committedGraph = snapshotPersistedSessionGraph();
			runtimeHarness.releaseTransaction();

			await expect(mutation).rejects.toThrow('changed in another tab');
			expect(snapshotPersistedSessionGraph()).toEqual(committedGraph);
			expect(draftHarness.state.sets).toEqual(originalDraftSets);
			expect(draftHarness.finalizeSets).not.toHaveBeenCalled();
			expect(draftHarness.finalize).not.toHaveBeenCalled();
		}
	);
});

describe('creation-side session edit compensation', () => {
	const exerciseFailureStages: Array<{
		name: string;
		injectFailure: () => void;
	}> = [
		{
			name: 'generated exercise insert',
			injectFailure: () => {
				runtimeHarness.db.sessionExercises.bulkAdd.mockImplementationOnce(
					async (sessionExercises: SessionExercise[]) => {
						runtimeHarness.state.additionalSessionExercises.push({ ...sessionExercises[0] });
						throw new Error('exercise insert failed after writing');
					}
				);
			}
		},
		{
			name: 'seed-set insert',
			injectFailure: () => {
				runtimeHarness.db.sessionSets.bulkAdd.mockImplementationOnce(
					async (sessionSets: SessionSet[]) => {
						runtimeHarness.state.sets.push({ ...sessionSets[0] });
						throw new Error('seed set insert failed after writing');
					}
				);
			}
		},
		{
			name: 'session metadata update',
			injectFailure: () => {
				runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
					async (id: string, patch: Partial<WorkoutSession>) => {
						if (runtimeHarness.state.workoutSession?.id === id) {
							runtimeHarness.state.workoutSession = {
								...runtimeHarness.state.workoutSession,
								...patch
							};
						}

						throw new Error('session metadata failed after writing');
					}
				);
			}
		}
	];

	it.each(exerciseFailureStages)(
		'fully removes a failed multi-exercise graph after the $name and lets retry converge',
		async ({ injectFailure }) => {
			const originalGraph = snapshotPersistedSessionGraph();
			const originalDraftSets = structuredClone(draftHarness.state.sets);
			const baseRevision = runtimeHarness.state.workoutSession!.updatedAt;
			const expectedExerciseIds = ['exercise-2', 'exercise-3'].map((exerciseId) =>
				getAddedSessionExerciseId('session-1', exerciseId, baseRevision)
			);
			injectFailure();
			const addition = addExercisesToSession(
				'session-1',
				['exercise-2', 'exercise-3'],
				renderedInProgress
			);
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			runtimeHarness.releaseTransaction();
			await expect(addition).rejects.toThrow('failed after writing');
			expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
			expect(draftHarness.state.sets).toEqual(originalDraftSets);

			await addExercisesToSession('session-1', ['exercise-2', 'exercise-3'], renderedInProgress);

			const sessionExercises = [
				...(runtimeHarness.state.sessionExercise ? [runtimeHarness.state.sessionExercise] : []),
				...runtimeHarness.state.additionalSessionExercises
			];
			expect(sessionExercises.filter(({ exerciseId }) => exerciseId === 'exercise-2')).toHaveLength(
				1
			);
			expect(sessionExercises.filter(({ exerciseId }) => exerciseId === 'exercise-3')).toHaveLength(
				1
			);
			expect(
				runtimeHarness.state.sets.filter(
					({ exerciseId }) => exerciseId === 'exercise-2' || exerciseId === 'exercise-3'
				)
			).toHaveLength(2);
			expect(
				sessionExercises
					.filter(({ exerciseId }) => exerciseId === 'exercise-2' || exerciseId === 'exercise-3')
					.sort((first, second) => first.exerciseId.localeCompare(second.exerciseId))
					.map(({ id }) => id)
			).toEqual(expectedExerciseIds);
			expect(runtimeHarness.db.sessionExercises.bulkPut).toHaveBeenCalled();
		}
	);

	it('uses a fresh membership id after removal while retaining the old storage tombstone', async () => {
		runtimeHarness.releaseTransaction();
		const firstBaseRevision = runtimeHarness.state.workoutSession!.updatedAt;
		const [firstMembership] = await addExercisesToSession(
			'session-1',
			['exercise-2'],
			renderedInProgress
		);

		expect(firstMembership.id).toBe(
			getAddedSessionExerciseId('session-1', 'exercise-2', firstBaseRevision)
		);

		const removalExpectation = await captureSessionExerciseDestructiveEditExpectation(
			firstMembership.id
		);
		await removeSessionExercise(firstMembership.id, renderedInProgress, removalExpectation);
		const removalRevision = runtimeHarness.state.workoutSession!.updatedAt;
		const [readdedMembership] = await addExercisesToSession(
			'session-1',
			['exercise-2'],
			renderedInProgress
		);

		expect(runtimeHarness.state.deletedSessionExercises.has(firstMembership.id)).toBe(true);
		expect(readdedMembership.id).toBe(
			getAddedSessionExerciseId('session-1', 'exercise-2', removalRevision)
		);
		expect(readdedMembership.id).not.toBe(firstMembership.id);
		expect(
			runtimeHarness.state.additionalSessionExercises.filter(
				({ exerciseId }) => exerciseId === 'exercise-2'
			)
		).toEqual([readdedMembership]);
	});

	const setFailureStages: Array<{
		name: string;
		injectFailure: () => void;
	}> = [
		{
			name: 'generated set insert',
			injectFailure: () => {
				runtimeHarness.db.sessionSets.bulkAdd.mockImplementationOnce(
					async (sessionSets: SessionSet[]) => {
						runtimeHarness.state.sets.push({ ...sessionSets[0] });
						throw new Error('set insert failed after writing');
					}
				);
			}
		},
		{
			name: 'exercise metadata update',
			injectFailure: () => {
				runtimeHarness.db.sessionExercises.update.mockImplementationOnce(
					async (id: string, patch: Partial<SessionExercise>) => {
						if (runtimeHarness.state.sessionExercise?.id === id) {
							runtimeHarness.state.sessionExercise = {
								...runtimeHarness.state.sessionExercise,
								...patch
							};
						}

						throw new Error('exercise metadata failed after writing');
					}
				);
			}
		},
		{
			name: 'session metadata update',
			injectFailure: () => {
				runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
					async (id: string, patch: Partial<WorkoutSession>) => {
						if (runtimeHarness.state.workoutSession?.id === id) {
							runtimeHarness.state.workoutSession = {
								...runtimeHarness.state.workoutSession,
								...patch
							};
						}

						throw new Error('session metadata failed after writing');
					}
				);
			}
		}
	];

	it.each(setFailureStages)(
		'fully removes a failed set graph after the $name and lets retry converge',
		async ({ injectFailure }) => {
			const originalGraph = snapshotPersistedSessionGraph();
			const originalDraftSets = structuredClone(draftHarness.state.sets);
			injectFailure();
			const addition = addSessionSetRow('session-exercise-1', renderedInProgress);
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			runtimeHarness.releaseTransaction();
			await expect(addition).rejects.toThrow('failed after writing');
			expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
			expect(draftHarness.state.sets).toEqual(originalDraftSets);

			const addedSets = await addSessionSetRow('session-exercise-1', renderedInProgress);

			expect(addedSets).toHaveLength(2);
			expect(addedSets.map(({ side }) => side)).toEqual(['right', 'left']);
			expect(addedSets.every(({ order }) => order === 4)).toBe(true);
			expect(runtimeHarness.state.sets).toHaveLength(originalGraph.sets.length + 2);
		}
	);

	it('retains cleanup failures and owned exercise-creation residue until retry repairs it', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
			async (id: string, patch: Partial<WorkoutSession>) => {
				if (runtimeHarness.state.workoutSession?.id === id) {
					runtimeHarness.state.workoutSession = {
						...runtimeHarness.state.workoutSession,
						...patch
					};
				}

				throw new Error('parent failed after writing');
			}
		);
		runtimeHarness.db.sessionSets.bulkDelete
			.mockRejectedValueOnce(new Error('first cleanup failed'))
			.mockRejectedValueOnce(new Error('bounded cleanup failed'));
		const addition = addExercisesToSession('session-1', ['exercise-2'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		const error = await addition.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionCreationCompensationError);
		if (!(error instanceof SessionCreationCompensationError)) {
			throw new Error('Expected a creation compensation error.');
		}
		expect(error.originalError).toEqual(
			expect.objectContaining({ message: 'parent failed after writing' })
		);
		expect(error.cleanupErrors).toHaveLength(2);
		expect(error.remainingRowIds).toEqual([expect.stringContaining('replacement-set-')]);
		const leakedIds = [...error.remainingRowIds];
		const cleanupCallsBeforeCrossOwnerRepair =
			runtimeHarness.db.sessionSets.bulkDelete.mock.calls.length;
		runtimeHarness.operation.userId = 'owner-2';

		await expect(repairSessionCreationCompensation(error)).rejects.toThrow(
			'belongs to a different authenticated user'
		);
		expect(runtimeHarness.db.sessionSets.bulkDelete).toHaveBeenCalledTimes(
			cleanupCallsBeforeCrossOwnerRepair
		);
		expect(error.remainingRowIds).toEqual(leakedIds);
		runtimeHarness.operation.userId = 'owner-1';

		await addExercisesToSession('session-1', ['exercise-2'], renderedInProgress);

		expect(error.remainingRowIds).toEqual([]);
		expect(
			leakedIds.every(
				(leakedId) => runtimeHarness.state.sets.filter(({ id }) => id === leakedId).length === 1
			)
		).toBe(true);
		expect(
			runtimeHarness.state.additionalSessionExercises.filter(
				({ exerciseId }) => exerciseId === 'exercise-2'
			)
		).toHaveLength(1);
		expect(
			runtimeHarness.state.sets.filter(({ exerciseId }) => exerciseId === 'exercise-2')
		).toHaveLength(1);
	});

	it('retains cleanup failures and owned set-creation residue until retry repairs it', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
			async (id: string, patch: Partial<WorkoutSession>) => {
				if (runtimeHarness.state.workoutSession?.id === id) {
					runtimeHarness.state.workoutSession = {
						...runtimeHarness.state.workoutSession,
						...patch
					};
				}

				throw new Error('parent failed after writing');
			}
		);
		runtimeHarness.db.sessionSets.bulkDelete
			.mockRejectedValueOnce(new Error('first cleanup failed'))
			.mockRejectedValueOnce(new Error('bounded cleanup failed'));
		const addition = addSessionSetRow('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		const error = await addition.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionCreationCompensationError);
		if (!(error instanceof SessionCreationCompensationError)) {
			throw new Error('Expected a creation compensation error.');
		}
		expect(error.originalError).toEqual(
			expect.objectContaining({ message: 'parent failed after writing' })
		);
		expect(error.cleanupErrors).toHaveLength(2);
		expect(error.remainingRowIds).toHaveLength(2);
		const leakedIds = [...error.remainingRowIds];

		const addedSets = await addSessionSetRow('session-exercise-1', renderedInProgress);

		expect(error.remainingRowIds).toEqual([]);
		expect(addedSets).toHaveLength(2);
		expect(runtimeHarness.state.sets.some(({ id }) => leakedIds.includes(id))).toBe(false);
		expect(runtimeHarness.state.sets).toHaveLength(8);
	});

	it('preserves a concurrent generated-row winner instead of deleting it during cleanup', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async () => {
			throw new Error('parent failed');
		});
		runtimeHarness.db.sessionSets.bulkDelete.mockImplementationOnce(async (ids: string[]) => {
			const winnerId = ids[0];
			const winnerIndex = runtimeHarness.state.sets.findIndex(({ id }) => id === winnerId);

			if (winnerIndex !== -1) {
				runtimeHarness.state.sets[winnerIndex] = {
					...runtimeHarness.state.sets[winnerIndex],
					repsInput: 'concurrent-winner',
					updatedAt: '2026-07-15T12:05:00.000Z'
				};
			}

			throw new Error('cleanup raced with a winner');
		});
		const addition = addSessionSetRow('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(addition).rejects.toBeInstanceOf(SessionCreationCompensationError);

		expect(runtimeHarness.state.sets).toContainEqual(
			expect.objectContaining({ repsInput: 'concurrent-winner' })
		);
	});

	it('preserves a concurrent generated-exercise winner instead of deleting it during cleanup', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async () => {
			throw new Error('parent failed');
		});
		runtimeHarness.db.sessionExercises.bulkDelete.mockImplementationOnce(async (ids: string[]) => {
			const winnerId = ids[0];
			const winnerIndex = runtimeHarness.state.additionalSessionExercises.findIndex(
				({ id }) => id === winnerId
			);

			if (winnerIndex !== -1) {
				runtimeHarness.state.additionalSessionExercises[winnerIndex] = {
					...runtimeHarness.state.additionalSessionExercises[winnerIndex],
					exerciseNameSnapshot: 'Concurrent exercise winner',
					updatedAt: '2026-07-15T12:05:00.000Z'
				};
			}

			throw new Error('exercise cleanup raced with a winner');
		});
		const addition = addExercisesToSession('session-1', ['exercise-2'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(addition).rejects.toBeInstanceOf(SessionCreationCompensationError);

		expect(runtimeHarness.state.additionalSessionExercises).toContainEqual(
			expect.objectContaining({
				exerciseId: 'exercise-2',
				exerciseNameSnapshot: 'Concurrent exercise winner'
			})
		);
		expect(
			runtimeHarness.state.sets.filter(({ exerciseId }) => exerciseId === 'exercise-2')
		).toEqual([]);
	});

	it('does not roll back session metadata that a concurrent winner changed', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
			async (id: string, patch: Partial<WorkoutSession>) => {
				if (runtimeHarness.state.workoutSession?.id === id) {
					runtimeHarness.state.workoutSession = {
						...runtimeHarness.state.workoutSession,
						...patch,
						workoutNameSnapshot: 'Concurrent winner',
						updatedAt: '2026-07-15T12:05:00.000Z'
					};
				}

				throw new Error('session metadata raced');
			}
		);
		const addition = addExercisesToSession('session-1', ['exercise-2'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(addition).rejects.toThrow('session metadata raced');

		expect(runtimeHarness.state.workoutSession).toEqual(
			expect.objectContaining({
				workoutNameSnapshot: 'Concurrent winner',
				updatedAt: '2026-07-15T12:05:00.000Z'
			})
		);
		expect(runtimeHarness.state.additionalSessionExercises).toEqual([]);
		expect(
			runtimeHarness.state.sets.filter(({ exerciseId }) => exerciseId === 'exercise-2')
		).toEqual([]);
	});

	it('does not roll back exercise metadata that a concurrent winner changed', async () => {
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async () => {
			if (runtimeHarness.state.sessionExercise) {
				runtimeHarness.state.sessionExercise = {
					...runtimeHarness.state.sessionExercise,
					exerciseNameSnapshot: 'Concurrent exercise metadata',
					updatedAt: '2026-07-15T12:05:00.000Z'
				};
			}

			throw new Error('exercise metadata raced');
		});
		const addition = addSessionSetRow('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(addition).rejects.toThrow('exercise metadata raced');

		expect(runtimeHarness.state.sessionExercise).toEqual(
			expect.objectContaining({
				exerciseNameSnapshot: 'Concurrent exercise metadata',
				updatedAt: '2026-07-15T12:05:00.000Z'
			})
		);
		expect(runtimeHarness.state.sets).toHaveLength(6);
	});
});

describe('reorderSessionExercises', () => {
	it.each([
		{
			placement: 'beginning',
			concurrentOrder: ['D', 'A', 'B', 'C'],
			expectedOrder: ['D', 'C', 'A', 'B']
		},
		{
			placement: 'middle',
			concurrentOrder: ['A', 'D', 'B', 'C'],
			expectedOrder: ['C', 'D', 'A', 'B']
		}
	])(
		'keeps an unseen concurrent exercise in its $placement slot',
		async ({ concurrentOrder, expectedOrder }) => {
			setSessionExerciseOrder(['A', 'B', 'C']);
			const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			// Another tab inserts or repositions D after this tab captured its drag snapshot.
			setSessionExerciseOrder(concurrentOrder);
			runtimeHarness.releaseTransaction();
			await reorder;

			expect(readSessionExerciseOrder()).toEqual(expectedOrder);
		}
	);

	it('applies a normal full reorder when the payload includes every current exercise', async () => {
		setSessionExerciseOrder(['A', 'B', 'C', 'D']);
		const reorder = reorderSessionExercises('session-1', ['D', 'B', 'A', 'C'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await reorder;

		expect(readSessionExerciseOrder()).toEqual(['D', 'B', 'A', 'C']);
	});

	it('restores an earlier row when a later exercise update returns zero, then retries cleanly', async () => {
		setSessionExerciseOrder(['A', 'B', 'C']);
		const originalGraph = snapshotPersistedSessionGraph();
		runtimeHarness.db.sessionExercises.update
			.mockImplementationOnce(async (id: string, patch: Partial<SessionExercise>) =>
				applySessionExercisePatch(id, patch)
			)
			.mockResolvedValueOnce(0);
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(reorder).rejects.toThrow('exercise disappeared');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);

		await reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		expect(readSessionExerciseOrder()).toEqual(['C', 'A', 'B']);
	});

	it('restores every exercise when the parent update returns zero', async () => {
		setSessionExerciseOrder(['A', 'B', 'C']);
		const originalGraph = snapshotPersistedSessionGraph();
		runtimeHarness.db.workoutSessions.update.mockResolvedValueOnce(0);
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(reorder).rejects.toThrow('Session disappeared');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
	});

	it('restores the exact parent snapshot when its update commits and then throws', async () => {
		setSessionExerciseOrder(['A', 'B', 'C']);
		const originalGraph = snapshotPersistedSessionGraph();
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
			async (id: string, patch: Partial<WorkoutSession>) => {
				if (runtimeHarness.state.workoutSession?.id === id) {
					runtimeHarness.state.workoutSession = {
						...runtimeHarness.state.workoutSession,
						...patch
					};
				}

				throw new Error('parent committed then failed');
			}
		);
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(reorder).rejects.toThrow('parent committed then failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
	});

	it('reports incomplete exact cleanup and repairs it before retrying the reorder', async () => {
		setSessionExerciseOrder(['A', 'B', 'C']);
		runtimeHarness.db.sessionExercises.update
			.mockImplementationOnce(async (id: string, patch: Partial<SessionExercise>) =>
				applySessionExercisePatch(id, patch)
			)
			.mockResolvedValueOnce(0);
		runtimeHarness.db.sessionExercises.put.mockRejectedValueOnce(new Error('row cleanup failed'));
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		const error = await reorder.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionReorderCompensationError);
		if (!(error instanceof SessionReorderCompensationError)) {
			throw new Error('Expected a reorder compensation error.');
		}
		expect(error.originalError).toEqual(
			expect.objectContaining({ message: expect.stringContaining('exercise disappeared') })
		);
		expect(error.cleanupErrors).toHaveLength(1);
		expect(error.remainingRowIds).toEqual(['C']);

		await reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);

		expect(error.remainingRowIds).toEqual([]);
		expect(readSessionExerciseOrder()).toEqual(['C', 'A', 'B']);
	});

	it('preserves a concurrent row winner during cleanup and converges on retry', async () => {
		setSessionExerciseOrder(['A', 'B', 'C']);
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(async () => {
			applySessionExercisePatch('B', {
				order: 99,
				exerciseNameSnapshot: 'Concurrent winner',
				updatedAt: '2026-07-15T12:05:00.000Z'
			});
			runtimeHarness.state.workoutSession = {
				...runtimeHarness.state.workoutSession!,
				workoutNameSnapshot: 'Concurrent session winner',
				updatedAt: '2026-07-15T12:06:00.000Z'
			};
			throw new Error('parent failed after concurrent row won');
		});
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await expect(reorder).rejects.toThrow('parent failed after concurrent row won');
		expect(runtimeHarness.state.additionalSessionExercises.find(({ id }) => id === 'B')).toEqual(
			expect.objectContaining({
				exerciseNameSnapshot: 'Concurrent winner',
				updatedAt: '2026-07-15T12:05:00.000Z'
			})
		);
		expect(runtimeHarness.state.workoutSession).toEqual(
			expect.objectContaining({ workoutNameSnapshot: 'Concurrent session winner' })
		);

		await reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);

		expect(readSessionExerciseOrder()).toEqual(['C', 'A', 'B']);
		expect(runtimeHarness.state.additionalSessionExercises.find(({ id }) => id === 'B')).toEqual(
			expect.objectContaining({ exerciseNameSnapshot: 'Concurrent winner' })
		);
		expect(runtimeHarness.state.workoutSession).toEqual(
			expect.objectContaining({ workoutNameSnapshot: 'Concurrent session winner' })
		);
	});
});

describe('monotonic structural edit revisions', () => {
	const inputIntentAt = '2026-07-15T12:00:01.000Z';
	const laterIntentAt = '2026-07-15T12:00:02.000Z';

	it('advances replacement rows and parents beyond a future input intent', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(timestamp));
		runtimeHarness.state.sessionExercise = {
			...runtimeHarness.state.sessionExercise!,
			updatedAt: inputIntentAt
		};
		runtimeHarness.state.workoutSession = {
			...runtimeHarness.state.workoutSession!,
			updatedAt: inputIntentAt
		};
		runtimeHarness.state.sets.push({
			...createSet(1, 'left'),
			id: 'replacement-set-session-exercise-1',
			exerciseId: 'exercise-2',
			side: 'bilateral',
			updatedAt: inputIntentAt
		});
		runtimeHarness.releaseTransaction();

		try {
			await replaceSessionExercise('session-exercise-1', 'exercise-2', renderedInProgress);
		} finally {
			vi.useRealTimers();
		}

		expect(runtimeHarness.state.sessionExercise?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
		expect(runtimeHarness.state.workoutSession?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
		expect(runtimeHarness.state.sets).toEqual([
			expect.objectContaining({
				id: 'replacement-set-session-exercise-1',
				exerciseId: 'exercise-2',
				updatedAt: '2026-07-15T12:00:01.001Z'
			})
		]);
	});

	it('advances every reordered survivor and the parent during removal', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(timestamp));
		runtimeHarness.state.additionalSessionExercises = [
			{
				...createSessionExercise('session-exercise-2', 2),
				updatedAt: laterIntentAt
			}
		];
		runtimeHarness.state.workoutSession = {
			...runtimeHarness.state.workoutSession!,
			updatedAt: inputIntentAt
		};
		runtimeHarness.releaseTransaction();

		try {
			await removeSessionExercise('session-exercise-1', renderedInProgress);
		} finally {
			vi.useRealTimers();
		}

		expect(runtimeHarness.state.sessionExercise).toEqual(
			expect.objectContaining({
				id: 'session-exercise-2',
				order: 1,
				updatedAt: '2026-07-15T12:00:02.001Z'
			})
		);
		expect(runtimeHarness.state.workoutSession?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
	});

	it('advances the exercise and parent after removing a set', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(timestamp));
		runtimeHarness.state.sessionExercise = {
			...runtimeHarness.state.sessionExercise!,
			updatedAt: inputIntentAt
		};
		runtimeHarness.state.workoutSession = {
			...runtimeHarness.state.workoutSession!,
			updatedAt: laterIntentAt
		};
		runtimeHarness.releaseTransaction();

		try {
			await removeSessionSetRow('set-2-left', renderedInProgress);
		} finally {
			vi.useRealTimers();
		}

		expect(runtimeHarness.state.sessionExercise?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
		expect(runtimeHarness.state.workoutSession?.updatedAt).toBe('2026-07-15T12:00:02.001Z');
	});

	it('advances reused reset rows and the parent beyond future revisions', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(timestamp));
		const resetSessionExerciseId = getResetSessionExerciseId(
			'session-1',
			'workout-1',
			'exercise-2',
			1
		);
		runtimeHarness.state.sessionExercise = {
			...runtimeHarness.state.sessionExercise!,
			id: resetSessionExerciseId,
			exerciseId: 'exercise-2',
			exerciseNameSnapshot: 'Bench press',
			updatedAt: inputIntentAt
		};
		runtimeHarness.state.sets = [
			{
				...createSet(1, 'left'),
				id: `replacement-set-${resetSessionExerciseId}`,
				sessionExerciseId: resetSessionExerciseId,
				exerciseId: 'exercise-2',
				side: 'bilateral',
				updatedAt: laterIntentAt
			}
		];
		runtimeHarness.state.workoutSession = {
			...runtimeHarness.state.workoutSession!,
			updatedAt: inputIntentAt
		};
		draftHarness.state.sets = {
			[`replacement-set-${resetSessionExerciseId}`]: { repsInput: '8', updatedAt: 1 }
		};
		runtimeHarness.releaseTransaction();

		try {
			await resetSessionInputs('session-1');
		} finally {
			vi.useRealTimers();
		}

		expect(runtimeHarness.state.sessionExercise?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
		expect(runtimeHarness.state.sets).toEqual([
			expect.objectContaining({
				id: `replacement-set-${resetSessionExerciseId}`,
				updatedAt: '2026-07-15T12:00:02.001Z'
			})
		]);
		expect(runtimeHarness.state.workoutSession?.updatedAt).toBe('2026-07-15T12:00:01.001Z');
	});
});

describe('exercise mutation draft cleanup', () => {
	it('drops only the replaced exercise set drafts after the swap commits', async () => {
		const deletedSetIds = runtimeHarness.state.sets.map((sessionSet) => sessionSet.id);
		const replacement = replaceSessionExercise(
			'session-exercise-1',
			'exercise-2',
			renderedInProgress
		);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await replacement;

		expect(draftHarness.removeSets).toHaveBeenCalledWith('session-1', deletedSetIds);
		expect(draftHarness.state.sets).toEqual({
			'unrelated-set': { repsInput: '12', updatedAt: 2 }
		});
		expect(runtimeHarness.state.sets).toEqual([
			expect.objectContaining({
				id: 'replacement-set-session-exercise-1',
				exerciseId: 'exercise-2'
			})
		]);
	});

	it('drops only the removed exercise set drafts after the removal commits', async () => {
		const deletedSetIds = runtimeHarness.state.sets.map((sessionSet) => sessionSet.id);
		const removal = removeSessionExercise('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		await removal;

		expect(draftHarness.removeSets).toHaveBeenCalledWith('session-1', deletedSetIds);
		expect(draftHarness.state.sets).toEqual({
			'unrelated-set': { repsInput: '12', updatedAt: 2 }
		});
		expect(runtimeHarness.state.sessionExercise).toBeUndefined();
		expect(runtimeHarness.state.sets).toEqual([]);
	});

	it('retains all drafts when replacing the exercise fails before commit', async () => {
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionSets.bulkPut.mockRejectedValueOnce(new Error('replacement failed'));
		const replacement = replaceSessionExercise(
			'session-exercise-1',
			'exercise-2',
			renderedInProgress
		);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(replacement).rejects.toThrow('replacement failed');
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
	});
});

describe('destructive session edit compensation', () => {
	it('restores a replaced exercise when deleting its old sets fails after the parent rewrite', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionSets.bulkDelete.mockRejectedValueOnce(
			new Error('old set delete failed')
		);
		const replacement = replaceSessionExercise(
			'session-exercise-1',
			'exercise-2',
			renderedInProgress
		);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(replacement).rejects.toThrow('old set delete failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores a replaced exercise after its old sets were deleted', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.workoutSessions.update.mockRejectedValueOnce(
			new Error('session timestamp failed')
		);
		const replacement = replaceSessionExercise(
			'session-exercise-1',
			'exercise-2',
			renderedInProgress
		);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(replacement).rejects.toThrow('session timestamp failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores a removed set when its parent update fails after deletion', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionExercises.update.mockRejectedValueOnce(
			new Error('exercise timestamp failed')
		);
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toThrow('exercise timestamp failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores surviving exercise order changes when parent deletion fails', async () => {
		runtimeHarness.state.additionalSessionExercises = [
			createSessionExercise('session-exercise-2', 2)
		];
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionExercises.delete.mockRejectedValueOnce(
			new Error('exercise delete failed')
		);
		const removal = removeSessionExercise('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toThrow('exercise delete failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores the exercise after its parent was deleted but set deletion fails', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionSets.bulkDelete.mockRejectedValueOnce(new Error('set delete failed'));
		const removal = removeSessionExercise('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toThrow('set delete failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores the complete exercise after its parent and sets were deleted', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.workoutSessions.update.mockRejectedValueOnce(
			new Error('session timestamp failed')
		);
		const removal = removeSessionExercise('session-exercise-1', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toThrow('session timestamp failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('restores a reset after old exercises were deleted but set deletion fails', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.sessionSets.bulkDelete.mockRejectedValueOnce(
			new Error('old set delete failed')
		);
		const reset = resetSessionInputs('session-1');
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(reset).rejects.toThrow('old set delete failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});

	it('restores a reset after both old sets and exercises were deleted', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		runtimeHarness.db.workoutSessions.update.mockRejectedValueOnce(
			new Error('session timestamp failed')
		);
		const reset = resetSessionInputs('session-1');
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();

		await expect(reset).rejects.toThrow('session timestamp failed');
		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});

	it('repairs a failed restoration before retry and refuses cross-owner cleanup', async () => {
		runtimeHarness.db.sessionExercises.update.mockRejectedValueOnce(
			new Error('exercise timestamp failed')
		);
		runtimeHarness.db.sessionSets.put.mockRejectedValueOnce(new Error('set restoration failed'));
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		const error = await removal.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionEditCompensationError);
		if (!(error instanceof SessionEditCompensationError)) {
			throw new Error('Expected a destructive edit compensation error.');
		}
		expect(error.originalError).toEqual(
			expect.objectContaining({ message: 'exercise timestamp failed' })
		);
		expect(error.cleanupErrors).toEqual([
			expect.objectContaining({ message: 'Failed to restore sessionSets row set-2-left.' })
		]);
		expect(error.remainingRowIds).toEqual(['set-2-left']);
		const readsBeforeCrossOwnerRepair = runtimeHarness.db.sessionSets.get.mock.calls.length;
		const writesBeforeCrossOwnerRepair = runtimeHarness.db.sessionSets.put.mock.calls.length;
		runtimeHarness.operation.userId = 'owner-2';

		await expect(repairSessionEditCompensation(error)).rejects.toThrow(
			'belongs to a different authenticated user'
		);
		expect(runtimeHarness.db.sessionSets.get).toHaveBeenCalledTimes(readsBeforeCrossOwnerRepair);
		expect(runtimeHarness.db.sessionSets.put).toHaveBeenCalledTimes(writesBeforeCrossOwnerRepair);
		expect(error.remainingRowIds).toEqual(['set-2-left']);
		runtimeHarness.operation.userId = 'owner-1';

		await expect(removeSessionSetRow('set-2-left', renderedInProgress)).resolves.toBeUndefined();
		expect(error.remainingRowIds).toEqual([]);
		expect(
			runtimeHarness.state.sets.some(
				(sessionSet) => sessionSet.id === 'set-2-left' || sessionSet.id === 'set-2-right'
			)
		).toBe(false);
		expect(draftHarness.removeSets).toHaveBeenCalledWith(
			'session-1',
			expect.arrayContaining(['set-2-left', 'set-2-right'])
		);
	});

	it('abandons an old pending rollback when a concurrent graph winner takes ownership', async () => {
		runtimeHarness.db.sessionExercises.update.mockRejectedValueOnce(
			new Error('exercise timestamp failed')
		);
		runtimeHarness.db.sessionSets.put.mockRejectedValueOnce(new Error('set restoration failed'));
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		runtimeHarness.releaseTransaction();
		const error = await removal.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionEditCompensationError);
		if (!(error instanceof SessionEditCompensationError)) {
			throw new Error('Expected a destructive edit compensation error.');
		}
		expect(error.remainingRowIds).toEqual(['set-2-left']);
		runtimeHarness.state.workoutSession = {
			...runtimeHarness.state.workoutSession!,
			workoutNameSnapshot: 'Concurrent winner',
			updatedAt: '2026-07-15T12:05:00.000Z'
		};
		const writesBeforeRepair = runtimeHarness.db.sessionSets.put.mock.calls.length;

		await expect(repairSessionEditCompensation(error)).resolves.toBe(true);

		expect(runtimeHarness.db.sessionSets.put).toHaveBeenCalledTimes(writesBeforeRepair);
		expect(runtimeHarness.state.sets.some(({ id }) => id === 'set-2-left')).toBe(false);
		expect(runtimeHarness.state.workoutSession).toEqual(
			expect.objectContaining({
				workoutNameSnapshot: 'Concurrent winner',
				updatedAt: '2026-07-15T12:05:00.000Z'
			})
		);
		expect(error.remainingRowIds).toEqual([]);
	});
});

describe('removeSessionSetRow', () => {
	it('rejects when a queued removal finds that another tab renumbered the requested row', async () => {
		const originalDraftSets = structuredClone(draftHarness.state.sets);
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		// Another serialized removal commits first, moving the requested pair from order 2 to 1.
		runtimeHarness.state.sets = runtimeHarness.state.sets
			.filter((sessionSet) => sessionSet.order !== 1)
			.map((sessionSet) => ({ ...sessionSet, order: sessionSet.order - 1 }));
		const concurrentGraph = snapshotPersistedSessionGraph();
		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toThrow('changed in another tab');
		expect(snapshotPersistedSessionGraph()).toEqual(concurrentGraph);
		expect(draftHarness.state.sets).toEqual(originalDraftSets);
		expect(draftHarness.finalizeSets).not.toHaveBeenCalled();
	});

	it('is idempotent when the requested row was already removed', async () => {
		runtimeHarness.state.sets = runtimeHarness.state.sets.filter(
			(sessionSet) => sessionSet.id !== 'set-2-left'
		);
		runtimeHarness.releaseTransaction();

		await expect(removeSessionSetRow('set-2-left', renderedInProgress)).resolves.toBeUndefined();

		expect(runtimeHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
		expect(runtimeHarness.db.sessionExercises.update).not.toHaveBeenCalled();
		expect(draftHarness.removeSets).not.toHaveBeenCalled();
	});

	it('removes only the selected bilateral row when two replicas added the same order', async () => {
		runtimeHarness.state.sets = [
			{ ...createSet(2, 'left'), id: 'replica-a-set', side: 'bilateral' },
			{ ...createSet(2, 'right'), id: 'replica-b-set', side: 'bilateral' }
		];
		draftHarness.state.sets = {
			'replica-a-set': { repsInput: '8', updatedAt: 1 },
			'replica-b-set': { repsInput: '9', updatedAt: 1 }
		};
		runtimeHarness.releaseTransaction();

		await removeSessionSetRow('replica-a-set', renderedInProgress);

		expect(runtimeHarness.state.sets).toEqual([expect.objectContaining({ id: 'replica-b-set' })]);
		expect(draftHarness.state.sets).toEqual({
			'replica-b-set': { repsInput: '9', updatedAt: 1 }
		});
	});

	it('removes only the selected encoded unilateral pair after an order collision', async () => {
		runtimeHarness.state.sets = [
			{ ...createSet(2, 'right'), id: 'pair-a:right' },
			{ ...createSet(2, 'left'), id: 'pair-a:left' },
			{ ...createSet(2, 'right'), id: 'pair-b:right' },
			{ ...createSet(2, 'left'), id: 'pair-b:left' }
		];
		draftHarness.state.sets = Object.fromEntries(
			runtimeHarness.state.sets.map((row) => [row.id, { repsInput: '8', updatedAt: 1 }])
		);
		runtimeHarness.releaseTransaction();

		await removeSessionSetRow('pair-a:right', renderedInProgress);

		expect(runtimeHarness.state.sets.map((row) => row.id)).toEqual(['pair-b:right', 'pair-b:left']);
		expect(Object.keys(draftHarness.state.sets)).toEqual(['pair-b:right', 'pair-b:left']);
	});

	it('does not guess and delete unrelated legacy sides when a collision is ambiguous', async () => {
		runtimeHarness.state.sets = [
			{ ...createSet(2, 'right'), id: 'legacy-a-right-row' },
			{ ...createSet(2, 'left'), id: 'legacy-a-left-row' },
			{ ...createSet(2, 'right'), id: 'legacy-b-right-row' },
			{ ...createSet(2, 'left'), id: 'legacy-b-left-row' }
		];
		runtimeHarness.releaseTransaction();

		await removeSessionSetRow('legacy-a-right-row', renderedInProgress);

		expect(runtimeHarness.state.sets.map((row) => row.id)).toEqual([
			'legacy-a-left-row',
			'legacy-b-right-row',
			'legacy-b-left-row'
		]);
		expect(draftHarness.removeSets).toHaveBeenCalledWith('session-1', ['legacy-a-right-row']);
	});

	it('marks a same-millisecond final-set removal as an intentional parent edit', async () => {
		runtimeHarness.state.sets = [createSet(1, 'left'), createSet(1, 'right')];
		vi.useFakeTimers();
		vi.setSystemTime(new Date(timestamp));
		runtimeHarness.releaseTransaction();

		try {
			await removeSessionSetRow('set-1-left', renderedInProgress);
		} finally {
			vi.useRealTimers();
		}

		expect(runtimeHarness.db.sessionExercises.update).toHaveBeenCalledWith('session-exercise-1', {
			updatedAt: '2026-07-15T12:00:00.001Z'
		});
		expect(runtimeHarness.state.sets).toEqual([]);
	});
});

describe('resetSessionInputs', () => {
	it.each(['completed', 'abandoned'] as const)(
		'preserves session history when a queued reset finds the session is %s',
		async (terminalStatus) => {
			const originalExercise = { ...runtimeHarness.state.sessionExercise! };
			const originalSets = runtimeHarness.state.sets.map((sessionSet) => ({ ...sessionSet }));
			const reset = resetSessionInputs('session-1');
			await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

			// A competing tab finishes or abandons the session before this transaction begins.
			setSessionStatus(terminalStatus);
			runtimeHarness.releaseTransaction();

			await expect(reset).rejects.toThrow('Only planned or in-progress sessions can be reset.');
			expect(runtimeHarness.state.sessionExercise).toEqual(originalExercise);
			expect(runtimeHarness.state.sets).toEqual(originalSets);
			expect(runtimeHarness.db.sessionSets.bulkDelete).not.toHaveBeenCalled();
			expect(runtimeHarness.db.sessionExercises.bulkDelete).not.toHaveBeenCalled();
			expect(draftHarness.clear).not.toHaveBeenCalled();
		}
	);

	it.each(['planned', 'in_progress'] as const)('resets a %s session', async (status) => {
		setSessionStatus(status);
		runtimeHarness.releaseTransaction();

		await expect(resetSessionInputs('session-1')).resolves.toBeUndefined();

		expect(runtimeHarness.state.sessionExercise).toEqual(
			expect.objectContaining({
				sessionId: 'session-1',
				exerciseId: 'exercise-2',
				exerciseNameSnapshot: 'Bench press'
			})
		);
		expect(runtimeHarness.state.sets).toEqual([
			expect.objectContaining({
				sessionExerciseId: runtimeHarness.state.sessionExercise?.id,
				exerciseId: 'exercise-2'
			})
		]);
		expect(draftHarness.finalize).toHaveBeenCalledOnce();
		expect(draftHarness.state.sets).toEqual({});
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});

	it('rejects reset when a newer durable draft version arrives before admission', async () => {
		const originalGraph = snapshotPersistedSessionGraph();
		const reset = resetSessionInputs('session-1');
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());

		draftHarness.state.sets['set-1-left'] = {
			weightInput: '205',
			weightInputVersion: 'new-version',
			updatedAt: 3
		};
		runtimeHarness.releaseTransaction();
		await expect(reset).rejects.toThrow('changed in another tab');

		expect(snapshotPersistedSessionGraph()).toEqual(originalGraph);
		expect(draftHarness.state.sets['set-1-left']).toEqual({
			weightInput: '205',
			weightInputVersion: 'new-version',
			updatedAt: 3
		});
		expect(draftHarness.finalize).not.toHaveBeenCalled();
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});
});

describe('durable editing compensation reload recovery', () => {
	it('hydrates creation cleanup after reload before retrying the same addition', async () => {
		runtimeHarness.operation.userId = 'owner-reload-creation';
		runtimeHarness.db.workoutSessions.update.mockImplementationOnce(
			async (id: string, patch: Partial<WorkoutSession>) => {
				if (runtimeHarness.state.workoutSession?.id === id) {
					runtimeHarness.state.workoutSession = {
						...runtimeHarness.state.workoutSession,
						...patch
					};
				}
				throw new Error('parent failed after writing');
			}
		);
		runtimeHarness.db.sessionSets.bulkDelete
			.mockRejectedValueOnce(new Error('first cleanup failed'))
			.mockRejectedValueOnce(new Error('bounded cleanup failed'));
		const addition = addExercisesToSession('session-1', ['exercise-2'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());
		runtimeHarness.releaseTransaction();

		await expect(addition).rejects.toBeInstanceOf(SessionCreationCompensationError);
		expect([...storage.values.values()].some((raw) => raw.includes('session-creation'))).toBe(true);

		vi.resetModules();
		const reloaded = await import('./editing');
		const result = await reloaded.addExercisesToSession(
			'session-1',
			['exercise-2'],
			renderedInProgress
		);

		expect(result).toHaveLength(1);
		expect(
			runtimeHarness.state.additionalSessionExercises.filter(
				({ exerciseId }) => exerciseId === 'exercise-2'
			)
		).toHaveLength(1);
		expect([...storage.values.values()].some((raw) => raw.includes('session-creation'))).toBe(
			false
		);
	});

	it('hydrates reorder cleanup after reload before applying the requested order', async () => {
		runtimeHarness.operation.userId = 'owner-reload-reorder';
		setSessionExerciseOrder(['A', 'B', 'C']);
		runtimeHarness.db.sessionExercises.update
			.mockImplementationOnce(async (id: string, patch: Partial<SessionExercise>) =>
				applySessionExercisePatch(id, patch)
			)
			.mockResolvedValueOnce(0);
		runtimeHarness.db.sessionExercises.put.mockRejectedValueOnce(new Error('row cleanup failed'));
		const reorder = reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());
		runtimeHarness.releaseTransaction();

		await expect(reorder).rejects.toBeInstanceOf(SessionReorderCompensationError);
		expect([...storage.values.values()].some((raw) => raw.includes('session-reorder'))).toBe(true);

		vi.resetModules();
		const reloaded = await import('./editing');
		await reloaded.reorderSessionExercises('session-1', ['C', 'A', 'B'], renderedInProgress);

		expect(readSessionExerciseOrder()).toEqual(['C', 'A', 'B']);
		expect([...storage.values.values()].some((raw) => raw.includes('session-reorder'))).toBe(false);
	});

	it('hydrates destructive edit cleanup after reload before retrying the removal', async () => {
		runtimeHarness.operation.userId = 'owner-reload-edit';
		runtimeHarness.db.sessionExercises.update.mockRejectedValueOnce(
			new Error('exercise timestamp failed')
		);
		runtimeHarness.db.sessionSets.put.mockRejectedValueOnce(new Error('set restoration failed'));
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());
		runtimeHarness.releaseTransaction();

		await expect(removal).rejects.toBeInstanceOf(SessionEditCompensationError);
		expect([...storage.values.values()].some((raw) => raw.includes('session-edit'))).toBe(true);

		vi.resetModules();
		const reloaded = await import('./editing');
		await reloaded.removeSessionSetRow('set-2-left', renderedInProgress);

		expect(
			runtimeHarness.state.sets.some(({ id }) => id === 'set-2-left' || id === 'set-2-right')
		).toBe(false);
		expect([...storage.values.values()].some((raw) => raw.includes('session-edit'))).toBe(false);
	});

	it('warns when an incomplete edit repair cannot be persisted', async () => {
		runtimeHarness.operation.userId = 'owner-storage-failure';
		runtimeHarness.db.sessionExercises.update.mockRejectedValueOnce(
			new Error('exercise timestamp failed')
		);
		runtimeHarness.db.sessionSets.put.mockRejectedValueOnce(new Error('set restoration failed'));
		storage.failWrites = true;
		const removal = removeSessionSetRow('set-2-left', renderedInProgress);
		await vi.waitFor(() => expect(runtimeHarness.db.transaction).toHaveBeenCalledOnce());
		runtimeHarness.releaseTransaction();
		const error = await removal.catch((caughtError: unknown) => caughtError);

		expect(error).toBeInstanceOf(SessionEditCompensationError);
		if (!(error instanceof SessionEditCompensationError)) throw error;
		expect(error.durabilityErrors).toHaveLength(1);
		expect(error.message).toContain('Recovery could not be saved for reload safety.');
	});
});
