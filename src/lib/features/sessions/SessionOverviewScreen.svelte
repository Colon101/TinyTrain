<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { Exercise, SessionExerciseOverview, SessionOverview } from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import SessionDragPreview from './SessionDragPreview.svelte';
	import SessionExerciseList from './SessionExerciseList.svelte';
	import SessionOverviewHeader from './SessionOverviewHeader.svelte';
	import SessionSummaryPanel from './SessionSummaryPanel.svelte';
	import { formatDayHeading } from './session-format';
	import { hasLoggedValues } from './session-overview';
	import { shareOrDownloadSessionImage } from './session-share-image';

	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';
	type DragPreview = {
		pointerId: number;
		x: number;
		y: number;
		width: number;
		height: number;
		grabX: number;
		grabY: number;
	};
	type DragPointerPosition = {
		clientX: number;
		clientY: number;
	};
	type DragDropTarget = {
		id: string;
		midpointY: number;
	};

	const DRAG_SCROLL_EDGE_PX = 96;
	const DRAG_SCROLL_MAX_STEP_PX = 18;

	let { sessionId }: { sessionId: string } = $props();

	let api = $state<DatabaseApi | null>(null);
	let overview = $state<SessionOverview | null>(null);
	let exercises = $state<Exercise[]>([]);
	let isLoading = $state(true);
	let isSaving = $state(false);
	let isSharingSession = $state(false);
	let errorMessage = $state('');
	let nowMs = $state(Date.now());
	let isExercisePickerOpen = $state(false);
	let pickerMode = $state<PickerMode>('add');
	let targetSessionExerciseId = $state('');
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let isSessionMenuOpen = $state(false);
	let openExerciseMenuId = $state('');
	let draggedSessionExerciseId = $state('');
	let dragStartSessionExerciseIds = $state<string[]>([]);
	let dragPreview = $state<DragPreview | null>(null);
	let dragAutoScrollFrameId: number | null = null;
	let dragAutoScrollPointerY = 0;
	let dragMoveFrameId: number | null = null;
	let dragPointerPosition: DragPointerPosition | null = null;
	let dragPreviewElement = $state<HTMLDivElement | null>(null);
	let dragDropTargets: DragDropTarget[] = [];
	let draggedRowElement: HTMLElement | null = null;

	let isRunning = $derived(
		Boolean(overview?.summary.status === 'in_progress' && !overview.summary.completedAt)
	);
	let isEditable = $derived(
		Boolean(
			overview &&
			(overview.summary.status === 'planned' || overview.summary.status === 'in_progress')
		)
	);
	let selectedExerciseIds = $derived(
		new Set((overview?.exercises ?? []).map((sessionExercise) => sessionExercise.exerciseId))
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
	let addSelectedLabel = $derived(
		pickerMode === 'swap'
			? 'Swap exercise'
			: selectedPickerExerciseIds.length === 0
				? 'Add exercise(s)'
				: `Add ${selectedPickerExerciseIds.length} exercise${
						selectedPickerExerciseIds.length === 1 ? '' : 's'
					}`
	);
	let draggedSessionExercise = $derived(
		overview?.exercises.find(
			(sessionExercise) => sessionExercise.id === draggedSessionExerciseId
		) ?? null
	);

	onMount(() => {
		let disposed = false;

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				await loadData();
			} catch (error) {
				errorMessage = getErrorMessage(error);
			} finally {
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
			stopDragAutoScroll();
			stopDragPreviewMove();
		};
	});

	$effect(() => {
		let intervalId: ReturnType<typeof setInterval> | null = null;

		if (isRunning) {
			intervalId = setInterval(() => {
				nowMs = Date.now();
			}, 1000);
		}

		return () => {
			if (intervalId) {
				clearInterval(intervalId);
			}
		};
	});

	function getErrorMessage(error: unknown) {
		return error instanceof Error ? error.message : 'Something went wrong.';
	}

	function requireApi() {
		if (!api) {
			throw new Error('The local database is still loading.');
		}

		return api;
	}

	async function loadData() {
		const dbApi = requireApi();
		await dbApi.cleanupStaleSessions();
		const [nextOverview, nextExercises] = await Promise.all([
			dbApi.getEditableSession(sessionId),
			dbApi.listExercises()
		]);

		overview = nextOverview;
		exercises = nextExercises;
		nowMs = Date.now();
		isSessionMenuOpen = false;
		openExerciseMenuId = '';
	}

	async function runMutation(action: () => Promise<void>) {
		isSaving = true;
		errorMessage = '';

		try {
			await action();
			await loadData();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}

	function openExercisePicker(mode: PickerMode, nextTargetSessionExerciseId = '') {
		pickerMode = mode;
		targetSessionExerciseId = nextTargetSessionExerciseId;
		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isExercisePickerOpen = true;
		openExerciseMenuId = '';
	}

	function closeExercisePicker() {
		isExercisePickerOpen = false;
		targetSessionExerciseId = '';
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

		if (pickerMode === 'swap') {
			selectedPickerExerciseIds = selectedPickerExerciseIdSet.has(exerciseId) ? [] : [exerciseId];
			return;
		}

		if (selectedPickerExerciseIdSet.has(exerciseId)) {
			selectedPickerExerciseIds = selectedPickerExerciseIds.filter((id) => id !== exerciseId);
			return;
		}

		selectedPickerExerciseIds = [...selectedPickerExerciseIds, exerciseId];
	}

	function getPickerExercisePosition(exerciseId: string) {
		if (!overview || pickerMode === 'swap') {
			return null;
		}

		const queuedIndex = selectedPickerExerciseIds.indexOf(exerciseId);

		if (queuedIndex >= 0) {
			return overview.exercises.length + queuedIndex + 1;
		}

		return null;
	}

	async function applyPickedExercises(exerciseIds: string[]) {
		if (!overview || exerciseIds.length === 0) {
			return;
		}

		const dbApi = requireApi();

		if (pickerMode === 'swap') {
			if (!targetSessionExerciseId) {
				return;
			}

			await dbApi.replaceSessionExercise(targetSessionExerciseId, exerciseIds[0]);
			closeExercisePicker();
			return;
		}

		for (const exerciseId of exerciseIds) {
			await dbApi.addExerciseToSession(overview.summary.id, exerciseId);
		}

		closeExercisePicker();
	}

	function handleAddSelected() {
		void runMutation(async () => {
			await applyPickedExercises(selectedPickerExerciseIds);
		});
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		const exerciseName = (newExerciseName || cleanExerciseSearch).trim();

		if (!exerciseName) {
			return;
		}

		void runMutation(async () => {
			const exercise = await requireApi().createExercise(exerciseName, isNewExerciseUnilateral);
			await applyPickedExercises([exercise.id]);
		});
	}

	function handleStartSession() {
		if (!overview) {
			return;
		}

		const summaryId = overview.summary.id;

		void runMutation(async () => {
			await requireApi().startWorkoutSession(summaryId);
		});
	}

	function handleDeleteSession() {
		if (!overview) {
			return;
		}

		const confirmed = window.confirm(
			`Delete ${overview.summary.workoutNameSnapshot} from ${formatDayHeading(overview.summary.dayKey)}?`
		);

		if (!confirmed) {
			return;
		}

		const summaryId = overview.summary.id;

		void runMutation(async () => {
			await requireApi().deleteWorkoutSession(summaryId);
			await goto(resolve('/'), { replaceState: true });
		});
	}

	function handleResetSession() {
		if (!overview) {
			return;
		}

		const confirmed = window.confirm(
			`Reset all logged values in ${overview.summary.workoutNameSnapshot}?`
		);

		if (!confirmed) {
			return;
		}

		const summaryId = overview.summary.id;

		void runMutation(async () => {
			await requireApi().resetSessionInputs(summaryId);
		});
	}

	function handleEndSession() {
		if (!overview) {
			return;
		}

		const confirmed = window.confirm(`End ${overview.summary.workoutNameSnapshot}?`);

		if (!confirmed) {
			return;
		}

		const summaryId = overview.summary.id;

		void runMutation(async () => {
			await requireApi().completeWorkoutSession(summaryId);
		});
	}

	async function handleShareSession() {
		if (!overview || overview.summary.status !== 'completed' || isSharingSession) {
			return;
		}

		isSharingSession = true;
		errorMessage = '';
		isSessionMenuOpen = false;

		try {
			const previousOverview = overview.previousSummary
				? await requireApi().getEditableSession(overview.previousSummary.id)
				: null;

			await shareOrDownloadSessionImage(overview, nowMs, previousOverview);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				return;
			}

			errorMessage = getErrorMessage(error);
		} finally {
			isSharingSession = false;
		}
	}

	function handleRemoveSessionExercise(sessionExerciseId: string) {
		if (!overview) {
			return;
		}

		const sessionExercise = overview.exercises.find((entry) => entry.id === sessionExerciseId);

		if (!sessionExercise) {
			return;
		}

		if (
			hasLoggedValues(sessionExercise) &&
			!window.confirm(
				`Remove ${sessionExercise.exerciseNameSnapshot} and discard its logged values?`
			)
		) {
			return;
		}

		void runMutation(async () => {
			await requireApi().removeSessionExercise(sessionExerciseId);
		});
	}

	function getSessionExerciseIds() {
		return overview?.exercises.map((sessionExercise) => sessionExercise.id) ?? [];
	}

	function orderSessionExercises(nextIds: string[]) {
		if (!overview) {
			return;
		}

		const sessionExerciseById = new Map(
			overview.exercises.map((sessionExercise) => [sessionExercise.id, sessionExercise])
		);

		overview = {
			...overview,
			exercises: nextIds
				.map((id) => sessionExerciseById.get(id))
				.filter((sessionExercise): sessionExercise is SessionExerciseOverview =>
					Boolean(sessionExercise)
				)
		};
	}

	function cacheDragDropTargets(excludedSessionExerciseId: string) {
		dragDropTargets = Array.from(
			document.querySelectorAll<HTMLElement>('[data-session-exercise-id]')
		).flatMap((row) => {
			const id = row.dataset.sessionExerciseId;

			if (!id || id === excludedSessionExerciseId) {
				return [];
			}

			const bounds = row.getBoundingClientRect();

			return [
				{
					id,
					midpointY: bounds.top + window.scrollY + bounds.height / 2
				}
			];
		});
	}

	function getDraggedOrderAt(pointerY: number) {
		if (!draggedSessionExerciseId) {
			return getSessionExerciseIds();
		}

		const nextIds = (
			dragStartSessionExerciseIds.length ? dragStartSessionExerciseIds : getSessionExerciseIds()
		).filter((id) => id !== draggedSessionExerciseId);
		const pointerDocumentY = pointerY + window.scrollY;
		const targetSessionExerciseId = dragDropTargets.find(
			(target) => pointerDocumentY < target.midpointY
		)?.id;

		if (!targetSessionExerciseId) {
			return [...nextIds, draggedSessionExerciseId];
		}

		const targetIndex = nextIds.indexOf(targetSessionExerciseId);

		if (targetIndex < 0) {
			return [...nextIds, draggedSessionExerciseId];
		}

		return [
			...nextIds.slice(0, targetIndex),
			draggedSessionExerciseId,
			...nextIds.slice(targetIndex)
		];
	}

	function updateDragPreviewPosition() {
		dragMoveFrameId = null;

		if (!dragPreview || !dragPointerPosition || !dragPreviewElement) {
			return;
		}

		const nextX = dragPointerPosition.clientX - dragPreview.grabX;
		const nextY = dragPointerPosition.clientY - dragPreview.grabY;

		dragPreviewElement.style.transform = `translate3d(${nextX - dragPreview.x}px, ${nextY - dragPreview.y}px, 0)`;
	}

	function queueDragPreviewPosition(clientX: number, clientY: number) {
		dragPointerPosition = { clientX, clientY };

		if (dragMoveFrameId !== null) {
			return;
		}

		dragMoveFrameId = window.requestAnimationFrame(updateDragPreviewPosition);
	}

	function flushDragPreviewPosition(clientX: number, clientY: number) {
		dragPointerPosition = { clientX, clientY };

		if (dragMoveFrameId !== null) {
			window.cancelAnimationFrame(dragMoveFrameId);
			dragMoveFrameId = null;
		}

		updateDragPreviewPosition();
	}

	function stopDragPreviewMove() {
		if (dragMoveFrameId !== null) {
			window.cancelAnimationFrame(dragMoveFrameId);
			dragMoveFrameId = null;
		}

		dragPointerPosition = null;

		if (dragPreviewElement) {
			dragPreviewElement.style.transform = '';
		}
	}

	function resetDrag(restoreOriginalOrder = false) {
		if (restoreOriginalOrder && dragStartSessionExerciseIds.length > 0) {
			orderSessionExercises(dragStartSessionExerciseIds);
		}

		stopDragAutoScroll();
		stopDragPreviewMove();

		if (draggedRowElement) {
			draggedRowElement.style.opacity = '';
			draggedRowElement = null;
		}

		draggedSessionExerciseId = '';
		dragStartSessionExerciseIds = [];
		dragDropTargets = [];
		dragPreview = null;
	}

	function getDragAutoScrollStep(pointerY: number) {
		if (pointerY < DRAG_SCROLL_EDGE_PX) {
			return -Math.ceil(
				((DRAG_SCROLL_EDGE_PX - pointerY) / DRAG_SCROLL_EDGE_PX) * DRAG_SCROLL_MAX_STEP_PX
			);
		}

		const bottomEdgeDistance = window.innerHeight - pointerY;

		if (bottomEdgeDistance < DRAG_SCROLL_EDGE_PX) {
			return Math.ceil(
				((DRAG_SCROLL_EDGE_PX - bottomEdgeDistance) / DRAG_SCROLL_EDGE_PX) * DRAG_SCROLL_MAX_STEP_PX
			);
		}

		return 0;
	}

	function startDragAutoScroll(pointerY: number) {
		dragAutoScrollPointerY = pointerY;

		if (dragAutoScrollFrameId !== null) {
			return;
		}

		const scrollFrame = () => {
			if (!draggedSessionExerciseId) {
				dragAutoScrollFrameId = null;
				return;
			}

			const scrollStep = getDragAutoScrollStep(dragAutoScrollPointerY);

			if (scrollStep !== 0) {
				window.scrollBy(0, scrollStep);
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

	function handleDragPointerDown(event: PointerEvent, sessionExerciseId: string) {
		if (!isEditable || isSaving || (overview?.exercises.length ?? 0) < 2) {
			return;
		}

		const target = event.currentTarget as HTMLElement;
		const row = target.closest<HTMLElement>('[data-session-exercise-id]');

		if (!row) {
			resetDrag();
			return;
		}

		const bounds = row.getBoundingClientRect();

		draggedSessionExerciseId = sessionExerciseId;
		dragStartSessionExerciseIds = getSessionExerciseIds();
		draggedRowElement = row;
		row.style.opacity = '0.4';

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
		cacheDragDropTargets(sessionExerciseId);
		startDragAutoScroll(event.clientY);
		event.preventDefault();
	}

	function handleDragPointerMove(event: PointerEvent) {
		if (!draggedSessionExerciseId || !dragPreview || event.pointerId !== dragPreview.pointerId) {
			return;
		}

		queueDragPreviewPosition(event.clientX, event.clientY);
		startDragAutoScroll(event.clientY);
		event.preventDefault();
	}

	function handleDragPointerUp(event: PointerEvent) {
		if (!overview || !draggedSessionExerciseId) {
			resetDrag();
			return;
		}

		const target = event.currentTarget as HTMLElement;
		flushDragPreviewPosition(event.clientX, event.clientY);
		const finalSessionExerciseIds = getDraggedOrderAt(event.clientY);
		const startedSessionExerciseIds = dragStartSessionExerciseIds;
		const orderChanged = finalSessionExerciseIds.join('|') !== startedSessionExerciseIds.join('|');

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag();

		if (!orderChanged) {
			return;
		}

		const summaryId = overview.summary.id;
		orderSessionExercises(finalSessionExerciseIds);

		void runMutation(async () => {
			await requireApi().reorderSessionExercises(summaryId, finalSessionExerciseIds);
		});
	}

	function handleDragPointerCancel(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag(true);
	}
</script>

<section class="box-border flex min-w-0 flex-1 flex-col px-1">
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
				<div class="h-full w-1/2 animate-pulse rounded-full bg-emerald-300"></div>
			</div>
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading session</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">Gathering the session summary.</p>
		</section>
	{:else if !overview}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Session not found</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				This session is not available in local storage.
			</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href={resolve('/')}
			>
				Back to home
			</a>
		</section>
	{:else}
		<SessionOverviewHeader
			{overview}
			{nowMs}
			{isSaving}
			{isSharingSession}
			{isSessionMenuOpen}
			onToggleSessionMenu={() => (isSessionMenuOpen = !isSessionMenuOpen)}
			onShareSession={handleShareSession}
			onEndSession={handleEndSession}
			onResetSession={handleResetSession}
			onDeleteSession={handleDeleteSession}
		/>

		<SessionSummaryPanel {overview} {isSaving} onStartSession={handleStartSession} />

		<SessionExerciseList
			{sessionId}
			{overview}
			{isEditable}
			{isSaving}
			hideHeading={overview.summary.status === 'in_progress'}
			{openExerciseMenuId}
			onToggleExerciseMenu={(sessionExerciseId) =>
				(openExerciseMenuId = openExerciseMenuId === sessionExerciseId ? '' : sessionExerciseId)}
			onAddExercise={() => openExercisePicker('add')}
			onSwapExercise={(sessionExerciseId) => openExercisePicker('swap', sessionExerciseId)}
			onRemoveExercise={handleRemoveSessionExercise}
			onDragPointerDown={handleDragPointerDown}
			onDragPointerMove={handleDragPointerMove}
			onDragPointerUp={handleDragPointerUp}
			onDragPointerCancel={handleDragPointerCancel}
		/>
	{/if}

	{#if dragPreview && draggedSessionExercise}
		<SessionDragPreview {dragPreview} {draggedSessionExercise} bind:dragPreviewElement />
	{/if}

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
			submitDisabled={selectedPickerExerciseIds.length === 0}
			{canCreateCustomExercise}
			{isSaving}
			sheetEyebrow={pickerMode === 'swap' ? 'Swap exercise' : 'Exercise picker'}
			sheetTitle={pickerMode === 'swap' ? 'Pick a replacement' : 'Add exercises'}
			onClose={closeExercisePicker}
			onExerciseSearchInput={handleExerciseSearchInput}
			onCustomExerciseNameInput={handleCustomExerciseNameInput}
			onTogglePickerExercise={togglePickerExercise}
			onToggleUnilateral={(nextValue) => (isNewExerciseUnilateral = nextValue)}
			onCreateExercise={handleCreateExercise}
			onAddSelected={handleAddSelected}
			{getPickerExercisePosition}
		/>
	{/if}
</section>
