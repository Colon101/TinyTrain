<script lang="ts">
	import SessionOverviewScreen from '$lib/features/sessions/SessionOverviewScreen.svelte';

	let { data }: { data: { sessionId: string } } = $props();
</script>

<svelte:head>
	<title>Session Overview | TinyTrain</title>
</svelte:head>

<SessionOverviewScreen sessionId={data.sessionId} />
