<script lang="ts">
	import { browser } from '$app/environment';
	import type { SessionSummary } from '$lib/db';
	import {
		SESSION_INACTIVITY_ABANDON_MS,
		SESSION_INACTIVITY_CHECK_INTERVAL_MS,
		SESSION_INACTIVITY_WARNING_MS
	} from '$lib/session-inactivity';

	let {
		summary,
		onAbandoned
	}: {
		summary: SessionSummary | null;
		onAbandoned: () => Promise<void> | void;
	} = $props();

	let warningVisible = $state(false);
	let warningActivityAt = $state('');
	let dismissedActivityAt = $state('');

	function getActivityTime(value?: string) {
		const time = value ? new Date(value).getTime() : NaN;
		return Number.isFinite(time) ? time : null;
	}

	function showSystemWarning(sessionId: string, activityAt: string) {
		if (!browser || !('Notification' in window) || Notification.permission !== 'granted') {
			return;
		}

		const storageKey = `tinytrain:session-inactivity-warning:${sessionId}`;

		try {
			if (localStorage.getItem(storageKey) === activityAt) {
				return;
			}

			new Notification('TinyTrain session still running', {
				body: 'No session activity for 2 hours. This session will be abandoned in 1 hour unless you make another change.',
				tag: `tinytrain-session-inactivity-${sessionId}`
			});
			localStorage.setItem(storageKey, activityAt);
		} catch {
			// The in-app warning remains available when system notifications fail.
		}
	}

	$effect(() => {
		const currentSummary = summary;
		const activityAt = currentSummary?.lastActivityAt ?? currentSummary?.startedAt;
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
		const sessionId = currentSummary.id;
		const currentActivityAt = activityAt;
		const currentActivityMs = activityMs;

		async function checkInactivity() {
			if (cancelled || checking) {
				return;
			}

			const elapsedMs = Date.now() - currentActivityMs;

			if (elapsedMs >= SESSION_INACTIVITY_ABANDON_MS) {
				checking = true;

				try {
					const dbApi = await import('$lib/db');
					const abandoned = await dbApi.abandonInactiveWorkoutSession(sessionId);

					if (!cancelled && abandoned) {
						warningVisible = false;
						await onAbandoned();
						return;
					}
				} catch (error) {
					console.warn('Session inactivity check failed.', error);
				} finally {
					checking = false;
				}
			} else if (elapsedMs >= SESSION_INACTIVITY_WARNING_MS) {
				warningActivityAt = currentActivityAt;
				warningVisible = dismissedActivityAt !== currentActivityAt;
				showSystemWarning(sessionId, currentActivityAt);
			}

			if (cancelled) {
				return;
			}

			const nextThreshold =
				elapsedMs < SESSION_INACTIVITY_WARNING_MS
					? SESSION_INACTIVITY_WARNING_MS - elapsedMs
					: elapsedMs < SESSION_INACTIVITY_ABANDON_MS
						? SESSION_INACTIVITY_ABANDON_MS - elapsedMs
						: SESSION_INACTIVITY_CHECK_INTERVAL_MS;
			timeoutId = setTimeout(
				() => void checkInactivity(),
				Math.max(1000, Math.min(nextThreshold, SESSION_INACTIVITY_CHECK_INTERVAL_MS))
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

	function dismissWarning() {
		dismissedActivityAt = warningActivityAt;
		warningVisible = false;
	}
</script>

{#if warningVisible}
	<div
		class="mb-4 flex items-start gap-3 rounded-lg border border-amber-300/30 bg-[#241f10]/95 px-3 py-3 text-sm leading-5 text-amber-100 shadow-2xl backdrop-blur-xl"
		role="status"
	>
		<p class="min-w-0 flex-1">
			No session activity for 2 hours. This session will be abandoned in 1 hour unless you make
			another change.
		</p>
		<button
			class="shrink-0 rounded-md border border-amber-200/20 px-2 py-1 text-xs font-semibold text-amber-50"
			type="button"
			onclick={dismissWarning}
		>
			Dismiss
		</button>
	</div>
{/if}
