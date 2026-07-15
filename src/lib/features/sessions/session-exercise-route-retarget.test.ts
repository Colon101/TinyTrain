import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const screenSource = readFileSync(
	resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'),
	'utf8'
);
const routeSource = readFileSync(
	resolve(
		import.meta.dirname,
		'../../../routes/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]/+page.svelte'
	),
	'utf8'
);

function getFunctionSource(name: string, nextName: string) {
	const start = screenSource.indexOf(`\n\tfunction ${name}`);
	const end = screenSource.indexOf(`\n\tfunction ${nextName}`, start + 1);

	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return screenSource.slice(start, end);
}

describe('session exercise route retargeting', () => {
	it('destroys exercise A picker/menu state when the route changes to exercise B', () => {
		expect(routeSource).toContain('{#key `${data.sessionId}:${data.sessionExerciseId}`}');

		const openPicker = getFunctionSource('openExercisePicker', 'closeExercisePicker');
		const closePicker = getFunctionSource('closeExercisePicker', 'getPickerMutationTarget');
		const getTarget = getFunctionSource('getPickerMutationTarget', 'handleExerciseSearchInput');

		expect(openPicker).toContain('pickerTargetSessionId = sessionId;');
		expect(openPicker).toContain('pickerTargetSessionExerciseId = activeExercise.id;');
		expect(closePicker).toContain("pickerTargetSessionExerciseId = '';");
		expect(closePicker).toContain('selectedPickerExerciseIds = [];');
		expect(closePicker).toContain('isMenuOpen = false;');
		expect(getTarget).toContain('pickerTargetSessionExerciseId !== sessionExerciseId');
	});

	it('keeps a picker submission scoped to the exercise captured when the picker opened', () => {
		const applyPicked = screenSource.slice(
			screenSource.indexOf('\n\tasync function applyPickedExercises'),
			screenSource.indexOf('\n\tfunction handleAddSelected')
		);

		expect(applyPicked).toContain('target.sessionExerciseId');
		expect(applyPicked).toContain('target.sessionId');
		expect(applyPicked).toContain("target.mode === 'swap'");
		expect(applyPicked).not.toContain('activeExercise');
		expect(applyPicked).not.toContain('pickerMode');
		expect(applyPicked).not.toContain('overview.summary.id');
	});

	it('does not retarget delayed add/remove work after pending input settlement', () => {
		const addSet = getFunctionSource('handleAddSet', 'handleRemoveSet');
		const removeExercise = getFunctionSource('handleRemoveExercise', 'handleEndSession');

		expect(addSet).toContain('const targetSessionExerciseId = activeExercise.id;');
		expect(addSet).toContain('addSessionSetRow(targetSessionExerciseId, expectation)');
		expect(addSet).not.toContain('addSessionSetRow(activeExercise.id');

		expect(removeExercise).toContain('const targetSessionExerciseId = targetSessionExercise.id;');
		expect(removeExercise).toContain('removeSessionExercise(\n\t\t\t\t\ttargetSessionExerciseId,');
		expect(removeExercise).toMatch(
			/captureSessionExerciseDestructiveEditExpectation\([\s\S]*?targetSessionExerciseId/
		);
		expect(removeExercise).not.toContain('removeSessionExercise(\n\t\t\t\t\tactiveExercise.id');
		expect(
			removeExercise.indexOf(
				'if (screenDisposed)',
				removeExercise.indexOf('captureSessionExerciseDestructiveEditExpectation')
			)
		).toBeLessThan(removeExercise.indexOf('window.confirm'));
	});

	it('cancels stale work and redirects once the captured screen instance is disposed', () => {
		const runMutation = screenSource.slice(
			screenSource.indexOf('\n\tasync function runMutation'),
			screenSource.indexOf('\n\tfunction sanitizeInputValue')
		);
		const actionIndex = runMutation.indexOf('await action(lease);');
		const loadIndex = runMutation.indexOf('await loadData();');
		const redirectIndex = runMutation.indexOf('await afterSuccess?.(lease);');

		expect(
			runMutation.indexOf(
				'if (screenDisposed)',
				runMutation.indexOf('await waitForPendingSetInputSaves();')
			)
		).toBeGreaterThan(runMutation.indexOf('await waitForPendingSetInputSaves();'));
		expect(runMutation.indexOf('if (screenDisposed)', actionIndex)).toBeLessThan(loadIndex);
		expect(runMutation.indexOf('if (screenDisposed)', loadIndex)).toBeLessThan(redirectIndex);
		expect(runMutation.indexOf('if (!lease.canRedirect())')).toBeLessThan(redirectIndex);
		expect(screenSource).toMatch(
			/screenDisposed = true;[\s\S]*controller\.abort\(\);[\s\S]*loadLifetime\.dispose\(\);/
		);
	});
});
