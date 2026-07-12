<script lang="ts">
	import './layout.css';
	import { injectSpeedInsights } from '@vercel/speed-insights/sveltekit';
	import { dev } from '$app/environment';
	import { injectAnalytics } from '@vercel/analytics/sveltekit';

	let { children } = $props();

	const privateDynamicRouteReplacements: Array<[RegExp, string]> = [
		[
			/^\/sessions\/[^/]+\/exercises\/[^/]+\/?$/,
			'/sessions/[sessionId]/exercises/[sessionExerciseId]'
		],
		[/^\/sessions\/[^/]+\/?$/, '/sessions/[sessionId]'],
		[/^\/workouts\/(?!new(?:\/|$))[^/]+\/?$/, '/workouts/[workoutId]'],
		[/^\/exercises\/.+\/?$/, '/exercises/[...exerciseId]']
	];

	function redactPrivateRouteIdentifiers<T extends { url: string }>(event: T): T {
		try {
			const url = new URL(event.url, 'https://tinytrain.invalid');
			let redactedPath = url.pathname;

			for (const [pattern, replacement] of privateDynamicRouteReplacements) {
				if (pattern.test(redactedPath)) {
					redactedPath = replacement;
					break;
				}
			}

			if (redactedPath === url.pathname) return event;

			return {
				...event,
				url: /^https?:\/\//i.test(event.url) ? `${url.origin}${redactedPath}` : redactedPath
			};
		} catch {
			return event;
		}
	}

	injectSpeedInsights({ beforeSend: redactPrivateRouteIdentifiers });
	injectAnalytics({
		mode: dev ? 'development' : 'production',
		beforeSend: redactPrivateRouteIdentifiers
	});
</script>

{@render children()}
