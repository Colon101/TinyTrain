<script lang="ts">
	import SessionOverviewScreen from '$lib/features/sessions/SessionOverviewScreen.svelte';

	let { data }: { data: { sessionId: string } } = $props();
</script>

<svelte:head>
	<title>Session Overview | TinyTrain</title>
</svelte:head>

{#key data.sessionId}
	<SessionOverviewScreen sessionId={data.sessionId} />
{/key}
