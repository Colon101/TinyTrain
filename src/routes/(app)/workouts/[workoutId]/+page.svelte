<script lang="ts">
	import WorkoutsScreen from '$lib/features/workouts/WorkoutsScreen.svelte';

	let { data }: { data: { workoutId: string } } = $props();
</script>

<svelte:head>
	<title>Workout Detail | TinyTrain</title>
</svelte:head>

<WorkoutsScreen routeWorkoutId={data.workoutId} />
