<script lang="ts">
	import { page } from '$app/state';
	import WorkoutsScreen from '$lib/features/workouts/WorkoutsScreen.svelte';
</script>

<svelte:head>
	<title>Workout Detail | TinyTrain</title>
</svelte:head>

{#key page.params.workoutId}
	<WorkoutsScreen routeWorkoutId={page.params.workoutId} />
{/key}
