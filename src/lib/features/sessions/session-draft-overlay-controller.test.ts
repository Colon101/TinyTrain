import { describe, expect, it, vi } from 'vitest';
import {
	getAuthOwnedStateIdentity,
	setAuthOwnedStateIdentity,
	type AuthOwnedStateIdentity
} from '$lib/auth-owned-state';
import type { SessionOverview, SessionSetOverview } from '$lib/db';
import type { SessionInputDraft } from './session-input-draft';
import {
	createSessionDraftOverlayController,
	type SessionDraftOverlayControllerOptions
} from './session-draft-overlay-controller';

const timestamp = '2026-07-15T10:00:00.000Z';

function buildSet(weightInput = '100'): SessionSetOverview {
	const weight = Number(weightInput);

	return {
		id: 'set-1',
		sessionExerciseId: 'session-exercise-1',
		exerciseId: 'exercise-1',
		order: 1,
		side: 'bilateral',
		weightInput,
		repsInput: '8',
		rirInput: '2',
		weight,
		reps: 8,
		rir: 2,
		createdAt: timestamp,
		updatedAt: timestamp,
		label: 'Set 01',
		previousReference: null,
		weightDelta: { state: 'empty', label: '' },
		repsDelta: { state: 'empty', label: '' },
		rirDelta: { state: 'empty', label: '' }
	};
}

function buildOverview(weightInput = '100'): SessionOverview {
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
			totalReps: 8,
			totalVolume: Number(weightInput) * 8
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
				sets: [buildSet(weightInput)],
				exercise: null,
				previousPerformance: null,
				progressStatus: 'new',
				progressSummary: 'First logged performance for this exercise.'
			}
		]
	};
}

function draft(weightInput: string): SessionInputDraft {
	return {
		sessionId: 'session-1',
		sets: { 'set-1': { weightInput } },
		updatedAt: Date.now()
	};
}

function visibleWeight(controller: ReturnType<typeof createSessionDraftOverlayController>) {
	return controller.getSnapshot().overview?.exercises[0]?.sets[0]?.weightInput;
}

function createHarness() {
	const eventSource = new EventTarget();
	const drafts = new Map<string, SessionInputDraft | null>();
	const invalidators = new Set<() => void>();
	let identity: AuthOwnedStateIdentity = {
		ownerId: 'user-a',
		generation: 1,
		isResolved: true
	};
	const options: SessionDraftOverlayControllerOptions = {
		sessionId: 'session-1',
		eventSource,
		getOwnerIdentity: () => identity,
		registerOwnerInvalidator: (invalidate) => {
			invalidators.add(invalidate);
			return () => invalidators.delete(invalidate);
		},
		readDraft: () => (identity.ownerId ? (drafts.get(identity.ownerId) ?? null) : null),
		isDraftStorageKey: (sessionId, key) =>
			Boolean(identity.ownerId && key === `draft:${identity.ownerId}:${sessionId}`)
	};

	function dispatchDraftChange(sessionId = 'session-1') {
		eventSource.dispatchEvent(
			new CustomEvent('tinytrain:session-input-draft-change', { detail: { sessionId } })
		);
	}

	function dispatchStorage(key: string) {
		const event = new Event('storage');
		Object.defineProperty(event, 'key', { value: key });
		eventSource.dispatchEvent(event);
	}

	function switchOwner(ownerId: string | null, isResolved = true) {
		identity = {
			ownerId: isResolved ? ownerId : null,
			generation: identity.generation + 1,
			isResolved
		};

		for (const invalidate of invalidators) {
			invalidate();
		}
	}

	return {
		dispatchDraftChange,
		dispatchStorage,
		drafts,
		eventSource,
		invalidators,
		options,
		switchOwner
	};
}

