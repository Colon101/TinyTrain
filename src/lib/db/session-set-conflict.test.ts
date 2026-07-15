import { describe, expect, it } from 'vitest';
import { sessionSetConflictHandler } from '../rxdb-conflicts';
import type { SessionSet } from './models';
import { chooseSessionSetConflict } from './session-set-conflict';

const createdAt = '2026-07-15T10:00:00.000Z';
const firstEditAt = '2026-07-15T10:00:01.000Z';
const secondEditAt = '2026-07-15T10:00:02.000Z';

function createSessionSet(overrides: Partial<SessionSet> = {}): SessionSet {
	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput: '',
		repsInput: '',
		rirInput: '',
		createdAt,
		updatedAt: createdAt,
		...overrides
	};
}

describe('session set conflict resolution', () => {
	it('keeps a completed local set when a stale Supabase revision conflicts', async () => {
		const staleMaster = createSessionSet({
			weightInput: '100',
			weight: 100,
			updatedAt: firstEditAt
		});
		const completedLocalSet = createSessionSet({
			weightInput: '100',
			repsInput: '8',
			rirInput: '2',
			weight: 100,
			reps: 8,
			rir: 2,
			updatedAt: secondEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				realMasterState: { ...staleMaster, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...completedLocalSet, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved).toMatchObject({
			weightInput: '100',
			repsInput: '8',
			rirInput: '2',
			weight: 100,
			reps: 8,
			rir: 2,
			updatedAt: secondEditAt
		});
	});

	it('accepts a genuinely newer master edit', async () => {
		const localSet = createSessionSet({
			weightInput: '100',
			repsInput: '8',
			weight: 100,
			reps: 8,
			updatedAt: firstEditAt
		});
		const newerMaster = createSessionSet({
			weightInput: '105',
			weight: 105,
			updatedAt: secondEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				realMasterState: { ...newerMaster, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localSet, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved).toMatchObject({ weightInput: '105', weight: 105, updatedAt: secondEditAt });
	});

	it('uses completeness when neither row has been edited after creation', () => {
		const emptyNewerSeed = createSessionSet({
			createdAt: secondEditAt,
			updatedAt: secondEditAt
		});
		const filledOlderSeed = createSessionSet({
			weightInput: '100',
			repsInput: '8',
			weight: 100,
			reps: 8
		});

		expect(chooseSessionSetConflict(emptyNewerSeed, filledOlderSeed).row).toBe(filledOlderSeed);
	});

	it('does not resurrect a set deleted on the master', async () => {
		const localSet = createSessionSet({ weightInput: '100', weight: 100, updatedAt: secondEditAt });
		const masterSet = createSessionSet({ updatedAt: firstEditAt });
		const resolved = await sessionSetConflictHandler.resolve(
			{
				realMasterState: { ...masterSet, user_id: 'user-1', _deleted: true },
				newDocumentState: { ...localSet, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved._deleted).toBe(true);
	});
});
