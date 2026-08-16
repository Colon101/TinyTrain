<script lang="ts">
	import { page } from '$app/state';
	import SessionOverviewScreen from '$lib/features/sessions/SessionOverviewScreen.svelte';
</script>

<svelte:head>
	<title>Session Overview | TinyTrain</title>
</svelte:head>

{#key page.params.sessionId}
	<SessionOverviewScreen sessionId={page.params.sessionId!} />
{/key}
