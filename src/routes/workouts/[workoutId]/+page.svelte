<script lang="ts">
	import WorkoutMaker from '$lib/WorkoutMaker.svelte';

	let { data }: { data: { workoutId: string } } = $props();
</script>

<WorkoutMaker routeWorkoutId={data.workoutId} />
