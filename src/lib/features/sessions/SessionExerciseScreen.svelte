<script lang="ts">
	import { resolve } from '$app/paths';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type {
		Exercise,
		ExerciseUsagePreference,
		SessionInputField,
		SessionOverview,
		SessionSetOverview
	} from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import {
		readExercisePickerCache,
		writeExercisePickerCache
	} from '$lib/features/workouts/exercise-picker-cache';
	import SessionExerciseFooter from './SessionExerciseFooter.svelte';
	import SessionExerciseHeader from './SessionExerciseHeader.svelte';
	import SessionSetEditor from './SessionSetEditor.svelte';
	import { readSessionDataCache, writeSessionDataCache } from './session-data-cache';
	import {
		applySessionInputDraft,
		clearSessionInputDraft as clearStoredSessionInputDraft,
		createEmptySessionInputDraft,
		getSessionInputFieldBaseKey,
		getSessionInputFieldKey,
		parseSessionInputValue,
		readSessionInputDraft,
		rebuildSessionSetOverview,
		SESSION_INPUT_DRAFT_CHANGE_EVENT,
		writeSessionInputDraft,
		type SessionInputDraft
	} from './session-input-draft';
	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';

	let {
		sessionId,
		sessionExerciseId
	}: {
		sessionId: string;
		sessionExerciseId: string;
	} = $props();
	const cachedSessionData = untrack(() => readSessionDataCache(sessionId));
	const cachedExercisePickerData = untrack(() => readExercisePickerCache());
	const cachedSessionInputDraft = untrack(
		() => readSessionInputDraft(sessionId) ?? createEmptySessionInputDraft(sessionId)
	);

	let api = $state<DatabaseApi | null>(null);
	let sessionInputDraft = $state<SessionInputDraft>(cachedSessionInputDraft);
	let overview = $state<SessionOverview | null>(
		applySessionInputDraft(cachedSessionData?.overview ?? null, cachedSessionInputDraft, {
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
	let errorMessage = $state('');
	let isMenuOpen = $state(false);
	let isExercisePickerOpen = $state(false);
	let pickerMode = $state<PickerMode>('add');
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let loadDataGeneration = 0;
	let inputVersions = new SvelteMap<string, number>();
	let setInputSaveChains = new SvelteMap<string, Promise<void>>();
	let pendingSetInputSaves = new SvelteSet<Promise<void>>();
	let isReplayingInputNavigation = false;

	let activeExercise = $derived(
		overview?.exercises.find((sessionExercise) => sessionExercise.id === sessionExerciseId) ?? null
	);
	let exerciseIndex = $derived(
		overview?.exercises.findIndex((sessionExercise) => sessionExercise.id === sessionExerciseId) ??
			-1
	);
	let previousExercise = $derived(
		exerciseIndex > 0 && overview ? overview.exercises[exerciseIndex - 1] : null
	);
	let nextExercise = $derived(
		exerciseIndex >= 0 && overview ? (overview.exercises[exerciseIndex + 1] ?? null) : null
	);
	let isLastExercise = $derived(
		exerciseIndex >= 0 && overview ? exerciseIndex === overview.exercises.length - 1 : false
	);
	let isEditMode = $derived(page.url.searchParams.get('edit') === '1');
	let canEditExercise = $derived(
		Boolean(
			overview &&
			(overview.summary.status === 'in_progress' ||
				(overview.summary.status === 'completed' && isEditMode))
		)
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

	onMount(() => {
		let disposed = false;
		let databaseSubscription: { unsubscribe(): void } | null = null;

		function refreshStoredSessionInputDraft(event: Event) {
			const detail = (event as CustomEvent<{ sessionId?: string }>).detail;

			if (detail?.sessionId !== sessionId) {
				return;
			}

			const nextDraft = readSessionInputDraft(sessionId) ?? createEmptySessionInputDraft(sessionId);
			sessionInputDraft = nextDraft;
			overview = applySessionInputDraft(overview, nextDraft, {
				includeCompleted: isCompletedEditRoute()
			});
		}

		window.addEventListener(SESSION_INPUT_DRAFT_CHANGE_EVENT, refreshStoredSessionInputDraft);

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
			window.removeEventListener(SESSION_INPUT_DRAFT_CHANGE_EVENT, refreshStoredSessionInputDraft);
			databaseSubscription?.unsubscribe();
		};
	});

	beforeNavigate((navigation) => {
		if (
			isReplayingInputNavigation ||
			navigation.willUnload ||
			!hasPendingSetInputWork() ||
			!navigation.to?.url
		) {
			return;
		}

		const targetUrl = navigation.to.url;
		const targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;

		navigation.cancel();
		void navigateAfterSavingSetInputs(targetPath, {
			replaceState: navigation.type === 'popstate'
		});
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

		if (nextOverview?.summary.status === 'abandoned') {
			clearLocalSessionInputDraft(sessionId);
			await goto(resolve('/(app)/sessions/[sessionId]', { sessionId }), { replaceState: true });
			return;
		}

		sessionInputDraft = readSessionInputDraft(sessionId) ?? createEmptySessionInputDraft(sessionId);
		const nextOverviewWithDraft = applySessionInputDraft(nextOverview, sessionInputDraft, {
			includeCompleted: isCompletedEditRoute()
		});

		overview = nextOverviewWithDraft;
		writeSessionDataCache(sessionId, {
			overview: nextOverviewWithDraft,
			exercises,
			exerciseUsagePreferences
		});
		isMenuOpen = false;
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

	async function runMutation(
		action: () => Promise<void>,
		afterSuccess?: () => Promise<void> | void
	) {
		isSaving = true;
		errorMessage = '';

		try {
			await flushPendingSetInputs();
			await action();
			await loadData();
			await afterSuccess?.();
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}

	function sanitizeInputValue(field: SessionInputField, rawValue: string) {
		if (field === 'reps' || field === 'rir') {
			return rawValue.replace(/\D/g, '');
		}

		const normalizedValue = rawValue.replace(',', '.').replace(/[^\d.]/g, '');
		const [whole = '', ...decimalParts] = normalizedValue.split('.');

		return decimalParts.length === 0 ? whole : `${whole}.${decimalParts.join('')}`;
	}

	function formatInputValue(value?: number) {
		return typeof value === 'number' && Number.isFinite(value) ? `${Number(value.toFixed(2))}` : '';
	}

	function formatAutofillInputValue(field: SessionInputField, value?: number) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return '';
		}

		return field === 'reps' || field === 'rir' ? `${Math.round(value)}` : formatInputValue(value);
	}

	function clearLocalSessionInputDraft(draftSessionId: string) {
		sessionInputDraft = createEmptySessionInputDraft(draftSessionId);
		clearStoredSessionInputDraft(draftSessionId);
	}

	function persistSessionInputDraft(nextDraft: SessionInputDraft) {
		sessionInputDraft = nextDraft;

		if (Object.keys(nextDraft.sets).length === 0) {
			clearStoredSessionInputDraft(nextDraft.sessionId);
			return;
		}

		writeSessionInputDraft(nextDraft);
	}

	function writeDraftInput(sessionSetId: string, field: SessionInputField, rawValue: string) {
		const now = Date.now();
		const fieldKey = getSessionInputFieldKey(field);
		const baseKey = getSessionInputFieldBaseKey(field);
		const currentSet = overview?.exercises
			.flatMap((sessionExercise) => sessionExercise.sets)
			.find((sessionSet) => sessionSet.id === sessionSetId);
		const currentDraftSet = sessionInputDraft.sets[sessionSetId];
		const nextDraft = {
			...sessionInputDraft,
			sets: {
				...sessionInputDraft.sets,
				[sessionSetId]: {
					...(currentDraftSet ?? { updatedAt: now }),
					[baseKey]: currentDraftSet?.[baseKey] ?? currentSet?.[fieldKey] ?? '',
					[fieldKey]: rawValue,
					updatedAt: now
				}
			},
			updatedAt: now
		};

		persistSessionInputDraft(nextDraft);
	}

	function clearDraftInput(sessionSetId: string, field: SessionInputField) {
		const draftSet = sessionInputDraft.sets[sessionSetId];
		const fieldKey = getSessionInputFieldKey(field);
		const baseKey = getSessionInputFieldBaseKey(field);

		if (!draftSet || !Object.hasOwn(draftSet, fieldKey)) {
			return;
		}

		const nextDraftSet = { ...draftSet };
		delete nextDraftSet[fieldKey];
		delete nextDraftSet[baseKey];

		const hasRemainingInput = (['weightInput', 'repsInput', 'rirInput'] as const).some(
			(nextFieldKey) => Object.hasOwn(nextDraftSet, nextFieldKey)
		);
		const nextSets = { ...sessionInputDraft.sets };

		if (hasRemainingInput) {
			nextSets[sessionSetId] = nextDraftSet;
		} else {
			delete nextSets[sessionSetId];
		}

		persistSessionInputDraft({
			...sessionInputDraft,
			sets: nextSets,
			updatedAt: Date.now()
		});
	}

	function updateOverviewSet(
		sessionSetId: string,
		updater: (sessionSet: SessionSetOverview) => SessionSetOverview
	) {
		if (!overview) {
			return;
		}

		const nextOverview = {
			...overview,
			exercises: overview.exercises.map((sessionExercise) => {
				const sessionSets = sessionExercise.sets as SessionSetOverview[];

				return {
					...sessionExercise,
					sets: sessionSets.map((sessionSet) =>
						sessionSet.id === sessionSetId ? updater(sessionSet) : sessionSet
					)
				};
			})
		};
		overview = nextOverview;
		writeSessionDataCache(sessionId, {
			overview: nextOverview,
			exercises,
			exerciseUsagePreferences
		});
	}

	function applyLocalInput(sessionSetId: string, field: SessionInputField, rawValue: string) {
		const parsedValue = parseSessionInputValue(rawValue);

		updateOverviewSet(sessionSetId, (sessionSet) => {
			if (field === 'weight') {
				return rebuildSessionSetOverview(sessionSet, {
					weightInput: rawValue,
					weight: parsedValue
				});
			}

			if (field === 'reps') {
				return rebuildSessionSetOverview(sessionSet, {
					repsInput: rawValue,
					reps: parsedValue
				});
			}

			return rebuildSessionSetOverview(sessionSet, {
				rirInput: rawValue,
				rir: parsedValue
			});
		});
	}

	function hasPendingSetInputWork() {
		return pendingSetInputSaves.size > 0 || Object.keys(sessionInputDraft.sets).length > 0;
	}

	function trackPendingSetInputSave(savePromise: Promise<void>) {
		pendingSetInputSaves.add(savePromise);
		void savePromise.then(
			() => pendingSetInputSaves.delete(savePromise),
			() => pendingSetInputSaves.delete(savePromise)
		);
	}

	function getSetInputKey(sessionSetId: string, field: SessionInputField) {
		return `${sessionSetId}:${field}`;
	}

	function queueSetInputSave(
		sessionSetId: string,
		field: SessionInputField,
		rawValue: string,
		version: number
	) {
		const key = getSetInputKey(sessionSetId, field);
		const previousSave = setInputSaveChains.get(key) ?? Promise.resolve();
		const savePromise = previousSave
			.catch(() => undefined)
			.then(async () => {
				if (inputVersions.get(key) !== version) {
					return;
				}

				try {
					const dbApi = requireApi();

					await dbApi.runWithClosedDatabaseRetry(() =>
						dbApi.updateSessionSetInput(sessionSetId, field, rawValue)
					);

					if (inputVersions.get(key) === version) {
						clearDraftInput(sessionSetId, field);
					}
				} catch (error) {
					if (inputVersions.get(key) !== version) {
						return;
					}

					errorMessage = getErrorMessage(error);

					if (api) {
						await loadData();
					}
				}
			});

		setInputSaveChains.set(key, savePromise);
		trackPendingSetInputSave(savePromise);
		void savePromise.finally(() => {
			if (setInputSaveChains.get(key) === savePromise) {
				setInputSaveChains.delete(key);
			}
		});
	}

	async function waitForPendingSetInputSaves() {
		while (pendingSetInputSaves.size > 0) {
			await Promise.allSettled([...pendingSetInputSaves]);
		}
	}

	async function flushPendingSetInputs() {
		await waitForPendingSetInputSaves();

		if (Object.keys(sessionInputDraft.sets).length === 0) {
			return;
		}

		const dbApi = requireApi();

		try {
			await dbApi.runWithClosedDatabaseRetry(() => dbApi.flushSessionInputDraft(sessionId));
		} finally {
			sessionInputDraft =
				readSessionInputDraft(sessionId) ?? createEmptySessionInputDraft(sessionId);
		}
	}

	async function navigateAfterSavingSetInputs(
		targetPath: string,
		options?: Parameters<typeof goto>[1]
	) {
		isSaving = true;
		errorMessage = '';

		try {
			await flushPendingSetInputs();
			isReplayingInputNavigation = true;
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(targetPath, options);
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isReplayingInputNavigation = false;
			isSaving = false;
		}
	}

	function handleSetInput(sessionSetId: string, field: SessionInputField, event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const rawValue = sanitizeInputValue(field, input.value);

		if (input.value !== rawValue) {
			input.value = rawValue;
		}

		const key = getSetInputKey(sessionSetId, field);
		const version = (inputVersions.get(key) ?? 0) + 1;
		inputVersions.set(key, version);
		writeDraftInput(sessionSetId, field, rawValue);
		applyLocalInput(sessionSetId, field, rawValue);
		queueSetInputSave(sessionSetId, field, rawValue, version);
	}

	function focusNextSetInput(currentInput: HTMLInputElement) {
		const inputs = [
			...document.querySelectorAll<HTMLInputElement>('[data-session-set-input="true"]')
		];
		const currentIndex = inputs.indexOf(currentInput);
		const nextInput = inputs[currentIndex + 1];

		if (nextInput) {
			nextInput.focus();
			nextInput.select();
			return;
		}

		currentInput.blur();
	}

	function handleSetInputKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') {
			return;
		}

		event.preventDefault();
		focusNextSetInput(event.currentTarget as HTMLInputElement);
	}

	function autofillPreviousSet(sessionSet: SessionSetOverview) {
		const previousReference = sessionSet.previousReference;

		if (!previousReference) {
			return;
		}

		const values: Array<[SessionInputField, string]> = [
			['weight', formatAutofillInputValue('weight', previousReference.weight)],
			['reps', formatAutofillInputValue('reps', previousReference.reps)],
			['rir', formatAutofillInputValue('rir', previousReference.rir)]
		];

		for (const [field, rawValue] of values) {
			const key = getSetInputKey(sessionSet.id, field);
			const version = (inputVersions.get(key) ?? 0) + 1;
			inputVersions.set(key, version);
			writeDraftInput(sessionSet.id, field, rawValue);
			applyLocalInput(sessionSet.id, field, rawValue);
			queueSetInputSave(sessionSet.id, field, rawValue, version);
		}
	}

	function openExercisePicker(mode: PickerMode) {
		pickerMode = mode;
		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isExercisePickerOpen = true;
		isMenuOpen = false;
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
		if (!overview || !activeExercise || exerciseIds.length === 0) {
			return;
		}

		const dbApi = requireApi();

		if (pickerMode === 'swap') {
			await dbApi.replaceSessionExercise(activeExercise.id, exerciseIds[0]);
			closeExercisePicker();
			return;
		}

		for (const exerciseId of exerciseIds) {
			await dbApi.addExerciseToSession(overview.summary.id, exerciseId);
		}

		closeExercisePicker();
	}

	function handleAddSelected() {
		const pickedIds = [...selectedPickerExerciseIds];

		void runMutation(
			async () => {
				await applyPickedExercises(pickedIds);
			},
			async () => {
				if (pickerMode === 'add' && pickedIds.length > 0 && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseId === pickedIds[pickedIds.length - 1]
					);

					if (addedExercise) {
						await navigateAfterSavingSetInputs(getSessionExercisePath(addedExercise.id), {
							replaceState: true
						});
					}
				}
			}
		);
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		const exerciseName = (newExerciseName || cleanExerciseSearch).trim();

		if (!exerciseName) {
			return;
		}

		void runMutation(
			async () => {
				const exercise = await requireApi().createExercise(exerciseName, isNewExerciseUnilateral);
				await applyPickedExercises([exercise.id]);
			},
			async () => {
				if (pickerMode === 'add' && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseNameSnapshot === exerciseName
					);

					if (addedExercise) {
						await navigateAfterSavingSetInputs(getSessionExercisePath(addedExercise.id), {
							replaceState: true
						});
					}
				}
			}
		);
	}

	function handleStartSession() {
		void runMutation(async () => {
			await requireApi().startWorkoutSession(sessionId);
		});
	}

	function handleAddSet() {
		if (!activeExercise) {
			return;
		}

		void runMutation(async () => {
			await requireApi().addSessionSetRow(activeExercise.id);
		});
	}

	function handleRemoveSet(sessionSetId: string) {
		void runMutation(async () => {
			await requireApi().removeSessionSetRow(sessionSetId);
		});
	}

	function handleRemoveExercise() {
		if (!activeExercise || !overview) {
			return;
		}

		const nextRouteTarget =
			overview.exercises[exerciseIndex + 1] ?? overview.exercises[exerciseIndex - 1] ?? null;

		if (
			activeExercise.sets.some(
				(sessionSet) =>
					sessionSet.weightInput?.trim() ||
					sessionSet.repsInput?.trim() ||
					sessionSet.rirInput?.trim()
			) &&
			!window.confirm(
				`Remove ${activeExercise.exerciseNameSnapshot} and discard its logged values?`
			)
		) {
			return;
		}

		void runMutation(
			async () => {
				await requireApi().removeSessionExercise(activeExercise.id);
			},
			async () => {
				if (nextRouteTarget) {
					await navigateAfterSavingSetInputs(getSessionExercisePath(nextRouteTarget.id), {
						replaceState: true
					});
					return;
				}

				await navigateAfterSavingSetInputs(getSessionOverviewPath(), { replaceState: true });
			}
		);
	}

	function handleEndSession() {
		if (!window.confirm('End this session?')) {
			return;
		}

		void runMutation(
			async () => {
				await flushPendingSetInputs();
				await requireApi().completeWorkoutSession(sessionId);
			},
			async () => {
				clearLocalSessionInputDraft(sessionId);
				await navigateAfterSavingSetInputs(resolve('/(app)/sessions/[sessionId]', { sessionId }), {
					replaceState: true
				});
			}
		);
	}

	function getSessionExercisePath(nextSessionExerciseId: string) {
		const path = resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
			sessionId,
			sessionExerciseId: nextSessionExerciseId
		});

		return `${path}${isEditMode ? '?edit=1' : ''}`;
	}

	function getSessionOverviewPath() {
		const path = resolve('/(app)/sessions/[sessionId]', { sessionId });

		return `${path}${isEditMode ? '?edit=1' : ''}`;
	}

	function goToNextExercise() {
		if (nextExercise) {
			void navigateAfterSavingSetInputs(getSessionExercisePath(nextExercise.id));
		}
	}

	function goToPreviousExercise() {
		if (previousExercise) {
			void navigateAfterSavingSetInputs(getSessionExercisePath(previousExercise.id));
		}
	}
