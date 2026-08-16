<script lang="ts">
	import { page } from '$app/state';
	import ExercisesScreen from '$lib/features/exercises/ExercisesScreen.svelte';
</script>

<svelte:head>
	<title>Exercise | TinyTrain</title>
</svelte:head>

<ExercisesScreen exerciseId={page.params.exerciseId} />
