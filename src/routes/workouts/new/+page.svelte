<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import type { Exercise, Workout, WorkoutExerciseWithExercise } from '$lib/db';

	type DatabaseApi = typeof import('$lib/db');

	let dbApi = $state<DatabaseApi | null>(null);
	let exercises = $state<Exercise[]>([]);
	let workouts = $state<Workout[]>([]);
	let workoutExercises = $state<WorkoutExerciseWithExercise[]>([]);
	let selectedWorkoutId = $state('');
	let newWorkoutName = $state('');
	let exerciseSearch = $state('');
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let draggedWorkoutExerciseId = $state('');
	let dragStartWorkoutExerciseIds = $state<string[]>([]);
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');

	let selectedWorkout = $derived(
		workouts.find((workout) => workout.id === selectedWorkoutId) ?? null
	);
	let selectedExerciseIds = $derived(
		new Set(workoutExercises.map((workoutExercise) => workoutExercise.exercise.id))
	);
	let cleanExerciseSearch = $derived(exerciseSearch.trim().replace(/\s+/g, ' '));
	let normalizedExerciseSearch = $derived(cleanExerciseSearch.toLocaleLowerCase());
	let filteredExercises = $derived(
		cleanExerciseSearch
			? exercises.filter((exercise) => exercise.normalizedName.includes(normalizedExerciseSearch))
			: []
	);

	onMount(async () => {
		try {
			dbApi = await import('$lib/db');
			await dbApi.ensureBaselineExercises();
			await loadPageData();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isLoading = false;
		}
	});

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function requireDbApi() {
		if (!dbApi) {
			throw new Error('The local database is still loading.');
		}

		return dbApi;
	}

	async function loadPageData(preferredWorkoutId = selectedWorkoutId) {
		const api = requireDbApi();
		const [nextExercises, nextWorkouts] = await Promise.all([
			api.listExercises(),
			api.listWorkouts()
		]);

		exercises = nextExercises;
		workouts = nextWorkouts;

		if (preferredWorkoutId && nextWorkouts.some((workout) => workout.id === preferredWorkoutId)) {
			selectedWorkoutId = preferredWorkoutId;
		} else {
			selectedWorkoutId = nextWorkouts[0]?.id ?? '';
		}

		await loadSelectedWorkoutExercises();
	}

	async function loadSelectedWorkoutExercises() {
		if (!dbApi || !selectedWorkoutId) {
			workoutExercises = [];
			return;
		}

		workoutExercises = await dbApi.listWorkoutExercises(selectedWorkoutId);
	}

	async function runMutation(action: () => Promise<void>) {
		isSaving = true;
		errorMessage = '';

		try {
			await action();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}

	function handleCreateWorkout(event: SubmitEvent) {
		event.preventDefault();

		void runMutation(async () => {
			const workout = await requireDbApi().createWorkout(newWorkoutName);
			newWorkoutName = '';
			await loadPageData(workout.id);
		});
	}

	function handleWorkoutSelect(event: Event) {
		const target = event.currentTarget as HTMLSelectElement;
		selectedWorkoutId = target.value;
		void loadSelectedWorkoutExercises();
	}

	function addExercise(exerciseId: string) {
		if (!selectedWorkoutId) {
			return;
		}

		void runMutation(async () => {
			await requireDbApi().addExerciseToWorkout(selectedWorkoutId, exerciseId);
			await loadSelectedWorkoutExercises();
		});
	}

	function getWorkoutExerciseIds() {
		return workoutExercises.map((workoutExercise) => workoutExercise.id);
	}

	function orderWorkoutExercises(nextIds: string[]) {
		const workoutExerciseById = new Map(
			workoutExercises.map((workoutExercise) => [workoutExercise.id, workoutExercise])
		);

		workoutExercises = nextIds
			.map((id) => workoutExerciseById.get(id))
			.filter((workoutExercise): workoutExercise is WorkoutExerciseWithExercise =>
				Boolean(workoutExercise)
			);
	}

	function previewDraggedOrder(targetWorkoutExerciseId: string, placement: 'before' | 'after') {
		if (
			!draggedWorkoutExerciseId ||
			targetWorkoutExerciseId === draggedWorkoutExerciseId ||
			workoutExercises.length < 2
		) {
			return;
		}

		const nextIds = getWorkoutExerciseIds().filter((id) => id !== draggedWorkoutExerciseId);
		const targetIndex = nextIds.indexOf(targetWorkoutExerciseId);

		if (targetIndex < 0) {
			return;
		}

		nextIds.splice(
			placement === 'before' ? targetIndex : targetIndex + 1,
			0,
			draggedWorkoutExerciseId
		);

		if (nextIds.join('|') !== getWorkoutExerciseIds().join('|')) {
			orderWorkoutExercises(nextIds);
		}
	}

	function resetDrag(restoreOriginalOrder = false) {
		if (restoreOriginalOrder && dragStartWorkoutExerciseIds.length > 0) {
			orderWorkoutExercises(dragStartWorkoutExerciseIds);
		}

		draggedWorkoutExerciseId = '';
		dragStartWorkoutExerciseIds = [];
	}

	function handleDragPointerDown(event: PointerEvent, workoutExerciseId: string) {
		if (isSaving || workoutExercises.length < 2) {
			return;
		}

		draggedWorkoutExerciseId = workoutExerciseId;
		dragStartWorkoutExerciseIds = getWorkoutExerciseIds();

		const target = event.currentTarget as HTMLElement;
		target.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function handleDragPointerMove(event: PointerEvent) {
		if (!draggedWorkoutExerciseId) {
			return;
		}

		const target = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest<HTMLElement>('[data-workout-exercise-id]');
		const targetWorkoutExerciseId = target?.dataset.workoutExerciseId;

		if (!target || !targetWorkoutExerciseId) {
			return;
		}

		const bounds = target.getBoundingClientRect();
		const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';

		previewDraggedOrder(targetWorkoutExerciseId, placement);
		event.preventDefault();
	}

	function handleDragPointerUp(event: PointerEvent) {
		if (!draggedWorkoutExerciseId || !selectedWorkoutId) {
			resetDrag();
			return;
		}

		const target = event.currentTarget as HTMLElement;
		const finalWorkoutExerciseIds = getWorkoutExerciseIds();
		const startedWorkoutExerciseIds = dragStartWorkoutExerciseIds;
		const workoutId = selectedWorkoutId;
		const orderChanged = finalWorkoutExerciseIds.join('|') !== startedWorkoutExerciseIds.join('|');

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag();

		if (!orderChanged) {
			return;
		}

		void runMutation(async () => {
			await requireDbApi().reorderWorkoutExercises(workoutId, finalWorkoutExerciseIds);
			await loadSelectedWorkoutExercises();
		});
	}

	function handleDragPointerCancel(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag(true);
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		if (!selectedWorkoutId) {
			return;
		}

		void runMutation(async () => {
			const exercise = await requireDbApi().createExercise(
				newExerciseName,
				isNewExerciseUnilateral
			);
			await requireDbApi().addExerciseToWorkout(selectedWorkoutId, exercise.id);
			newExerciseName = '';
			isNewExerciseUnilateral = false;
			exerciseSearch = '';
			await loadPageData(selectedWorkoutId);
		});
	}

	function moveExercise(workoutExerciseId: string, direction: 'up' | 'down') {
		void runMutation(async () => {
			await requireDbApi().moveWorkoutExercise(workoutExerciseId, direction);
			await loadSelectedWorkoutExercises();
		});
	}

	function removeExercise(workoutExerciseId: string) {
		void runMutation(async () => {
			await requireDbApi().removeWorkoutExercise(workoutExerciseId);
			await loadSelectedWorkoutExercises();
		});
	}
</script>

<a href={resolve('/')}>Home</a>

<h1>Create workout</h1>

{#if errorMessage}
	<p>{errorMessage}</p>
{/if}

{#if isLoading}
	<p>Loading local data...</p>
{:else}
	<section>
		<h2>Workout</h2>

		<form onsubmit={handleCreateWorkout}>
			<label for="new-workout-name">Workout name</label>
			<input id="new-workout-name" bind:value={newWorkoutName} autocomplete="off" />
			<button type="submit" disabled={isSaving || !newWorkoutName.trim()}>Create workout</button>
		</form>

		{#if workouts.length > 0}
			<label for="workout-select">Existing workout</label>
			<select id="workout-select" value={selectedWorkoutId} onchange={handleWorkoutSelect}>
				{#each workouts as workout (workout.id)}
					<option value={workout.id}>{workout.name}</option>
				{/each}
			</select>
		{/if}
	</section>

	{#if selectedWorkout}
		<section>
			<h2>{selectedWorkout.name}</h2>

			{#if workoutExercises.length === 0}
				<p>No exercises in this workout yet.</p>
			{:else}
				<ol>
					{#each workoutExercises as workoutExercise, index (workoutExercise.id)}
						<li data-workout-exercise-id={workoutExercise.id}>
							<span>{workoutExercise.exercise.name}</span>
							{#if workoutExercise.exercise.unilateral}
								<small>Unilateral</small>
							{/if}
							<button
								type="button"
								disabled={isSaving || workoutExercises.length < 2}
								style="touch-action: none;"
								onpointerdown={(event) => handleDragPointerDown(event, workoutExercise.id)}
								onpointermove={handleDragPointerMove}
								onpointerup={handleDragPointerUp}
								onpointercancel={handleDragPointerCancel}>Drag</button
							>
							<button
								type="button"
								disabled={isSaving || index === 0}
								onclick={() => moveExercise(workoutExercise.id, 'up')}>Move up</button
							>
							<button
								type="button"
								disabled={isSaving || index === workoutExercises.length - 1}
								onclick={() => moveExercise(workoutExercise.id, 'down')}>Move down</button
							>
							<button
								type="button"
								disabled={isSaving}
								onclick={() => removeExercise(workoutExercise.id)}>Remove</button
							>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<section>
			<h2>Find exercise</h2>

			<label for="exercise-search">Search exercises</label>
			<input id="exercise-search" bind:value={exerciseSearch} autocomplete="off" />

			{#if !cleanExerciseSearch}
				<p>Search exercises to add them.</p>
			{:else if filteredExercises.length === 0}
				<p>No matching exercises.</p>
			{:else}
				<ul>
					{#each filteredExercises as exercise (exercise.id)}
						<li>
							<span>{exercise.name}</span>
							{#if exercise.unilateral}
								<small>Unilateral</small>
							{/if}
							<button
								type="button"
								disabled={isSaving || selectedExerciseIds.has(exercise.id)}
								onclick={() => addExercise(exercise.id)}
							>
								{selectedExerciseIds.has(exercise.id) ? 'Added' : 'Add'}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section>
			<h2>Create exercise</h2>

			<form onsubmit={handleCreateExercise}>
				<label for="new-exercise-name">Exercise name</label>
				<input id="new-exercise-name" bind:value={newExerciseName} autocomplete="off" />
				<label>
					<input type="checkbox" bind:checked={isNewExerciseUnilateral} />
					Unilateral
				</label>
				<button type="submit" disabled={isSaving || !newExerciseName.trim()}>
					Create exercise
				</button>
			</form>
		</section>
	{:else}
		<p>Create a workout first.</p>
	{/if}
{/if}
