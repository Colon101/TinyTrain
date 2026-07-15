import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import {
	clearSessionEditDraft,
	getLegacySessionEditDraftKey,
	getSessionEditDraftKey,
	migrateLegacySessionEditDraftForCurrentUser,
	readSessionEditDraft,
	writeSessionEditDraft
} from './session-overview-actions';

function createStorageHarness() {
	const values = new Map<string, string>();

	return {
		values,
		storage: {
			getItem: vi.fn((key: string) => values.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => {
				values.set(key, value);
			}),
			removeItem: vi.fn((key: string) => {
				values.delete(key);
			})
		}
	};
}

describe('session edit draft storage', () => {
	beforeEach(() => {
		setAuthOwnedStateIdentity('user-1', true);
	});

	afterEach(() => {
		setAuthOwnedStateIdentity(null, false);
		vi.unstubAllGlobals();
	});

	it('does not let unavailable storage interrupt session edit actions', () => {
		const storageError = new Error('Storage is unavailable.');
		const unavailableStorage = {
			getItem: vi.fn(() => {
				throw storageError;
			}),
			setItem: vi.fn(() => {
				throw storageError;
			}),
			removeItem: vi.fn(() => {
				throw storageError;
			})
		};
		vi.stubGlobal('sessionStorage', unavailableStorage);
		vi.stubGlobal('localStorage', unavailableStorage);

		expect(() => readSessionEditDraft('session-1')).not.toThrow();
		expect(readSessionEditDraft('session-1')).toBeNull();
		expect(() =>
			writeSessionEditDraft('session-1', {
				startedAt: '2026-07-13T10:00:00.000Z',
				completedAt: '2026-07-13T11:00:00.000Z',
				baseStartedAt: '2026-07-13T10:00:00.000Z',
				baseCompletedAt: '2026-07-13T11:00:00.000Z'
			})
		).not.toThrow();
		expect(() => clearSessionEditDraft('session-1')).not.toThrow();
	});

	it('restores the edit baseline together with the unsaved values', () => {
		const tab = createStorageHarness();
		const legacy = createStorageHarness();
		vi.stubGlobal('sessionStorage', tab.storage);
		vi.stubGlobal('localStorage', legacy.storage);
		const draft = {
			startedAt: '2026-07-13T09:45:00.000Z',
			completedAt: '2026-07-13T11:15:00.000Z',
			baseStartedAt: '2026-07-13T10:00:00.000Z',
			baseCompletedAt: '2026-07-13T11:00:00.000Z'
		};

		writeSessionEditDraft('session-1', draft);

		expect(readSessionEditDraft('session-1')).toEqual(draft);
		expect(legacy.values.size).toBe(0);
	});

	it('isolates drafts for the same session in two tab contexts', () => {
		const legacy = createStorageHarness();
		const firstTab = createStorageHarness();
		const secondTab = createStorageHarness();
		const firstDraft = {
			startedAt: '2026-07-13T09:45:00.000Z',
			completedAt: '2026-07-13T11:00:00.000Z',
			baseStartedAt: '2026-07-13T10:00:00.000Z',
			baseCompletedAt: '2026-07-13T11:00:00.000Z'
		};
		const secondDraft = {
			startedAt: '2026-07-13T10:00:00.000Z',
			completedAt: '2026-07-13T11:30:00.000Z',
			baseStartedAt: '2026-07-13T10:00:00.000Z',
			baseCompletedAt: '2026-07-13T11:00:00.000Z'
		};
		vi.stubGlobal('localStorage', legacy.storage);

		vi.stubGlobal('sessionStorage', firstTab.storage);
		writeSessionEditDraft('session-1', firstDraft);
		vi.stubGlobal('sessionStorage', secondTab.storage);
		writeSessionEditDraft('session-1', secondDraft);

		expect(readSessionEditDraft('session-1')).toEqual(secondDraft);
		vi.stubGlobal('sessionStorage', firstTab.storage);
		expect(readSessionEditDraft('session-1')).toEqual(firstDraft);
		expect(legacy.values.size).toBe(0);
	});

	it('quarantines a legacy timing draft until ownership is confirmed, then scopes it', () => {
		const tab = createStorageHarness();
		const legacy = createStorageHarness();
		const legacyDraft = {
			startedAt: '2026-07-13T09:45:00.000Z',
			completedAt: '2026-07-13T11:15:00.000Z'
		};
		const legacyDraftKey = getLegacySessionEditDraftKey('session-1');
		legacy.values.set(legacyDraftKey, JSON.stringify(legacyDraft));
		vi.stubGlobal('sessionStorage', tab.storage);
		vi.stubGlobal('localStorage', legacy.storage);

		expect(readSessionEditDraft('session-1')).toBeNull();
		expect(migrateLegacySessionEditDraftForCurrentUser('session-1')).toBe(true);
		expect(readSessionEditDraft('session-1')).toEqual(legacyDraft);
		expect(JSON.parse(tab.values.get(getSessionEditDraftKey('session-1')) ?? 'null')).toEqual(
			legacyDraft
		);
		expect(legacy.values.has(legacyDraftKey)).toBe(false);
	});

	it('isolates A to B to A timing drafts even when their session IDs are identical', () => {
		const tab = createStorageHarness();
		const legacy = createStorageHarness();
		const firstDraft = {
			startedAt: '2026-07-13T09:45:00.000Z',
			completedAt: '2026-07-13T11:15:00.000Z'
		};
		const secondDraft = {
			startedAt: '2026-07-13T10:30:00.000Z',
			completedAt: '2026-07-13T12:00:00.000Z'
		};
		vi.stubGlobal('localStorage', legacy.storage);
		vi.stubGlobal('sessionStorage', tab.storage);

		writeSessionEditDraft('session-1', firstDraft);
		setAuthOwnedStateIdentity(null, false);
		expect(readSessionEditDraft('session-1')).toBeNull();
		setAuthOwnedStateIdentity('user-2', true);
		expect(readSessionEditDraft('session-1')).toBeNull();
		writeSessionEditDraft('session-1', secondDraft);
		expect(readSessionEditDraft('session-1')).toEqual(secondDraft);

		setAuthOwnedStateIdentity('user-1', true);
		expect(readSessionEditDraft('session-1')).toEqual(firstDraft);
		clearSessionEditDraft('session-1');
		expect(readSessionEditDraft('session-1')).toBeNull();
		setAuthOwnedStateIdentity('user-2', true);
		expect(readSessionEditDraft('session-1')).toEqual(secondDraft);
	});

	it('never overwrites or resurrects an owner-scoped timing draft from stale legacy storage', () => {
		const tab = createStorageHarness();
		const legacy = createStorageHarness();
		const currentDraft = {
			startedAt: '2026-07-13T10:00:00.000Z',
			completedAt: '2026-07-13T11:00:00.000Z'
		};
		const staleLegacyDraft = {
			startedAt: '2026-07-12T08:00:00.000Z',
			completedAt: '2026-07-12T09:00:00.000Z'
		};
		const legacyKey = getLegacySessionEditDraftKey('session-1');
		vi.stubGlobal('sessionStorage', tab.storage);
		vi.stubGlobal('localStorage', legacy.storage);

		writeSessionEditDraft('session-1', currentDraft);
		legacy.values.set(legacyKey, JSON.stringify(staleLegacyDraft));

		expect(migrateLegacySessionEditDraftForCurrentUser('session-1')).toBe(false);
		expect(readSessionEditDraft('session-1')).toEqual(currentDraft);
		clearSessionEditDraft('session-1');
		expect(migrateLegacySessionEditDraftForCurrentUser('session-1')).toBe(false);
		expect(readSessionEditDraft('session-1')).toBeNull();
	});
});
