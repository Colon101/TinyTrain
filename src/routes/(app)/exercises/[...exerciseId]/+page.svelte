<script lang="ts">
	import ExercisesScreen from '$lib/features/exercises/ExercisesScreen.svelte';

	let {
		data
	}: {
		data: {
			exerciseId: string;
		};
	} = $props();
</script>

<svelte:head>
	<title>Exercise | TinyTrain</title>
</svelte:head>

<ExercisesScreen exerciseId={data.exerciseId} />
