<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { flip } from 'svelte/animate';
	import { onMount } from 'svelte';
	import type { Exercise, Workout, WorkoutExerciseWithExercise } from '$lib/db';

	type DatabaseApi = typeof import('$lib/db');
	type PageMode = 'workouts' | 'detail';
	type DragPreview = {
		pointerId: number;
		x: number;
		y: number;
		width: number;
		height: number;
		grabX: number;
		grabY: number;
	};

	let { routeWorkoutId = '' }: { routeWorkoutId?: string } = $props();

	let dbApi = $state<DatabaseApi | null>(null);
	let exercises = $state<Exercise[]>([]);
	let workouts = $state<Workout[]>([]);
	let workoutExercises = $state<WorkoutExerciseWithExercise[]>([]);
	let selectedWorkoutId = $state('');
	let pageMode = $state<PageMode>('workouts');
	let activeRouteWorkoutId = $state('');
	let isCreatingWorkout = $state(false);
	let newWorkoutName = $state('');
	let isExercisePickerOpen = $state(false);
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let draggedWorkoutExerciseId = $state('');
	let dragStartWorkoutExerciseIds = $state<string[]>([]);
	let dragPreview = $state<DragPreview | null>(null);
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');

	let selectedWorkout = $derived(
		workouts.find((workout) => workout.id === selectedWorkoutId) ?? null
	);
	let selectedExerciseIds = $derived(
		new Set(workoutExercises.map((workoutExercise) => workoutExercise.exercise.id))
	);
	let selectedPickerExerciseIdSet = $derived(new Set(selectedPickerExerciseIds));
	let cleanExerciseSearch = $derived(exerciseSearch.trim().replace(/\s+/g, ' '));
	let normalizedExerciseSearch = $derived(cleanExerciseSearch.toLocaleLowerCase());
	let filteredExercises = $derived(
		cleanExerciseSearch
			? exercises.filter((exercise) => exercise.normalizedName.includes(normalizedExerciseSearch))
			: exercises
	);
	let visiblePickerExercises = $derived(filteredExercises.slice(0, cleanExerciseSearch ? 80 : 60));
	let hiddenPickerExerciseCount = $derived(
		Math.max(filteredExercises.length - visiblePickerExercises.length, 0)
	);
	let hasExactExerciseMatch = $derived(
		Boolean(cleanExerciseSearch) &&
			exercises.some((exercise) => exercise.normalizedName === normalizedExerciseSearch)
	);
	let canCreateCustomExercise = $derived(
		Boolean(cleanExerciseSearch) && filteredExercises.length < 5 && !hasExactExerciseMatch
	);
	let workoutExerciseCount = $derived(workoutExercises.length);
	let selectedPickerCount = $derived(selectedPickerExerciseIds.length);
	let addSelectedLabel = $derived(
		selectedPickerCount === 0
			? 'Add exercise(s)'
			: `Add ${selectedPickerCount} exercise${selectedPickerCount === 1 ? '' : 's'}`
	);
	let draggedWorkoutExercise = $derived(
		workoutExercises.find((workoutExercise) => workoutExercise.id === draggedWorkoutExerciseId) ??
			null
	);
	let draggedWorkoutExerciseIndex = $derived(
		workoutExercises.findIndex((workoutExercise) => workoutExercise.id === draggedWorkoutExerciseId)
	);

	onMount(async () => {
		try {
			dbApi = await import('$lib/db');
			await dbApi.ensureBaselineExercises();
			pageMode = routeWorkoutId ? 'detail' : 'workouts';
			await loadPageData(routeWorkoutId);
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isLoading = false;
		}
	});

	$effect(() => {
		if (routeWorkoutId === activeRouteWorkoutId) {
			return;
		}

		activeRouteWorkoutId = routeWorkoutId;

		if (!dbApi || isLoading) {
			return;
		}

		closeExercisePicker();
		pageMode = routeWorkoutId ? 'detail' : 'workouts';

		if (!routeWorkoutId) {
			selectedWorkoutId = '';
			workoutExercises = [];
			return;
		}

		void loadPageData(routeWorkoutId);
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

		if (preferredWorkoutId) {
			if (nextWorkouts.some((workout) => workout.id === preferredWorkoutId)) {
				selectedWorkoutId = preferredWorkoutId;
				await loadSelectedWorkoutExercises();
				return;
			}

			selectedWorkoutId = preferredWorkoutId;
			workoutExercises = [];
			return;
		}

		if (selectedWorkoutId && nextWorkouts.some((workout) => workout.id === selectedWorkoutId)) {
			await loadSelectedWorkoutExercises();
			return;
		}

		selectedWorkoutId = '';
		workoutExercises = [];
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
			isCreatingWorkout = false;
			pageMode = 'detail';
			await loadPageData(workout.id);
			await goto(resolve('/workouts/[workoutId]', { workoutId: workout.id }), {
				keepFocus: true
			});
		});
	}

	function openWorkout(workoutId: string) {
		selectedWorkoutId = workoutId;
		pageMode = 'detail';
		closeExercisePicker();
		void loadSelectedWorkoutExercises();
		void goto(resolve('/workouts/[workoutId]', { workoutId }), { keepFocus: true });
	}

	function closeWorkout() {
		pageMode = 'workouts';
		selectedWorkoutId = '';
		workoutExercises = [];
		closeExercisePicker();
		void goto(resolve('/workouts'), { keepFocus: true });
	}

	function openExercisePicker() {
		if (!selectedWorkoutId) {
			return;
		}

		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isExercisePickerOpen = true;
	}

	function closeExercisePicker() {
		isExercisePickerOpen = false;
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
	}

	function handleExerciseSearchInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		exerciseSearch = target.value;

		if (!newExerciseName) {
			newExerciseName = target.value;
		}
	}

	function togglePickerExercise(exerciseId: string) {
		if (selectedExerciseIds.has(exerciseId)) {
			return;
		}

		if (selectedPickerExerciseIdSet.has(exerciseId)) {
			selectedPickerExerciseIds = selectedPickerExerciseIds.filter((id) => id !== exerciseId);
			return;
		}

		selectedPickerExerciseIds = [...selectedPickerExerciseIds, exerciseId];
	}

	function getPickerExercisePosition(exerciseId: string) {
		const queuedIndex = selectedPickerExerciseIds.indexOf(exerciseId);

		if (queuedIndex >= 0) {
			return workoutExerciseCount + queuedIndex + 1;
		}

		const existingIndex = workoutExercises.findIndex(
			(workoutExercise) => workoutExercise.exercise.id === exerciseId
		);

		return existingIndex >= 0 ? existingIndex + 1 : null;
	}

	function addSelectedExercises() {
		if (!selectedWorkoutId || selectedPickerExerciseIds.length === 0) {
			return;
		}

		const exerciseIdsToAdd = selectedPickerExerciseIds.filter((id) => !selectedExerciseIds.has(id));

		if (exerciseIdsToAdd.length === 0) {
			return;
		}

		void runMutation(async () => {
			const api = requireDbApi();

			for (const exerciseId of exerciseIdsToAdd) {
				await api.addExerciseToWorkout(selectedWorkoutId, exerciseId);
			}

			closeExercisePicker();
			await loadSelectedWorkoutExercises();
		});
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		if (!selectedWorkoutId) {
			return;
		}

		const exerciseName = (newExerciseName || cleanExerciseSearch).trim();

		if (!exerciseName) {
			return;
		}

		void runMutation(async () => {
			const api = requireDbApi();
			const exercise = await api.createExercise(exerciseName, isNewExerciseUnilateral);

			await api.addExerciseToWorkout(selectedWorkoutId, exercise.id);
			closeExercisePicker();
			exerciseSearch = '';
			await loadPageData(selectedWorkoutId);
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

	function previewDraggedOrderAt(pointerY: number) {
		if (!draggedWorkoutExerciseId || workoutExercises.length < 2) {
			return;
		}

		const nextIds = getWorkoutExerciseIds().filter((id) => id !== draggedWorkoutExerciseId);
		const targetRow = Array.from(
			document.querySelectorAll<HTMLElement>('[data-workout-exercise-id]')
		)
			.filter((row) => row.dataset.workoutExerciseId !== draggedWorkoutExerciseId)
			.find((row) => {
				const bounds = row.getBoundingClientRect();
				return pointerY < bounds.top + bounds.height / 2;
			});

		const targetWorkoutExerciseId = targetRow?.dataset.workoutExerciseId;

		if (targetWorkoutExerciseId) {
			const targetIndex = nextIds.indexOf(targetWorkoutExerciseId);

			if (targetIndex < 0) {
				return;
			}

			nextIds.splice(targetIndex, 0, draggedWorkoutExerciseId);
		} else {
			nextIds.push(draggedWorkoutExerciseId);
		}

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
		dragPreview = null;
	}

	function handleDragPointerDown(event: PointerEvent, workoutExerciseId: string) {
		if (isSaving || workoutExercises.length < 2) {
			return;
		}

		draggedWorkoutExerciseId = workoutExerciseId;
		dragStartWorkoutExerciseIds = getWorkoutExerciseIds();

		const target = event.currentTarget as HTMLElement;
		const row = target.closest<HTMLElement>('[data-workout-exercise-id]');

		if (!row) {
			resetDrag();
			return;
		}

		const bounds = row.getBoundingClientRect();

		dragPreview = {
			pointerId: event.pointerId,
			x: bounds.left,
			y: bounds.top,
			width: bounds.width,
			height: bounds.height,
			grabX: event.clientX - bounds.left,
			grabY: event.clientY - bounds.top
		};

		target.setPointerCapture(event.pointerId);
		event.preventDefault();
	}

	function handleDragPointerMove(event: PointerEvent) {
		if (!draggedWorkoutExerciseId || !dragPreview) {
			return;
		}

		dragPreview = {
			...dragPreview,
			x: event.clientX - dragPreview.grabX,
			y: event.clientY - dragPreview.grabY
		};

		previewDraggedOrderAt(event.clientY);
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

	function removeExercise(workoutExerciseId: string) {
		void runMutation(async () => {
			await requireDbApi().removeWorkoutExercise(workoutExerciseId);
			await loadSelectedWorkoutExercises();
		});
	}
</script>

<svelte:head>
	<title>Workouts | TinyTrain</title>
</svelte:head>

<main
	class="mx-auto flex min-h-svh w-full max-w-[430px] flex-col bg-[#080b0d] text-zinc-100"
	aria-busy={isSaving}
>
	{#if errorMessage}
		<p
			class="mx-4 mt-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
			role="alert"
		>
			{errorMessage}
		</p>
	{/if}

	{#if isLoading}
		<section class="flex flex-1 flex-col justify-center px-5">
			<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading workouts</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">Preparing your local exercise library.</p>
		</section>
	{:else if pageMode === 'workouts'}
		<section class="flex flex-1 flex-col px-4 pt-4 pb-6">
			<header class="flex items-center justify-between gap-3 pb-5">
				<a
					href={resolve('/')}
					class="rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-300"
				>
					Home
				</a>
				<button
					class="rounded-lg bg-emerald-300 px-4 py-2 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving}
					onclick={() => (isCreatingWorkout = true)}
				>
					Add workout
				</button>
			</header>

			<div class="border-b border-white/10 pb-5">
				<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">TinyTrain</p>
				<h1 class="mt-2 text-3xl font-semibold text-white">Workouts</h1>
				<p class="mt-2 text-sm leading-6 text-zinc-400">
					Choose a workout to edit its exercise list.
				</p>
			</div>

			{#if isCreatingWorkout || workouts.length === 0}
				<form class="mt-5 space-y-3" onsubmit={handleCreateWorkout}>
					<label class="block" for="new-workout-name">
						<span class="mb-2 block text-sm font-medium text-zinc-300">Workout name</span>
						<input
							id="new-workout-name"
							class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-emerald-300/60"
							bind:value={newWorkoutName}
							autocomplete="off"
							placeholder="Push day, legs, upper..."
						/>
					</label>

					<div class="flex gap-2">
						<button
							class="min-h-11 flex-1 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
							type="submit"
							disabled={isSaving || !newWorkoutName.trim()}
						>
							Create workout
						</button>

						{#if workouts.length > 0}
							<button
								class="min-h-11 rounded-lg border border-white/10 px-4 text-sm font-semibold text-zinc-300"
								type="button"
								onclick={() => (isCreatingWorkout = false)}
							>
								Cancel
							</button>
						{/if}
					</div>
				</form>
			{/if}

			{#if workouts.length > 0}
				<ol class="mt-5 divide-y divide-white/10 border-y border-white/10">
					{#each workouts as workout (workout.id)}
						<li>
							<button
								class="flex min-h-[4.5rem] w-full items-center justify-between gap-4 py-3 text-left"
								type="button"
								onclick={() => openWorkout(workout.id)}
							>
								<span class="min-w-0">
									<span class="block truncate text-base font-semibold text-white"
										>{workout.name}</span
									>
									<span class="mt-1 block text-sm text-zinc-500">Open exercise list</span>
								</span>
								<span
									class="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300"
								>
									Open
								</span>
							</button>
						</li>
					{/each}
				</ol>
			{:else}
				<div class="flex flex-1 flex-col justify-center py-10">
					<p class="text-xl font-semibold text-white">No workouts yet.</p>
					<p class="mt-2 text-sm leading-6 text-zinc-400">
						Create one, then add exercises in bulk from the library.
					</p>
				</div>
			{/if}
		</section>
	{:else if selectedWorkout}
		<section class="flex flex-1 flex-col">
			<header
				class="sticky top-0 z-20 border-b border-white/10 bg-[#080b0d]/95 px-4 pt-4 pb-4 backdrop-blur"
			>
				<div class="flex items-center justify-between gap-3">
					<button
						class="rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-300"
						type="button"
						onclick={closeWorkout}
					>
						Workouts
					</button>
					<p class="text-sm font-medium text-zinc-500">{workoutExerciseCount} exercises</p>
				</div>
				<h1 class="mt-4 text-2xl font-semibold text-white">{selectedWorkout.name}</h1>
				<p class="mt-2 text-sm leading-6 text-zinc-400">Add exercises from the bottom action.</p>
			</header>

			<div class="flex-1 px-4 pt-4 pb-28">
				{#if workoutExercises.length === 0}
					<div class="flex min-h-[22rem] flex-col justify-center border-y border-white/10 py-10">
						<p class="text-xl font-semibold text-white">No exercises added.</p>
						<p class="mt-2 text-sm leading-6 text-zinc-400">
							Use Add exercise to select one or more movements.
						</p>
					</div>
				{:else}
					<ol class="divide-y divide-white/10 border-y border-white/10">
						{#each workoutExercises as workoutExercise, index (workoutExercise.id)}
							<li
								class="py-3 transition data-[dragging=true]:rounded-lg data-[dragging=true]:bg-emerald-300/10 data-[dragging=true]:opacity-20"
								data-workout-exercise-id={workoutExercise.id}
								data-dragging={draggedWorkoutExerciseId === workoutExercise.id}
								animate:flip={{ duration: 160 }}
							>
								<div class="flex items-center gap-3">
									<button
										class="touch-none rounded-lg border border-white/10 px-3 py-3 text-sm font-bold text-zinc-300 enabled:cursor-grab enabled:active:cursor-grabbing disabled:text-zinc-700"
										type="button"
										aria-label={`Move ${workoutExercise.exercise.name}`}
										disabled={isSaving || workoutExercises.length < 2}
										onpointerdown={(event) => handleDragPointerDown(event, workoutExercise.id)}
										onpointermove={handleDragPointerMove}
										onpointerup={handleDragPointerUp}
										onpointercancel={handleDragPointerCancel}
									>
										{index + 1}
									</button>

									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<p class="min-w-0 text-base font-semibold text-white">
												{workoutExercise.exercise.name}
											</p>
											{#if workoutExercise.exercise.unilateral}
												<span
													class="rounded-md border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[0.68rem] font-semibold text-amber-100"
												>
													Unilateral
												</span>
											{/if}
										</div>
									</div>

									<button
										class="rounded-lg border border-red-300/20 px-3 py-2 text-sm font-semibold text-red-200 disabled:text-zinc-700"
										type="button"
										disabled={isSaving}
										onclick={() => removeExercise(workoutExercise.id)}
									>
										Remove
									</button>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			</div>

			<div
				class="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[430px] border-t border-white/10 bg-[#080b0d]/95 p-4 backdrop-blur"
			>
				<button
					class="min-h-12 w-full rounded-lg bg-emerald-300 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving}
					onclick={openExercisePicker}
				>
					Add exercise
				</button>
			</div>
		</section>
	{:else}
		<section class="flex flex-1 flex-col justify-center px-4">
			<p class="text-xl font-semibold text-white">Workout not found.</p>
			<button
				class="mt-4 min-h-11 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950"
				type="button"
				onclick={closeWorkout}
			>
				Back to workouts
			</button>
		</section>
	{/if}

	{#if isExercisePickerOpen && selectedWorkout}
		<div
			class="fixed inset-0 z-50 mx-auto flex w-full max-w-[430px] flex-col bg-[#080b0d] text-zinc-100"
			role="dialog"
			aria-modal="true"
			aria-label="Add exercises"
		>
			<header class="border-b border-white/10 px-4 pt-4 pb-3">
				<div class="flex items-center justify-between gap-3">
					<button
						class="rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-300"
						type="button"
						onclick={closeExercisePicker}
					>
						Close
					</button>
					<p class="text-sm font-medium text-zinc-500">
						{selectedPickerCount} selected
					</p>
				</div>

				<label class="mt-4 block" for="exercise-search">
					<span class="sr-only">Search exercises</span>
					<input
						id="exercise-search"
						class="min-h-12 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 text-base text-white outline-none placeholder:text-zinc-600 focus:border-emerald-300/60"
						type="search"
						value={exerciseSearch}
						oninput={handleExerciseSearchInput}
						autocomplete="off"
						placeholder="Search exercises"
					/>
				</label>
			</header>

			<div class="flex-1 overflow-y-auto px-4 pt-4 pb-28">
				<div class="flex items-center justify-between gap-3 pb-2">
					<h2 class="text-sm font-semibold text-white">
						{cleanExerciseSearch ? 'Results' : 'Exercise library'}
					</h2>
					<p class="text-xs font-medium text-zinc-500">{filteredExercises.length} matches</p>
				</div>

				{#if visiblePickerExercises.length === 0}
					<p class="border-y border-white/10 py-8 text-sm leading-6 text-zinc-400">
						No matches. Adjust the search or create a custom exercise below.
					</p>
				{:else}
					<ul class="divide-y divide-white/10 border-y border-white/10">
						{#each visiblePickerExercises as exercise (exercise.id)}
							{@const isExerciseQueued = selectedPickerExerciseIdSet.has(exercise.id)}
							{@const isExerciseAlreadyInWorkout = selectedExerciseIds.has(exercise.id)}
							{@const pickerExercisePosition = getPickerExercisePosition(exercise.id)}
							<li>
								<button
									class={`flex min-h-[4.25rem] w-full items-center gap-3 px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45 ${
										isExerciseQueued ? 'rounded-lg bg-emerald-300/10' : ''
									}`}
									type="button"
									disabled={isSaving || isExerciseAlreadyInWorkout}
									onclick={() => togglePickerExercise(exercise.id)}
								>
									<span
										class={`flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-bold tabular-nums transition ${
											isExerciseQueued
												? 'border-emerald-300 bg-emerald-300 text-zinc-950'
												: isExerciseAlreadyInWorkout
													? 'border-white/10 bg-white/[0.03] text-zinc-500'
													: 'border-white/15 text-zinc-600'
										}`}
									>
										{pickerExercisePosition ?? ''}
									</span>

									<span class="min-w-0 flex-1">
										<span class="block truncate text-base font-semibold text-white">
											{exercise.name}
										</span>
										<span class="mt-1 flex items-center gap-2 text-sm text-zinc-500">
											{#if isExerciseAlreadyInWorkout}
												Already in workout
											{:else if exercise.unilateral}
												Unilateral
											{:else}
												Exercise
											{/if}
										</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>

					{#if hiddenPickerExerciseCount > 0}
						<p class="py-3 text-xs font-medium text-zinc-500">
							{hiddenPickerExerciseCount} more matches. Keep typing to narrow the list.
						</p>
					{/if}
				{/if}

				{#if canCreateCustomExercise}
					<form
						class="mt-4 rounded-lg border border-emerald-300/30 bg-emerald-300/10 p-3"
						onsubmit={handleCreateExercise}
					>
						<p class="text-sm font-semibold text-emerald-100">Create custom exercise</p>
						<label class="mt-3 block" for="new-exercise-name">
							<span class="sr-only">Custom exercise name</span>
							<input
								id="new-exercise-name"
								class="min-h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-base text-white outline-none placeholder:text-zinc-500"
								bind:value={newExerciseName}
								autocomplete="off"
								placeholder={cleanExerciseSearch}
							/>
						</label>

						<div class="mt-3 flex items-center justify-between gap-3">
							<label class="flex items-center gap-2 text-sm font-medium text-zinc-300">
								<input
									class="h-4 w-4 accent-emerald-300"
									type="checkbox"
									bind:checked={isNewExerciseUnilateral}
								/>
								Track unilateral
							</label>
							<button
								class="min-h-10 rounded-lg bg-emerald-300 px-3 text-sm font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
								type="submit"
								disabled={isSaving || !(newExerciseName || cleanExerciseSearch).trim()}
							>
								Create and add
							</button>
						</div>
					</form>
				{/if}
			</div>

			<div
				class="fixed inset-x-0 bottom-0 z-10 mx-auto w-full max-w-[430px] border-t border-white/10 bg-[#080b0d]/95 p-4 backdrop-blur"
			>
				<button
					class="min-h-12 w-full rounded-lg bg-emerald-300 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving || selectedPickerExerciseIds.length === 0}
					onclick={addSelectedExercises}
				>
					{addSelectedLabel}
				</button>
			</div>
		</div>
	{/if}

	{#if dragPreview && draggedWorkoutExercise}
		<div
			class="pointer-events-none fixed top-0 left-0 z-[60] overflow-hidden rounded-lg border border-emerald-300/30 bg-[#101719] py-3 shadow-2xl ring-1 shadow-black/40 ring-white/10 will-change-transform"
			style={`width: ${dragPreview.width}px; height: ${dragPreview.height}px; transform: translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0);`}
			aria-hidden="true"
		>
			<div class="flex h-full items-center gap-3">
				<span
					class="rounded-lg border border-emerald-300/50 bg-emerald-300/15 px-3 py-3 text-sm font-bold text-emerald-100"
				>
					{draggedWorkoutExerciseIndex + 1}
				</span>

				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						<p class="min-w-0 text-base font-semibold text-white">
							{draggedWorkoutExercise.exercise.name}
						</p>
						{#if draggedWorkoutExercise.exercise.unilateral}
							<span
								class="rounded-md border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[0.68rem] font-semibold text-amber-100"
							>
								Unilateral
							</span>
						{/if}
					</div>
				</div>

				<span
					class="rounded-lg border border-red-300/10 px-3 py-2 text-sm font-semibold text-red-200 opacity-50"
				>
					Remove
				</span>
			</div>
		</div>
	{/if}
</main>
