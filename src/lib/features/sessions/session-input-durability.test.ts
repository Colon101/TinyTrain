import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('session input durability fence', () => {
	const source = readFileSync(resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'), 'utf8');

	it('prompts on unload and blocks SPA navigation while an input has no durable copy', () => {
		expect(source).toContain(
			"window.addEventListener('beforeunload', preventNonDurableInputUnload);"
		);
		expect(source).toContain(
			"window.removeEventListener('beforeunload', preventNonDurableInputUnload);"
		);
		expect(source).toMatch(
			/nonDurableInputs\.size > 0[\s\S]*window\.addEventListener\('beforeunload', preventNonDurableInputUnload\);[\s\S]*nonDurableInputs\.size === 0[\s\S]*window\.removeEventListener\('beforeunload', preventNonDurableInputUnload\);/
		);
		expect(source).toMatch(/event\.preventDefault\(\);[\s\S]*event\.returnValue = '';/);
		expect(source).toMatch(
			/beforeNavigate[\s\S]*nonDurableInputs\.size === 0[\s\S]*navigation\.cancel\(\);[\s\S]*navigateAfterSavingSetInputs/
		);
		expect(source).toMatch(
			/waitForPendingSetInputSaves\(\);[\s\S]*nonDurableInputs\.size > 0[\s\S]*throw new Error\(NON_DURABLE_INPUT_MESSAGE\)/
		);
	});

	it('keeps failed-draft input in view until its exact database save succeeds', () => {
		expect(source).toContain(
			'trackInputDurability(draftOwnerScope, sessionSetId, field, rawValue, version, intent.persisted);'
		);
		expect(source).toMatch(
			/result\.skipped[\s\S]*return;[\s\S]*const draftFieldToClear = intent\.persisted[\s\S]*clearDraftInput\([\s\S]*clearNonDurableInputIfVersion\(key, version\);/
		);
		expect(source).toContain('overview = applyNonDurableInputs(snapshot.overview);');
		expect(source).toContain('overview = applyNonDurableInputs(nextDraftOverlay.overview);');
		expect(source).toContain('{NON_DURABLE_INPUT_MESSAGE}');
	});

	it('settles queued saves and blocks non-durable input before destructive snapshots or confirmation', () => {
		const mutationSource = source.slice(
			source.indexOf('async function runMutation('),
			source.indexOf('function sanitizeInputValue(')
		);
		const removeExerciseSource = source.slice(
			source.indexOf('function handleRemoveExercise()'),
			source.indexOf('function handleEndSession()')
		);

		expect(mutationSource.indexOf('await waitForPendingSetInputSaves();')).toBeLessThan(
			mutationSource.indexOf('if (nonDurableInputs.size > 0)')
		);
		expect(mutationSource.indexOf('if (nonDurableInputs.size > 0)')).toBeLessThan(
			mutationSource.indexOf('await options.prepare()')
		);
		expect(removeExerciseSource).toContain('settlePendingInputsBeforePrepare: true');
		expect(removeExerciseSource).toContain('flushPendingInputs: false');
		expect(
			removeExerciseSource.indexOf('captureSessionExerciseDestructiveEditExpectation')
		).toBeLessThan(removeExerciseSource.indexOf('window.confirm('));
		expect(source).toMatch(
			/handleRemoveSet[\s\S]*flushPendingInputs: false,[\s\S]*settlePendingInputsBeforePrepare: true/
		);
	});

	it('admits queued saves under the keystroke owner and fences teardown side effects', () => {
		const queueSource = source.slice(
			source.indexOf('function queueSetInputSave('),
			source.indexOf('async function waitForPendingSetInputSaves()')
		);
		const teardownSource = source.slice(
			source.indexOf('return () => {'),
			source.indexOf('\n\t});', source.indexOf('return () => {'))
		);

		expect(source).toContain(
			"return `${ownerScope.authGeneration}:${ownerScope.ownerId ?? 'unresolved'}:${sessionSetId}:${field}`;"
		);
		expect(queueSource).toContain(
			'dbApi.updateSessionSetInput(sessionSetId, field, rawValue, intent, {'
		);
		expect(queueSource).toContain('waitFor: previousSave.catch(() => undefined)');
		expect(queueSource).toContain('expectedOwnerId: intent.ownerId');
		expect(queueSource).not.toContain('runWithClosedDatabaseRetry');
		expect(queueSource.indexOf('dbApi.updateSessionSetInput(')).toBeLessThan(
			queueSource.indexOf('const savePromise = ownerBoundSave.then(')
		);
		expect(queueSource).toMatch(
			/const isCurrentSave = \(\) =>[\s\S]*!screenDisposed[\s\S]*inputVersions\.get\(key\) === version[\s\S]*isCurrentOwnerScope\(draftOwnerScope\)/
		);
		expect(queueSource).toContain('if (!isCurrentSave()) {');
		expect(teardownSource).toContain('screenDisposed = true;');
		expect(teardownSource).toContain('controller.abort();');
		expect(teardownSource.indexOf('screenDisposed = true;')).toBeLessThan(
			teardownSource.indexOf('controller.abort();')
		);
	});
});
