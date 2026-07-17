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
	let selectedWorkoutId = $state('');
	let pageMode = $state<PageMode>('workouts');
	let activeRouteWorkoutId = $state<string | null>(null);
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
	let dragAutoScrollFrameId: number | null = null;
	let dragAutoScrollPointerY = 0;
	let isLoading = $state(true);
	let isSaving = $state(false);
	let errorMessage = $state('');
	let pageDataLoadGeneration = 0;
	let workoutExerciseLoadGeneration = 0;
	let exercisePickerLoadGeneration = 0;
	let isDisposed = false;

	let selectedWorkout = $derived(
		workouts.find((workout) => workout.id === selectedWorkoutId) ?? null
	);
	let selectedExerciseIds = $derived(
		new Set(workoutExercises.map((workoutExercise) => workoutExercise.exercise.id))
	);
	let selectedPickerExerciseIdSet = $derived(new Set(selectedPickerExerciseIds));
	let cleanExerciseSearch = $derived(exerciseSearch.trim().replace(/\s+/g, ' '));
	let normalizedExerciseSearch = $derived(cleanExerciseSearch.toLocaleLowerCase());
	let exerciseUsageByNormalizedName = $derived(
		new Map(exerciseUsagePreferences.map((preference) => [preference.normalizedName, preference]))
	);
	let exerciseUsageById = $derived(
		new Map(
			exerciseUsagePreferences.flatMap((preference) =>
				preference.exerciseIds.map((exerciseId) => [exerciseId, preference] as const)
			)
		)
	);
	let filteredExercises = $derived(
		(cleanExerciseSearch
			? exercises.filter((exercise) => exercise.normalizedName.includes(normalizedExerciseSearch))
			: exercises
		).toSorted(compareExercisePickerPreference)
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
						const preferredWorkoutId = selectedWorkoutId || routeWorkoutId;

						void loadPageData(preferredWorkoutId).catch((error) => {
							if (!isDisposed && preferredWorkoutId === (selectedWorkoutId || routeWorkoutId)) {
								errorMessage = getErrorMessage(error);
							}
						});
					},
					{ debounceMs: 250 }
				);
				const initialRouteWorkoutId = routeWorkoutId;
				pageMode = initialRouteWorkoutId ? 'detail' : 'workouts';
				const didLoadInitialRoute = await loadPageData(initialRouteWorkoutId);

				if (isDisposed) {
					return;
				}

				if (didLoadInitialRoute && initialRouteWorkoutId === routeWorkoutId) {
					activeRouteWorkoutId = initialRouteWorkoutId;
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

	$effect(() => {
		const nextRouteWorkoutId = routeWorkoutId;
		const isReady = Boolean(dbApi) && !isLoading;

		if (!isReady || nextRouteWorkoutId === activeRouteWorkoutId) {
			return;
		}

		activeRouteWorkoutId = nextRouteWorkoutId;
		invalidatePageDataLoads();
		errorMessage = '';

		closeExercisePicker();
		pageMode = nextRouteWorkoutId ? 'detail' : 'workouts';

		if (!nextRouteWorkoutId) {
			selectedWorkoutId = '';
			clearWorkoutExercises();
			return;
		}

		selectedWorkoutId = nextRouteWorkoutId;
		clearWorkoutExercises();
		void loadPageData(nextRouteWorkoutId).catch((error) => {
			if (routeWorkoutId === nextRouteWorkoutId) {
				errorMessage = getErrorMessage(error);
			}
		});
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

	function getExerciseUsagePreference(exercise: Exercise) {
		return (
			exerciseUsageById.get(exercise.id) ??
			exerciseUsageByNormalizedName.get(exercise.normalizedName) ??
			null
		);
	}

	function isPreviouslyUsedExercise(exercise: Exercise) {
		return Boolean(getExerciseUsagePreference(exercise));
	}

	function compareExercisePickerPreference(first: Exercise, second: Exercise) {
		const firstUsage = getExerciseUsagePreference(first);
		const secondUsage = getExerciseUsagePreference(second);

		if (Boolean(firstUsage) !== Boolean(secondUsage)) {
			return firstUsage ? -1 : 1;
		}

		if (firstUsage && secondUsage) {
			return (
				secondUsage.lastPerformedAt.localeCompare(firstUsage.lastPerformedAt) ||
				secondUsage.sessionCount - firstUsage.sessionCount ||
				first.name.localeCompare(second.name)
			);
		}

		return first.name.localeCompare(second.name);
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
			workoutId === selectedWorkoutId &&
			(!expectedPageLoad ||
				isCurrentPageDataLoad(expectedPageLoad.generation, expectedPageLoad.routeWorkoutId))
		);
	}

	async function loadPageData(preferredWorkoutId = selectedWorkoutId) {
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

		if (preferredWorkoutId) {
			if (nextWorkouts.some((workout) => workout.id === preferredWorkoutId)) {
				selectedWorkoutId = preferredWorkoutId;

				try {
					await loadSelectedWorkoutExercises(preferredWorkoutId, {
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

				void loadExercisePickerData(generation, routeWorkoutIdAtStart).catch((error) => {
					if (isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
						errorMessage = getErrorMessage(error);
					}
				});
				return true;
			}

			selectedWorkoutId = '';
			pageMode = 'workouts';
			closeExercisePicker();
			clearWorkoutExercises();
			void loadExercisePickerData(generation, routeWorkoutIdAtStart).catch((error) => {
				if (isCurrentPageDataLoad(generation, routeWorkoutIdAtStart)) {
					errorMessage = getErrorMessage(error);
				}
			});
			return true;
		}

		selectedWorkoutId = '';
		clearWorkoutExercises();
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
		workoutId = selectedWorkoutId,
		expectedPageLoad?: { generation: number; routeWorkoutId: string }
	) {
		const generation = ++workoutExerciseLoadGeneration;
		const api = dbApi;

		if (isDisposed || !api || !workoutId) {
			if (!isDisposed && !workoutId && !selectedWorkoutId) {
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
			pageMode = 'detail';
			await loadPageData(workout.id);
			await goto(resolve('/(app)/workouts/[workoutId]', { workoutId: workout.id }), {
				keepFocus: true
			});
		});
	}

	function openWorkout(workoutId: string) {
		invalidatePageDataLoads();
		errorMessage = '';
		selectedWorkoutId = workoutId;
		pageMode = 'detail';
		closeExercisePicker();
		clearWorkoutExercises();
		void loadSelectedWorkoutExercises(workoutId).catch((error) => {
			if (!isDisposed && selectedWorkoutId === workoutId) {
				errorMessage = getErrorMessage(error);
			}
		});
		void goto(resolve('/(app)/workouts/[workoutId]', { workoutId }), { keepFocus: true });
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

	function handleCustomExerciseNameInput(value: string) {
		newExerciseName = value;
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
			await api.addExercisesToWorkout(selectedWorkoutId, exerciseIdsToAdd);

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

				if (!isDisposed && selectedWorkoutId === workoutId && isStillShowingOptimisticOrder) {
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

		if (isSaving || !selectedWorkoutId) {
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
		persistWorkoutExerciseOrder(
			selectedWorkoutId,
			startedWorkoutExerciseIds,
			finalWorkoutExerciseIds
		);
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
{:else if pageMode === 'workouts'}
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
				{exerciseSearch}
				{newExerciseName}
				{isNewExerciseUnilateral}
				{visiblePickerExercises}
				{hiddenPickerExerciseCount}
				{selectedPickerExerciseIdSet}
				{selectedExerciseIds}
				{addSelectedLabel}
				submitDisabled={selectedPickerCount === 0}
				{canCreateCustomExercise}
				{isSaving}
				onClose={closeExercisePicker}
				onExerciseSearchInput={handleExerciseSearchInput}
				onCustomExerciseNameInput={handleCustomExerciseNameInput}
				onTogglePickerExercise={togglePickerExercise}
				onToggleUnilateral={(nextValue) => (isNewExerciseUnilateral = nextValue)}
				onCreateExercise={handleCreateExercise}
				onAddSelected={addSelectedExercises}
				{isPreviouslyUsedExercise}
				{getPickerExercisePosition}
			/>
		{/if}
	</WorkoutDetailView>
{/if}
