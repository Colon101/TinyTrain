import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import type { SessionOverview, SessionSetOverview, SessionStatus } from '../../db/models';
import {
	applySessionInputDraft,
	clearSessionInputDraft,
	getSessionInputDraftKey,
	readSessionInputDraft,
	type SessionInputDraft,
	type SessionInputDraftSet,
	writeSessionInputDraft
} from './session-input-draft';

vi.mock('$app/environment', () => ({ browser: true }));

beforeEach(() => {
	setAuthOwnedStateIdentity('user-1', true);
});

afterEach(() => {
	setAuthOwnedStateIdentity(null, false);
});

const timestamp = '2026-07-11T10:00:00.000Z';

function buildSet(overrides: Partial<SessionSetOverview> = {}): SessionSetOverview {
	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput: '100',
		repsInput: '8',
		rirInput: '2',
		weight: 100,
		reps: 8,
		rir: 2,
		createdAt: timestamp,
		updatedAt: timestamp,
		label: 'Set 01',
		previousReference: {
			sessionId: 'previous-session',
			order: 1,
			side: 'bilateral',
			weight: 95,
			reps: 8,
			rir: 3
		},
		weightDelta: { state: 'improved', label: '+5' },
		repsDelta: { state: 'matched', label: '' },
		rirDelta: { state: 'regressed', label: '-1' },
		...overrides
	};
}

function buildOverview(status: SessionStatus = 'in_progress'): SessionOverview {
	return {
		summary: {
			id: 'session-1',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Strength',
			dayKey: '2026-07-11',
			startedAt: timestamp,
			status,
			createdAt: timestamp,
			updatedAt: timestamp,
			totalExercises: 1,
			totalSets: 1,
			totalReps: 8,
			totalVolume: 800
		},
		previousSummary: null,
		progress: null,
		exercises: [
			{
				id: 'session-exercise-1',
				sessionId: 'session-1',
				workoutId: 'workout-1',
				exerciseId: 'exercise-1',
				exerciseNameSnapshot: 'Bench Press',
				order: 1,
				performedAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
				sets: [buildSet()],
				exercise: null,
				previousPerformance: null,
				progressStatus: 'new',
				progressSummary: 'First logged performance for this exercise.'
			}
		]
	};
}

function buildDraft(set: SessionInputDraftSet, sessionId = 'session-1'): SessionInputDraft {
	return {
		sessionId,
		sets: { 'set-1': set },
		updatedAt: Date.parse(timestamp)
	};
}

function getOnlySet(overview: SessionOverview | null) {
	const sessionSet = overview?.exercises[0]?.sets[0];

	if (!sessionSet) {
		throw new Error('Expected one session set.');
	}

	return sessionSet;
}

