import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSet } from '../models';

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
		get: vi.fn(async () => undefined)
	};
	const workoutSessions = {};
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

	return { db, state };
});

const draftHarness = vi.hoisted(() => ({
	read: vi.fn(),
	write: vi.fn(),
	clear: vi.fn()
}));

vi.mock('../runtime', () => ({
	db: runtimeHarness.db,
	requireLoggedInUser: vi.fn()
}));

vi.mock('../session-drafts', () => ({
	readSessionInputDraft: draftHarness.read,
	writeSessionInputDraft: draftHarness.write,
	clearSessionInputDraft: draftHarness.clear,
	isSessionInputDraftSet: (value: unknown) =>
		Boolean(value && typeof value === 'object' && !Array.isArray(value))
}));

import { flushSessionInputDraft, updateSessionSetInputValues } from './inputs';

const createdAt = '2026-01-01T10:00:00.000Z';
const draftActivityAt = '2026-01-01T11:00:00.000Z';
const storedUpdatedAt = '2026-01-01T12:00:00.000Z';

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T13:00:00.000Z'));
	draftHarness.read.mockReturnValue(null);
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
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('updateSessionSetInputValues', () => {
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
		draftHarness.read.mockReturnValue({
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
		});

		await expect(flushSessionInputDraft('session-1')).rejects.toThrow(
			'Some workout inputs changed on another device. Your unsaved values were kept; review and edit them again.'
		);

		expect(runtimeHarness.state.storedSet).toMatchObject({
			weightInput: '95',
			weight: 95,
			repsInput: '10',
			reps: 10
		});
		expect(draftHarness.write).toHaveBeenCalledWith('session-1', {
			sessionId: 'session-1',
			updatedAt: draftUpdatedAt,
			sets: {
				'set-1': {
					weightInput: '100',
					weightInputBase: '90',
					updatedAt: draftUpdatedAt
				}
			}
		});
		expect(draftHarness.clear).not.toHaveBeenCalled();
	});
});
