import { describe, expect, it } from 'vitest';
import { sessionExerciseConflictHandler } from '../../rxdb-conflicts';
import type { SessionExercise, SessionSet, WorkoutSession } from '../models';
import {
	filterSessionSetsForSessionExercises,
	projectUniqueSessionExercises,
	summarizeSession
} from '../shared';
import {
	getAddedSessionExerciseId,
	getResetSessionExerciseId,
	getSessionExerciseSeedSetLogicalId
} from './schedule-identity';

const createdAt = '2026-07-15T10:00:00.000Z';
const firstEditAt = '2026-07-15T10:00:01.000Z';
const secondEditAt = '2026-07-15T10:00:02.000Z';

function sessionExercise(overrides: Partial<SessionExercise> = {}): SessionExercise {
	return {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'exercise-old',
		exerciseNameSnapshot: 'Old exercise',
		order: 1,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt,
		...overrides
	};
}

function sessionSet(exerciseId: string, overrides: Partial<SessionSet> = {}): SessionSet {
	return {
		id: `${getSessionExerciseSeedSetLogicalId('session-exercise-1', exerciseId, 1)}:bilateral`,
		sessionExerciseId: 'session-exercise-1',
		exerciseId,
		order: 1,
		side: 'bilateral',
		createdAt,
		updatedAt: createdAt,
		...overrides
	};
}

function synced<T extends SessionExercise>(row: T) {
	return { ...row, user_id: 'user-1', _deleted: false };
}

describe('session structure fork convergence', () => {
	it('maps concurrent same-exercise adds to one row while different exercises remain distinct', () => {
		const firstForkId = getAddedSessionExerciseId('session-1', 'exercise-1', createdAt);
		const secondForkId = getAddedSessionExerciseId('session-1', 'exercise-1', createdAt);
		const retryId = getAddedSessionExerciseId('session-1', 'exercise-1', createdAt);
		const otherExerciseId = getAddedSessionExerciseId('session-1', 'exercise-2', createdAt);
		const readdId = getAddedSessionExerciseId('session-1', 'exercise-1', firstEditAt);

		expect(firstForkId).toBe(secondForkId);
		expect(retryId).toBe(firstForkId);
		expect(new Set([firstForkId, secondForkId]).size).toBe(1);
		expect(otherExerciseId).not.toBe(firstForkId);
		expect(readdId).not.toBe(firstForkId);
	});

	it('maps reset forks from the same template to the same exercise and set rows', () => {
		const firstExerciseId = getResetSessionExerciseId('session-1', 'workout-1', 'exercise-1', 1);
		const secondExerciseId = getResetSessionExerciseId('session-1', 'workout-1', 'exercise-1', 1);
		const firstSetId = `${getSessionExerciseSeedSetLogicalId(
			firstExerciseId,
			'exercise-1',
			1
		)}:right`;
		const secondSetId = `${getSessionExerciseSeedSetLogicalId(
			secondExerciseId,
			'exercise-1',
			1
		)}:right`;

		expect(firstExerciseId).toBe(secondExerciseId);
		expect(firstSetId).toBe(secondSetId);
	});

	it('projects one deterministic membership while a removal tombstone is still converging', () => {
		const oldMembership = sessionExercise({ id: 'old-membership' });
		const readdedMembership = sessionExercise({
			id: 'readded-membership',
			createdAt: firstEditAt,
			updatedAt: firstEditAt
		});
		const firstProjection = projectUniqueSessionExercises([oldMembership, readdedMembership]);
		const reverseProjection = projectUniqueSessionExercises([readdedMembership, oldMembership]);

		expect(firstProjection).toEqual([readdedMembership]);
		expect(reverseProjection).toEqual(firstProjection);
	});

	it('projects only seed sets belonging to the conflict-resolved replacement parent', async () => {
		const base = sessionExercise();
		const replacementX = sessionExercise({
			...base,
			exerciseId: 'exercise-x',
			exerciseNameSnapshot: 'Exercise X',
			updatedAt: firstEditAt
		});
		const replacementY = sessionExercise({
			...base,
			exerciseId: 'exercise-y',
			exerciseNameSnapshot: 'Exercise Y',
			updatedAt: secondEditAt
		});
		const resolve = (local: SessionExercise, master: SessionExercise) =>
			sessionExerciseConflictHandler.resolve(
				{
					assumedMasterState: synced(base),
					realMasterState: synced(master),
					newDocumentState: synced(local)
				},
				'test'
			);
		const [resolved, reverseResolved] = await Promise.all([
			resolve(replacementX, replacementY),
			resolve(replacementY, replacementX)
		]);
		const physicalRows = [
			sessionSet('exercise-x', { repsInput: '5', reps: 5 }),
			sessionSet('exercise-y', { repsInput: '9', reps: 9 })
		];
		const projectedRows = filterSessionSetsForSessionExercises(physicalRows, [resolved]);

		expect(reverseResolved).toEqual(resolved);
		expect(physicalRows).toHaveLength(2);
		expect(projectedRows).toHaveLength(1);
		expect(projectedRows[0].exerciseId).toBe(resolved.exerciseId);

		const session: WorkoutSession = {
			id: 'session-1',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Workout',
			dayKey: '2026-07-15',
			status: 'completed',
			startedAt: createdAt,
			completedAt: secondEditAt,
			createdAt,
			updatedAt: secondEditAt
		};
		const summary = summarizeSession(session, [resolved], physicalRows);

		expect(summary.totalSets).toBe(1);
		expect(summary.totalReps).toBe(projectedRows[0].reps);
	});
});
