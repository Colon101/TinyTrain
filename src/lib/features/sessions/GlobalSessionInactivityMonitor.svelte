<script lang="ts">
	import { onMount } from 'svelte';
	import type { SessionSummary } from '$lib/db';
	import { SESSION_INACTIVITY_CHECK_INTERVAL_MS } from '$lib/session-inactivity';
	import SessionInactivityMonitor from './SessionInactivityMonitor.svelte';

	type DatabaseApi = typeof import('$lib/db');
	type SubscriptionLike = { unsubscribe(): void };

	let summary = $state<SessionSummary | null>(null);
	let api: DatabaseApi | null = null;
	let loadGeneration = 0;

	async function loadCurrentSession(runCleanup = false) {
		const dbApi = api;

		if (!dbApi) {
			return;
		}

		const generation = ++loadGeneration;

		if (runCleanup) {
			try {
				await dbApi.cleanupStaleSessions();
			} catch (error) {
				console.warn('Session inactivity cleanup failed.', error);
			}
		}

		const nextSummary = await dbApi.getCurrentInProgressSession();

		if (generation === loadGeneration) {
			summary = nextSummary;
		}
	}

	onMount(() => {
		let disposed = false;
		let subscription: SubscriptionLike | null = null;
		let intervalId: ReturnType<typeof setInterval> | null = null;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');
				await dbApi.ensureDbOpen();

				if (disposed) {
					return;
				}

				api = dbApi;
				subscription = dbApi.subscribeToDatabaseChanges(
					['workoutSessions', 'sessionExercises', 'sessionSets'],
					() => {
						void loadCurrentSession().catch((error) => {
							console.warn('Session inactivity refresh failed.', error);
						});
					},
					{ debounceMs: 250 }
				);
				intervalId = setInterval(() => {
					void loadCurrentSession(true).catch((error) => {
						console.warn('Session inactivity cleanup failed.', error);
					});
				}, SESSION_INACTIVITY_CHECK_INTERVAL_MS);
				void loadCurrentSession(true).catch((error) => {
					console.warn('Session inactivity monitor failed to load.', error);
				});
			} catch (error) {
				console.warn('Session inactivity monitor failed to start.', error);
			}
		})();

		return () => {
			disposed = true;
			api = null;
			loadGeneration += 1;
			subscription?.unsubscribe();

			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	});
</script>

<div
	class="pointer-events-none absolute inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40"
>
	<div class="pointer-events-auto mx-auto max-w-107.5">
		<SessionInactivityMonitor {summary} onAbandoned={() => loadCurrentSession()} />
	</div>
</div>
