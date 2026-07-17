// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '$app/state';
import { setAuthOwnedStateIdentity } from '$lib/auth-owned-state';
import type { SessionOverview } from '$lib/db';
import SessionExerciseScreen from './SessionExerciseScreen.svelte';
import SessionOverviewScreen from './SessionOverviewScreen.svelte';
import { readSessionDataCache } from './session-data-cache';
import { getLegacySessionEditDraftKey, readSessionEditDraft } from './session-overview-actions';
import { createSessionScreenLoadLifetime } from './session-screen-load-lifetime';

const dbMocks = vi.hoisted(() => ({
	cleanupStaleSessions: vi.fn(async () => undefined),
	getEditableSession: vi.fn<(sessionId: string) => Promise<SessionOverview | null>>(),
	hydrateVisibleScope: vi.fn(async () => undefined),
	listExercises: vi.fn(async () => []),
	listExerciseUsagePreferences: vi.fn(async () => []),
	runWithClosedDatabaseRetry: vi.fn(async (operation: () => Promise<unknown>) => operation()),
	subscribeToDatabaseChanges: vi.fn(() => ({ unsubscribe: vi.fn() }))
}));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({
	beforeNavigate: vi.fn(),
	goto: vi.fn(async () => undefined)
}));
vi.mock('$app/paths', () => ({
	resolve: (route: string, parameters: Record<string, string> = {}) =>
		Object.entries(parameters).reduce(
			(path, [key, value]) => path.replace(`[${key}]`, value),
			route.replace('/(app)', '')
		)
}));
vi.mock('$app/state', () => ({
	page: { url: new URL('https://tinytrain.test/sessions/session-1') }
}));
vi.mock('$lib/db', () => dbMocks);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});

	return { promise, resolve };
}

type ScreenCase = {
	name: string;
	mountScreen: (target: HTMLElement) => Record<string, unknown>;
	loadingText: string;
	emptyText: string;
};

const screenCases: ScreenCase[] = [
	{
		name: 'session overview',
		mountScreen: (target) =>
			mount(SessionOverviewScreen, { target, props: { sessionId: 'session-1' } }),
		loadingText: 'Loading session',
		emptyText: 'Session not found'
	},
	{
		name: 'session exercise',
		mountScreen: (target) =>
			mount(SessionExerciseScreen, {
				target,
				props: { sessionId: 'session-1', sessionExerciseId: 'session-exercise-1' }
			}),
		loadingText: 'Loading exercise',
		emptyText: 'Exercise not found'
	}
];

function buildCompletedOverview(): SessionOverview {
	const timestamp = '2026-07-11T10:00:00.000Z';

	return {
		summary: {
			id: 'session-1',
			workoutId: 'workout-1',
			workoutNameSnapshot: 'Strength',
			dayKey: '2026-07-11',
			startedAt: timestamp,
			completedAt: '2026-07-11T11:00:00.000Z',
			status: 'completed',
			createdAt: timestamp,
			updatedAt: timestamp,
			totalExercises: 0,
			totalSets: 0,
			totalReps: 0,
			totalVolume: 0
		},
		previousSummary: null,
		progress: null,
		exercises: []
	};
}

afterEach(() => {
	document.body.replaceChildren();
	localStorage.clear();
	vi.clearAllMocks();
});

