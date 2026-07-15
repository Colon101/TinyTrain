import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import {
	captureSessionInputDraftVersionSnapshot,
	clearSessionInputDraft,
	clearSessionInputDraftFieldIfVersion,
	finalizeSessionInputDraftIfUnchanged,
	finalizeSessionInputDraftSetsIfUnchanged,
	getLegacySessionInputDraftKey,
	getSessionInputDraftKey,
	isSessionInputDraftStorageKey,
	migrateLegacySessionInputDraftForCurrentUser,
	readSessionInputDraft,
	removeSessionInputDraftSets,
	sessionInputDraftVersionSnapshotMatches,
	writeSessionInputDraft,
	writeSessionInputDraftField
} from './session-drafts';

vi.mock('$app/environment', () => ({ browser: true }));

describe('session input draft field mutations', () => {
	let values: Map<string, string>;

	beforeEach(() => {
		setAuthOwnedStateIdentity('user-1', true);
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T12:00:00.000Z'));
		values = new Map();
		vi.stubGlobal('localStorage', {
			get length() {
				return values.size;
			},
			getItem: vi.fn((key: string) => values.get(key) ?? null),
			key: vi.fn((index: number) => [...values.keys()][index] ?? null),
			setItem: vi.fn((key: string, value: string) => values.set(key, value)),
			removeItem: vi.fn((key: string) => values.delete(key))
		});
		vi.stubGlobal('window', { dispatchEvent: vi.fn() });
	});

	afterEach(() => {
		setAuthOwnedStateIdentity(null, false);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('does not let an old save completion clear a newer edit of the same field', () => {
		const oldWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const newWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '102',
			baseValue: '100'
		});

		expect(oldWrite.fieldVersion).not.toBe(newWrite.fieldVersion);
		expect(newWrite.intentAt).toBe(oldWrite.intentAt + 1);
		expect(
			clearSessionInputDraftFieldIfVersion('session-1', 'set-1', 'weight', oldWrite.fieldVersion)
		).toMatchObject({ cleared: false });
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '102',
			weightInputBase: '100',
			weightInputVersion: newWrite.fieldVersion
		});
	});

	it('detects a newer scoped journal version and finalizes only the initiating version', () => {
		const firstWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const snapshot = captureSessionInputDraftVersionSnapshot('session-1', ['set-1']);
		const newerWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '102',
			baseValue: '100'
		});

		expect(snapshot.fields).toEqual([
			expect.objectContaining({
				fieldVersion: firstWrite.fieldVersion,
				rawValue: '101'
			})
		]);
		expect(sessionInputDraftVersionSnapshotMatches(snapshot)).toBe(false);
		expect(finalizeSessionInputDraftSetsIfUnchanged(snapshot, ['set-1'])).toBe(true);
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '102',
			weightInputVersion: newerWrite.fieldVersion
		});
	});

	it('keeps a narrow target expectation valid when an unrelated set is journaled', () => {
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const snapshot = captureSessionInputDraftVersionSnapshot('session-1', ['set-1']);

		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-2',
			field: 'reps',
			rawValue: '12',
			baseValue: '10'
		});

		expect(sessionInputDraftVersionSnapshotMatches(snapshot)).toBe(true);
	});

	it('merges field writes with the latest stored draft instead of a stale tab snapshot', () => {
		const firstTabWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const staleFirstTabSnapshot = firstTabWrite.draft;

		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-2',
			field: 'reps',
			rawValue: '9',
			baseValue: '8'
		});

		// The first tab still holds a snapshot from before set-2 was edited. The field-level
		// mutation must synchronously read storage rather than spreading that stale snapshot.
		expect(staleFirstTabSnapshot.sets['set-2']).toBeUndefined();
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'rir',
			rawValue: '1',
			baseValue: '2'
		});

		expect(readSessionInputDraft('session-1')?.sets).toMatchObject({
			'set-1': {
				weightInput: '101',
				weightInputBase: '100',
				rirInput: '1',
				rirInputBase: '2'
			},
			'set-2': {
				repsInput: '9',
				repsInputBase: '8'
			}
		});
	});

	it('survives two tabs interleaving their reads and disjoint storage writes', () => {
		const setItem = vi.mocked(localStorage.setItem);
		let interleaveBeforeFirstCommit: (() => void) | null = () => {
			interleaveBeforeFirstCommit = null;
			writeSessionInputDraftField({
				sessionId: 'session-1',
				sessionSetId: 'set-1',
				field: 'reps',
				rawValue: '9',
				baseValue: '8'
			});
		};
		setItem.mockImplementation((key: string, value: string) => {
			if (interleaveBeforeFirstCommit) {
				const interleave = interleaveBeforeFirstCommit;
				interleaveBeforeFirstCommit = null;
				interleave();
			}

			values.set(key, value);
		});

		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});

		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '101',
			weightInputBase: '100',
			repsInput: '9',
			repsInputBase: '8'
		});
		expect(
			[...values.keys()].filter((key) => key.includes('session-input-draft-journal')).length
		).toBe(2);
	});

	it('does not let an interleaved exact clear erase an unseen newer field version', () => {
		const oldWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const setItem = vi.mocked(localStorage.setItem);
		let newerWrite: ReturnType<typeof writeSessionInputDraftField> | null = null;
		setItem.mockImplementation((key: string, value: string) => {
			if (key.includes(':clear:') && !newerWrite) {
				newerWrite = writeSessionInputDraftField({
					sessionId: 'session-1',
					sessionSetId: 'set-1',
					field: 'weight',
					rawValue: '102',
					baseValue: '100'
				});
			}

			values.set(key, value);
		});

		const clearResult = clearSessionInputDraftFieldIfVersion(
			'session-1',
			'set-1',
			'weight',
			oldWrite.fieldVersion
		);

		expect(clearResult.cleared).toBe(true);
		expect(newerWrite).not.toBeNull();
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '102',
			weightInputBase: '100',
			weightInputVersion: newerWrite!.fieldVersion
		});
	});

	it('clears only one of two unseen same-time versions of the same field', () => {
		const setItem = vi.mocked(localStorage.setItem);
		let concurrentWrite: ReturnType<typeof writeSessionInputDraftField> | null = null;
		let interleaveBeforeFirstCommit = true;
		setItem.mockImplementation((key: string, value: string) => {
			if (interleaveBeforeFirstCommit) {
				interleaveBeforeFirstCommit = false;
				concurrentWrite = writeSessionInputDraftField({
					sessionId: 'session-1',
					sessionSetId: 'set-1',
					field: 'weight',
					rawValue: '102',
					baseValue: '100'
				});
			}

			values.set(key, value);
		});
		const firstWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});

		expect(concurrentWrite).not.toBeNull();
		expect(concurrentWrite!.intentAt).toBe(firstWrite.intentAt);
		clearSessionInputDraftFieldIfVersion('session-1', 'set-1', 'weight', firstWrite.fieldVersion);

		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '102',
			weightInputVersion: concurrentWrite!.fieldVersion
		});
	});

	it('merges new field journals with untouched legacy aggregate fields', () => {
		writeSessionInputDraft({
			sessionId: 'session-1',
			updatedAt: 10,
			sets: {
				'set-1': { repsInput: '8', repsInputBase: '7', updatedAt: 10 }
			}
		});

		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});

		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			weightInput: '101',
			weightInputBase: '100',
			repsInput: '8',
			repsInputBase: '7'
		});
	});

	it('assigns ordered same-field intents even when edits happen in the same millisecond', () => {
		vi.spyOn(Date, 'now').mockReturnValue(100);
		const firstWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '8',
			baseValue: '7'
		});
		const secondWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '9',
			baseValue: '7'
		});

		expect(firstWrite.intentAt).toBe(100);
		expect(secondWrite.intentAt).toBe(101);
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			repsInput: '9',
			repsInputIntentAt: 101
		});
	});

	it('clears only the matching field version and preserves disjoint draft data', () => {
		const weightWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '9',
			baseValue: '8'
		});

		expect(
			clearSessionInputDraftFieldIfVersion('session-1', 'set-1', 'weight', weightWrite.fieldVersion)
		).toMatchObject({ cleared: true });
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			repsInput: '9',
			repsInputBase: '8'
		});
		expect(readSessionInputDraft('session-1')?.sets['set-1']).not.toHaveProperty('weightInput');
		expect(localStorage.removeItem).not.toHaveBeenCalledWith(getSessionInputDraftKey('session-1'));
	});

	it('compacts superseded mutation and clear records after exact clears', () => {
		const firstWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const secondWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '102',
			baseValue: '100'
		});

		clearSessionInputDraftFieldIfVersion('session-1', 'set-1', 'weight', firstWrite.fieldVersion);
		clearSessionInputDraftFieldIfVersion('session-1', 'set-1', 'weight', secondWrite.fieldVersion);

		const journalKeys = [...values.keys()].filter((key) =>
			key.includes('session-input-draft-journal')
		);
		expect(journalKeys).toHaveLength(1);
		expect(journalKeys[0]).toContain(':clear:');
		expect(JSON.parse(values.get(journalKeys[0]!) ?? '{}')).toMatchObject({
			clearedIdentities: [`version:${secondWrite.fieldVersion}`]
		});
		expect(readSessionInputDraft('session-1')).toBeNull();
	});

	it('recognizes aggregate and journal storage events for only the matching session', () => {
		expect(isSessionInputDraftStorageKey('session-1', getSessionInputDraftKey('session-1'))).toBe(
			true
		);
		const write = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'rir',
			rawValue: '1',
			baseValue: '2'
		});
		expect(write.persisted).toBe(true);
		const journalKey = [...values.keys()].find((key) =>
			key.includes('session-input-draft-journal')
		);

		expect(isSessionInputDraftStorageKey('session-1', journalKey ?? null)).toBe(true);
		expect(isSessionInputDraftStorageKey('other-session', journalKey ?? null)).toBe(false);
		expect(isSessionInputDraftStorageKey('session-1', null)).toBe(false);
	});

	it('removes only deleted set entries while preserving the rest of the session draft', () => {
		writeSessionInputDraft({
			sessionId: 'session-1',
			updatedAt: 10,
			sets: {
				'deleted-set': { weightInput: '101', updatedAt: 8 },
				'kept-set': { repsInput: '12', updatedAt: 9 }
			}
		});

		removeSessionInputDraftSets('session-1', ['deleted-set', 'already-missing-set']);

		expect(readSessionInputDraft('session-1')).toEqual({
			sessionId: 'session-1',
			updatedAt: 10,
			sets: {
				'kept-set': { repsInput: '12', updatedAt: 9 }
			}
		});
	});

	it('reports a field as non-durable when storage rejects the recovery draft', () => {
		const storageError = new DOMException('Storage quota exceeded.', 'QuotaExceededError');
		vi.mocked(localStorage.setItem).mockImplementation(() => {
			throw storageError;
		});

		const result = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '102.5',
			baseValue: '100'
		});

		expect(result).toMatchObject({
			persisted: false,
			baseValue: '100',
			draft: {
				sets: {
					'set-1': { weightInput: '102.5', weightInputBase: '100' }
				}
			}
		});
		expect(readSessionInputDraft('session-1')).toBeNull();
	});

	it('reports a field as durable after synchronous storage succeeds', () => {
		const result = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '9',
			baseValue: '8'
		});

		expect(result.persisted).toBe(true);
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.repsInput).toBe('9');
	});

	it('isolates A to B to A input journals when session and set IDs collide', () => {
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '101',
			baseValue: '100'
		});
		const userOneJournalKey = [...values.keys()].find((key) =>
			key.startsWith('tinytrain:session-input-draft-journal:user-1:session-1:')
		);
		expect(userOneJournalKey).toBeDefined();

		setAuthOwnedStateIdentity(null, false);
		expect(readSessionInputDraft('session-1')).toBeNull();
		expect(isSessionInputDraftStorageKey('session-1', userOneJournalKey ?? null)).toBe(false);

		setAuthOwnedStateIdentity('user-2', true);
		expect(readSessionInputDraft('session-1')).toBeNull();
		expect(isSessionInputDraftStorageKey('session-1', userOneJournalKey ?? null)).toBe(false);
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'weight',
			rawValue: '202',
			baseValue: '200'
		});
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.weightInput).toBe('202');

		setAuthOwnedStateIdentity('user-1', true);
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.weightInput).toBe('101');
		expect(isSessionInputDraftStorageKey('session-1', userOneJournalKey ?? null)).toBe(true);
	});

	it('quarantines unscoped input recovery until confirmed ownership migrates it', () => {
		const legacyKey = getLegacySessionInputDraftKey('session-1');
		values.set(
			legacyKey,
			JSON.stringify({
				sessionId: 'session-1',
				updatedAt: 10,
				sets: { 'set-1': { repsInput: '9', repsInputBase: '8', updatedAt: 10 } }
			})
		);

		expect(readSessionInputDraft('session-1')).toBeNull();
		expect(migrateLegacySessionInputDraftForCurrentUser('session-1')).toBe(true);
		expect(readSessionInputDraft('session-1')?.sets['set-1']).toMatchObject({
			repsInput: '9',
			repsInputBase: '8'
		});
		expect(values.has(legacyKey)).toBe(false);

		setAuthOwnedStateIdentity('user-2', true);
		expect(readSessionInputDraft('session-1')).toBeNull();
	});

	it('does not resurrect legacy input after the owner migrated and cleared it', () => {
		const legacyKey = getLegacySessionInputDraftKey('session-1');
		const legacyDraft = JSON.stringify({
			sessionId: 'session-1',
			updatedAt: 10,
			sets: { 'set-1': { repsInput: '9', updatedAt: 10 } }
		});
		values.set(legacyKey, legacyDraft);

		expect(migrateLegacySessionInputDraftForCurrentUser('session-1')).toBe(true);
		clearSessionInputDraft('session-1');
		values.set(legacyKey, legacyDraft);

		expect(migrateLegacySessionInputDraftForCurrentUser('session-1')).toBe(false);
		expect(readSessionInputDraft('session-1')).toBeNull();
	});

	it('does not let a late A flush finalize B recovery data with identical IDs', () => {
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '8',
			baseValue: '7'
		});
		const userOneSnapshot = readSessionInputDraft('session-1');
		expect(userOneSnapshot).not.toBeNull();

		setAuthOwnedStateIdentity('user-2', true);
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '12',
			baseValue: '10'
		});

		expect(finalizeSessionInputDraftIfUnchanged(userOneSnapshot!, null)).toBe(false);
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.repsInput).toBe('12');

		setAuthOwnedStateIdentity('user-1', true);
		expect(finalizeSessionInputDraftIfUnchanged(userOneSnapshot!, null)).toBe(true);
		expect(readSessionInputDraft('session-1')).toBeNull();
	});

	it('does not let a late A field save clear B legacy-version recovery data', () => {
		const userOneWrite = writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '8',
			baseValue: '7'
		});

		setAuthOwnedStateIdentity('user-2', true);
		writeSessionInputDraft({
			sessionId: 'session-1',
			updatedAt: 20,
			sets: { 'set-1': { repsInput: '8', updatedAt: 20 } }
		});

		const clear = clearSessionInputDraftFieldIfVersion(
			'session-1',
			'set-1',
			'reps',
			null,
			'8',
			userOneWrite.ownerId
		);

		expect(clear.cleared).toBe(false);
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.repsInput).toBe('8');
	});

	it('lets a captured A operation finalize only A while B is the resolved owner', () => {
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '8',
			baseValue: '7'
		});
		const ownerASnapshot = readSessionInputDraft('session-1', 'user-1');
		expect(ownerASnapshot).not.toBeNull();

		setAuthOwnedStateIdentity('user-2', true);
		writeSessionInputDraftField({
			sessionId: 'session-1',
			sessionSetId: 'set-1',
			field: 'reps',
			rawValue: '12',
			baseValue: '10'
		});

		expect(finalizeSessionInputDraftIfUnchanged(ownerASnapshot!, null, 'user-1')).toBe(true);
		expect(readSessionInputDraft('session-1')?.sets['set-1']?.repsInput).toBe('12');
		expect(readSessionInputDraft('session-1', 'user-1')).toBeNull();
	});
});
