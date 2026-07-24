import { describe, expect, it } from 'vitest';
import type {
	ExerciseHistoryEntry,
	SessionExercise,
	SessionExerciseDetail,
	SessionSet,
	WorkoutSession
} from './models';
import {
	buildPreviousReferenceBySetKey,
	findLatestHistoryEntryWithPerformedSets,
	getLastSessionSetActivityAt,
	getSessionActivityAt,
	normalizeName,
	summarizeSession,
	toParsedInputValue,
	toStoredInputValue
} from './shared';

const baseTime = Date.parse('2026-05-10T10:00:00.000Z');
const atMinute = (minute: number) => new Date(baseTime + minute * 60_000).toISOString();

function session(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
	return {
		id: 'session',
		workoutId: 'workout',
		workoutNameSnapshot: 'Upper body',
		dayKey: '2026-05-10',
		startedAt: atMinute(0),
		status: 'in_progress',
		createdAt: atMinute(-5),
		updatedAt: atMinute(0),
		...overrides
	};
}

function sessionSet(overrides: Partial<SessionSet> = {}): SessionSet {
	return {
		id: 'set',
		sessionExerciseId: 'session-exercise',
		exerciseId: 'exercise',
		order: 1,
		side: 'bilateral',
		createdAt: atMinute(0),
		updatedAt: atMinute(0),
		...overrides
	};
}

function sessionExercise(overrides: Partial<SessionExercise> = {}): SessionExercise {
	return {
		id: 'session-exercise',
		sessionId: 'session',
		workoutId: 'workout',
		exerciseId: 'exercise',
		exerciseNameSnapshot: 'Bench Press',
		order: 1,
		performedAt: atMinute(0),
		createdAt: atMinute(0),
		updatedAt: atMinute(0),
		...overrides
	};
}

function exerciseDetail(sets: SessionSet[]): SessionExerciseDetail {
	return { ...sessionExercise(), sets };
}

function historyEntry(
	sets: SessionSet[],
	overrides: Partial<ExerciseHistoryEntry> = {}
): ExerciseHistoryEntry {
	return {
		sessionId: 'previous-session',
		workoutNameSnapshot: 'Upper body',
		dayKey: '2026-05-03',
		status: 'completed',
		sets,
		...overrides
	};
}

describe('persisted name normalization', () => {
	it('uses locale-independent lowercase keys', () => {
		expect(normalizeName('  I   PRESS  ')).toBe('i press');
	});
});

describe('session input values', () => {
	it('preserves intentional blanks and parses only finite values', () => {
		expect(toStoredInputValue('', 100)).toBe('');
		expect(toStoredInputValue(undefined, 0)).toBe('0');
		expect(toStoredInputValue(undefined, Number.NaN)).toBe('');

		expect(toParsedInputValue(' 82.5 ', 'weight')).toBe(82.5);
		expect(toParsedInputValue(' 8 ', 'reps')).toBe(8);
		expect(toParsedInputValue('Infinity', 'weight')).toBeUndefined();
		expect(toParsedInputValue('   ', 'rir')).toBeUndefined();
	});
});

describe('session activity and summaries', () => {
	it('uses the latest real set edit inside the session window', () => {
		const result = getLastSessionSetActivityAt(
			[
				sessionSet({ id: 'seed-row' }),
				sessionSet({ id: 'before-start', createdAt: atMinute(-10), updatedAt: atMinute(-1) }),
				sessionSet({ id: 'first-edit', createdAt: atMinute(1), updatedAt: atMinute(20) }),
				sessionSet({ id: 'at-cutoff', createdAt: atMinute(2), updatedAt: atMinute(60) }),
				sessionSet({ id: 'after-cutoff', createdAt: atMinute(2), updatedAt: atMinute(61) }),
				sessionSet({ id: 'invalid', createdAt: atMinute(2), updatedAt: 'not-a-date' })
			],
			Date.parse(atMinute(60)),
			Date.parse(atMinute(0))
		);

		expect(result).toEqual({ value: atMinute(60), time: Date.parse(atMinute(60)) });
	});

	it.each([
		{
			name: 'seed row whose timestamps match',
			row: sessionSet()
		},
		{
			name: 'edit before the session started',
			row: sessionSet({ createdAt: atMinute(-10), updatedAt: atMinute(-1) })
		}
	])('ignores a $name', ({ row }) => {
		expect(
			getLastSessionSetActivityAt([row], Date.parse(atMinute(60)), Date.parse(atMinute(0)))
		).toBeNull();
	});

	it('counts session updates only while a workout is in progress', () => {
		const setEdits = [
			sessionSet({ id: 'during-session', createdAt: atMinute(1), updatedAt: atMinute(30) }),
			sessionSet({ id: 'after-completion', createdAt: atMinute(1), updatedAt: atMinute(61) })
		];

		expect(getSessionActivityAt(session({ updatedAt: atMinute(45) }), [setEdits[0]])).toEqual({
			value: atMinute(45),
			time: Date.parse(atMinute(45))
		});
		expect(
			getSessionActivityAt(
				session({ status: 'completed', completedAt: atMinute(60), updatedAt: atMinute(90) }),
				setEdits
			)
		).toEqual({ value: atMinute(30), time: Date.parse(atMinute(30)) });
	});

	it('derives finite workout totals and activity without treating seed rows as edits', () => {
		const editedSet = sessionSet({
			id: 'loaded',
			weight: 100,
			reps: 5,
			createdAt: atMinute(1),
			updatedAt: atMinute(10)
		});
		const sets = [
			editedSet,
			sessionSet({ id: 'weight-only', weight: 60 }),
			sessionSet({ id: 'invalid-weight', weight: Number.NaN, reps: 3 }),
			sessionSet({ id: 'zero-weight', weight: 0, reps: 10 }),
			sessionSet({ id: 'invalid-reps', weight: 20, reps: Number.POSITIVE_INFINITY })
		];

		const summary = summarizeSession(
			session({ dayKey: '', updatedAt: atMinute(5) }),
			[sessionExercise(), sessionExercise({ id: 'second-exercise', order: 2 })],
			sets
		);

		expect(summary).toMatchObject({
			dayKey: '2026-05-10',
			lastActivityAt: atMinute(10),
			lastSetActivityAt: atMinute(10),
			totalExercises: 2,
			totalSets: 5,
			totalReps: 18,
			totalVolume: 500
		});
	});
});

describe('previous-performance comparisons', () => {
	it('skips newer empty history when choosing a performance reference', () => {
		const emptyHistory = historyEntry([sessionSet({ weightInput: ' ' })], {
			sessionId: 'newer-empty'
		});
		const performedHistory = historyEntry([sessionSet({ weight: 0 })], {
			sessionId: 'older-performed'
		});

		expect(findLatestHistoryEntryWithPerformedSets([emptyHistory, performedHistory])).toBe(
			performedHistory
		);
	});

	it('matches references by both set order and side and ignores empty matches', () => {
		const current = exerciseDetail([
			sessionSet({ id: 'current-right', side: 'right' }),
			sessionSet({ id: 'current-left', side: 'left' })
		]);
		const previous = historyEntry([
			sessionSet({ id: 'empty-right', side: 'right' }),
			sessionSet({ id: 'performed-left', side: 'left', weight: 45 }),
			sessionSet({ id: 'wrong-side', side: 'bilateral', weight: 999 })
		]);

		const references = buildPreviousReferenceBySetKey(current, previous);

		expect([...references.keys()]).toEqual(['1:left']);
		expect(references.get('1:left')).toMatchObject({
			weight: 45
		});
	});
});
