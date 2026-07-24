<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		getAuthOwnedStateIdentity,
		isAuthOwnedStateIdentityCurrent
	} from '$lib/auth-owned-state';
	import ExercisePickerSheet from './ExercisePickerSheet.svelte';
	import { readExercisePickerCache, writeExercisePickerCache } from './exercise-picker-cache';
	import WorkoutDetailView from './WorkoutDetailView.svelte';
	import WorkoutListView from './WorkoutListView.svelte';
	import type {
		Exercise,
		ExerciseUsagePreference,
		Workout,
		WorkoutExerciseWithExercise
	} from '$lib/db';

	type DatabaseApi = typeof import('$lib/db');
	type DragPreview = {
		pointerId: number;
		x: number;
		y: number;
		width: number;
		height: number;
		grabX: number;
		grabY: number;
	};

	const DRAG_SCROLL_EDGE_PX = 96;
	const DRAG_SCROLL_MAX_STEP_PX = 18;

	let { routeWorkoutId = '' }: { routeWorkoutId?: string } = $props();
	const cachedExercisePickerData = readExercisePickerCache();

	let dbApi = $state<DatabaseApi | null>(null);
	let exercises = $state<Exercise[]>(cachedExercisePickerData?.exercises ?? []);
	let exerciseUsagePreferences = $state<ExerciseUsagePreference[]>(
		cachedExercisePickerData?.exerciseUsagePreferences ?? []
	);
	let workouts = $state<Workout[]>([]);
	let workoutExercises = $state<WorkoutExerciseWithExercise[]>([]);
	let isCreatingWorkout = $state(false);
	let newWorkoutName = $state('');
	let isExercisePickerOpen = $state(false);
	let draggedWorkoutExerciseId = $state('');
	let dragStartWorkoutExerciseIds = $state<string[]>([]);
	let dragPreview = $state<DragPreview | null>(null);
	let dragAutoScrollFrameId: number | null = null;
	let dragAutoScrollPointerY = 0;
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');
	let pageDataLoadGeneration = 0;
	let workoutExerciseLoadGeneration = 0;
	let exercisePickerLoadGeneration = 0;
	let isDisposed = false;

	let selectedWorkout = $derived(workouts.find((workout) => workout.id === routeWorkoutId) ?? null);
	let selectedExerciseIds = $derived(
		new Set(workoutExercises.map((workoutExercise) => workoutExercise.exercise.id))
	);
	let draggedWorkoutExercise = $derived(
		workoutExercises.find((workoutExercise) => workoutExercise.id === draggedWorkoutExerciseId) ??
			null
	);

	onMount(() => {
		isDisposed = false;
		let databaseSubscription: { unsubscribe(): void } | null = null;

		void (async () => {
			try {
				const api = await import('$lib/db');

				if (isDisposed) {
					return;
				}

				await api.ensureDbOpen();

				if (isDisposed) {
					return;
				}

				dbApi = api;
				databaseSubscription = api.subscribeToDatabaseChanges(
					['workouts', 'workoutExercises', 'exercises', 'sessionExercises', 'workoutSessions'],
					() => {
						void loadPageData().catch((error) => {
							if (!isDisposed) {
								errorMessage = getErrorMessage(error);
							}
						});
					},
					{ debounceMs: 250 }
				);
				await loadPageData();

				if (isDisposed) {
					return;
				}

				void api.hydrateVisibleScope({ type: 'workouts' }).catch(() => undefined);
				isLoading = false;
			} catch (error) {
				if (!isDisposed) {
					errorMessage = getErrorMessage(error);
					isLoading = false;
				}
			}
		})();

		return () => {
			isDisposed = true;
			invalidatePageDataLoads();
			exercisePickerLoadGeneration += 1;
			databaseSubscription?.unsubscribe();
			stopDragAutoScroll();
		};
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

	function invalidatePageDataLoads() {
		pageDataLoadGeneration += 1;
		workoutExerciseLoadGeneration += 1;
	}

	function clearWorkoutExercises() {
		workoutExerciseLoadGeneration += 1;
		workoutExercises = [];
	}

	function isCurrentPageDataLoad(generation: number, routeWorkoutIdAtStart: string) {
		return (
			!isDisposed &&
			generation === pageDataLoadGeneration &&
			routeWorkoutId === routeWorkoutIdAtStart
		);
	}

	function isCurrentWorkoutExerciseLoad(
		generation: number,
		workoutId: string,
		expectedPageLoad?: { generation: number; routeWorkoutId: string }
	) {
		return (
			!isDisposed &&
			generation === workoutExerciseLoadGeneration &&
			workoutId === routeWorkoutId &&
			(!expectedPageLoad ||
				isCurrentPageDataLoad(expectedPageLoad.generation, expectedPageLoad.routeWorkoutId))
		);
	}

	async function loadPageData() {
		if (isDisposed) {
			return false;
		}

		const generation = ++pageDataLoadGeneration;
		const routeWorkoutIdAtStart = routeWorkoutId;
		const api = requireDbApi();
		let nextWorkouts: Workout[];

		try {
			nextWorkouts = await api.listWorkouts();
		} catch (error) {
			if (!isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
				return false;
			}

			throw error;
		}

		if (!isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
			return false;
		}

		workouts = nextWorkouts;

		if (routeWorkoutId && nextWorkouts.some((workout) => workout.id === routeWorkoutId)) {
			try {
				await loadSelectedWorkoutExercises(routeWorkoutId, {
					generation,
					routeWorkoutId: routeWorkoutIdAtStart
				});
			} catch (error) {
				if (!isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
					return false;
				}

				throw error;
			}

			if (!isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
				return false;
			}
		} else {
			closeExercisePicker();
			clearWorkoutExercises();
		}

		void loadExercisePickerData(generation, routeWorkoutIdAtStart).catch((error) => {
			if (isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
				errorMessage = getErrorMessage(error);
			}
		});
		return true;
	}

	async function loadExercisePickerData(
		pageDataGeneration = pageDataLoadGeneration,
		routeWorkoutIdAtStart = routeWorkoutId
	) {
		if (isDisposed) {
			return;
		}

		const generation = ++exercisePickerLoadGeneration;
		const ownerIdentity = getAuthOwnedStateIdentity();
		const api = requireDbApi();
		let nextExercises: Exercise[];
		let nextExerciseUsagePreferences: ExerciseUsagePreference[];

		try {
			[nextExercises, nextExerciseUsagePreferences] = await Promise.all([
				api.listExercises(),
				api.listExerciseUsagePreferences()
			]);
		} catch (error) {
			if (
				generation !== exercisePickerLoadGeneration ||
				!isAuthOwnedStateIdentityCurrent(ownerIdentity) ||
				!isCurrentPageDataLoad(pageDataGeneration, routeWorkoutIdAtStart)
			) {
				return;
			}

			throw error;
		}

		if (
			generation !== exercisePickerLoadGeneration ||
			!isAuthOwnedStateIdentityCurrent(ownerIdentity) ||
			!isCurrentPageDataLoad(pageDataGeneration, routeWorkoutIdAtStart)
		) {
			return;
		}

		exercises = nextExercises;
		exerciseUsagePreferences = nextExerciseUsagePreferences;
		writeExercisePickerCache(nextExercises, nextExerciseUsagePreferences, ownerIdentity);
	}

	async function loadSelectedWorkoutExercises(
		workoutId = routeWorkoutId,
		expectedPageLoad?: { generation: number; routeWorkoutId: string }
	) {
		const generation = ++workoutExerciseLoadGeneration;
		const api = dbApi;

		if (isDisposed || !api || !workoutId) {
			if (!isDisposed && !workoutId && !routeWorkoutId) {
				workoutExercises = [];
			}

			return false;
		}

		let nextWorkoutExercises: WorkoutExerciseWithExercise[];

		try {
			nextWorkoutExercises = await api.listWorkoutExercises(workoutId);
		} catch (error) {
			if (!isCurrentWorkoutExerciseLoad(generation, workoutId, expectedPageLoad)) {
				return false;
			}

			throw error;
		}

		if (!isCurrentWorkoutExerciseLoad(generation, workoutId, expectedPageLoad)) {
			return false;
		}

		workoutExercises = nextWorkoutExercises;
		return true;
	}

	async function runMutation(action: () => Promise<void>) {
		isSaving = true;
		errorMessage = '';

		try {
			await action();
		} catch (error) {
			if (!isDisposed) {
				errorMessage = getErrorMessage(error);
			}
		} finally {
			if (!isDisposed) {
				isSaving = false;
			}
		}
	}

	function handleCreateWorkout(event: SubmitEvent) {
		event.preventDefault();

		void runMutation(async () => {
			const workout = await requireDbApi().createWorkout(newWorkoutName);
			newWorkoutName = '';
			isCreatingWorkout = false;
			await goto(resolve('/(app)/workouts/[workoutId]', { workoutId: workout.id }), {
				keepFocus: true
			});
		});
	}

	function openWorkout(workoutId: string) {
		void goto(resolve('/(app)/workouts/[workoutId]', { workoutId }), { keepFocus: true });
	}

	function openExercisePicker() {
		if (!routeWorkoutId) {
			return;
		}

		isExercisePickerOpen = true;
	}

	function closeExercisePicker() {
		isExercisePickerOpen = false;
	}

	function addSelectedExercises(exerciseIds: string[]) {
		const workoutId = routeWorkoutId;

		if (!workoutId || exerciseIds.length === 0) {
			return;
		}

		const exerciseIdsToAdd = exerciseIds.filter((id) => !selectedExerciseIds.has(id));

		if (exerciseIdsToAdd.length === 0) {
			return;
		}

		void runMutation(async () => {
			const api = requireDbApi();
			await api.addExercisesToWorkout(workoutId, exerciseIdsToAdd);

			closeExercisePicker();
			await loadSelectedWorkoutExercises(workoutId);
		});
	}

	function handleCreateExercise(exerciseName: string, unilateral: boolean) {
		const workoutId = routeWorkoutId;

		if (!workoutId) {
			return;
		}

		void runMutation(async () => {
			const api = requireDbApi();
			const exercise = await api.createExercise(exerciseName, unilateral);

			await api.addExercisesToWorkout(workoutId, [exercise.id]);
			closeExercisePicker();
			await loadPageData();
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

		stopDragAutoScroll();
		draggedWorkoutExerciseId = '';
		dragStartWorkoutExerciseIds = [];
		dragPreview = null;
	}

	function getDragAutoScrollStep(pointerY: number) {
		const scrollBounds =
			document.querySelector<HTMLElement>('[data-app-scroll-area]')?.getBoundingClientRect() ??
			null;
		const topEdge = scrollBounds?.top ?? 0;
		const bottomEdge = scrollBounds?.bottom ?? window.innerHeight;
		const topEdgeDistance = pointerY - topEdge;

		if (topEdgeDistance < DRAG_SCROLL_EDGE_PX) {
			return -Math.ceil(
				((DRAG_SCROLL_EDGE_PX - topEdgeDistance) / DRAG_SCROLL_EDGE_PX) * DRAG_SCROLL_MAX_STEP_PX
			);
		}

		const bottomEdgeDistance = bottomEdge - pointerY;

		if (bottomEdgeDistance < DRAG_SCROLL_EDGE_PX) {
			return Math.ceil(
				((DRAG_SCROLL_EDGE_PX - bottomEdgeDistance) / DRAG_SCROLL_EDGE_PX) * DRAG_SCROLL_MAX_STEP_PX
			);
		}

		return 0;
	}

	function scrollDragContainer(scrollStep: number) {
		const scrollArea = document.querySelector<HTMLElement>('[data-app-scroll-area]');

		if (scrollArea) {
			scrollArea.scrollBy(0, scrollStep);
			return;
		}

		window.scrollBy(0, scrollStep);
	}

	function startDragAutoScroll(pointerY: number) {
		dragAutoScrollPointerY = pointerY;

		if (dragAutoScrollFrameId !== null) {
			return;
		}

		const scrollFrame = () => {
			if (!draggedWorkoutExerciseId) {
				dragAutoScrollFrameId = null;
				return;
			}

			const scrollStep = getDragAutoScrollStep(dragAutoScrollPointerY);

			if (scrollStep !== 0) {
				scrollDragContainer(scrollStep);
				previewDraggedOrderAt(dragAutoScrollPointerY);
			}

			dragAutoScrollFrameId = window.requestAnimationFrame(scrollFrame);
		};

		dragAutoScrollFrameId = window.requestAnimationFrame(scrollFrame);
	}

	function stopDragAutoScroll() {
		if (dragAutoScrollFrameId === null) {
			return;
		}

		window.cancelAnimationFrame(dragAutoScrollFrameId);
		dragAutoScrollFrameId = null;
	}

	function handleDragPointerDown(event: PointerEvent, workoutExerciseId: string) {
		if (isSaving || workoutExercises.length < 2 || draggedWorkoutExerciseId || dragPreview) {
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
		startDragAutoScroll(event.clientY);
		event.preventDefault();
	}

	function handleDragPointerMove(event: PointerEvent) {
		if (!draggedWorkoutExerciseId || !dragPreview || event.pointerId !== dragPreview.pointerId) {
			return;
		}

		dragPreview = {
			...dragPreview,
			x: event.clientX - dragPreview.grabX,
			y: event.clientY - dragPreview.grabY
		};

		previewDraggedOrderAt(event.clientY);
		startDragAutoScroll(event.clientY);
		event.preventDefault();
	}

	function handleDragPointerUp(event: PointerEvent) {
		if (dragPreview && event.pointerId !== dragPreview.pointerId) {
			return;
		}

		if (!draggedWorkoutExerciseId || !routeWorkoutId) {
			resetDrag();
			return;
		}

		const target = event.currentTarget as HTMLElement;
		const finalWorkoutExerciseIds = getWorkoutExerciseIds();
		const startedWorkoutExerciseIds = dragStartWorkoutExerciseIds;
		const workoutId = routeWorkoutId;
		const orderChanged = finalWorkoutExerciseIds.join('|') !== startedWorkoutExerciseIds.join('|');

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag();

		if (!orderChanged) {
			return;
		}

		persistWorkoutExerciseOrder(workoutId, startedWorkoutExerciseIds, finalWorkoutExerciseIds);
	}

	function persistWorkoutExerciseOrder(
		workoutId: string,
		startedWorkoutExerciseIds: string[],
		finalWorkoutExerciseIds: string[]
	) {
		void runMutation(async () => {
			try {
				await requireDbApi().reorderWorkoutExercises(workoutId, finalWorkoutExerciseIds);
			} catch (error) {
				const isStillShowingOptimisticOrder =
					getWorkoutExerciseIds().join('|') === finalWorkoutExerciseIds.join('|');

				if (!isDisposed && routeWorkoutId === workoutId && isStillShowingOptimisticOrder) {
					orderWorkoutExercises(startedWorkoutExerciseIds);
				}

				throw error;
			}

			await loadSelectedWorkoutExercises(workoutId);
		});
	}

	function handleReorderKeydown(event: KeyboardEvent, workoutExerciseId: string) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
			return;
		}

		event.preventDefault();

		if (isSaving || !routeWorkoutId) {
			return;
		}

		const startedWorkoutExerciseIds = getWorkoutExerciseIds();
		const currentIndex = startedWorkoutExerciseIds.indexOf(workoutExerciseId);
		const nextIndex = currentIndex + (event.key === 'ArrowUp' ? -1 : 1);

		if (currentIndex < 0 || nextIndex < 0 || nextIndex >= startedWorkoutExerciseIds.length) {
			return;
		}

		const finalWorkoutExerciseIds = [...startedWorkoutExerciseIds];
		[finalWorkoutExerciseIds[currentIndex], finalWorkoutExerciseIds[nextIndex]] = [
			finalWorkoutExerciseIds[nextIndex],
			finalWorkoutExerciseIds[currentIndex]
		];
		orderWorkoutExercises(finalWorkoutExerciseIds);
		persistWorkoutExerciseOrder(routeWorkoutId, startedWorkoutExerciseIds, finalWorkoutExerciseIds);
	}

	function handleDragPointerCancel(event: PointerEvent) {
		if (dragPreview && event.pointerId !== dragPreview.pointerId) {
			return;
		}

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

{#if errorMessage}
	<p
		class="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-3 text-sm leading-5 text-red-100"
		role="alert"
	>
		{errorMessage}
	</p>
{/if}

{#if isLoading}
	<section class="flex flex-1 flex-col justify-center">
		<div class="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
			<div class="h-full w-1/2 animate-pulse rounded-full bg-accent"></div>
		</div>
		<h1 class="mt-5 text-2xl font-semibold text-white">Loading workouts</h1>
		<p class="mt-2 text-sm leading-6 text-zinc-400">Preparing your workout library.</p>
	</section>
{:else if !selectedWorkout}
	<WorkoutListView
		{workouts}
		{isCreatingWorkout}
		{newWorkoutName}
		{isSaving}
		onStartCreate={() => (isCreatingWorkout = true)}
		onCancelCreate={() => (isCreatingWorkout = false)}
		onWorkoutNameInput={(value) => (newWorkoutName = value)}
		onSubmitCreate={handleCreateWorkout}
		onOpenWorkout={openWorkout}
	/>
{:else if selectedWorkout}
	<WorkoutDetailView
		{selectedWorkout}
		{workoutExercises}
		{isSaving}
		{dragPreview}
		{draggedWorkoutExerciseId}
		{draggedWorkoutExercise}
		onOpenPicker={openExercisePicker}
		onRemoveExercise={removeExercise}
		onDragPointerDown={handleDragPointerDown}
		onDragPointerMove={handleDragPointerMove}
		onDragPointerUp={handleDragPointerUp}
		onDragPointerCancel={handleDragPointerCancel}
		onReorderKeydown={handleReorderKeydown}
	>
		{#if isExercisePickerOpen}
			<ExercisePickerSheet
				{exercises}
				{exerciseUsagePreferences}
				disabledExerciseIds={selectedExerciseIds}
				{isSaving}
				onClose={closeExercisePicker}
				onCreateExercise={handleCreateExercise}
				onAddSelected={addSelectedExercises}
			/>
		{/if}
	</WorkoutDetailView>
{/if}
