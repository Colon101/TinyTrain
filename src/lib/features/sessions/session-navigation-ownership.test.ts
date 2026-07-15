import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSessionNavigationOwnershipCoordinator } from './session-navigation-ownership';

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});

	return { promise, resolve, reject };
}

describe('session navigation ownership coordinator', () => {
	it('coalesces two rapid Back replays during a delayed flush and uses the latest target', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const preparation = deferred();
		const prepare = vi.fn(() => preparation.promise);
		const navigate = vi.fn(async () => undefined);

		const firstReplay = coordinator.requestReplay('/first', { prepare, navigate });
		const secondReplay = coordinator.requestReplay('/second', { prepare, navigate });

		expect(firstReplay).toBe(secondReplay);
		expect(prepare).toHaveBeenCalledOnce();
		expect(coordinator.getSnapshot()).toMatchObject({
			isReplayBusy: true,
			shouldBlockUnload: true
		});

		preparation.resolve();
		await expect(firstReplay).resolves.toEqual({ status: 'navigated', target: '/second' });

		expect(navigate).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith('/second');
		expect(coordinator.getSnapshot()).toMatchObject({
			isReplayBusy: false,
			shouldBlockUnload: false
		});
	});

	it('returns the same replay promise to a request made re-entrantly during preparation', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const navigate = vi.fn(async () => undefined);
		let coalescedReplay: Promise<unknown> | null = null;

		const firstReplay = coordinator.requestReplay('/first', {
			prepare: async () => {
				coalescedReplay = coordinator.requestReplay('/second', {
					prepare: vi.fn(async () => undefined),
					navigate
				});
			},
			navigate
		});

		expect(coalescedReplay).toBe(firstReplay);
		await expect(firstReplay).resolves.toEqual({ status: 'navigated', target: '/second' });
		expect(navigate).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith('/second');
	});

	it('suppresses a replay when route ownership changes during preparation', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const preparation = deferred();
		const navigate = vi.fn(async () => undefined);
		const replay = coordinator.requestReplay('/stale', {
			prepare: () => preparation.promise,
			navigate
		});

		coordinator.markRouteChanged();
		preparation.resolve();

		await expect(replay).resolves.toEqual({ status: 'stale' });
		expect(navigate).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().isReplayBusy).toBe(false);
	});

	it('invalidates structural redirects after a route change while keeping the mutation busy', () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const lease = coordinator.beginStructuralMutation();

		expect(lease).not.toBeNull();
		expect(lease?.canRedirect()).toBe(true);
		expect(coordinator.getSnapshot()).toMatchObject({
			isStructuralBusy: true,
			shouldBlockUnload: true
		});

		coordinator.markRouteChanged();

		expect(lease?.canRedirect()).toBe(false);
		expect(coordinator.getSnapshot()).toMatchObject({
			isStructuralBusy: true,
			shouldBlockUnload: true
		});
		expect(lease?.release()).toBe(true);
		expect(coordinator.getSnapshot().shouldBlockUnload).toBe(false);
	});

	it('does not let a stale or repeated lease release clear newer ownership', () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const firstLease = coordinator.beginStructuralMutation();

		expect(firstLease?.release()).toBe(true);

		const secondLease = coordinator.beginStructuralMutation();

		expect(firstLease?.release()).toBe(false);
		expect(secondLease?.canRedirect()).toBe(true);
		expect(coordinator.getSnapshot().isStructuralBusy).toBe(true);
		expect(secondLease?.release()).toBe(true);
		expect(coordinator.getSnapshot().isStructuralBusy).toBe(false);
	});

	it('keeps structural mutation and navigation replay ownership mutually exclusive', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const lease = coordinator.beginStructuralMutation();
		const replayWhileStructural = coordinator.requestReplay('/blocked', {
			prepare: vi.fn(async () => undefined),
			navigate: vi.fn(async () => undefined)
		});

		await expect(replayWhileStructural).resolves.toEqual({ status: 'blocked' });
		expect(coordinator.shouldBlockUnload()).toBe(true);
		lease?.release();

		const preparation = deferred();
		const replay = coordinator.requestReplay('/next', {
			prepare: () => preparation.promise,
			navigate: async () => undefined
		});

		expect(coordinator.beginStructuralMutation()).toBeNull();
		preparation.resolve();
		await replay;
		expect(coordinator.shouldBlockUnload()).toBe(false);
	});

	it('blocks navigation during a delayed remove and leaves its owned redirect single-flight', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const remove = deferred();
		const lease = coordinator.beginStructuralMutation();
		const prepareBackReplay = vi.fn(async () => undefined);
		const replayBack = coordinator.requestReplay('/back', {
			prepare: prepareBackReplay,
			navigate: vi.fn(async () => undefined)
		});
		const goto = vi.fn(async (target: string) => {
			void target;
		});
		const finishRemove = (async () => {
			await remove.promise;

			if (lease?.canRedirect()) {
				await goto('/after-remove');
			}

			lease?.release();
		})();

		await expect(replayBack).resolves.toEqual({ status: 'blocked' });
		expect(prepareBackReplay).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();

		remove.resolve();
		await finishRemove;

		expect(goto).toHaveBeenCalledOnce();
		expect(goto).toHaveBeenCalledWith('/after-remove');
		expect(coordinator.shouldBlockUnload()).toBe(false);
	});

	it('publishes structural/replay busy changes for beforeunload fencing', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const snapshots = vi.fn();
		const unsubscribe = coordinator.subscribe(snapshots);
		const lease = coordinator.beginStructuralMutation();

		expect(snapshots).toHaveBeenLastCalledWith(
			expect.objectContaining({ isStructuralBusy: true, shouldBlockUnload: true })
		);

		lease?.release();
		const preparation = deferred();
		const replay = coordinator.requestReplay('/next', {
			prepare: () => preparation.promise,
			navigate: async () => undefined
		});

		expect(snapshots).toHaveBeenLastCalledWith(
			expect.objectContaining({ isReplayBusy: true, shouldBlockUnload: true })
		);

		preparation.resolve();
		await replay;
		expect(snapshots).toHaveBeenLastCalledWith(
			expect.objectContaining({
				isStructuralBusy: false,
				isReplayBusy: false,
				shouldBlockUnload: false
			})
		);

		unsubscribe();
	});

	it('causes a full-unload warning only while structural or replay ownership is busy', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const preventDefault = vi.fn();
		const warnBeforeUnload = () => {
			if (coordinator.shouldBlockUnload()) {
				preventDefault();
			}
		};
		const lease = coordinator.beginStructuralMutation();

		warnBeforeUnload();
		expect(preventDefault).toHaveBeenCalledOnce();

		lease?.release();
		warnBeforeUnload();
		expect(preventDefault).toHaveBeenCalledOnce();

		const preparation = deferred();
		const replay = coordinator.requestReplay('/next', {
			prepare: () => preparation.promise,
			navigate: async () => undefined
		});

		warnBeforeUnload();
		expect(preventDefault).toHaveBeenCalledTimes(2);

		preparation.resolve();
		await replay;
		warnBeforeUnload();
		expect(preventDefault).toHaveBeenCalledTimes(2);
	});

	it('suppresses a delayed afterSuccess goto after route ownership changes', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const lease = coordinator.beginStructuralMutation();
		const remove = deferred();
		const goto = vi.fn(async (target: string) => {
			void target;
		});
		const finishRemove = (async () => {
			await remove.promise;

			if (lease?.canRedirect()) {
				await goto('/stale-after-success');
			}
		})();

		coordinator.markRouteChanged();
		remove.resolve();
		await finishRemove;

		expect(goto).not.toHaveBeenCalled();
		expect(lease?.release()).toBe(true);
	});

	it('disposal invalidates pending work and leaves stale completions unable to release new state', async () => {
		const coordinator = createSessionNavigationOwnershipCoordinator<string>();
		const preparation = deferred();
		const navigate = vi.fn(async () => undefined);
		const replay = coordinator.requestReplay('/next', {
			prepare: () => preparation.promise,
			navigate
		});

		coordinator.dispose();
		expect(coordinator.getSnapshot()).toMatchObject({
			isStructuralBusy: false,
			isReplayBusy: false,
			shouldBlockUnload: false
		});

		preparation.resolve();
		await expect(replay).resolves.toEqual({ status: 'stale' });
		expect(navigate).not.toHaveBeenCalled();

		const structuralCoordinator = createSessionNavigationOwnershipCoordinator<string>();
		const lease = structuralCoordinator.beginStructuralMutation();
		structuralCoordinator.dispose();
		expect(lease?.canRedirect()).toBe(false);
		expect(lease?.release()).toBe(false);
	});
});

