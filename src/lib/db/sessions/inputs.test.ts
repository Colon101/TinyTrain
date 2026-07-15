import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import type { SessionSet } from '../models';
import {
	readSessionInputDraft,
	type SessionInputDraft,
	writeSessionInputDraft,
	writeSessionInputDraftField
} from '../session-drafts';

const runtimeHarness = vi.hoisted(() => {
	const state = {
		storedSet: undefined as SessionSet | undefined
	};
	const sessionSets = {
		get: vi.fn(async (id: string) =>
			state.storedSet?.id === id ? { ...state.storedSet } : undefined
		),
		bulkGet: vi.fn(async (ids: string[]) =>
			ids.map((id) => (state.storedSet?.id === id ? { ...state.storedSet } : undefined))
		),
		update: vi.fn(async (id: string, patch: Partial<SessionSet>) => {
			if (!state.storedSet || state.storedSet.id !== id) {
				return 0;
			}

			state.storedSet = { ...state.storedSet, ...patch };
			return 1;
		})
	};
	const sessionExercises = {
		get: vi.fn(async (id: string) =>
			id === 'session-exercise-1'
				? {
						id,
						sessionId: 'session-1',
						workoutId: 'workout-1',
						exerciseId: 'exercise-1',
						exerciseNameSnapshot: 'Exercise 1',
						order: 1,
						performedAt: '2026-01-01T10:00:00.000Z',
						createdAt: '2026-01-01T10:00:00.000Z',
						updatedAt: '2026-01-01T12:00:00.000Z'
					}
				: undefined
		)
	};
	const workoutSessions = {
		get: vi.fn(async () => undefined),
		update: vi.fn(async () => 0)
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

			return callback();
		})
	};
	const operation = {
		userId: 'user-1',
		generation: 1,
		database: db
	};

	return { db, operation, state };
});

vi.mock('../runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn(),
	runAuthenticatedDatabaseOperation: vi.fn((callback) => callback({ ...runtimeHarness.operation }))
}));

vi.mock('$app/environment', () => ({ browser: true }));

import {
	flushSessionInputDraft,
	updateSessionSetInputs,
	updateSessionSetInputValues
} from './inputs';

const createdAt = '2026-01-01T10:00:00.000Z';
const draftActivityAt = '2026-01-01T11:00:00.000Z';
const storedUpdatedAt = '2026-01-01T12:00:00.000Z';
let storedDrafts: Map<string, string>;

beforeEach(() => {
	setAuthOwnedStateIdentity('user-1', true);
	vi.clearAllMocks();
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T13:00:00.000Z'));
	storedDrafts = new Map();
	vi.stubGlobal('localStorage', {
		get length() {
			return storedDrafts.size;
		},
		getItem: vi.fn((key: string) => storedDrafts.get(key) ?? null),
		key: vi.fn((index: number) => [...storedDrafts.keys()][index] ?? null),
		setItem: vi.fn((key: string, value: string) => storedDrafts.set(key, value)),
		removeItem: vi.fn((key: string) => storedDrafts.delete(key))
	});
	vi.stubGlobal('window', { dispatchEvent: vi.fn() });
	runtimeHarness.state.storedSet = {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput: '95',
		repsInput: '8',
		rirInput: '',
		weight: 95,
		reps: 8,
		createdAt,
		updatedAt: storedUpdatedAt
	};
	runtimeHarness.operation.userId = 'user-1';
	runtimeHarness.operation.generation = 1;
	runtimeHarness.operation.database = runtimeHarness.db;
});

