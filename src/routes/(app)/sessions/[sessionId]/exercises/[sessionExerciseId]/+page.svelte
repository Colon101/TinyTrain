<script lang="ts">
	import SessionExerciseScreen from '$lib/features/sessions/SessionExerciseScreen.svelte';

	let {
		data
	}: {
		data: {
			sessionId: string;
			sessionExerciseId: string;
		};
	} = $props();
</script>

<svelte:head>
	<title>Session Exercise | TinyTrain</title>
</svelte:head>

{#key data.sessionId}
	<SessionExerciseScreen sessionId={data.sessionId} sessionExerciseId={data.sessionExerciseId} />
{/key}
