import { describe, expect, it } from 'vitest';
import type {
	ExerciseHistoryEntry,
	SessionExercise,
	SessionExerciseDetail,
	SessionSet,
	SessionSetReference,
	WorkoutSession
} from './models';
import {
	buildPreviousReferenceBySetKey,
	findLatestHistoryEntryWithPerformedSets,
	getLastSessionSetActivityAt,
	getSessionActivityAt,
	normalizeName,
	reconcileSessionExerciseOrderCollisions,
	reconcileSessionSetOrderCollisions,
	summarizeExerciseProgress,
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
		workoutId: 'workout',
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

describe('distributed child ordering', () => {
	it('converges exercise collisions on both replicas without defeating a later reorder', () => {
		const first = sessionExercise({ id: 'exercise-z', order: 2 });
		const second = sessionExercise({ id: 'exercise-a', order: 2 });
		const leading = sessionExercise({ id: 'exercise-leading', order: 1 });
		const firstReplica = reconcileSessionExerciseOrderCollisions([leading, first, second]);
		const secondReplica = reconcileSessionExerciseOrderCollisions([second, first, leading]);

		expect(firstReplica.map(({ id, order }) => [id, order])).toEqual([
			['exercise-leading', 1],
			['exercise-a', 2],
			['exercise-z', 3]
		]);
		expect(secondReplica).toEqual(firstReplica);
		expect(first.order).toBe(2);
		expect(second.order).toBe(2);

		const afterUserReorder = reconcileSessionExerciseOrderCollisions([
			leading,
			{ ...first, order: 2 },
			{ ...second, order: 3 }
		]);
		expect(afterUserReorder.map((row) => row.id)).toEqual([
			'exercise-leading',
			'exercise-z',
			'exercise-a'
		]);
	});

	it('converges colliding unilateral set pairs and preserves a later explicit order', () => {
		const leading = sessionSet({ id: 'leading:bilateral', order: 1 });
		const firstPair = [
			sessionSet({ id: 'pair-z:right', order: 2, side: 'right' }),
			sessionSet({ id: 'pair-z:left', order: 2, side: 'left' })
		];
		const secondPair = [
			sessionSet({ id: 'pair-a:right', order: 2, side: 'right' }),
			sessionSet({ id: 'pair-a:left', order: 2, side: 'left' })
		];
		const firstReplica = reconcileSessionSetOrderCollisions([leading, ...firstPair, ...secondPair]);
		const secondReplica = reconcileSessionSetOrderCollisions([
			...secondPair.toReversed(),
			...firstPair.toReversed(),
			leading
		]);

		expect(firstReplica.map(({ id, order }) => [id, order])).toEqual([
			['leading:bilateral', 1],
			['pair-a:right', 2],
			['pair-a:left', 2],
			['pair-z:right', 3],
			['pair-z:left', 3]
		]);
		expect(secondReplica).toEqual(firstReplica);
		expect(firstPair.every((row) => row.order === 2)).toBe(true);
		expect(secondPair.every((row) => row.order === 2)).toBe(true);

		const afterUserReorder = reconcileSessionSetOrderCollisions([
			leading,
			...firstPair.map((row) => ({ ...row, order: 2 })),
			...secondPair.map((row) => ({ ...row, order: 3 }))
		]);
		expect(afterUserReorder.map((row) => row.id)).toEqual([
			'leading:bilateral',
			'pair-z:right',
			'pair-z:left',
			'pair-a:right',
			'pair-a:left'
		]);
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
			[
				sessionExercise(),
				sessionExercise({ id: 'second-exercise', exerciseId: 'second-exercise', order: 2 })
			],
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
			sessionId: 'previous-session',
			order: 1,
			side: 'left',
			weight: 45
		});
	});

	const priorSet = new Map<string, SessionSetReference>([
		[
			'1:bilateral',
			{
				sessionId: 'previous-session',
				order: 1,
				side: 'bilateral',
				weight: 100,
				reps: 5,
				rir: 2
			}
		]
	]);

	it.each([
		{
			name: 'new exercise',
			values: { weight: 100, reps: 5, rir: 2 },
			references: new Map<string, SessionSetReference>(),
			status: 'new',
			summary: 'First logged performance for this exercise.'
		},
		{
			name: 'matched exercise',
			values: { weight: 100.004, reps: 5, rir: 2 },
			references: priorSet,
			status: 'matched',
			summary: 'Matched the last workout.'
		},
		{
			name: 'improved exercise',
			values: { weight: 102.5, reps: 5, rir: 2 },
			references: priorSet,
			status: 'improved',
			summary: '1 higher field'
		},
		{
			name: 'regressed exercise',
			values: { weight: 100, reps: 4, rir: 2 },
			references: priorSet,
			status: 'regressed',
			summary: '1 lower field'
		},
		{
			name: 'mixed exercise',
			values: { weight: 102.5, reps: 4, rir: 2 },
			references: priorSet,
			status: 'mixed',
			summary: '1 higher field, 1 lower field'
		}
	])('classifies a $name', ({ values, references, status, summary }) => {
		expect(summarizeExerciseProgress(exerciseDetail([sessionSet(values)]), references)).toEqual({
			progressStatus: status,
			progressSummary: summary
		});
	});
});
