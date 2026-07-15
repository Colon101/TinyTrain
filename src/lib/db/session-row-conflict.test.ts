import { describe, expect, it } from 'vitest';
import { sessionExerciseConflictHandler, workoutSessionConflictHandler } from '../rxdb-conflicts';
import type { SessionExercise, SessionSet, WorkoutSession } from './models';

const createdAt = '2026-07-15T10:00:00.000Z';
const firstEditAt = '2026-07-15T10:00:01.000Z';
const secondEditAt = '2026-07-15T10:00:02.000Z';
const staleActivityAt = '2026-07-15T10:00:03.000Z';

function createWorkoutSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
	return {
		id: 'session-1',
		workoutId: 'workout-1',
		workoutNameSnapshot: 'Push',
		dayKey: '2026-07-15',
		startedAt: createdAt,
		status: 'in_progress',
		createdAt,
		updatedAt: createdAt,
		...overrides
	};
}

function createSessionExercise(overrides: Partial<SessionExercise> = {}): SessionExercise {
	return {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'old-exercise',
		exerciseNameSnapshot: 'Old exercise',
		order: 0,
		performedAt: createdAt,
		createdAt,
		updatedAt: createdAt,
		...overrides
	};
}

const synced = <T extends WorkoutSession | SessionExercise>(row: T) => ({
	...row,
	user_id: 'user-1',
	_deleted: false
});

describe('workout session conflict resolution', () => {
	it('keeps completion terminal when a later stale typing timestamp still says in progress', async () => {
		const base = createWorkoutSession();
		const completed = createWorkoutSession({
			...base,
			status: 'completed',
			completedAt: firstEditAt,
			updatedAt: firstEditAt
		});
		const staleTypingActivity = createWorkoutSession({
			...base,
			updatedAt: staleActivityAt
		});
		const resolved = await workoutSessionConflictHandler.resolve(
			{
				assumedMasterState: synced(base),
				realMasterState: synced(completed),
				newDocumentState: synced(staleTypingActivity)
			},
			'test'
		);

		expect(resolved).toMatchObject({
			status: 'completed',
			completedAt: firstEditAt,
			updatedAt: staleActivityAt
		});
	});

	it('preserves a legitimate abandoned-to-in-progress resume over later unchanged abandonment', async () => {
		const base = createWorkoutSession({
			status: 'abandoned',
			completedAt: firstEditAt,
			updatedAt: firstEditAt
		});
		const resumed = createWorkoutSession({
			...base,
			status: 'in_progress',
			startedAt: secondEditAt,
			completedAt: undefined,
			updatedAt: secondEditAt
		});
		const staleAbandonedActivity = createWorkoutSession({
			...base,
			workoutNameSnapshot: 'Push day',
			updatedAt: staleActivityAt
		});
		const resolved = await workoutSessionConflictHandler.resolve(
			{
				assumedMasterState: synced(base),
				realMasterState: synced(staleAbandonedActivity),
				newDocumentState: synced(resumed)
			},
			'test'
		);

		expect(resolved).toMatchObject({
			status: 'in_progress',
			startedAt: secondEditAt,
			workoutNameSnapshot: 'Push day',
			updatedAt: staleActivityAt
		});
		expect(resolved.completedAt).toBeUndefined();
	});
});

describe('session exercise conflict resolution', () => {
	it('keeps a swap atomic while merging a disjoint reorder and performed-at edit', async () => {
		const base = createSessionExercise();
		const swapped = createSessionExercise({
			...base,
			exerciseId: 'replacement-exercise',
			exerciseNameSnapshot: 'Replacement exercise',
			updatedAt: firstEditAt
		});
		const reordered = createSessionExercise({
			...base,
			order: 3,
			performedAt: secondEditAt,
			updatedAt: staleActivityAt
		});
		const resolved = await sessionExerciseConflictHandler.resolve(
			{
				assumedMasterState: synced(base),
				realMasterState: synced(reordered),
				newDocumentState: synced(swapped)
			},
			'test'
		);

		expect(resolved).toMatchObject({
			exerciseId: 'replacement-exercise',
			exerciseNameSnapshot: 'Replacement exercise',
			order: 3,
			performedAt: secondEditAt,
			updatedAt: staleActivityAt
		});
	});

	it('keeps replacement child sets coherent when a stale reorder branch retains the old exercise', async () => {
		const base = createSessionExercise();
		const swapped = createSessionExercise({
			...base,
			exerciseId: 'replacement-exercise',
			exerciseNameSnapshot: 'Replacement exercise',
			updatedAt: firstEditAt
		});
		const reordered = createSessionExercise({ ...base, order: 2, updatedAt: secondEditAt });
		const replacementChild: SessionSet = {
			id: 'replacement-set',
			sessionExerciseId: base.id,
			exerciseId: swapped.exerciseId,
			order: 0,
			side: 'bilateral',
			createdAt: firstEditAt,
			updatedAt: firstEditAt
		};
		const removedOldChildTombstone = {
			id: 'old-set',
			sessionExerciseId: base.id,
			exerciseId: base.exerciseId,
			_deleted: true
		};
		const childRows = [replacementChild, removedOldChildTombstone];
		const resolved = await sessionExerciseConflictHandler.resolve(
			{
				assumedMasterState: synced(base),
				realMasterState: synced(reordered),
				newDocumentState: synced(swapped)
			},
			'test'
		);

		expect(resolved.order).toBe(2);
		expect(resolved.exerciseId).toBe(replacementChild.exerciseId);
		expect(
			childRows
				.filter((row) => !('_deleted' in row) || row._deleted !== true)
				.every((row) => row.exerciseId === resolved.exerciseId)
		).toBe(true);
		expect(removedOldChildTombstone).toMatchObject({
			exerciseId: 'old-exercise',
			_deleted: true
		});
	});
});