afterEach(() => {
	setAuthOwnedStateIdentity(null, false);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('updateSessionSetInputValues', () => {
	it('keeps a queued same-id input save on owner A while its prior-save barrier spans A to B', async () => {
		let releasePriorSave!: () => void;
		const priorSave = new Promise<void>((resolve) => {
			releasePriorSave = resolve;
		});
		const userBTransaction = vi.fn(async () => {
			throw new Error("owner B's database was touched");
		});
		const userBDatabase = {
			...runtimeHarness.db,
			transaction: userBTransaction
		} as typeof runtimeHarness.db;

		const ownerASave = updateSessionSetInputs(
			'set-1',
			'weight',
			'100',
			{
				updatedAt: Date.now(),
				baseValue: '95'
			},
			{ waitFor: priorSave }
		);

		// The operation must already own A before the queued barrier is released under B.
		runtimeHarness.operation.userId = 'user-2';
		runtimeHarness.operation.generation = 2;
		runtimeHarness.operation.database = userBDatabase;
		releasePriorSave();

		await expect(ownerASave).resolves.toMatchObject({ skipped: false });
		expect(runtimeHarness.state.storedSet).toMatchObject({
			id: 'set-1',
			weightInput: '100',
			weight: 100
		});
		expect(userBTransaction).not.toHaveBeenCalled();
	});

	it('cancels a teardown save before touching either owner and leaves owner A recovery durable', async () => {
		const ownerAIntent = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '100',
			baseValue: '95'
		});
		let releasePriorSave!: () => void;
		const priorSave = new Promise<void>((resolve) => {
			releasePriorSave = resolve;
		});
		const teardown = new AbortController();
		const userBTransaction = vi.fn(async () => {
			throw new Error("owner B's database was touched");
		});
		const userBDatabase = {
			...runtimeHarness.db,
			transaction: userBTransaction
		} as typeof runtimeHarness.db;
		const ownerASave = updateSessionSetInputs(
			'set-1',
			'weight',
			'100',
			{
				updatedAt: ownerAIntent.intentAt,
				baseValue: ownerAIntent.baseValue
			},
			{ waitFor: priorSave, signal: teardown.signal }
		);

		setAuthOwnedStateIdentity('user-2', true);
		runtimeHarness.operation.userId = 'user-2';
		runtimeHarness.operation.generation = 2;
		runtimeHarness.operation.database = userBDatabase;
		const ownerBIntent = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '205',
			baseValue: '200'
		});
		teardown.abort();
		releasePriorSave();

		await expect(ownerASave).rejects.toMatchObject({ name: 'AbortError' });
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95
		});
		expect(userBTransaction).not.toHaveBeenCalled();
		expect(readSessionInputDraft('session-1', 'user-1')?.sets['set-1']).toMatchObject({
			weightInput: '100',
			weightInputVersion: ownerAIntent.fieldVersion
		});
		expect(readSessionInputDraft('session-1', 'user-2')?.sets['set-1']).toMatchObject({
			weightInput: '205',
			weightInputVersion: ownerBIntent.fieldVersion
		});
	});

	it('skips a delayed direct save when a newer write changed the field from its base', async () => {
		const result = await updateSessionSetInputs('set-1', 'weight', '100', {
			updatedAt: Date.parse(draftActivityAt),
			baseValue: '90'
		});

		expect(result.skipped).toBe(true);
		expect(result.sessionSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			updatedAt: storedUpdatedAt
		});
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95
		});
		expect(runtimeHarness.db.sessionSets.update).not.toHaveBeenCalled();
	});

	it('preserves logical intent ordering for same-millisecond direct saves', async () => {
		const now = Date.now();
		const newerIntentAt = now + 1;

		const newerResult = await updateSessionSetInputs('set-1', 'weight', '101', {
			updatedAt: newerIntentAt,
			baseValue: '95'
		});

		expect(newerResult.skipped).toBe(false);
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '101',
			weight: 101,
			updatedAt: '2026-01-01T13:00:00.001Z'
		});

		const delayedOlderResult = await updateSessionSetInputs('set-1', 'weight', '100', {
			updatedAt: now,
			baseValue: '95'
		});

		expect(delayedOlderResult.skipped).toBe(true);
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '101',
			weight: 101,
			updatedAt: '2026-01-01T13:00:00.001Z'
		});
	});

	it('applies only stale draft fields whose stored value still matches the draft base', async () => {
		const result = await updateSessionSetInputValues(
			'set-1',
			{ weight: '100', reps: '10' },
			Date.parse(draftActivityAt),
			{ weight: '90', reps: '8' }
		);

		expect(result.skippedFields).toEqual(['weight']);
		expect(result.sessionSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			repsInput: '10',
			reps: 10,
			updatedAt: storedUpdatedAt
		});
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			repsInput: '10',
			reps: 10
		});
		expect(runtimeHarness.db.sessionSets.update).toHaveBeenCalledOnce();
		expect(runtimeHarness.db.sessionSets.update).toHaveBeenCalledWith('set-1', {
			repsInput: '10',
			reps: 10,
			updatedAt: storedUpdatedAt
		});
	});

	it('keeps only conflicted fields in the draft after applying the safe fields', async () => {
		const draftUpdatedAt = Date.parse(draftActivityAt);
		const draft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					repsInput: '10',
					repsInputBase: '8',
					updatedAt: draftUpdatedAt
				}
			}
		};
		writeSessionInputDraft(draft);

		await expect(flushSessionInputDraft('session-1')).rejects.toThrow(
			'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
		);

		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			repsInput: '10',
			reps: 10
		});
		expect(readSessionInputDraft('session-1')).toEqual({
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					weightInputIntentAt: draftUpdatedAt,
					updatedAt: draftUpdatedAt
				}
			}
		});
	});

	it('uses each field intent time when another field was edited later', async () => {
		const weightIntentAt = Date.parse('2026-01-01T11:00:00.000Z');
		const concurrentWeightEditAt = '2026-01-01T11:30:00.000Z';
		const repsIntentAt = Date.parse('2026-01-01T12:00:00.000Z');
		const draft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: repsIntentAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					weightInputIntentAt: weightIntentAt,
					repsInput: '10',
					repsInputBase: '8',
					repsInputIntentAt: repsIntentAt,
					updatedAt: repsIntentAt
				}
			}
		};
		runtimeHarness.state.storedSet = {
			...runtimeHarness.state.storedSet!,
			updatedAt: concurrentWeightEditAt
		};
		writeSessionInputDraft(draft);

		await expect(flushSessionInputDraft('session-1')).rejects.toThrow(
			'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
		);

		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			repsInput: '10',
			reps: 10,
			updatedAt: '2026-01-01T12:00:00.000Z'
		});
		expect(readSessionInputDraft('session-1')).toEqual({
			sessionId: 'session-1',
			updatedAt: repsIntentAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					weightInputIntentAt: weightIntentAt,
					updatedAt: repsIntentAt
				}
			}
		});
	});

	it('keeps the exact journal version when a flush cannot apply that field', async () => {
		const draftWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '100',
			baseValue: '90'
		});
		runtimeHarness.state.storedSet = {
			...runtimeHarness.state.storedSet!,
			updatedAt: '2026-01-01T13:30:00.000Z'
		};

		await expect(flushSessionInputDraft('session-1')).rejects.toThrow(
			'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
		);

		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '100',
			weightInputBase: '90',
			weightInputIntentAt: draftWrite.intentAt,
			weightInputVersion: draftWrite.fieldVersion
		});
	});

	it('preserves a newer edit that lands while a successful flush is awaiting the database', async () => {
		const draftUpdatedAt = Date.parse(draftActivityAt);
		const snapshot: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '95',
					updatedAt: draftUpdatedAt
				}
			}
		};
		const newerDraft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: Date.now(),
			sets: {
				'set-1': {
					weightInput: '105',
					weightInputBase: '95',
					updatedAt: Date.now()
				}
			}
		};
		let resolveBulkGet!: (sets: (SessionSet | undefined)[]) => void;
		runtimeHarness.db.sessionSets.bulkGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveBulkGet = resolve;
				})
		);
		writeSessionInputDraft(snapshot);

		const flushPromise = flushSessionInputDraft('session-1');
		writeSessionInputDraft(newerDraft);
		resolveBulkGet([{ ...runtimeHarness.state.storedSet! }]);
		await flushPromise;

		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '100',
			weight: 100
		});
		expect(readSessionInputDraft('session-1')).toEqual(newerDraft);
	});

	it('does not overwrite a newer edit with stale conflict-only fields', async () => {
		const draftUpdatedAt = Date.parse(draftActivityAt);
		const snapshot: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					updatedAt: draftUpdatedAt
				}
			}
		};
		const newerDraft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: Date.now(),
			sets: {
				'set-1': {
					weightInput: '105',
					weightInputBase: '95',
					updatedAt: Date.now()
				}
			}
		};
		let resolveBulkGet!: (sets: (SessionSet | undefined)[]) => void;
		runtimeHarness.db.sessionSets.bulkGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveBulkGet = resolve;
				})
		);
		writeSessionInputDraft(snapshot);

		const flushPromise = flushSessionInputDraft('session-1');
		writeSessionInputDraft(newerDraft);
		resolveBulkGet([{ ...runtimeHarness.state.storedSet! }]);

		await expect(flushPromise).rejects.toThrow(
			'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
		);
		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95
		});
		expect(readSessionInputDraft('session-1')).toEqual(newerDraft);
	});

	it('keeps a flush bound to owner A when owner B writes the same session and set IDs', async () => {
		const draftUpdatedAt = Date.parse(draftActivityAt);
		const ownerADraft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '95',
					updatedAt: draftUpdatedAt
				}
			}
		};
		const ownerBDraft: SessionInputDraft = {
			sessionId: 'session-1',
			updatedAt: Date.now(),
			sets: {
				'set-1': {
					weightInput: '205',
					weightInputBase: '200',
					updatedAt: Date.now()
				}
			}
		};
		let resolveBulkGet!: (sets: (SessionSet | undefined)[]) => void;
		runtimeHarness.db.sessionSets.bulkGet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveBulkGet = resolve;
				})
		);
		writeSessionInputDraft(ownerADraft);

		const ownerAFlush = flushSessionInputDraft('session-1');
		await vi.waitFor(() => expect(resolveBulkGet).toBeTypeOf('function'));
		setAuthOwnedStateIdentity('user-2', true);
		writeSessionInputDraft(ownerBDraft);
		resolveBulkGet([{ ...runtimeHarness.state.storedSet! }]);
		await ownerAFlush;

		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '100',
			weight: 100
		});
		expect(readSessionInputDraft('session-1')).toEqual(ownerBDraft);
		expect(readSessionInputDraft('session-1', 'user-1')).toBeNull();
	});
});
