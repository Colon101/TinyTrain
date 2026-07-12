import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearSessionEditDraft,
	readSessionEditDraft,
	writeSessionEditDraft
} from './session-overview-actions';

describe('session edit draft storage', () => {
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
});