</script>

<section class="flex min-h-0 flex-1 flex-col overflow-hidden">
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
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading exercise</h1>
		</section>
	{:else if !overview || !activeExercise}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Exercise not found</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				This exercise is not available in the current session.
			</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950"
				href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
			>
				Back to session
			</a>
		</section>
	{:else if !canEditExercise}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">{activeExercise.exerciseNameSnapshot}</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				Start the session before you begin logging set data.
			</p>

			<div class="mt-6 grid gap-3">
				<button
					class="flex min-h-12 items-center justify-center rounded-lg bg-emerald-300 px-4 text-base font-bold text-zinc-950 disabled:bg-white/10 disabled:text-zinc-500"
					type="button"
					disabled={isSaving || overview.summary.status !== 'planned'}
					onclick={handleStartSession}
				>
					Start session
				</button>
				<a
					class="flex min-h-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-base font-semibold text-white"
					href={resolve('/(app)/sessions/[sessionId]', { sessionId })}
				>
					Back to session
				</a>
			</div>
		</section>
	{:else}
		<SessionExerciseHeader
			{sessionId}
			{activeExercise}
			workoutName={overview.summary.workoutNameSnapshot}
			{exerciseIndex}
			totalExercises={overview.exercises.length}
			{isSaving}
			{isMenuOpen}
			onToggleMenu={() => (isMenuOpen = !isMenuOpen)}
			onCloseMenu={() => (isMenuOpen = false)}
			onAddSet={handleAddSet}
			onSwapExercise={() => openExercisePicker('swap')}
			onRemoveExercise={handleRemoveExercise}
			{isEditMode}
		/>

		<SessionSetEditor
			sets={activeExercise.sets}
			{isSaving}
			isUnilateral={Boolean(activeExercise.exercise?.unilateral)}
			onAutofillPreviousSet={autofillPreviousSet}
			onSetInput={handleSetInput}
			onSetInputKeydown={handleSetInputKeydown}
			onAddSet={handleAddSet}
			onRemoveSet={handleRemoveSet}
		/>

		<SessionExerciseFooter
			{previousExercise}
			{nextExercise}
			{isLastExercise}
			{isSaving}
			{isEditMode}
			onPreviousExercise={goToPreviousExercise}
			onNextExercise={goToNextExercise}
			onAddExercise={() => openExercisePicker('add')}
			onEndSession={handleEndSession}
		/>
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
</section>
