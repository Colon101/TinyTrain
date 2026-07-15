import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('terminal session draft ownership', () => {
	const screenSource = readFileSync(
		resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'),
		'utf8'
	);
	const lifecycleSource = readFileSync(
		resolve(import.meta.dirname, '../../db/sessions/lifecycle.ts'),
		'utf8'
	);
	const editingSource = readFileSync(
		resolve(import.meta.dirname, '../../db/sessions/editing.ts'),
		'utf8'
	);

	it('does not broadly delete drafts after completion or inactivity abandonment', () => {
		const completionSource = lifecycleSource.slice(
			lifecycleSource.indexOf('export async function completeWorkoutSession'),
			lifecycleSource.indexOf('export async function updateWorkoutSessionTiming')
		);
		const abandonmentSource = lifecycleSource.slice(
			lifecycleSource.indexOf('async function abandonInactiveWorkoutSessionForOperation'),
			lifecycleSource.indexOf('async function cleanupStaleSessionsForOperation')
		);

		expect(lifecycleSource).not.toContain('clearSessionInputDraft');
		expect(completionSource).toContain(
			'await flushSessionInputDraftWithDatabase(database, sessionId, {}, userId);'
		);
		expect(completionSource).toContain("status: 'completed'");
		expect(abandonmentSource).toContain(
			'await flushSessionInputDraftWithDatabase(database, sessionId, {}, userId);'
		);
		expect(abandonmentSource).toContain('abandonStoredInactiveSessionForOperation');
	});

	it('finalizes only the reset snapshot captured before the database mutation starts', () => {
		expect(editingSource).toMatch(
			/resetSessionInputsWithOperation[\s\S]*const initiatingExpectation =[\s\S]*captureSessionResetExpectationWithOperation[\s\S]*await database\.transaction[\s\S]*finalizeSessionInputDraftIfUnchanged\(initiatingExpectation\.inputDraft\.draft, null, userId\)/
		);
		expect(editingSource).not.toMatch(
			/resetSessionInputs[\s\S]*clearSessionInputDraft\(sessionId\)/
		);
	});

	it('redirects terminal screens without flushing or clearing a newer recovery draft', () => {
		const terminalNavigationStart = screenSource.indexOf(
			'async function navigateWithoutFlushingSetInputs'
		);
		const terminalNavigationEnd = screenSource.indexOf(
			'\n\tfunction handleSetInput',
			terminalNavigationStart
		);
		const terminalNavigationSource = screenSource.slice(
			terminalNavigationStart,
			terminalNavigationEnd
		);
		const ownedNavigationSource = screenSource.slice(
			screenSource.indexOf('async function performOwnedSessionNavigation'),
			screenSource.indexOf('async function navigateWithoutFlushingSetInputs')
		);

		expect(terminalNavigationStart).toBeGreaterThan(-1);
		expect(terminalNavigationSource).toMatch(
			/nonDurableInputs\.size > 0[\s\S]*waitForPendingSetInputSaves\(\)[\s\S]*throw new Error\(NON_DURABLE_INPUT_MESSAGE\)/
		);
		expect(terminalNavigationSource).toContain('await performOwnedSessionNavigation({');
		expect(ownedNavigationSource).toContain('isReplayingInputNavigation = true;');
		expect(ownedNavigationSource).toContain('await goto(target.path, target.options);');
		expect(terminalNavigationSource).not.toContain('flushPendingSetInputs');
		expect(screenSource).toMatch(/status === 'abandoned'[\s\S]*navigateWithoutFlushingSetInputs/);
		expect(screenSource).toMatch(
			/handleEndSession[\s\S]*completeWorkoutSession\(targetSessionId\)[\s\S]*navigateWithoutFlushingSetInputs/
		);
		expect(screenSource).not.toContain('clearLocalSessionInputDraft');
	});
});
