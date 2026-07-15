import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'SessionOverviewScreen.svelte'), 'utf8');

function readFunction(functionName: string, endMarker: string) {
	const start = source.indexOf(`function ${functionName}`);
	const end = source.indexOf(endMarker, start);

	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);

	return source.slice(start, end);
}

describe('session exercise drag cancellation', () => {
	it('only clears transient drag state and never restores a stale exercise order', () => {
		const resetDragSource = readFunction('resetDrag', '\n\tfunction getDragAutoScrollStep');
		const cancelSource = readFunction('handleDragPointerCancel', '\n\t$effect');

		expect(resetDragSource).toContain('function resetDrag()');
		expect(resetDragSource).not.toContain('orderSessionExercises');
		expect(resetDragSource).not.toContain('writeSessionDataCache');
		expect(cancelSource).toContain('resetDrag();');
		expect(cancelSource).not.toContain('dragStartSessionExerciseIds');
		expect(cancelSource).not.toContain('orderSessionExercises');
	});

	it('only applies the optimistic order after the mutation fence admits the drop', () => {
		const pointerUpSource = readFunction(
			'handleDragPointerUp',
			'\n\tfunction handleDragPointerCancel'
		);
		const mutationBoundary = pointerUpSource.indexOf('void runMutation(async () => {');
		const optimisticReorder = pointerUpSource.indexOf(
			'orderSessionExercises(finalSessionExerciseIds);'
		);

		expect(mutationBoundary).toBeGreaterThan(-1);
		expect(optimisticReorder).toBeGreaterThan(mutationBoundary);
	});
});
