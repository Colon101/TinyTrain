import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionExerciseOverview, SessionSetOverview } from '$lib/db';
import { confirmSessionExerciseReplacement } from './session-overview';

const timestamp = '2026-07-13T10:00:00.000Z';

function buildSet(overrides: Partial<SessionSetOverview> = {}): SessionSetOverview {
	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		createdAt: timestamp,
		updatedAt: timestamp,
		label: 'Set 01',
		previousReference: null,
		weightDelta: { state: 'empty', label: '' },
		repsDelta: { state: 'empty', label: '' },
		rirDelta: { state: 'empty', label: '' },
		...overrides
	};
}

function buildSessionExercise(sets: SessionSetOverview[] = [buildSet()]): SessionExerciseOverview {
	return {
		id: 'session-exercise-1',
		sessionId: 'session-1',
		workoutId: 'workout-1',
		exerciseId: 'exercise-1',
		exerciseNameSnapshot: 'Bench Press',
		order: 1,
		performedAt: timestamp,
		createdAt: timestamp,
		updatedAt: timestamp,
		sets,
		exercise: null,
		previousPerformance: null,
		progressStatus: 'new',
		progressSummary: 'First logged performance for this exercise.'
	};
}

describe('confirmSessionExerciseReplacement', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('replaces an exercise with blank sets without asking for confirmation', () => {
		const confirm = vi.fn(() => false);
		vi.stubGlobal('window', { confirm });

		expect(confirmSessionExerciseReplacement(buildSessionExercise())).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it.each([
		[false, false],
		[true, true]
	])('uses the user response before discarding logged values', (confirmation, expected) => {
		const confirm = vi.fn(() => confirmation);
		vi.stubGlobal('window', { confirm });

		expect(
			confirmSessionExerciseReplacement(buildSessionExercise([buildSet({ weightInput: '100' })]))
		).toBe(expected);
		expect(confirm).toHaveBeenCalledWith('Replace Bench Press and discard its logged values?');
	});
});
