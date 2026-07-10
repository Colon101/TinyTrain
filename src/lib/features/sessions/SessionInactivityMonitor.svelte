<script lang="ts">
	import { browser } from '$app/environment';
	import type { SessionSummary } from '$lib/db';

	const WARNING_AFTER_MS = 2 * 60 * 60 * 1000;
	const ABANDON_AFTER_MS = 3 * 60 * 60 * 1000;
	const CHECK_INTERVAL_MS = 60 * 1000;

	let {
		summary,
		onAbandoned
	}: {
		summary: SessionSummary | null;
		onAbandoned: () => Promise<void> | void;
	} = $props();

	let warningVisible = $state(false);

	function getActivityTime(value?: string) {
		const time = value ? new Date(value).getTime() : NaN;
		return Number.isFinite(time) ? time : null;
	}

	function showSystemWarning(activityAt: string) {
		if (!browser || !('Notification' in window) || Notification.permission !== 'granted') {
			return;
		}

		const storageKey = `tinytrain:session-inactivity-warning:${summary?.id ?? ''}`;

		try {
			if (localStorage.getItem(storageKey) === activityAt) {
				return;
			}

			new Notification('TinyTrain session still running', {
				body: 'No workout input for 2 hours. This session will be abandoned in 1 hour unless you log another value.',
				tag: `tinytrain-session-inactivity-${summary?.id ?? ''}`
			});
			localStorage.setItem(storageKey, activityAt);
		} catch {
			// The in-app warning remains available when system notifications fail.
		}
	}

	$effect(() => {
		const currentSummary = summary;
		const activityAt = currentSummary?.lastInputAt ?? currentSummary?.startedAt;
		const activityMs = getActivityTime(activityAt);
		let cancelled = false;
		let checking = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		warningVisible = false;

		if (
			!currentSummary ||
			currentSummary.status !== 'in_progress' ||
			!activityAt ||
			activityMs === null
		) {
			return;
		}

		async function checkInactivity() {
			if (cancelled || checking) {
				return;
			}

			const elapsedMs = Date.now() - activityMs;

			if (elapsedMs >= ABANDON_AFTER_MS) {
				checking = true;

				try {
					const dbApi = await import('$lib/db');
					const abandoned = await dbApi.abandonInactiveWorkoutSession(currentSummary.id);

					if (!cancelled && abandoned) {
						warningVisible = false;
						await onAbandoned();
						return;
					}
				} finally {
					checking = false;
				}
			} else if (elapsedMs >= WARNING_AFTER_MS) {
				warningVisible = true;
				showSystemWarning(activityAt);
			}

			if (cancelled) {
				return;
			}

			const nextThreshold =
				elapsedMs < WARNING_AFTER_MS ? WARNING_AFTER_MS - elapsedMs : ABANDON_AFTER_MS - elapsedMs;
			timeoutId = setTimeout(
				() => void checkInactivity(),
				Math.max(1000, Math.min(nextThreshold, CHECK_INTERVAL_MS))
			);
		}

		void checkInactivity();

		return () => {
			cancelled = true;

			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
	});
</script>

{#if warningVisible}
	<p
		class="mb-4 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-3 text-sm leading-5 text-amber-100"
		role="status"
	>
		No workout input for 2 hours. This session will be abandoned in 1 hour unless you log
		another value.
	</p>
{/if}
