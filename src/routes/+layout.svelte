<script lang="ts">
	import './layout.css';

	let { children } = $props();
	import { injectSpeedInsights } from '@vercel/speed-insights/sveltekit';

	injectSpeedInsights();
</script>

{@render children()}