describe('applySessionInputDraft', () => {
	it('changes only fields explicitly present in the draft', () => {
		const overview = buildOverview();
		const nextSet = getOnlySet(
			applySessionInputDraft(overview, buildDraft({ weightInput: '102.5' }))
		);

		expect(nextSet).toMatchObject({
			weightInput: '102.5',
			weight: 102.5,
			repsInput: '8',
			reps: 8,
			rirInput: '2',
			rir: 2
		});
		expect(getOnlySet(overview).weight).toBe(100);
	});

	it('treats an explicit blank as clearing the stored value', () => {
		const nextSet = getOnlySet(
			applySessionInputDraft(buildOverview(), buildDraft({ repsInput: '' }))
		);

		expect(nextSet.repsInput).toBe('');
		expect(nextSet.reps).toBeUndefined();
		expect(nextSet.repsDelta).toEqual({ state: 'empty', label: '' });
		expect(nextSet.weight).toBe(100);
	});

	it('recalculates every changed field delta against the previous set', () => {
		const nextSet = getOnlySet(
			applySessionInputDraft(
				buildOverview(),
				buildDraft({ weightInput: '90', repsInput: '10', rirInput: '3' })
			)
		);

		expect(nextSet.weightDelta).toEqual({ state: 'regressed', label: '-5' });
		expect(nextSet.repsDelta).toEqual({ state: 'improved', label: '+2' });
		expect(nextSet.rirDelta).toEqual({ state: 'matched', label: '' });
	});

	it('ignores a draft belonging to another session', () => {
		const overview = buildOverview();

		expect(
			applySessionInputDraft(overview, buildDraft({ weightInput: '120' }, 'other-session'))
		).toBe(overview);
	});

	it.each(['planned', 'completed', 'abandoned'] as const)(
		'leaves a %s session untouched by default',
		(status) => {
			const overview = buildOverview(status);

			expect(applySessionInputDraft(overview, buildDraft({ weightInput: '120' }))).toBe(overview);
		}
	);

	it('can explicitly restore a draft onto a completed session', () => {
		const overview = buildOverview('completed');
		const result = applySessionInputDraft(overview, buildDraft({ weightInput: '120' }), {
			includeCompleted: true
		});

		expect(result).not.toBe(overview);
		expect(getOnlySet(result)).toMatchObject({
			weightInput: '120',
			weight: 120,
			weightDelta: { state: 'improved', label: '+25' }
		});
	});

	it('ignores a malformed draft set instead of applying it', () => {
		const overview = buildOverview();
		const draft = buildDraft({ weightInput: 5 } as unknown as SessionInputDraftSet);

		expect(() => applySessionInputDraft(overview, draft)).not.toThrow();
		expect(getOnlySet(applySessionInputDraft(overview, draft))).toBe(getOnlySet(overview));
	});
});

describe('session input draft storage', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('discards persisted sets containing non-string input fields', () => {
		const intentAt = Date.parse(timestamp);
		const storedDraft = {
			sessionId: 'session-1',
			sets: {
				'valid-set': { weightInput: '102.5', weightInputBase: '100' },
				'valid-intent-set': { repsInput: '10', repsInputIntentAt: intentAt },
				'invalid-input-set': { repsInput: 8 },
				'invalid-base-set': { rirInput: '2', rirInputBase: null },
				'invalid-intent-set': { weightInput: '105', weightInputIntentAt: 'later' }
			},
			updatedAt: intentAt
		};
		vi.stubGlobal('localStorage', {
			getItem: vi.fn(() => JSON.stringify(storedDraft))
		});

		expect(readSessionInputDraft('session-1')).toEqual({
			sessionId: 'session-1',
			sets: {
				'valid-set': { weightInput: '102.5', weightInputBase: '100' },
				'valid-intent-set': { repsInput: '10', repsInputIntentAt: intentAt }
			},
			updatedAt: intentAt
		});
	});

	it('does not throw when optional draft storage is unavailable', () => {
		const storageError = new DOMException('Storage is unavailable.', 'SecurityError');
		vi.stubGlobal('localStorage', {
			setItem: vi.fn(() => {
				throw storageError;
			}),
			removeItem: vi.fn(() => {
				throw storageError;
			})
		});
		vi.stubGlobal('window', { dispatchEvent: vi.fn() });
		const draft = buildDraft({ weightInput: '102.5' });

		expect(writeSessionInputDraft(draft)).toBe(false);
		expect(() => clearSessionInputDraft('session-1')).not.toThrow();
	});

	it('does not throw when draft change notification fails', () => {
		vi.stubGlobal('localStorage', {
			setItem: vi.fn(),
			removeItem: vi.fn()
		});
		vi.stubGlobal('window', {
			dispatchEvent: vi.fn(() => {
				throw new Error('Listener failed.');
			})
		});
		const draft = buildDraft({ weightInput: '102.5' });

		expect(writeSessionInputDraft(draft)).toBe(true);
		expect(() => clearSessionInputDraft('session-1')).not.toThrow();
		expect(localStorage.setItem).toHaveBeenCalledWith(
			getSessionInputDraftKey('session-1'),
			JSON.stringify(draft)
		);
	});
});