describe('session screen navigation ownership integration', () => {
	const overviewSource = readFileSync(
		resolve(import.meta.dirname, 'SessionOverviewScreen.svelte'),
		'utf8'
	);
	const exerciseSource = readFileSync(
		resolve(import.meta.dirname, 'SessionExerciseScreen.svelte'),
		'utf8'
	);

	it('leases and releases every screen structural mutation and fences full unload', () => {
		for (const source of [overviewSource, exerciseSource]) {
			const runMutationSource = source.slice(
				source.indexOf('\n\tasync function runMutation'),
				source.indexOf('\n\tfunction sanitizeInputValue') > -1
					? source.indexOf('\n\tfunction sanitizeInputValue')
					: source.indexOf('\n\tfunction writeStoredEditDraft')
			);

			expect(source).toContain('createSessionNavigationOwnershipCoordinator');
			expect(source).toContain('beforeNavigate((navigation) => {');
			expect(source).toContain("addEventListener('beforeunload'");
			expect(source).toContain("removeEventListener('beforeunload'");
			expect(source).toContain('navigationOwnership.dispose();');
			expect(runMutationSource).toContain('navigationOwnership.beginStructuralMutation()');
			expect(runMutationSource).toContain('lease.release();');
		}
	});

	it('coalesces Exercise draft replay and lease-checks stale afterSuccess redirects', () => {
		const beforeNavigationSource = exerciseSource.slice(
			exerciseSource.indexOf('\n\tbeforeNavigate'),
			exerciseSource.indexOf('\n\tfunction getErrorMessage')
		);
		const replaySource = exerciseSource.slice(
			exerciseSource.indexOf('\n\tasync function navigateAfterSavingSetInputs'),
			exerciseSource.indexOf('\n\tfunction handleSetInput')
		);
		const runMutationSource = exerciseSource.slice(
			exerciseSource.indexOf('\n\tasync function runMutation'),
			exerciseSource.indexOf('\n\tfunction sanitizeInputValue')
		);

		expect(beforeNavigationSource).toContain('navigation.cancel();');
		expect(beforeNavigationSource).toContain('ownershipSnapshot.isStructuralBusy');
		expect(replaySource).toContain('navigationOwnership.requestReplay(');
		expect(replaySource).toContain('{ path: targetPath, options }');
		expect(runMutationSource.indexOf('if (!lease.canRedirect())')).toBeLessThan(
			runMutationSource.indexOf('await afterSuccess?.(lease)')
		);
	});

	it('invalidates ordinary route ownership and allows only explicit owned redirects through', () => {
		expect(overviewSource).toContain('navigationOwnership.markRouteChanged();');
		expect(overviewSource).toContain('isOwnedSessionNavigation');
		expect(overviewSource).toContain('!lease.canRedirect()');
		expect(exerciseSource).toContain('navigationOwnership.markRouteChanged();');
		expect(exerciseSource).toContain('isReplayingInputNavigation');
		expect(exerciseSource).toContain('!lease.canRedirect()');
	});
});
