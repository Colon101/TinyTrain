<script lang="ts">
	import './layout.css';

	let { children } = $props();
	import { injectSpeedInsights } from '@vercel/speed-insights/sveltekit';

	import { dev } from '$app/environment';
	import { injectAnalytics } from '@vercel/analytics/sveltekit';
	
	injectSpeedInsights();
	injectAnalytics({ mode: dev ? 'development' : 'production' });
</script>

{@render children()}
