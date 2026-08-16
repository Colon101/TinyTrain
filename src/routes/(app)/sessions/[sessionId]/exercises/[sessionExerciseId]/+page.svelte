<script lang="ts">
	import { page } from '$app/state';
	import SessionExerciseScreen from '$lib/features/sessions/SessionExerciseScreen.svelte';
</script>

<svelte:head>
	<title>Session Exercise | TinyTrain</title>
</svelte:head>

{#key page.params.sessionId}
	<SessionExerciseScreen
		sessionId={page.params.sessionId!}
		sessionExerciseId={page.params.sessionExerciseId!}
	/>
{/key}
