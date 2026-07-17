import { describe, expect, it } from 'vitest';
import { isSessionExerciseRoute } from './session-navigation';

describe('isSessionExerciseRoute', () => {
	it('recognizes another exercise inside the current session', () => {
		expect(
			isSessionExerciseRoute('/sessions/session-1/exercises/exercise-2', '/sessions/session-1')
		).toBe(true);
		expect(
			isSessionExerciseRoute(
				'/tinytrain/sessions/session-1/exercises/exercise-2',
				'/tinytrain/sessions/session-1/'
			)
		).toBe(true);
	});

	it('does not classify session exits or another session as exercise navigation', () => {
		expect(isSessionExerciseRoute('/sessions/session-1', '/sessions/session-1')).toBe(false);
		expect(
			isSessionExerciseRoute('/sessions/session-2/exercises/exercise-2', '/sessions/session-1')
		).toBe(false);
		expect(isSessionExerciseRoute('/sessions/session-1/exercises/', '/sessions/session-1')).toBe(
			false
		);
		expect(
			isSessionExerciseRoute(
				'/sessions/session-1/exercises/exercise-2/details',
				'/sessions/session-1'
			)
		).toBe(false);
	});
});
