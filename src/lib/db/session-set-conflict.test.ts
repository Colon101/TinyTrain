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
	it('keeps a structural reset one logical tick after a stale input branch', async () => {
		const assumedMaster = createSessionSet({ weightInput: '80', weight: 80 });
		const staleInputBranch = createSessionSet({
			...assumedMaster,
			weightInput: '105',
			weight: 105,
			updatedAt: firstEditAt
		});
		const structuralReset = createSessionSet({
			...assumedMaster,
			weightInput: '90',
			weight: 90,
			updatedAt: '2026-07-15T10:00:01.001Z'
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
				realMasterState: { ...staleInputBranch, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...structuralReset, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved).toMatchObject({
			weightInput: '90',
			weight: 90,
			updatedAt: '2026-07-15T10:00:01.001Z'
		});
	});

	it('three-way merges disjoint weight and reps edits from a common master', async () => {
		const assumedMaster = createSessionSet({
			weightInput: '80',
			weight: 80,
			repsInput: '8',
			reps: 8,
			rirInput: '2',
			rir: 2
		});
		const localWeightEdit = createSessionSet({
			...assumedMaster,
			weightInput: '100',
			weight: 100,
			updatedAt: firstEditAt
		});
		const masterRepsEdit = createSessionSet({
			...assumedMaster,
			repsInput: '10',
			reps: 10,
			updatedAt: secondEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
				realMasterState: { ...masterRepsEdit, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localWeightEdit, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved).toMatchObject({
			weightInput: '100',
			weight: 100,
			repsInput: '10',
			reps: 10,
			rirInput: '2',
			rir: 2,
			updatedAt: secondEditAt
		});
	});

	it('resolves equal-time same-field edits identically regardless of branch order', async () => {
		const assumedMaster = createSessionSet({ weightInput: '80', weight: 80 });
		const ninety = createSessionSet({
			...assumedMaster,
			weightInput: '90',
			weight: 90,
			updatedAt: secondEditAt
		});
		const ninetyFive = createSessionSet({
			...assumedMaster,
			weightInput: '95',
			weight: 95,
			updatedAt: secondEditAt
		});
		const resolve = (local: SessionSet, master: SessionSet) =>
			sessionSetConflictHandler.resolve(
				{
					assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
					realMasterState: { ...master, user_id: 'user-1', _deleted: false },
					newDocumentState: { ...local, user_id: 'user-1', _deleted: false }
				},
				'test'
			);

		const [firstOrder, reverseOrder] = await Promise.all([
			resolve(ninety, ninetyFive),
			resolve(ninetyFive, ninety)
		]);

		expect(firstOrder).toMatchObject({ weightInput: '95', weight: 95 });
		expect(reverseOrder).toEqual(firstOrder);
	});

	it('preserves an intentional clear while merging a disjoint edit', async () => {
		const assumedMaster = createSessionSet({
			weightInput: '80',
			weight: 80,
			repsInput: '8',
			reps: 8
		});
		const localClear = createSessionSet({
			...assumedMaster,
			repsInput: '',
			reps: undefined,
			updatedAt: firstEditAt
		});
		const masterWeightEdit = createSessionSet({
			...assumedMaster,
			weightInput: '90',
			weight: 90,
			updatedAt: secondEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
				realMasterState: { ...masterWeightEdit, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localClear, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved).toMatchObject({ weightInput: '90', weight: 90, repsInput: '' });
		expect(resolved.reps).toBeUndefined();
	});

	it('lets the newer same-field clear win instead of treating blank as incomplete', async () => {
		const assumedMaster = createSessionSet({ repsInput: '8', reps: 8 });
		const newerLocalClear = createSessionSet({
			...assumedMaster,
			repsInput: '',
			reps: undefined,
			updatedAt: secondEditAt
		});
		const olderMasterEdit = createSessionSet({
			...assumedMaster,
			repsInput: '10',
			reps: 10,
			updatedAt: firstEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
				realMasterState: { ...olderMasterEdit, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...newerLocalClear, user_id: 'user-1', _deleted: false }
			},
			'test'
		);

		expect(resolved.repsInput).toBe('');
		expect(resolved.reps).toBeUndefined();
	});

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

	it('does not delete a master set from a conflicting local tombstone', async () => {
		const localSet = createSessionSet({ updatedAt: secondEditAt });
		const masterSet = createSessionSet({ weightInput: '100', weight: 100, updatedAt: firstEditAt });
		const resolved = await sessionSetConflictHandler.resolve(
			{
				realMasterState: { ...masterSet, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localSet, user_id: 'user-1', _deleted: true }
			},
			'test'
		);

		expect(resolved).toMatchObject({ weightInput: '100', weight: 100, _deleted: false });
	});

	it('does not resurrect a known local deletion when the master concurrently edits the set', async () => {
		const assumedMaster = createSessionSet({ weightInput: '80', weight: 80 });
		const localTombstone = createSessionSet({ ...assumedMaster });
		const masterEdit = createSessionSet({
			...assumedMaster,
			weightInput: '100',
			weight: 100,
			updatedAt: secondEditAt
		});
		const resolved = await sessionSetConflictHandler.resolve(
			{
				assumedMasterState: { ...assumedMaster, user_id: 'user-1', _deleted: false },
				realMasterState: { ...masterEdit, user_id: 'user-1', _deleted: false },
				newDocumentState: { ...localTombstone, user_id: 'user-1', _deleted: true }
			},
			'test'
		);

		expect(resolved._deleted).toBe(true);
	});
});
