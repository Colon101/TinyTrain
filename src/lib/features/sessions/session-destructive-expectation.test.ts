import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('session overview destructive expectations', () => {
	const source = readFileSync(resolve(import.meta.dirname, 'SessionOverviewScreen.svelte'), 'utf8');

	it('captures the complete reset graph and journal before asking for confirmation', () => {
		const resetSource = source.slice(
			source.indexOf('function handleResetSession()'),
			source.indexOf('function handleEndSession()')
		);

		expect(resetSource.indexOf('captureSessionResetExpectation(summaryId)')).toBeGreaterThan(-1);
		expect(resetSource.indexOf('captureSessionResetExpectation(summaryId)')).toBeLessThan(
			resetSource.indexOf('window.confirm(')
		);
		expect(resetSource).toContain('resetSessionInputs(summaryId, destructiveExpectation)');
	});

	it('captures every removed exercise row and draft version before confirmation', () => {
		const removalSource = source.slice(
			source.indexOf('function handleRemoveSessionExercise('),
			source.indexOf('function getSessionExerciseIds()')
		);

		expect(
			removalSource.indexOf('captureSessionExerciseDestructiveEditExpectation(')
		).toBeGreaterThan(-1);
		expect(removalSource.indexOf('captureSessionExerciseDestructiveEditExpectation(')).toBeLessThan(
			removalSource.indexOf('window.confirm(')
		);
		expect(removalSource).toContain('destructiveExpectation');
	});

	it('captures the active replacement branch before either swap action is queued', () => {
		const selectedSource = source.slice(
			source.indexOf('function handleAddSelected()'),
			source.indexOf('function handleCreateExercise(')
		);
		const customSource = source.slice(
			source.indexOf('function handleCreateExercise('),
			source.indexOf('function handleStartSession()')
		);

		for (const handlerSource of [selectedSource, customSource]) {
			expect(handlerSource).toContain('captureSessionExerciseDestructiveEditExpectation');
			expect(handlerSource).toContain('activeSetsOnly: true');
			expect(handlerSource).toContain('destructiveExpectation');
			expect(
				handlerSource.indexOf('captureSessionExerciseDestructiveEditExpectation')
			).toBeLessThan(handlerSource.indexOf('void runMutation('));
		}
	});
});
