import { describe, expect, it } from 'vitest';
import { createBaselineExerciseId, normalizeExerciseName } from './exercises';

describe('baseline exercise identifiers', () => {
	it('normalizes names with locale-independent lowercase keys', () => {
		expect(normalizeExerciseName('  I   PRESS  ')).toBe('i press');
		expect(createBaselineExerciseId('I   PRESS')).toBe(createBaselineExerciseId('i press'));
	});
});
