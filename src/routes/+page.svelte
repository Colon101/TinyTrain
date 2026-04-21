<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<form action={resolve('/workouts/new')}>
	<button type="submit">Create workout</button>
</form>
