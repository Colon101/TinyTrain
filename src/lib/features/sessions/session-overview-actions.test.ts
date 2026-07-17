import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import {
	clearSessionEditDraft,
	getSessionEditDraftKey,
	migrateLegacySessionEditDraftForCurrentUser,
	readSessionEditDraft,
	writeSessionEditDraft
} from './session-overview-actions';

describe('session edit draft storage', () => {
	beforeEach(() => {
		setAuthOwnedStateIdentity('user-a', true);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('does not let unavailable storage interrupt session edit actions', () => {
		const storageError = new Error('Storage is unavailable.');
		vi.stubGlobal('localStorage', {
			getItem: vi.fn(() => {
				throw storageError;
			}),
			setItem: vi.fn(() => {
				throw storageError;
			}),
			removeItem: vi.fn(() => {
				throw storageError;
			})
		});

		expect(() => readSessionEditDraft('session-1')).not.toThrow();
		expect(readSessionEditDraft('session-1')).toBeNull();
		expect(() =>
			writeSessionEditDraft('session-1', {
				startedAt: '2026-07-13T10:00:00.000Z',
				completedAt: '2026-07-13T11:00:00.000Z'
			})
		).not.toThrow();
		expect(() => clearSessionEditDraft('session-1')).not.toThrow();
	});

	it('scopes timing drafts to the authenticated owner', () => {
		const userAKey = getSessionEditDraftKey('shared-session-id');

		setAuthOwnedStateIdentity('user-b', true);

		expect(userAKey).toBe('tinytrain:session-edit-draft:user-a:shared-session-id');
		expect(getSessionEditDraftKey('shared-session-id')).toBe(
			'tinytrain:session-edit-draft:user-b:shared-session-id'
		);
	});

	it('claims a legacy timing draft after the signed-in session is confirmed', () => {
		const legacyDraft = {
			startedAt: '2026-07-13T10:00:00.000Z',
			completedAt: '2026-07-13T11:00:00.000Z'
		};
		const storedValues = new Map<string, string>([
			['tinytrain:session-edit-draft:session-1', JSON.stringify(legacyDraft)]
		]);
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => storedValues.get(key) ?? null,
			setItem: (key: string, value: string) => storedValues.set(key, value),
			removeItem: (key: string) => storedValues.delete(key)
		});

		expect(readSessionEditDraft('session-1')).toBeNull();
		expect(migrateLegacySessionEditDraftForCurrentUser('session-1')).toBe(true);
		expect(readSessionEditDraft('session-1')).toEqual(legacyDraft);
		expect(storedValues.has('tinytrain:session-edit-draft:session-1')).toBe(false);
	});
});