describe('session screen load lifetime', () => {
	it('prevents an older response from overwriting a newer load', async () => {
		const lifetime = createSessionScreenLoadLifetime();
		const olderResponse = deferred<string>();
		const newerResponse = deferred<string>();
		const apply = vi.fn();
		const finishLoad = async (generation: number, response: Promise<string>) => {
			const value = await response;

			if (lifetime.isCurrent(generation)) {
				apply(value);
			}
		};

		const olderLoad = finishLoad(lifetime.beginLoad(), olderResponse.promise);
		const newerLoad = finishLoad(lifetime.beginLoad(), newerResponse.promise);
		newerResponse.resolve('newer');
		await newerLoad;
		olderResponse.resolve('older');
		await olderLoad;

		expect(apply).toHaveBeenCalledOnce();
		expect(apply).toHaveBeenCalledWith('newer');
	});

	it('invalidates cache and navigation side effects after disposal', async () => {
		const lifetime = createSessionScreenLoadLifetime();
		const response = deferred<'abandoned'>();
		const generation = lifetime.beginLoad();
		const redirect = vi.fn();
		const finishLoad = (async () => {
			const status = await response.promise;

			if (lifetime.isCurrent(generation) && status === 'abandoned') {
				redirect();
			}
		})();

		lifetime.dispose();
		response.resolve('abandoned');
		await finishLoad;

		expect(redirect).not.toHaveBeenCalled();
	});

	describe.each(screenCases)('$name screen', (screen) => {
		it('publishes the current delayed load', async () => {
			setAuthOwnedStateIdentity(null, true);
			setAuthOwnedStateIdentity('user-a', true);
			const response = deferred<null>();
			dbMocks.getEditableSession.mockReturnValueOnce(response.promise);
			const target = document.createElement('div');
			document.body.append(target);
			const instance = screen.mountScreen(target);

			try {
				await vi.waitFor(() => expect(dbMocks.getEditableSession).toHaveBeenCalledOnce());
				expect(target.textContent).toContain(screen.loadingText);

				response.resolve(null);
				await vi.waitFor(() => expect(target.textContent).toContain(screen.emptyText));
				expect(readSessionDataCache('session-1')).not.toBeNull();
			} finally {
				await unmount(instance);
			}
		});

		it('ignores a delayed load after the authenticated owner changes', async () => {
			setAuthOwnedStateIdentity(null, true);
			setAuthOwnedStateIdentity('user-a', true);
			const response = deferred<null>();
			dbMocks.getEditableSession.mockReturnValueOnce(response.promise);
			const target = document.createElement('div');
			document.body.append(target);
			const instance = screen.mountScreen(target);

			try {
				await vi.waitFor(() => expect(dbMocks.getEditableSession).toHaveBeenCalledOnce());
				setAuthOwnedStateIdentity('user-b', true);
				response.resolve(null);
				await response.promise;
				await tick();

				expect(target.textContent).toContain(screen.loadingText);
				expect(target.textContent).not.toContain(screen.emptyText);
				expect(readSessionDataCache('session-1')).toBeNull();
			} finally {
				await unmount(instance);
			}
		});

		it('ignores a delayed load after unmount', async () => {
			setAuthOwnedStateIdentity(null, true);
			setAuthOwnedStateIdentity('user-a', true);
			const response = deferred<null>();
			dbMocks.getEditableSession.mockReturnValueOnce(response.promise);
			const target = document.createElement('div');
			document.body.append(target);
			const instance = screen.mountScreen(target);

			await vi.waitFor(() => expect(dbMocks.getEditableSession).toHaveBeenCalledOnce());
			await unmount(instance);
			response.resolve(null);
			await response.promise;
			await tick();

			expect(target.textContent).toBe('');
			expect(readSessionDataCache('session-1')).toBeNull();
		});
	});

	it('claims a legacy edit draft before the overview screen can replace it', async () => {
		setAuthOwnedStateIdentity(null, true);
		setAuthOwnedStateIdentity('user-a', true);
		const legacyDraft = {
			startedAt: '2026-07-11T09:45:00.000Z',
			completedAt: '2026-07-11T11:05:00.000Z'
		};
		localStorage.setItem(getLegacySessionEditDraftKey('session-1'), JSON.stringify(legacyDraft));
		dbMocks.getEditableSession.mockResolvedValueOnce(buildCompletedOverview());
		page.url.searchParams.set('edit', '1');
		const target = document.createElement('div');
		document.body.append(target);
		const instance = mount(SessionOverviewScreen, {
			target,
			props: { sessionId: 'session-1' }
		});

		try {
			await vi.waitFor(() => expect(readSessionEditDraft('session-1')).toEqual(legacyDraft));
			expect(localStorage.getItem(getLegacySessionEditDraftKey('session-1'))).toBeNull();
		} finally {
			page.url.searchParams.delete('edit');
			await unmount(instance);
		}
	});
});
