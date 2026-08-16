import { describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ db: {}, requireLoggedInUser: vi.fn() }));

import { getSessionExercisePerformedAt } from './exercises';

describe('exercise activity helpers', () => {
	it('preserves the existing performed-at fallback order', () => {
		const session = {
			completedAt: '2026-05-05T11:00:00.000Z',
			startedAt: '2026-05-05T10:00:00.000Z',
			createdAt: '2026-05-05T09:00:00.000Z'
		};

		expect(
			getSessionExercisePerformedAt(session, {
				performedAt: '2026-05-05T10:30:00.000Z'
			})
		).toBe(session.completedAt);
		expect(
			getSessionExercisePerformedAt(
				{ ...session, completedAt: undefined },
				{ performedAt: '2026-05-05T10:30:00.000Z' }
			)
		).toBe(session.startedAt);
	});
});
