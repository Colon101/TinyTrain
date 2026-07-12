<script lang="ts">
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type {
		Exercise,
		ExerciseUsagePreference,
		SessionExerciseOverview,
		SessionOverview
	} from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import {
		readExercisePickerCache,
		writeExercisePickerCache
	} from '$lib/features/workouts/exercise-picker-cache';
	import Icon from '$lib/ui/Icon.svelte';
	import SessionDragPreview from './SessionDragPreview.svelte';
	import SessionExerciseList from './SessionExerciseList.svelte';
	import SessionOverviewHeader from './SessionOverviewHeader.svelte';
	import SessionSummaryPanel from './SessionSummaryPanel.svelte';
	import {
		SESSION_EDIT_DISCARD_MESSAGE,
		clearSessionEditDraft,
		clearSessionOverviewActions,
		readSessionEditDraft,
		setSessionOverviewActions
	} from './session-overview-actions';
	import { writeSessionEditDraft } from './session-overview-actions';
	import { formatDayHeading, formatDuration } from './session-format';
	import { hasLoggedValues } from './session-overview';
	import { applySessionInputDraft } from './session-input-draft';
	import { shareOrDownloadSessionImage } from './session-share-image';
	import { readSessionDataCache, writeSessionDataCache } from './session-data-cache';

	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';
	type TimeEditorEndMode = 'custom' | 'recorded_end' | 'last_activity';
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
	const cachedSessionData = untrack(() => readSessionDataCache(sessionId));
	const cachedExercisePickerData = untrack(() => readExercisePickerCache());

	let api = $state<DatabaseApi | null>(null);
	let overview = $state<SessionOverview | null>(
		applySessionInputDraft(cachedSessionData?.overview ?? null, undefined, {
			includeCompleted: isCompletedEditRoute()
		})
	);
	let exercises = $state<Exercise[]>(
		cachedSessionData?.exercises ?? cachedExercisePickerData?.exercises ?? []
	);
	let exerciseUsagePreferences = $state<ExerciseUsagePreference[]>(
		cachedSessionData?.exerciseUsagePreferences ??
			cachedExercisePickerData?.exerciseUsagePreferences ??
			[]
	);
	let isLoading = $state(!cachedSessionData);
	let isSaving = $state(false);
	let isSharingSession = $state(false);
	let errorMessage = $state('');
	let nowMs = $state(Date.now());
	let isEditMode = $state(false);
	let isTimeEditorOpen = $state(false);
	let draftStartedAt = $state('');
	let draftCompletedAt = $state('');
	let timeEditorStartTime = $state('');
	let timeEditorDurationHours = $state('0');
	let timeEditorDurationMinutes = $state('0');
	let timeEditorDurationSeconds = $state('0');
	let timeEditorEndMode = $state<TimeEditorEndMode>('recorded_end');
	let isExercisePickerOpen = $state(false);
	let pickerMode = $state<PickerMode>('add');
	let targetSessionExerciseId = $state('');
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let loadDataGeneration = 0;
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
			(overview.summary.status === 'planned' ||
				overview.summary.status === 'in_progress' ||
				isEditMode)
		)
	);
	let timerSummary = $derived(
		overview
			? {
					...overview.summary,
					startedAt: isEditMode
						? draftStartedAt || overview.summary.startedAt
						: overview.summary.startedAt,
					completedAt: isEditMode
						? draftCompletedAt || overview.summary.completedAt
						: overview.summary.completedAt
				}
			: null
	);
	let canEditSession = $derived(Boolean(overview?.summary.status === 'completed'));
	let hasUnsavedTimeChanges = $derived(
		Boolean(
			overview &&
			isEditMode &&
			(draftStartedAt !== (overview.summary.startedAt ?? '') ||
				draftCompletedAt !== (overview.summary.completedAt ?? ''))
		)
	);
	let timerSummaryEndMs = $derived(
		timerSummary?.completedAt ? new Date(timerSummary.completedAt).getTime() : nowMs
	);
	let timeEditorDurationText = $derived(
		formatDuration(timerSummary?.startedAt, timerSummary?.completedAt, timerSummaryEndMs)
	);
	let selectedExerciseIds = $derived(
		new Set((overview?.exercises ?? []).map((sessionExercise) => sessionExercise.exerciseId))
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
		let databaseSubscription: { unsubscribe(): void } | null = null;

		function handlePointerDown(event: PointerEvent) {
			const target = event.target as Element | null;

			if (openExerciseMenuId && target && !target.closest('[data-exercise-card-menu]')) {
				openExerciseMenuId = '';
			}
		}

		window.addEventListener('pointerdown', handlePointerDown, { capture: true });

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (disposed) {
					return;
				}

				api = dbApi;
				databaseSubscription = dbApi.subscribeToDatabaseChanges(
					['workoutSessions', 'sessionExercises', 'sessionSets', 'exercises'],
					() => {
						void loadData();
					},
					{ debounceMs: 250 }
				);
				await loadData();
				void dbApi.hydrateVisibleScope({ type: 'session', sessionId }).catch(() => undefined);
			} catch (error) {
				errorMessage = getErrorMessage(error);
			} finally {
				isLoading = false;
			}
		})();

		return () => {
			disposed = true;
			databaseSubscription?.unsubscribe();
			window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
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

	function isCompletedEditRoute() {
		return page.url.searchParams.get('edit') === '1';
	}

	async function loadData() {
		const generation = ++loadDataGeneration;
		const dbApi = requireApi();
		void dbApi.cleanupStaleSessions();
		const nextOverview = await dbApi.runWithClosedDatabaseRetry(() =>
			dbApi.getEditableSession(sessionId)
		);

		if (generation !== loadDataGeneration) {
			return;
		}

		const nextOverviewWithDraft = applySessionInputDraft(nextOverview, undefined, {
			includeCompleted: isCompletedEditRoute()
		});

		overview = nextOverviewWithDraft;
		writeSessionDataCache(sessionId, {
			overview: nextOverviewWithDraft,
			exercises,
			exerciseUsagePreferences
		});
		nowMs = Date.now();
		openExerciseMenuId = '';
		void loadExercisePickerData(generation).catch((error) => {
			errorMessage = getErrorMessage(error);
		});
	}

	async function loadExercisePickerData(generation = loadDataGeneration) {
		const dbApi = requireApi();
		const [nextExercises, nextExerciseUsagePreferences] = await Promise.all([
			dbApi.listExercises(),
			dbApi.listExerciseUsagePreferences()
		]);

		if (generation !== loadDataGeneration) {
			return;
		}

		exercises = nextExercises;
		exerciseUsagePreferences = nextExerciseUsagePreferences;
		writeExercisePickerCache(nextExercises, nextExerciseUsagePreferences);
		writeSessionDataCache(sessionId, {
			overview,
			exercises: nextExercises,
			exerciseUsagePreferences: nextExerciseUsagePreferences
		});
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

	function writeStoredEditDraft() {
		if (!browser || !overview || !isEditMode) {
			return;
		}

		writeSessionEditDraft(sessionId, {
			startedAt: draftStartedAt,
			completedAt: draftCompletedAt
		});
	}

	function clearStoredEditDraft() {
		if (!browser) {
			return;
		}

		clearSessionEditDraft(sessionId);
	}

	function getSessionOverviewPath(editMode: boolean) {
		const basePath = resolve('/(app)/sessions/[sessionId]', { sessionId });

		return editMode ? `${basePath}?edit=1` : basePath;
	}

	async function syncEditUrl(editMode: boolean) {
		const nextPath = getSessionOverviewPath(editMode);

		if (`${page.url.pathname}${page.url.search}` === nextPath) {
			return;
		}

		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(nextPath, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function getDurationSeconds(startedAt?: string | null, completedAt?: string | null) {
		const startedAtMs = startedAt ? new Date(startedAt).getTime() : NaN;
		const completedAtMs = completedAt ? new Date(completedAt).getTime() : NaN;

		if (Number.isNaN(startedAtMs) || Number.isNaN(completedAtMs) || completedAtMs < startedAtMs) {
			return 0;
		}

		return Math.max(Math.round((completedAtMs - startedAtMs) / 1000), 0);
	}

	function toTimeInputValue(value?: string | null) {
		if (!value) {
			return '';
		}

		const date = new Date(value);

		if (Number.isNaN(date.getTime())) {
			return '';
		}

		return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	}

	function getTimeEditorNumber(value: string) {
		const nextValue = Number(value);

		return Number.isFinite(nextValue) ? Math.max(Math.trunc(nextValue), 0) : 0;
	}

	function enterEditMode() {
		if (!overview || !canEditSession) {
			return;
		}

		const storedDraft = browser ? readSessionEditDraft(sessionId) : null;

		draftStartedAt = storedDraft?.startedAt ?? overview.summary.startedAt ?? '';
		draftCompletedAt = storedDraft?.completedAt ?? overview.summary.completedAt ?? '';
		overview = applySessionInputDraft(overview, undefined, { includeCompleted: true });
		isEditMode = true;
		openExerciseMenuId = '';
		void syncEditUrl(true);
	}

	async function refreshAfterLeavingEditMode() {
		try {
			await loadData();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		}
	}

	function openTimeEditor() {
		if (!overview || !isEditMode || !timerSummary?.startedAt) {
			return;
		}

		const durationSeconds = getDurationSeconds(timerSummary.startedAt, timerSummary.completedAt);

		timeEditorStartTime = toTimeInputValue(timerSummary.startedAt);
		timeEditorDurationHours = `${Math.floor(durationSeconds / 3600)}`;
		timeEditorDurationMinutes = `${Math.floor((durationSeconds % 3600) / 60)}`;
		timeEditorDurationSeconds = `${durationSeconds % 60}`;
		timeEditorEndMode = 'recorded_end';
		isTimeEditorOpen = true;
	}

	function getTimeEditorStartedAt() {
		if (!timerSummary?.startedAt || !timeEditorStartTime) {
			return null;
		}

		const [hours = '0', minutes = '0'] = timeEditorStartTime.split(':');
		const currentStartedAt = new Date(timerSummary.startedAt);

		if (Number.isNaN(currentStartedAt.getTime())) {
			return null;
		}

		return new Date(
			currentStartedAt.getFullYear(),
			currentStartedAt.getMonth(),
			currentStartedAt.getDate(),
			Number(hours),
			Number(minutes),
			0,
			0
		);
	}

	function useTimeEditorEnd(mode: Exclude<TimeEditorEndMode, 'custom'>) {
		const endAtValue =
			mode === 'last_activity'
				? overview?.summary.lastSetActivityAt
				: overview?.summary.completedAt;
		const startedAt = getTimeEditorStartedAt();
		const endAt = endAtValue ? new Date(endAtValue) : null;

		if (!startedAt || !endAt || Number.isNaN(endAt.getTime()) || endAt < startedAt) {
			return;
		}

		const durationSeconds = Math.max(Math.round((endAt.getTime() - startedAt.getTime()) / 1000), 0);
		timeEditorDurationHours = `${Math.floor(durationSeconds / 3600)}`;
		timeEditorDurationMinutes = `${Math.floor((durationSeconds % 3600) / 60)}`;
		timeEditorDurationSeconds = `${durationSeconds % 60}`;
		timeEditorEndMode = mode;
	}

	function closeTimeEditor() {
		isTimeEditorOpen = false;
	}

	function applyTimeEditor(event: SubmitEvent) {
		event.preventDefault();

		if (!overview || !timerSummary?.startedAt || !timeEditorStartTime) {
			return;
		}

		const [hours = '0', minutes = '0'] = timeEditorStartTime.split(':');
		const currentStartedAt = new Date(timerSummary.startedAt);

		if (Number.isNaN(currentStartedAt.getTime())) {
			return;
		}

		const nextStartedAt = new Date(
			currentStartedAt.getFullYear(),
			currentStartedAt.getMonth(),
			currentStartedAt.getDate(),
			Number(hours),
			Number(minutes),
			0,
			0
		);

		const durationSeconds =
			getTimeEditorNumber(timeEditorDurationHours) * 3600 +
			getTimeEditorNumber(timeEditorDurationMinutes) * 60 +
			getTimeEditorNumber(timeEditorDurationSeconds);
		const nextCompletedAt = new Date(nextStartedAt.getTime() + durationSeconds * 1000);

		draftStartedAt = nextStartedAt.toISOString();
		draftCompletedAt = nextCompletedAt.toISOString();
		isTimeEditorOpen = false;
	}

	async function discardEditMode() {
		if (!isEditMode) {
			return;
		}

		if (hasUnsavedTimeChanges && !window.confirm(SESSION_EDIT_DISCARD_MESSAGE)) {
			return;
		}

		await syncEditUrl(false);
		clearStoredEditDraft();
		isEditMode = false;
		isTimeEditorOpen = false;
		await refreshAfterLeavingEditMode();
	}

	async function saveEditMode() {
		if (!overview || !isEditMode) {
			return;
		}

		if (!hasUnsavedTimeChanges) {
			await syncEditUrl(false);
			clearStoredEditDraft();
			isEditMode = false;
			isTimeEditorOpen = false;
			await refreshAfterLeavingEditMode();
			return;
		}

		const summaryId = overview.summary.id;
		const nextStartedAt = draftStartedAt;
		const nextCompletedAt = draftCompletedAt || undefined;

		void runMutation(async () => {
			await requireApi().updateWorkoutSessionTiming(summaryId, nextStartedAt, nextCompletedAt);
			clearStoredEditDraft();
			await syncEditUrl(false);
			isEditMode = false;
			isTimeEditorOpen = false;
		});
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
		const summaryDayKey = overview.summary.dayKey;

		void runMutation(async () => {
			await requireApi().deleteWorkoutSession(summaryId);
			const todayDayKey = new Date().toLocaleDateString('sv-SE');
			const homePath =
				summaryDayKey === todayDayKey ? '/' : `/?date=${encodeURIComponent(summaryDayKey)}`;
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(homePath === '/' ? resolve('/') : `${resolve('/')}${homePath.slice(1)}`, {
				replaceState: true
			});
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

		const nextOverview = {
			...overview,
			exercises: nextIds
				.map((id) => sessionExerciseById.get(id))
				.filter((sessionExercise): sessionExercise is SessionExerciseOverview =>
					Boolean(sessionExercise)
				)
		};
		overview = nextOverview;
		writeSessionDataCache(sessionId, {
			overview: nextOverview,
			exercises,
			exerciseUsagePreferences
		});
	}

	function cacheDragDropTargets(excludedSessionExerciseId: string) {
		const scrollArea = document.querySelector<HTMLElement>('[data-app-scroll-area]');
		const scrollAreaBounds = scrollArea?.getBoundingClientRect() ?? null;

		dragDropTargets = Array.from(
			document.querySelectorAll<HTMLElement>('[data-session-exercise-id]')
		).flatMap((row) => {
			const id = row.dataset.sessionExerciseId;

			if (!id || id === excludedSessionExerciseId) {
				return [];
			}

			const bounds = row.getBoundingClientRect();
			const midpointY =
				scrollArea && scrollAreaBounds
					? bounds.top - scrollAreaBounds.top + scrollArea.scrollTop + bounds.height / 2
					: bounds.top + window.scrollY + bounds.height / 2;

			return [
				{
					id,
					midpointY
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
		const scrollArea = document.querySelector<HTMLElement>('[data-app-scroll-area]');
		const scrollAreaBounds = scrollArea?.getBoundingClientRect() ?? null;
		const pointerDocumentY =
			scrollArea && scrollAreaBounds
				? pointerY - scrollAreaBounds.top + scrollArea.scrollTop
				: pointerY + window.scrollY;
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

		dragPreviewElement.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
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

		if (dragPreviewElement && dragPreview) {
			dragPreviewElement.style.transform = `translate3d(${dragPreview.x}px, ${dragPreview.y}px, 0)`;
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
			if (!draggedSessionExerciseId) {
				dragAutoScrollFrameId = null;
				return;
			}

			const scrollStep = getDragAutoScrollStep(dragAutoScrollPointerY);

			if (scrollStep !== 0) {
				scrollDragContainer(scrollStep);
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
		const overviewBeforeReorder = overview;
		orderSessionExercises(finalSessionExerciseIds);
		const optimisticOverview = overview;

		void runMutation(async () => {
			try {
				await requireApi().reorderSessionExercises(summaryId, finalSessionExerciseIds);
			} catch (error) {
				if (overview === optimisticOverview) {
					overview = overviewBeforeReorder;
					writeSessionDataCache(sessionId, {
						overview: overviewBeforeReorder,
						exercises,
						exerciseUsagePreferences
					});
				}

				throw error;
			}
		});
	}

	function handleDragPointerCancel(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;

		if (target.hasPointerCapture(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}

		resetDrag(true);
	}

	$effect(() => {
		if (overview && page.url.searchParams.get('edit') === '1' && !isEditMode && canEditSession) {
			enterEditMode();
		}
	});

	$effect(() => {
		if (overview && isEditMode) {
			writeStoredEditDraft();
		}
	});

	$effect(() => {
		if (!overview) {
			clearSessionOverviewActions();
			return;
		}

		setSessionOverviewActions({
			status: overview.summary.status,
			timerSummary: timerSummary ?? overview.summary,
			isEditMode,
			canEditSession,
			canEditTime: Boolean(isEditMode && overview.summary.startedAt),
			hasUnsavedChanges: hasUnsavedTimeChanges,
			isSaving,
			isSharingSession,
			onEnterEditMode: enterEditMode,
			onSaveEditMode: saveEditMode,
			onDiscardEditMode: discardEditMode,
			onOpenTimeEditor: openTimeEditor,
			onShareSession: handleShareSession,
			onEndSession: handleEndSession,
			onResetSession: handleResetSession,
			onDeleteSession: handleDeleteSession
		});
	});

	onDestroy(() => {
		clearSessionOverviewActions();
	});
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
			overview={timerSummary ? { ...overview, summary: timerSummary } : overview}
			{nowMs}
		/>

		{#if overview.summary.status !== 'in_progress'}
			<SessionSummaryPanel {overview} {isSaving} onStartSession={handleStartSession} />
		{/if}

		<SessionExerciseList
			{sessionId}
			{overview}
			{isEditMode}
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
			{isPreviouslyUsedExercise}
			{getPickerExercisePosition}
		/>
	{/if}

	{#if isTimeEditorOpen}
		<div
			class="fixed inset-0 z-40 flex items-end px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
			role="presentation"
		>
			<button
				class="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
				type="button"
				aria-label="Close time editor"
				onclick={closeTimeEditor}
			></button>
			<form
				class="relative max-h-[calc(100svh-env(safe-area-inset-bottom)-1.5rem)] w-full overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#0b1013] shadow-[0_24px_80px_rgba(0,0,0,0.58)]"
				onsubmit={applyTimeEditor}
			>
				<div class="flex justify-center pt-2">
					<div class="h-1 w-10 rounded-full bg-white/20"></div>
				</div>

				<div class="flex items-start justify-between gap-3 px-4 pt-4">
					<div class="min-w-0">
						<p class="text-xs font-semibold tracking-[0.18em] text-emerald-200 uppercase">
							Edit time
						</p>
						<h2 class="mt-1 text-2xl leading-tight font-semibold text-white tabular-nums">
							{timeEditorDurationText}
						</h2>
					</div>
					<button
						class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-zinc-300"
						type="button"
						aria-label="Close time editor"
						onclick={closeTimeEditor}
					>
						<Icon name="x" class="h-4 w-4" />
					</button>
				</div>

				<div class="mt-5 border-y border-white/10">
					<label class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 px-4 py-3">
						<span class="flex items-center gap-2 text-sm font-medium text-zinc-400">
							<Icon name="clock-3" class="h-4 w-4 text-zinc-500" />
							Start
						</span>
						<input
							class="h-11 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-right text-xl font-semibold text-white tabular-nums outline-none focus:border-emerald-300/60"
							type="time"
							name="tinytrain-session-start-time"
							autocomplete="off"
							bind:value={timeEditorStartTime}
							oninput={() => (timeEditorEndMode = 'custom')}
							required
						/>
					</label>
				</div>

				<div class="px-4 pt-4">
					<p class="mb-2 text-xs font-semibold tracking-[0.16em] text-zinc-500 uppercase">
						Clock stops at
					</p>
					<div class="grid gap-2">
						<button
							class={`rounded-lg border px-3 py-3 text-left transition ${
								timeEditorEndMode === 'recorded_end'
									? 'border-emerald-300/60 bg-emerald-300/10'
									: 'border-white/10 bg-white/[0.03]'
							}`}
							type="button"
							aria-pressed={timeEditorEndMode === 'recorded_end'}
							disabled={!overview?.summary.completedAt}
							onclick={() => useTimeEditorEnd('recorded_end')}
						>
							<span class="block text-sm font-semibold text-white">Session end</span>
							<span class="mt-1 block text-xs leading-5 text-zinc-400">
								Use the time saved when the session ended.
							</span>
						</button>
						<button
							class={`rounded-lg border px-3 py-3 text-left transition disabled:opacity-40 ${
								timeEditorEndMode === 'last_activity'
									? 'border-emerald-300/60 bg-emerald-300/10'
									: 'border-white/10 bg-white/[0.03]'
							}`}
							type="button"
							aria-pressed={timeEditorEndMode === 'last_activity'}
							disabled={!overview?.summary.lastSetActivityAt}
							onclick={() => useTimeEditorEnd('last_activity')}
						>
							<span class="block text-sm font-semibold text-white">Last set activity</span>
							<span class="mt-1 block text-xs leading-5 text-zinc-400">
								Use the latest saved set activity before the session ended.
							</span>
						</button>
					</div>
				</div>

				<div class="px-4 pt-4">
					<p class="mb-2 text-xs font-semibold tracking-[0.16em] text-zinc-500 uppercase">
						Duration
					</p>
					<div class="grid grid-cols-3 gap-2">
						<label class="grid gap-1.5">
							<span
								class="text-center text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase"
							>
								Hours
							</span>
							<input
								class="h-13 min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-center text-2xl font-semibold text-white tabular-nums outline-none focus:border-emerald-300/60"
								type="number"
								name="tinytrain-session-duration-hours"
								autocomplete="off"
								min="0"
								inputmode="numeric"
								bind:value={timeEditorDurationHours}
								oninput={() => (timeEditorEndMode = 'custom')}
							/>
						</label>
						<label class="grid gap-1.5">
							<span
								class="text-center text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase"
							>
								Min
							</span>
							<input
								class="h-13 min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-center text-2xl font-semibold text-white tabular-nums outline-none focus:border-emerald-300/60"
								type="number"
								name="tinytrain-session-duration-minutes"
								autocomplete="off"
								min="0"
								inputmode="numeric"
								bind:value={timeEditorDurationMinutes}
								oninput={() => (timeEditorEndMode = 'custom')}
							/>
						</label>
						<label class="grid gap-1.5">
							<span
								class="text-center text-[10px] font-semibold tracking-[0.14em] text-zinc-500 uppercase"
							>
								Sec
							</span>
							<input
								class="h-13 min-w-0 rounded-lg border border-white/10 bg-white/[0.04] px-2 text-center text-2xl font-semibold text-white tabular-nums outline-none focus:border-emerald-300/60"
								type="number"
								name="tinytrain-session-duration-seconds"
								autocomplete="off"
								min="0"
								inputmode="numeric"
								bind:value={timeEditorDurationSeconds}
								oninput={() => (timeEditorEndMode = 'custom')}
							/>
						</label>
					</div>
				</div>

				<div
					class="sticky bottom-0 grid grid-cols-[1fr_1.35fr] gap-2 border-t border-white/10 bg-[#0b1013]/95 px-4 pt-4 pb-4 backdrop-blur-xl"
				>
					<button
						class="flex min-h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] px-4 text-sm font-semibold text-zinc-200"
						type="button"
						onclick={closeTimeEditor}
					>
						Cancel
					</button>
					<button
						class="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-300 px-4 text-sm font-bold text-zinc-950"
						type="submit"
					>
						<Icon name="check" class="h-4 w-4" />
						Apply
					</button>
				</div>
			</form>
		</div>
	{/if}
</section>
