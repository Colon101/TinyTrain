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
		SessionSetOverview,
		SessionStructuralEditExpectation,
		SessionDestructiveEditExpectation
	} from '$lib/db';
	import ExercisePickerSheet from '$lib/features/workouts/ExercisePickerSheet.svelte';
	import {
		readExercisePickerCache,
		writeExercisePickerCache
	} from '$lib/features/workouts/exercise-picker-cache';
	import SessionExerciseFooter from './SessionExerciseFooter.svelte';
	import SessionExerciseHeader from './SessionExerciseHeader.svelte';
	import SessionSetEditor from './SessionSetEditor.svelte';
	import { isSessionExerciseRoute } from './session-navigation';
	import {
		createSessionNavigationOwnershipCoordinator,
		type SessionStructuralMutationLease
	} from './session-navigation-ownership';
	import { readSessionDataCache, writeSessionDataCache } from './session-data-cache';
	import {
		createSessionDraftOverlayController,
		type SessionDraftOverlayOwnerScope
	} from './session-draft-overlay-controller';
	import { createSessionScreenLoadLifetime } from './session-screen-load-lifetime';
	import {
		clearSessionInputDraftFieldIfVersion,
		createEmptySessionInputDraft,
		getSessionInputFieldKey,
		parseSessionInputValue,
		rebuildSessionSetOverview,
		migrateLegacySessionInputDraftForCurrentUser,
		writeSessionInputDraftField,
		type SessionInputDraft
	} from './session-input-draft';
	type DatabaseApi = typeof import('$lib/db');
	type PickerMode = 'add' | 'swap';
	type PickerMutationTarget = {
		mode: PickerMode;
		sessionId: string;
		sessionExerciseId: string;
	};
	type SessionNavigationTarget = {
		path: string;
		options?: Parameters<typeof goto>[1];
	};
	type NonDurableInput = {
		sessionSetId: string;
		field: SessionInputField;
		rawValue: string;
		version: number;
	};
	const NON_DURABLE_INPUT_MESSAGE =
		"We couldn't make a recovery copy of your latest input. Keep this tab open while TinyTrain retries the database save.";

	let {
		sessionId,
		sessionExerciseId
	}: {
		sessionId: string;
		sessionExerciseId: string;
	} = $props();
	const controllerSessionId = untrack(() => sessionId);
	const cachedSessionData = untrack(() => readSessionDataCache(controllerSessionId));
	const cachedExercisePickerData = untrack(() => readExercisePickerCache());
	const draftOverlayController = createSessionDraftOverlayController({
		sessionId: controllerSessionId,
		includeCompleted: isCompletedEditRoute()
	});
	const cachedDraftOverlay = untrack(() =>
		draftOverlayController.setBaseline(cachedSessionData?.overview ?? null)
	);

	let api = $state<DatabaseApi | null>(null);
	let sessionInputDraft = $state<SessionInputDraft>(
		cachedDraftOverlay.draft ?? createEmptySessionInputDraft(controllerSessionId)
	);
	let overview = $state<SessionOverview | null>(cachedDraftOverlay.overview);
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
	let pickerTargetSessionId = $state('');
	let pickerTargetSessionExerciseId = $state('');
	let exerciseSearch = $state('');
	let selectedPickerExerciseIds = $state<string[]>([]);
	let newExerciseName = $state('');
	let isNewExerciseUnilateral = $state(false);
	let sessionSetEditorContainer = $state<HTMLElement | null>(null);
	const loadLifetime = createSessionScreenLoadLifetime();
	const navigationOwnership =
		createSessionNavigationOwnershipCoordinator<SessionNavigationTarget>();
	let inputVersions = new SvelteMap<string, number>();
	let setInputSaveChains = new SvelteMap<string, Promise<void>>();
	let setInputSaveAbortControllers = new SvelteMap<string, AbortController>();
	let pendingSetInputSaves = new SvelteSet<Promise<void>>();
	let nonDurableInputs = new SvelteMap<string, NonDurableInput>();
	let isReplayingInputNavigation = false;
	let isNonDurableUnloadFenceRegistered = false;
	let screenDisposed = false;

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

	function getStructuralEditExpectation(): SessionStructuralEditExpectation | null {
		if (!overview) {
			return null;
		}

		return {
			status: overview.summary.status,
			allowCompleted: overview.summary.status === 'completed' && isEditMode
		};
	}

	function preventNonDurableInputUnload(event: BeforeUnloadEvent) {
		event.preventDefault();
		event.returnValue = '';
	}

	function syncNonDurableUnloadFence() {
		const shouldBlockUnload = nonDurableInputs.size > 0 || navigationOwnership.shouldBlockUnload();

		if (shouldBlockUnload && !isNonDurableUnloadFenceRegistered) {
			window.addEventListener('beforeunload', preventNonDurableInputUnload);
			isNonDurableUnloadFenceRegistered = true;
			return;
		}

		if (
			nonDurableInputs.size === 0 &&
			!navigationOwnership.shouldBlockUnload() &&
			isNonDurableUnloadFenceRegistered
		) {
			window.removeEventListener('beforeunload', preventNonDurableInputUnload);
			isNonDurableUnloadFenceRegistered = false;
		}
	}

	onMount(() => {
		screenDisposed = false;
		let databaseSubscription: { unsubscribe(): void } | null = null;
		const unsubscribeDraftOverlay = draftOverlayController.subscribe((snapshot) => {
			if (screenDisposed || loadLifetime.isDisposed()) {
				return;
			}

			sessionInputDraft = snapshot.draft ?? createEmptySessionInputDraft(sessionId);
			overview = applyNonDurableInputs(snapshot.overview);
		});
		const unsubscribeNavigationOwnership = navigationOwnership.subscribe(() => {
			syncNonDurableUnloadFence();
		});

		void (async () => {
			try {
				const dbApi = await import('$lib/db');

				if (screenDisposed) {
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
				if (!screenDisposed) {
					errorMessage = getErrorMessage(error);
				}
			} finally {
				if (!screenDisposed) {
					isLoading = false;
				}
			}
		})();

		return () => {
			screenDisposed = true;
			for (const controller of setInputSaveAbortControllers.values()) {
				controller.abort();
			}
			setInputSaveAbortControllers.clear();
			loadLifetime.dispose();
			unsubscribeDraftOverlay();
			draftOverlayController.dispose();
			unsubscribeNavigationOwnership();
			navigationOwnership.dispose();
			window.removeEventListener('beforeunload', preventNonDurableInputUnload);
			isNonDurableUnloadFenceRegistered = false;
			databaseSubscription?.unsubscribe();
		};
	});

	beforeNavigate((navigation) => {
		const targetUrl = navigation.to?.url;

		if (isReplayingInputNavigation || navigation.willUnload || !targetUrl) {
			return;
		}

		const ownershipSnapshot = navigationOwnership.getSnapshot();
		const canLeaveWithoutDraftReplay =
			nonDurableInputs.size === 0 &&
			(!hasPendingSetInputWork() ||
				isSessionExerciseRoute(targetUrl.pathname, getSessionOverviewPathname()));

		if (canLeaveWithoutDraftReplay && !ownershipSnapshot.shouldBlockUnload) {
			navigationOwnership.markRouteChanged();
			return;
		}

		const targetPath = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;

		navigation.cancel();

		if (ownershipSnapshot.isStructuralBusy) {
			return;
		}

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
		if (screenDisposed || loadLifetime.isDisposed()) {
			return;
		}

		const generation = loadLifetime.beginLoad();
		const draftOwnerScope = draftOverlayController.getOwnerScope();
		const dbApi = requireApi();
		void dbApi.cleanupStaleSessions();
		const nextOverview = await dbApi.runWithClosedDatabaseRetry(() =>
			dbApi.getEditableSession(sessionId)
		);

		if (
			screenDisposed ||
			!loadLifetime.isCurrent(generation) ||
			!draftOverlayController.isCurrentOwnerScope(draftOwnerScope)
		) {
			return;
		}

		if (nextOverview?.summary.status === 'abandoned') {
			try {
				await navigateWithoutFlushingSetInputs(
					resolve('/(app)/sessions/[sessionId]', { sessionId }),
					{ replaceState: true }
				);
			} catch (error) {
				if (loadLifetime.isCurrent(generation)) {
					errorMessage = getErrorMessage(error);
				}
			}
			return;
		}

		if (nextOverview) {
			migrateLegacySessionInputDraftForCurrentUser(sessionId);
		}

		draftOverlayController.setIncludeCompleted(isCompletedEditRoute());
		const nextDraftOverlay = draftOverlayController.setBaseline(nextOverview, draftOwnerScope);
		sessionInputDraft = nextDraftOverlay.draft ?? createEmptySessionInputDraft(sessionId);
		overview = applyNonDurableInputs(nextDraftOverlay.overview);
		writeSessionDataCache(sessionId, {
			overview: nextDraftOverlay.baseline,
			exercises,
			exerciseUsagePreferences
		});
		isMenuOpen = false;
		void loadExercisePickerData(generation).catch((error) => {
			if (loadLifetime.isCurrent(generation)) {
				errorMessage = getErrorMessage(error);
			}
		});
	}

	async function loadExercisePickerData(generation = loadLifetime.getGeneration()) {
		const dbApi = requireApi();
		const [nextExercises, nextExerciseUsagePreferences] = await Promise.all([
			dbApi.listExercises(),
			dbApi.listExerciseUsagePreferences()
		]);

		if (screenDisposed || !loadLifetime.isCurrent(generation)) {
			return;
		}

		exercises = nextExercises;
		exerciseUsagePreferences = nextExerciseUsagePreferences;
		writeExercisePickerCache(nextExercises, nextExerciseUsagePreferences);
		writeSessionDataCache(sessionId, {
			overview: draftOverlayController.getSnapshot().baseline,
			exercises: nextExercises,
			exerciseUsagePreferences: nextExerciseUsagePreferences
		});
	}

	async function runMutation(
		action: (lease: SessionStructuralMutationLease) => Promise<void>,
		afterSuccess?: (lease: SessionStructuralMutationLease) => Promise<void> | void,
		options: {
			flushPendingInputs?: boolean;
			prepare?: () => Promise<boolean> | boolean;
			settlePendingInputsBeforePrepare?: boolean;
		} = {}
	) {
		if (isSaving) {
			return;
		}

		const lease = navigationOwnership.beginStructuralMutation();

		if (!lease) {
			return;
		}

		isSaving = true;
		errorMessage = '';

		try {
			if (options.settlePendingInputsBeforePrepare) {
				await waitForPendingSetInputSaves();

				if (screenDisposed) {
					return;
				}

				if (nonDurableInputs.size > 0) {
					throw new Error(NON_DURABLE_INPUT_MESSAGE);
				}
			}

			if (options.prepare) {
				const prepared = await options.prepare();

				if (screenDisposed || !prepared) {
					return;
				}
			}

			if (options.flushPendingInputs !== false) {
				await flushPendingSetInputs();

				if (screenDisposed) {
					return;
				}
			}

			await action(lease);

			if (screenDisposed) {
				return;
			}

			await loadData();

			if (screenDisposed) {
				return;
			}

			if (!lease.canRedirect()) {
				return;
			}

			await afterSuccess?.(lease);
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			lease.release();
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

	function writeDraftInput(sessionSetId: string, field: SessionInputField, rawValue: string) {
		const fieldKey = getSessionInputFieldKey(field);
		const currentSet = overview?.exercises
			.flatMap((sessionExercise) => sessionExercise.sets)
			.find((sessionSet) => sessionSet.id === sessionSetId);
		const result = writeSessionInputDraftField({
			sessionId,
			sessionSetId,
			field,
			rawValue,
			baseValue: currentSet?.[fieldKey] ?? ''
		});

		sessionInputDraft = result.draft;
		return {
			updatedAt: result.intentAt,
			baseValue: result.baseValue,
			ownerId: result.ownerId,
			fieldVersion: result.fieldVersion,
			persisted: result.persisted,
			replacedField: result.replacedField
		};
	}

	function trackInputDurability(
		ownerScope: SessionDraftOverlayOwnerScope,
		sessionSetId: string,
		field: SessionInputField,
		rawValue: string,
		version: number,
		persisted: boolean
	) {
		const key = getSetInputKey(ownerScope, sessionSetId, field);

		if (persisted) {
			nonDurableInputs.delete(key);
			syncNonDurableUnloadFence();
			return;
		}

		nonDurableInputs.set(key, { sessionSetId, field, rawValue, version });
		syncNonDurableUnloadFence();
	}

	function clearNonDurableInputIfVersion(key: string, expectedVersion: number) {
		if (nonDurableInputs.get(key)?.version === expectedVersion) {
			nonDurableInputs.delete(key);
			syncNonDurableUnloadFence();
		}
	}

	function clearDraftInput(
		sessionSetId: string,
		field: SessionInputField,
		expectedFieldVersion: string | null,
		expectedRawValue?: string,
		expectedOwnerId?: string | null
	) {
		const result = clearSessionInputDraftFieldIfVersion(
			sessionId,
			sessionSetId,
			field,
			expectedFieldVersion,
			expectedRawValue,
			expectedOwnerId
		);
		sessionInputDraft = result.draft;
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
	}

	function updateSessionBaselineSet(
		sessionSetId: string,
		updater: (sessionSet: SessionSetOverview) => SessionSetOverview,
		expectedOwnerScope = draftOverlayController.getOwnerScope()
	) {
		const baseline = draftOverlayController.getSnapshot().baseline;

		if (!baseline || !draftOverlayController.isCurrentOwnerScope(expectedOwnerScope)) {
			return;
		}

		const nextBaseline = {
			...baseline,
			exercises: baseline.exercises.map((sessionExercise) => ({
				...sessionExercise,
				sets: (sessionExercise.sets as SessionSetOverview[]).map((sessionSet) =>
					sessionSet.id === sessionSetId ? updater(sessionSet) : sessionSet
				)
			}))
		};
		const nextSnapshot = draftOverlayController.setBaseline(nextBaseline, expectedOwnerScope);
		overview = applyNonDurableInputs(nextSnapshot.overview);
		writeSessionDataCache(sessionId, {
			overview: nextSnapshot.baseline,
			exercises,
			exerciseUsagePreferences
		});
	}

	function rebuildSessionSetWithInput(
		sessionSet: SessionSetOverview,
		field: SessionInputField,
		rawValue: string
	) {
		const parsedValue = parseSessionInputValue(rawValue);

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
	}

	function applyNonDurableInputs(nextOverview: SessionOverview | null) {
		if (!nextOverview || nonDurableInputs.size === 0) {
			return nextOverview;
		}
		const ownerScope = draftOverlayController.getOwnerScope();

		return {
			...nextOverview,
			exercises: nextOverview.exercises.map((sessionExercise) => ({
				...sessionExercise,
				sets: (sessionExercise.sets as SessionSetOverview[]).map((sessionSet) => {
					let nextSet = sessionSet;

					for (const field of ['weight', 'reps', 'rir'] as const) {
						const key = getSetInputKey(ownerScope, sessionSet.id, field);
						const nonDurableInput = nonDurableInputs.get(key);

						if (nonDurableInput && inputVersions.get(key) === nonDurableInput.version) {
							nextSet = rebuildSessionSetWithInput(nextSet, field, nonDurableInput.rawValue);
						}
					}

					return nextSet;
				})
			}))
		};
	}

	function applyLocalInput(sessionSetId: string, field: SessionInputField, rawValue: string) {
		updateOverviewSet(sessionSetId, (sessionSet) =>
			rebuildSessionSetWithInput(sessionSet, field, rawValue)
		);
	}

	function hasPendingSetInputWork() {
		return (
			nonDurableInputs.size > 0 ||
			pendingSetInputSaves.size > 0 ||
			Object.keys(sessionInputDraft.sets).length > 0
		);
	}

	function trackPendingSetInputSave(savePromise: Promise<void>) {
		pendingSetInputSaves.add(savePromise);
		void savePromise.then(
			() => !screenDisposed && pendingSetInputSaves.delete(savePromise),
			() => !screenDisposed && pendingSetInputSaves.delete(savePromise)
		);
	}

	function getSetInputKey(
		ownerScope: SessionDraftOverlayOwnerScope,
		sessionSetId: string,
		field: SessionInputField
	) {
		return `${ownerScope.authGeneration}:${ownerScope.ownerId ?? 'unresolved'}:${sessionSetId}:${field}`;
	}

	function queueSetInputSave(
		draftOwnerScope: SessionDraftOverlayOwnerScope,
		sessionSetId: string,
		field: SessionInputField,
		rawValue: string,
		version: number,
		intent: {
			updatedAt: number;
			baseValue: string;
			ownerId: string | null;
			fieldVersion: string;
			persisted: boolean;
			replacedField: { fieldVersion: string | null; rawValue: string } | null;
		}
	) {
		const key = getSetInputKey(draftOwnerScope, sessionSetId, field);
		const previousSave = setInputSaveChains.get(key) ?? Promise.resolve();
		const previousAbortController = setInputSaveAbortControllers.get(key);
		const abortController = new AbortController();
		previousAbortController?.abort();
		setInputSaveAbortControllers.set(key, abortController);
		const isCurrentSave = () =>
			!screenDisposed &&
			inputVersions.get(key) === version &&
			setInputSaveAbortControllers.get(key) === abortController &&
			draftOverlayController.isCurrentOwnerScope(draftOwnerScope);
		let ownerBoundSave: ReturnType<DatabaseApi['updateSessionSetInput']>;

		try {
			const dbApi = requireApi();
			// Starting the API call here admits an authenticated database operation synchronously.
			// Its A-generation lease is already held while it waits for the previous A save.
			ownerBoundSave = dbApi.updateSessionSetInput(sessionSetId, field, rawValue, intent, {
				waitFor: previousSave.catch(() => undefined),
				signal: abortController.signal,
				expectedOwnerId: intent.ownerId
			});
		} catch (error) {
			ownerBoundSave = Promise.reject(error);
		}

		const savePromise = ownerBoundSave.then(
			async (result) => {
				if (!isCurrentSave()) {
					return;
				}

				if (result.skipped) {
					errorMessage =
						'This input changed on another device. Your unsaved value was kept; review and edit it again.';
					await loadData();
					return;
				}

				updateSessionBaselineSet(
					sessionSetId,
					(sessionSet) => rebuildSessionSetOverview(sessionSet, result.sessionSet),
					draftOwnerScope
				);
				const draftFieldToClear = intent.persisted
					? { fieldVersion: intent.fieldVersion, rawValue: rawValue }
					: intent.replacedField;

				if (draftFieldToClear) {
					clearDraftInput(
						sessionSetId,
						field,
						draftFieldToClear.fieldVersion,
						draftFieldToClear.rawValue,
						intent.ownerId
					);
				} else {
					sessionInputDraft =
						draftOverlayController.refreshDraft().draft ?? createEmptySessionInputDraft(sessionId);
				}

				clearNonDurableInputIfVersion(key, version);
			},
			async (error) => {
				if (!isCurrentSave()) {
					return;
				}

				errorMessage = getErrorMessage(error);

				if (api) {
					await loadData();
				}
			}
		);

		setInputSaveChains.set(key, savePromise);
		trackPendingSetInputSave(savePromise);
		void savePromise.finally(() => {
			if (!screenDisposed && setInputSaveChains.get(key) === savePromise) {
				setInputSaveChains.delete(key);
			}

			if (!screenDisposed && setInputSaveAbortControllers.get(key) === abortController) {
				setInputSaveAbortControllers.delete(key);
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

		if (nonDurableInputs.size > 0) {
			throw new Error(NON_DURABLE_INPUT_MESSAGE);
		}

		if (Object.keys(sessionInputDraft.sets).length === 0) {
			return;
		}

		const dbApi = requireApi();

		try {
			await dbApi.runWithClosedDatabaseRetry(() => dbApi.flushSessionInputDraft(sessionId));
		} finally {
			sessionInputDraft =
				draftOverlayController.refreshDraft().draft ?? createEmptySessionInputDraft(sessionId);
		}
	}

	async function navigateAfterSavingSetInputs(
		targetPath: string,
		options?: Parameters<typeof goto>[1],
		lease?: SessionStructuralMutationLease
	) {
		if (screenDisposed) {
			return;
		}

		isSaving = true;
		errorMessage = '';

		try {
			if (lease) {
				await flushPendingSetInputs();

				if (screenDisposed || !lease.canRedirect()) {
					return;
				}

				await performOwnedSessionNavigation({ path: targetPath, options });
				return;
			}

			await navigationOwnership.requestReplay(
				{ path: targetPath, options },
				{
					prepare: flushPendingSetInputs,
					navigate: performOwnedSessionNavigation
				}
			);
		} catch (error) {
			if (!screenDisposed) {
				errorMessage = getErrorMessage(error);
			}
		} finally {
			if (!screenDisposed) {
				isSaving = false;
			}
		}
	}

	async function performOwnedSessionNavigation(target: SessionNavigationTarget) {
		if (screenDisposed) {
			return;
		}

		isReplayingInputNavigation = true;

		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(target.path, target.options);
		} finally {
			isReplayingInputNavigation = false;
		}
	}

	async function navigateWithoutFlushingSetInputs(
		targetPath: string,
		options?: Parameters<typeof goto>[1],
		lease?: SessionStructuralMutationLease
	) {
		if (screenDisposed || (lease && !lease.canRedirect())) {
			return;
		}

		if (nonDurableInputs.size > 0) {
			await waitForPendingSetInputSaves();

			if (screenDisposed || (lease && !lease.canRedirect())) {
				return;
			}

			if (nonDurableInputs.size > 0) {
				throw new Error(NON_DURABLE_INPUT_MESSAGE);
			}
		}

		await performOwnedSessionNavigation({ path: targetPath, options });
	}

	function handleSetInput(sessionSetId: string, field: SessionInputField, event: Event) {
		const input = event.currentTarget as HTMLInputElement;

		if (isSaving) {
			const persistedValue = activeExercise?.sets.find((set) => set.id === sessionSetId)?.[
				getSessionInputFieldKey(field)
			];
			input.value = persistedValue ?? '';
			return;
		}

		const rawValue = sanitizeInputValue(field, input.value);

		if (input.value !== rawValue) {
			input.value = rawValue;
		}

		const draftOwnerScope = draftOverlayController.getOwnerScope();
		const key = getSetInputKey(draftOwnerScope, sessionSetId, field);
		const version = (inputVersions.get(key) ?? 0) + 1;
		inputVersions.set(key, version);
		const intent = writeDraftInput(sessionSetId, field, rawValue);
		trackInputDurability(draftOwnerScope, sessionSetId, field, rawValue, version, intent.persisted);
		applyLocalInput(sessionSetId, field, rawValue);
		queueSetInputSave(draftOwnerScope, sessionSetId, field, rawValue, version, intent);
	}

	function focusNextSetInput(currentInput: HTMLInputElement) {
		const inputs = [
			...(sessionSetEditorContainer?.querySelectorAll<HTMLInputElement>(
				'[data-session-set-input="true"]'
			) ?? [])
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
		if (isSaving) {
			return;
		}

		const previousReference = sessionSet.previousReference;

		if (!previousReference) {
			return;
		}

		const values: Array<[SessionInputField, string]> = [
			['weight', formatAutofillInputValue('weight', previousReference.weight)],
			['reps', formatAutofillInputValue('reps', previousReference.reps)],
			['rir', formatAutofillInputValue('rir', previousReference.rir)]
		];
		const draftOwnerScope = draftOverlayController.getOwnerScope();

		for (const [field, rawValue] of values) {
			const key = getSetInputKey(draftOwnerScope, sessionSet.id, field);
			const version = (inputVersions.get(key) ?? 0) + 1;
			inputVersions.set(key, version);
			const intent = writeDraftInput(sessionSet.id, field, rawValue);
			trackInputDurability(
				draftOwnerScope,
				sessionSet.id,
				field,
				rawValue,
				version,
				intent.persisted
			);
			applyLocalInput(sessionSet.id, field, rawValue);
			queueSetInputSave(draftOwnerScope, sessionSet.id, field, rawValue, version, intent);
		}
	}

	function openExercisePicker(mode: PickerMode) {
		if (!activeExercise) {
			return;
		}

		pickerMode = mode;
		pickerTargetSessionId = sessionId;
		pickerTargetSessionExerciseId = activeExercise.id;
		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isExercisePickerOpen = true;
		isMenuOpen = false;
	}

	function closeExercisePicker() {
		isExercisePickerOpen = false;
		pickerMode = 'add';
		pickerTargetSessionId = '';
		pickerTargetSessionExerciseId = '';
		exerciseSearch = '';
		selectedPickerExerciseIds = [];
		newExerciseName = '';
		isNewExerciseUnilateral = false;
		isMenuOpen = false;
	}

	function getPickerMutationTarget(): PickerMutationTarget | null {
		if (
			!pickerTargetSessionId ||
			!pickerTargetSessionExerciseId ||
			pickerTargetSessionId !== sessionId ||
			pickerTargetSessionExerciseId !== sessionExerciseId
		) {
			return null;
		}

		return {
			mode: pickerMode,
			sessionId: pickerTargetSessionId,
			sessionExerciseId: pickerTargetSessionExerciseId
		};
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

	async function applyPickedExercises(
		exerciseIds: string[],
		target: PickerMutationTarget,
		expectation: SessionStructuralEditExpectation,
		destructiveExpectation?: SessionDestructiveEditExpectation
	) {
		if (exerciseIds.length === 0) {
			return;
		}

		const dbApi = requireApi();

		if (target.mode === 'swap') {
			await dbApi.replaceSessionExercise(
				target.sessionExerciseId,
				exerciseIds[0],
				expectation,
				destructiveExpectation
			);
			closeExercisePicker();
			return;
		}

		await dbApi.addExercisesToSession(target.sessionId, exerciseIds, expectation);

		closeExercisePicker();
	}

	function handleAddSelected() {
		const pickedIds = [...selectedPickerExerciseIds];
		const target = getPickerMutationTarget();
		const expectation = getStructuralEditExpectation();
		let destructiveExpectation: SessionDestructiveEditExpectation | undefined;

		if (!target || !expectation) {
			return;
		}
		const isSwap = target.mode === 'swap';

		void runMutation(
			async () => {
				await applyPickedExercises(pickedIds, target, expectation, destructiveExpectation);
			},
			async (lease) => {
				if (target.mode === 'add' && pickedIds.length > 0 && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseId === pickedIds[pickedIds.length - 1]
					);

					if (addedExercise) {
						await navigateAfterSavingSetInputs(
							getSessionExercisePath(addedExercise.id, target.sessionId),
							{
								replaceState: true
							},
							lease
						);
					}
				}
			},
			{
				flushPendingInputs: !isSwap,
				settlePendingInputsBeforePrepare: isSwap,
				prepare: isSwap
					? async () => {
							destructiveExpectation =
								await requireApi().captureSessionExerciseDestructiveEditExpectation(
									target.sessionExerciseId,
									{ activeSetsOnly: true }
								);
							return true;
						}
					: undefined
			}
		);
	}

	function handleCreateExercise(event: SubmitEvent) {
		event.preventDefault();

		const exerciseName = (newExerciseName || cleanExerciseSearch).trim();
		const createAsUnilateral = isNewExerciseUnilateral;
		const target = getPickerMutationTarget();

		if (!exerciseName) {
			return;
		}
		const expectation = getStructuralEditExpectation();
		let destructiveExpectation: SessionDestructiveEditExpectation | undefined;
		let createdExerciseId = '';

		if (!target || !expectation) {
			return;
		}
		const isSwap = target.mode === 'swap';

		void runMutation(
			async () => {
				const exercise = await requireApi().createExercise(exerciseName, createAsUnilateral);
				createdExerciseId = exercise.id;
				await applyPickedExercises([exercise.id], target, expectation, destructiveExpectation);
			},
			async (lease) => {
				if (target.mode === 'add' && overview) {
					const addedExercise = overview.exercises.find(
						(sessionExercise) => sessionExercise.exerciseId === createdExerciseId
					);

					if (addedExercise) {
						await navigateAfterSavingSetInputs(
							getSessionExercisePath(addedExercise.id, target.sessionId),
							{
								replaceState: true
							},
							lease
						);
					}
				}
			},
			{
				flushPendingInputs: !isSwap,
				settlePendingInputsBeforePrepare: isSwap,
				prepare: isSwap
					? async () => {
							destructiveExpectation =
								await requireApi().captureSessionExerciseDestructiveEditExpectation(
									target.sessionExerciseId,
									{ activeSetsOnly: true }
								);
							return true;
						}
					: undefined
			}
		);
	}

	function handleStartSession() {
		const targetSessionId = sessionId;

		void runMutation(async () => {
			await requireApi().startWorkoutSession(targetSessionId);
		});
	}

	function handleAddSet() {
		if (!activeExercise) {
			return;
		}
		const targetSessionExerciseId = activeExercise.id;
		const expectation = getStructuralEditExpectation();

		if (!expectation) {
			return;
		}

		void runMutation(async () => {
			await requireApi().addSessionSetRow(targetSessionExerciseId, expectation);
		});
	}

	function handleRemoveSet(sessionSetId: string) {
		const expectation = getStructuralEditExpectation();
		let destructiveExpectation: SessionDestructiveEditExpectation | undefined;

		if (!expectation) {
			return;
		}

		void runMutation(
			async () => {
				await requireApi().removeSessionSetRow(sessionSetId, expectation, destructiveExpectation);
			},
			undefined,
			{
				flushPendingInputs: false,
				settlePendingInputsBeforePrepare: true,
				prepare: async () => {
					destructiveExpectation =
						await requireApi().captureSessionSetRemovalExpectation(sessionSetId);
					return true;
				}
			}
		);
	}

	function handleRemoveExercise() {
		if (!activeExercise || !overview) {
			return;
		}
		const targetSessionId = sessionId;
		const targetSessionExercise = activeExercise;
		const targetSessionExerciseId = targetSessionExercise.id;

		const nextRouteTargetId =
			(overview.exercises[exerciseIndex + 1] ?? overview.exercises[exerciseIndex - 1] ?? null)
				?.id ?? null;

		const expectation = getStructuralEditExpectation();
		let destructiveExpectation: SessionDestructiveEditExpectation | undefined;

		if (!expectation) {
			return;
		}

		void runMutation(
			async () => {
				await requireApi().removeSessionExercise(
					targetSessionExerciseId,
					expectation,
					destructiveExpectation
				);
			},
			async (lease) => {
				if (nextRouteTargetId) {
					await navigateWithoutFlushingSetInputs(
						getSessionExercisePath(nextRouteTargetId, targetSessionId),
						{
							replaceState: true
						},
						lease
					);
					return;
				}

				await navigateWithoutFlushingSetInputs(
					getSessionOverviewPath(targetSessionId),
					{
						replaceState: true
					},
					lease
				);
			},
			{
				flushPendingInputs: false,
				settlePendingInputsBeforePrepare: true,
				prepare: async () => {
					destructiveExpectation =
						await requireApi().captureSessionExerciseDestructiveEditExpectation(
							targetSessionExerciseId
						);

					if (screenDisposed) {
						return false;
					}

					return (
						!targetSessionExercise.sets.some(
							(sessionSet) =>
								sessionSet.weightInput?.trim() ||
								sessionSet.repsInput?.trim() ||
								sessionSet.rirInput?.trim()
						) ||
						window.confirm(
							`Remove ${targetSessionExercise.exerciseNameSnapshot} and discard its logged values?`
						)
					);
				}
			}
		);
	}

	function handleEndSession() {
		const targetSessionId = sessionId;

		if (!window.confirm('End this session?')) {
			return;
		}

		void runMutation(
			async () => {
				await flushPendingSetInputs();
				await requireApi().completeWorkoutSession(targetSessionId);
			},
			async (lease) => {
				await navigateWithoutFlushingSetInputs(
					resolve('/(app)/sessions/[sessionId]', { sessionId: targetSessionId }),
					{ replaceState: true },
					lease
				);
			}
		);
	}

	function getSessionExercisePath(nextSessionExerciseId: string, pathSessionId = sessionId) {
		const path = resolve('/(app)/sessions/[sessionId]/exercises/[sessionExerciseId]', {
			sessionId: pathSessionId,
			sessionExerciseId: nextSessionExerciseId
		});

		return `${path}${isEditMode ? '?edit=1' : ''}`;
	}

	function getSessionOverviewPath(pathSessionId = sessionId) {
		const path = getSessionOverviewPathname(pathSessionId);

		return `${path}${isEditMode ? '?edit=1' : ''}`;
	}

	function getSessionOverviewPathname(pathSessionId = sessionId) {
		return resolve('/(app)/sessions/[sessionId]', { sessionId: pathSessionId });
	}

	async function navigateBetweenSessionExercises(targetPath: string) {
		isSaving = true;
		errorMessage = '';

		try {
			// Set input is already durable in the local draft. Its queued database write can safely
			// finish while the user continues through this same session.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(targetPath);
		} catch (error) {
			errorMessage = getErrorMessage(error);
		} finally {
			isSaving = false;
		}
	}

	function goToNextExercise() {
		if (nextExercise) {
			void navigateBetweenSessionExercises(getSessionExercisePath(nextExercise.id));
		}
	}

	function goToPreviousExercise() {
		if (previousExercise) {
			void navigateBetweenSessionExercises(getSessionExercisePath(previousExercise.id));
		}
	}
</script>

<section class="flex min-h-0 flex-1 flex-col overflow-hidden">
	{#if nonDurableInputs.size > 0}
		<p
			class="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-3 text-sm leading-5 text-amber-100"
			role="alert"
		>
			{NON_DURABLE_INPUT_MESSAGE}
		</p>
	{/if}

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
			<h1 class="mt-5 text-2xl font-semibold text-white">Loading exercise</h1>
		</section>
	{:else if !overview || !activeExercise}
		<section class="flex flex-1 flex-col justify-center">
			<h1 class="text-3xl font-semibold text-white">Exercise not found</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-400">
				This exercise is not available in the current session.
			</p>
			<a
				class="mt-6 flex min-h-12 items-center justify-center rounded-lg bg-accent px-4 text-base font-bold text-on-accent"
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
					class="flex min-h-12 items-center justify-center rounded-lg bg-accent px-4 text-base font-bold text-on-accent disabled:bg-white/10 disabled:text-zinc-500"
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

		<div bind:this={sessionSetEditorContainer} class="flex min-h-0 flex-1 flex-col">
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
		</div>

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
