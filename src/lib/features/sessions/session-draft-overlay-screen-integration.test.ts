import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthOwnedStateIdentity } from '$lib/auth-owned-state';
import type { SessionOverview, SessionSetOverview } from '$lib/db';
import { createSessionDraftOverlayController } from './session-draft-overlay-controller';
import type { SessionInputDraft } from './session-input-draft';
import { hasLoggedValues } from './session-overview';

const timestamp = '2026-07-15T10:00:00.000Z';

function buildEmptySet(repsInput = ''): SessionSetOverview {
	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput: '',
		repsInput,
		rirInput: '',
		...(repsInput ? { reps: Number(repsInput) } : {}),
		createdAt: timestamp,
		updatedAt: timestamp,
		label: 'Set 01',
		previousReference: null,
		weightDelta: { state: 'empty', label: '' },
		repsDelta: { state: 'empty', label: '' },
		rirDelta: { state: 'empty', label: '' }
	};
}

function buildEmptyOverview(repsInput = ''): SessionOverview {
	return {
		summary: {
			id: 'session-1',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Strength',
			dayKey: '2026-07-15',
			startedAt: timestamp,
			status: 'in_progress',
			createdAt: timestamp,
			updatedAt: timestamp,
			totalExercises: 1,
			totalSets: 1,
			totalReps: repsInput ? Number(repsInput) : 0,
			totalVolume: 0
		},
		previousSummary: null,
		progress: null,
		exercises: [
			{
				id: 'session-exercise-1',
				sessionId: 'session-1',
				workoutId: 'workout-1',
				exerciseId: 'exercise-1',
				exerciseNameSnapshot: 'Bench Press',
				order: 1,
				performedAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
				sets: [buildEmptySet(repsInput)],
				exercise: null,
				previousPerformance: null,
				progressStatus: 'new',
				progressSummary: 'First logged performance for this exercise.'
			}
		]
	};
}

function draft(repsInput: string): SessionInputDraft {
	return {
		sessionId: 'session-1',
		sets: { 'set-1': { repsInput } },
		updatedAt: Date.now()
	};
}

describe('session screen draft-overlay integration', () => {
	it('updates Overview logged-value prompts from a durable cross-tab draft and restores baseline on clear', () => {
		const eventSource = new EventTarget();
		const identity: AuthOwnedStateIdentity = {
			ownerId: 'user-1',
			generation: 1,
			isResolved: true
		};
		let storedDraft: SessionInputDraft | null = null;
		const controller = createSessionDraftOverlayController({
			sessionId: 'session-1',
			eventSource,
			getOwnerIdentity: () => identity,
			registerOwnerInvalidator: () => () => undefined,
			readDraft: () => storedDraft,
			isDraftStorageKey: (_sessionId, key) => key === 'draft:user-1:session-1'
		});
		const baseline = buildEmptyOverview();
		let renderedOverview = controller.setBaseline(baseline).overview;
		controller.subscribe((snapshot) => {
			renderedOverview = snapshot.overview;
		});

		expect(hasLoggedValues(renderedOverview!.exercises[0])).toBe(false);

		storedDraft = draft('8');
		const storageEvent = new Event('storage');
		Object.defineProperty(storageEvent, 'key', { value: 'draft:user-1:session-1' });
		eventSource.dispatchEvent(storageEvent);

		expect(renderedOverview!.exercises[0].sets[0].repsInput).toBe('8');
		expect(hasLoggedValues(renderedOverview!.exercises[0])).toBe(true);
		expect(controller.getSnapshot().baseline).toBe(baseline);

		storedDraft = null;
		eventSource.dispatchEvent(
			new CustomEvent('tinytrain:session-input-draft-change', {
				detail: { sessionId: 'session-1' }
			})
		);

		expect(renderedOverview).toBe(baseline);
		expect(hasLoggedValues(renderedOverview!.exercises[0])).toBe(false);
	});

	it('moves a successful input into the clean baseline before clearing its recovery overlay', () => {
		const eventSource = new EventTarget();
		const identity: AuthOwnedStateIdentity = {
			ownerId: 'user-1',
			generation: 1,
			isResolved: true
		};
		let storedDraft: SessionInputDraft | null = draft('8');
		const controller = createSessionDraftOverlayController({
			sessionId: 'session-1',
			eventSource,
			getOwnerIdentity: () => identity,
			registerOwnerInvalidator: () => () => undefined,
			readDraft: () => storedDraft,
			isDraftStorageKey: () => true
		});

		controller.setBaseline(buildEmptyOverview());
		expect(controller.getSnapshot().overview!.exercises[0].sets[0].repsInput).toBe('8');

		const savedBaseline = buildEmptyOverview('8');
		controller.setBaseline(savedBaseline);
		storedDraft = null;
		eventSource.dispatchEvent(
			new CustomEvent('tinytrain:session-input-draft-change', {
				detail: { sessionId: 'session-1' }
			})
		);

		expect(controller.getSnapshot().overview).toBe(savedBaseline);
		expect(controller.getSnapshot().overview!.exercises[0].sets[0].repsInput).toBe('8');
	});

	it('feeds clean baselines to both screens and tears the controller down with route lifetime', () => {
		const screenSources = ['SessionOverviewScreen.svelte', 'SessionExerciseScreen.svelte'].map(
			(fileName) => readFileSync(resolve(import.meta.dirname, fileName), 'utf8')
		);

		for (const source of screenSources) {
			expect(source).toContain('createSessionDraftOverlayController({');
			expect(source).toContain('draftOverlayController.subscribe((snapshot) =>');
			expect(source).toContain('draftOverlayController.getOwnerScope()');
			expect(source).toContain('draftOverlayController.isCurrentOwnerScope(draftOwnerScope)');
			expect(source).toContain('draftOverlayController.setBaseline(nextOverview, draftOwnerScope)');
			expect(source).toContain('overview: nextDraftOverlay.baseline');
			expect(source).toContain('draftOverlayController.dispose();');
			expect(source).not.toContain('overview: nextOverviewWithDraft');
		}

		expect(screenSources[0]).toContain('hasLoggedValues(sessionExercise)');
		expect(screenSources[1]).toContain('applyNonDurableInputs(snapshot.overview)');
		expect(screenSources[1]).toContain('updateSessionBaselineSet(');
		const draftClearIndex = screenSources[1].indexOf('const draftFieldToClear');
		expect(draftClearIndex).toBeGreaterThan(-1);
		expect(
			screenSources[1].lastIndexOf('updateSessionBaselineSet(', draftClearIndex)
		).toBeGreaterThan(-1);
		expect(screenSources[1]).not.toContain(
			'window.addEventListener(SESSION_INPUT_DRAFT_CHANGE_EVENT'
		);

		const overviewRoute = readFileSync(
			resolve(import.meta.dirname, '../../../routes/(app)/sessions/[sessionId]/+page.svelte'),
			'utf8'
		);
		const exerciseRoute = readFileSync(
			resolve(
				import.meta.dirname,
				'../../../routes/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]/+page.svelte'
			),
			'utf8'
		);

		expect(overviewRoute).toContain('{#key data.sessionId}');
		expect(exerciseRoute).toContain('{#key `${data.sessionId}:${data.sessionExerciseId}`}');
	});
});