describe('session draft overlay controller', () => {
	it('retains its clean baseline and overlay for same-user token refreshes only', () => {
		setAuthOwnedStateIdentity('user-a', true);
		const drafts = new Map([
			['user-a', draft('125')],
			['user-b', draft('225')]
		]);
		const controller = createSessionDraftOverlayController({
			sessionId: 'session-1',
			eventSource: new EventTarget(),
			readDraft: () => {
				const ownerId = getAuthOwnedStateIdentity().ownerId;

				return ownerId ? (drafts.get(ownerId) ?? null) : null;
			}
		});
		const baseline = buildOverview('100');
		const snapshotBeforeRefresh = controller.setBaseline(baseline);
		const generationBeforeRefresh = snapshotBeforeRefresh.authGeneration;

		setAuthOwnedStateIdentity('user-a', true);

		expect(getAuthOwnedStateIdentity().generation).toBe(generationBeforeRefresh);
		expect(controller.getSnapshot()).toBe(snapshotBeforeRefresh);
		expect(controller.getSnapshot().baseline).toBe(baseline);
		expect(visibleWeight(controller)).toBe('125');

		setAuthOwnedStateIdentity('user-b', true);
		expect(controller.getSnapshot()).toMatchObject({
			ownerId: 'user-b',
			baseline: null,
			overview: null
		});

		controller.setBaseline(buildOverview('200'));
		setAuthOwnedStateIdentity('user-a', true);
		controller.setBaseline(baseline);
		setAuthOwnedStateIdentity(null, false);
		expect(controller.getSnapshot()).toMatchObject({
			ownerId: null,
			baseline: null,
			overview: null
		});

		controller.dispose();
	});

	it("keeps another tab's durable draft visible when its database save is delayed or fails", async () => {
		const harness = createHarness();
		const controller = createSessionDraftOverlayController(harness.options);
		const cleanBaseline = buildOverview('100');
		controller.setBaseline(cleanBaseline);
		let rejectDatabaseSave!: (reason: unknown) => void;
		const databaseSave = new Promise<void>((_resolve, reject) => {
			rejectDatabaseSave = reject;
		});

		harness.drafts.set('user-a', draft('125'));
		harness.dispatchStorage('draft:user-a:session-1');

		expect(visibleWeight(controller)).toBe('125');
		expect(controller.getSnapshot().baseline).toBe(cleanBaseline);

		// A database change can re-deliver the old clean row while the other tab's save is pending.
		controller.setBaseline(buildOverview('100'));
		expect(visibleWeight(controller)).toBe('125');

		rejectDatabaseSave(new Error('database write failed'));
		await expect(databaseSave).rejects.toThrow('database write failed');
		expect(visibleWeight(controller)).toBe('125');
	});

	it('replaces the same draft field by deriving from the clean baseline each time', () => {
		const harness = createHarness();
		const controller = createSessionDraftOverlayController(harness.options);
		const cleanBaseline = buildOverview('100');
		controller.setBaseline(cleanBaseline);

		harness.drafts.set('user-a', draft('110'));
		harness.dispatchDraftChange();
		expect(visibleWeight(controller)).toBe('110');

		harness.drafts.set('user-a', draft('135'));
		harness.dispatchDraftChange();

		expect(visibleWeight(controller)).toBe('135');
		expect(controller.getSnapshot().baseline).toBe(cleanBaseline);
		expect(cleanBaseline.exercises[0].sets[0].weightInput).toBe('100');
	});

	it('restores the latest database baseline when the durable overlay is cleared', () => {
		const harness = createHarness();
		const controller = createSessionDraftOverlayController(harness.options);
		controller.setBaseline(buildOverview('100'));
		harness.drafts.set('user-a', draft('125'));
		harness.dispatchDraftChange();

		const latestBaseline = buildOverview('105');
		controller.setBaseline(latestBaseline);
		expect(visibleWeight(controller)).toBe('125');

		harness.drafts.set('user-a', null);
		harness.dispatchDraftChange();

		expect(controller.getSnapshot().overview).toBe(latestBaseline);
		expect(visibleWeight(controller)).toBe('105');
	});

	it("invalidates the baseline and re-reads only the new owner's journal on owner switch", () => {
		const harness = createHarness();
		harness.drafts.set('user-a', draft('111'));
		harness.drafts.set('user-b', draft('222'));
		const controller = createSessionDraftOverlayController(harness.options);
		controller.setBaseline(buildOverview('100'));
		expect(visibleWeight(controller)).toBe('111');

		harness.switchOwner('user-b');

		expect(controller.getSnapshot()).toMatchObject({
			ownerId: 'user-b',
			baseline: null,
			overview: null,
			draft: harness.drafts.get('user-b')
		});

		controller.setBaseline(buildOverview('200'));
		expect(visibleWeight(controller)).toBe('222');

		// A late storage event for A is filtered against B's owner-scoped key.
		harness.drafts.set('user-a', draft('999'));
		harness.dispatchStorage('draft:user-a:session-1');
		expect(visibleWeight(controller)).toBe('222');
	});

	it('rejects a clean baseline that finishes loading after its owner scope changed', () => {
		const harness = createHarness();
		const controller = createSessionDraftOverlayController(harness.options);
		const staleOwnerScope = controller.getOwnerScope();

		harness.switchOwner('user-b');
		controller.setBaseline(buildOverview('100'), staleOwnerScope);

		expect(controller.isCurrentOwnerScope(staleOwnerScope)).toBe(false);
		expect(controller.getSnapshot()).toMatchObject({
			ownerId: 'user-b',
			baseline: null,
			overview: null
		});
	});

	it('unsubscribes from draft and owner events on disposal', () => {
		const harness = createHarness();
		const controller = createSessionDraftOverlayController(harness.options);
		controller.setBaseline(buildOverview('100'));
		const listener = vi.fn();
		controller.subscribe(listener);
		const snapshotBeforeDispose = controller.getSnapshot();

		controller.dispose();
		harness.drafts.set('user-a', draft('130'));
		harness.dispatchDraftChange();
		harness.dispatchStorage('draft:user-a:session-1');
		harness.switchOwner('user-b');

		expect(controller.getSnapshot()).toBe(snapshotBeforeDispose);
		expect(listener).toHaveBeenCalledOnce();
		expect(harness.invalidators).toHaveLength(0);
	});
});
